import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { findSessionFile, inspectSessionFile, sessionToolCalls, sessionToolResults } from "./session-log.js";

/**
 * Reading a persisted Pi session: identity, the intact prefix and
 * the tool calls it records. The parser must never turn a broken file into a
 * complete history by dropping the broken line.
 */

const HEADER = (id: string, cwd = "/home/agent/repo"): string =>
  JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" });

const USER = (text: string): string =>
  JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text } });

const CALL = (id: string, command: string): string =>
  JSON.stringify({
    type: "message",
    id: `m-${id}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
  });

/** A `toolResult` entry as Pi writes it: `durationMs` is present only for a
 *  tool that really executed, and `content` is a block list. */
const RESULT = (id: string, message: Record<string, unknown>): string =>
  JSON.stringify({
    type: "message",
    id: `r-${id}`,
    parentId: `m-${id}`,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false, ...message },
  });

describe("the session reader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-session-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(name: string, lines: string[]): string {
    const path = join(dir, "--home-agent-repo--", name);
    mkdirSync(join(dir, "--home-agent-repo--"), { recursive: true });
    writeFileSync(path, lines.join("\n"), "utf8");
    return path;
  }

  test("a session ending with a newline is intact and its whole prefix is counted", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [HEADER("session-1"), USER("do the work"), ""]);
    const inspection = inspectSessionFile(path, "session-1");
    assert.equal(inspection.status, "intact");
    assert.equal(inspection.intactEntries, 1);
    assert.deepEqual(inspection, { status: "intact", intactEntries: 1 }, "nothing beyond the diagnosis is claimed");
  });

  test("a truncated last entry is a partial tail, not a corrupt history, and the prefix is counted", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [HEADER("session-1"), USER("one"), USER("two"), '{"type":"message","id":"trunc']);
    const inspection = inspectSessionFile(path, "session-1");
    assert.equal(inspection.status, "partial");
    assert.equal(inspection.intactEntries, 2);
    assert.match(inspection.detail ?? "", /incomplete entry/);
  });

  test("an unparseable line followed by more history is unreadable", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [HEADER("session-1"), "not json", USER("after"), ""]);
    assert.equal(inspectSessionFile(path, "session-1").status, "unreadable");
  });

  test("a file whose header names another session is an identity mismatch", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [HEADER("someone-else"), USER("x"), ""]);
    const inspection = inspectSessionFile(path, "session-1");
    assert.equal(inspection.status, "identity-mismatch");
    assert.match(inspection.detail ?? "", /someone-else/);
  });

  test("an identity mismatch wins over a partial tail: the file is not this attempt's to continue", () => {
    const file = join(dir, "2026-01-01T00-00-00-000Z_other.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "other", cwd: "/x", timestamp: "" })}\n` +
        `${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "", message: { role: "user", content: "hi" } })}\n` +
        '{"type":"message","id":"cut',
      "utf8",
    );
    const inspection = inspectSessionFile(file, "mine");
    assert.equal(inspection.status, "identity-mismatch");
    assert.match(inspection.detail ?? "", /other/);
  });

  test("an absent file is missing, and an empty one is unreadable", () => {
    assert.equal(inspectSessionFile(join(dir, "nope.jsonl"), "session-1").status, "missing");
    const empty = writeSession("2026-01-01_session-1.jsonl", []);
    assert.equal(inspectSessionFile(empty, "session-1").status, "unreadable");
  });

  test("the session is found by its id under any cwd-encoded directory", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [HEADER("session-1"), ""]);
    assert.equal(findSessionFile(dir, "session-1"), path);
    assert.equal(findSessionFile(dir, "session-2"), null);
    assert.equal(findSessionFile(join(dir, "missing-dir"), "session-1"), null);
  });

  test("the recorded bash calls carry their command and whether a result answered them", () => {
    const call = (id: string, command: string): string =>
      JSON.stringify({
        type: "message",
        id: `m-${id}`,
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
      });
    const result = (id: string): string =>
      JSON.stringify({
        type: "message",
        id: `r-${id}`,
        parentId: `m-${id}`,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false },
      });
    const path = writeSession("2026-01-01_session-1.jsonl", [
      HEADER("session-1"),
      call("c1", "git status"),
      result("c1"),
      call("c2", "git push origin agent-issue-7"),
      "",
    ]);
    const calls = sessionToolCalls(path, 3);
    assert.deepEqual(calls, [
      { callId: "c1", tool: "bash", command: "git status", answered: true },
      { callId: "c2", tool: "bash", command: "git push origin agent-issue-7", answered: false },
    ]);
  });

  test("the recorded results carry their outcome, its text and whether the tool really ran", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [
      HEADER("session-1"),
      CALL("c1", "git push origin agent-issue-7"),
      // Refused before execution: Pi records no duration.
      RESULT("c1", { isError: true, content: [{ type: "text", text: "msf continuity guardrail: blocked" }] }),
      CALL("c2", "git status"),
      // Executed and failed: the duration is there, so the outcome is real.
      RESULT("c2", { isError: true, content: [{ type: "text", text: "no repository" }], durationMs: 1200 }),
      "",
    ]);

    assert.deepEqual(sessionToolResults(path, 4), [
      {
        callId: "c1",
        tool: "bash",
        isError: true,
        text: "msf continuity guardrail: blocked",
        durationMs: null,
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        callId: "c2",
        tool: "bash",
        isError: true,
        text: "no repository",
        durationMs: 1200,
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ]);
  });

  test("a result beyond the intact prefix is not read: a discarded tail proves nothing", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [
      HEADER("session-1"),
      CALL("c1", "git push origin agent-issue-7"),
      RESULT("c1", { isError: false }),
      "",
    ]);

    assert.deepEqual(sessionToolResults(path, 1), [], "the prefix ends at the call, not at its result");
    assert.equal(sessionToolResults(path, 2).length, 1);
  });

  test("an entry without Pi's own outcome field is not a terminal result", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [
      HEADER("session-1"),
      CALL("c1", "git push origin agent-issue-7"),
      // An "answered"/compatibility marker: a result entry that never states
      // whether the call failed. It must not be read as a success.
      RESULT("c1", { isError: undefined, answered: true }),
      "",
    ]);

    assert.deepEqual(sessionToolResults(path, 2), [], "no fabricated success");
  });

  test("a result the entry does not name is still reported as it was written", () => {
    const path = writeSession("2026-01-01_session-1.jsonl", [
      HEADER("session-1"),
      CALL("c1", "git status"),
      RESULT("c1", {
        toolName: undefined,
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
      "",
    ]);

    const [result] = sessionToolResults(path, 2);
    assert.equal(result?.tool, "", "no invented tool name");
    assert.equal(result?.text, "first\nsecond", "every text block, in order");
    assert.equal(result?.durationMs, null);
  });
});
