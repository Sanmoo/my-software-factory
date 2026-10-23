import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  installGuardrail,
  type GuardrailApi,
  type GuardrailBlock,
  type ToolCallLike,
  type ToolResultLike,
} from "./extension.js";
import {
  EFFECT_JOURNAL_FILENAME,
  GUARDRAIL_STATE_FILENAME,
  type GuardrailState,
} from "../continuity-artifacts.js";

/**
 * The in-container guardrail (issue 119): executable protection at the tool
 * boundary. The fake Pi API here is a deterministic "model" that tries the
 * same action again — what is asserted is that the code, not the prompt,
 * records the intent before the action and blocks a repeat after an
 * interruption.
 */

interface Handlers {
  sessionStart: (event: { type: "session_start"; reason: string }) => void | Promise<void>;
  toolCall: (event: ToolCallLike) => GuardrailBlock | undefined | Promise<GuardrailBlock | undefined>;
  toolResult: (event: ToolResultLike) => void | Promise<void>;
}

function fakePi(): { api: GuardrailApi; handlers: Handlers } {
  const handlers = {
    sessionStart: () => {},
    toolCall: () => undefined,
    toolResult: () => {},
  } as Handlers;
  const api: GuardrailApi = {
    on: ((event: string, handler: (event: never, ctx: never) => unknown) => {
      if (event === "session_start") handlers.sessionStart = handler as Handlers["sessionStart"];
      if (event === "tool_call") handlers.toolCall = handler as Handlers["toolCall"];
      if (event === "tool_result") handlers.toolResult = handler as Handlers["toolResult"];
      return () => {};
    }) as GuardrailApi["on"],
  };
  return { api, handlers };
}

describe("the in-container continuity guardrail (issue 119)", () => {
  let workMount: string;

  beforeEach(() => {
    workMount = mkdtempSync(join(tmpdir(), "msf-guardrail-"));
  });

  afterEach(() => {
    rmSync(workMount, { recursive: true, force: true });
  });

  function writeState(verdicts: Record<string, "realized" | "absent">, sessionId = "session-1"): void {
    const state: GuardrailState = {
      version: 1,
      attempt: 3,
      sessionId,
      mode: "resume",
      verdicts,
      at: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(join(workMount, GUARDRAIL_STATE_FILENAME), JSON.stringify(state), "utf8");
  }

  function journalLines(): Array<Record<string, unknown>> {
    try {
      return readFileSync(join(workMount, EFFECT_JOURNAL_FILENAME), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  function install(): Handlers {
    const { api, handlers } = fakePi();
    installGuardrail(api, {
      workMount,
      observeRef: () => ({ branch: "agent-issue-7", sha: "abc123" }),
    });
    return handlers;
  }

  test("the session start proves the guardrail was active in that session", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });
    const lines = journalLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.["type"], "session-start");
    assert.equal(lines[0]?.["attempt"], 3);
    assert.equal(lines[0]?.["sessionId"], "session-1");
    assert.equal(typeof lines[0]?.["at"], "string");
  });

  test("the effect intent is on disk BEFORE the tool returns (the interrupted window has its fact)", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });

    const block = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });

    assert.equal(block, undefined, "a first run is allowed");
    const intent = journalLines().find((line) => line["type"] === "intent");
    assert.ok(intent, "the intent exists before the action could run");
    assert.equal(intent["callId"], "call-1");
    assert.equal(intent["safety"], "effect");
    const actions = intent["actions"] as Array<Record<string, unknown>>;
    assert.equal(actions[0]?.["key"], "push:agent-issue-7@abc123");
  });

  test("a realized effect is blocked before it can run again, and the block names it", async () => {
    writeState({ "push:agent-issue-7@abc123": "realized" });
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });

    const block = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "call-again",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });

    assert.ok(block?.block);
    assert.match(block?.reason ?? "", /realized before the interruption/);
    assert.match(block?.reason ?? "", /agent-issue-7/);
    assert.equal(journalLines().filter((line) => line["type"] === "intent").length, 0, "a blocked call leaves no intent");
  });

  test("an effect proved absent is allowed exactly once in the round", async () => {
    writeState({ "push:agent-issue-7@abc123": "absent" });
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });
    const call = (): ToolCallLike => ({
      type: "tool_call",
      toolCallId: `call-${Math.random()}`,
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });

    assert.equal(await handlers.toolCall(call()), undefined, "the proven-absent effect is allowed once");
    const blocked = await handlers.toolCall(call());
    assert.ok(blocked?.block);
    assert.match(blocked?.reason ?? "", /already attempted once in this round/);
  });

  test("an effect a previous round already performed is blocked; a failed one may be retried", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });

    await handlers.toolCall({
      type: "tool_call",
      toolCallId: "previous",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });
    await handlers.toolResult({ type: "tool_result", toolCallId: "previous", toolName: "bash", isError: false });

    const blocked = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "retry",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });
    assert.ok(blocked?.block);
    assert.match(blocked?.reason ?? "", /already attempted by an earlier round/);
  });

  test("a failed previous attempt does not block a retry", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });
    await handlers.toolCall({
      type: "tool_call",
      toolCallId: "previous",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });
    await handlers.toolResult({ type: "tool_result", toolCallId: "previous", toolName: "bash", isError: true });

    const retry = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "retry",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });
    assert.equal(retry, undefined);
  });

  test("an unknown command is journaled as unknown (a recovery will pause on it) and a safe one is not journaled", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });

    await handlers.toolCall({ type: "tool_call", toolCallId: "safe", toolName: "bash", input: { command: "git status" } });
    assert.equal(journalLines().filter((line) => line["type"] === "intent").length, 0);

    await handlers.toolCall({
      type: "tool_call",
      toolCallId: "unknown",
      toolName: "bash",
      input: { command: "curl -X POST https://example.com" },
    });
    const intent = journalLines().find((line) => line["type"] === "intent");
    assert.equal(intent?.["safety"], "unknown");
    assert.match(String(intent?.["reason"]), /curl/);
  });

  test("an unreadable state refuses every external effect instead of running unguarded", async () => {
    // No continuidade.json at all: the host's verdicts, the attempt and the
    // session are unknown, so nothing can be authorized (issue 119). A call
    // that could reach outside the worktree is blocked; a provably local one
    // still runs, so the worker can inspect and report.
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });

    const blocked = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "call-push",
      toolName: "bash",
      input: { command: "git push -u origin agent-issue-7" },
    });
    assert.ok(blocked?.block);
    assert.match(blocked?.reason ?? "", /cannot be read/);
    assert.match(blocked?.reason ?? "", /self-report blocked/);
    assert.equal(journalLines().length, 0, "nothing was journaled against a session it cannot name");

    for (const command of ["curl -X POST https://example.com", "npm publish"]) {
      const refused = await handlers.toolCall({
        type: "tool_call",
        toolCallId: `call-${command}`,
        toolName: "bash",
        input: { command },
      });
      assert.ok(refused?.block, command);
    }

    const local = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "call-read",
      toolName: "bash",
      input: { command: "git status" },
    });
    assert.equal(local, undefined, "a provably local command still runs");

    const delegation = await handlers.toolCall({
      type: "tool_call",
      toolCallId: "call-sub",
      toolName: "subagent",
      input: { task: "review" },
    });
    assert.ok(delegation?.block, "a delegation can reach outside: refused too");
  });

  test("a delegation is an unknown effect: an interruption inside it is not replayable blind", async () => {
    writeState({});
    const handlers = install();
    await handlers.sessionStart({ type: "session_start", reason: "resume" });
    await handlers.toolCall({ type: "tool_call", toolCallId: "sub", toolName: "subagent", input: { task: "review" } });
    const intent = journalLines().find((line) => line["type"] === "intent");
    assert.equal(intent?.["safety"], "unknown");
  });
});
