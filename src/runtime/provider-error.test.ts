import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { appendAttemptEvent } from "./attempt-logs.js";
import { readTurnProviderError } from "./provider-error.js";

/**
 * The provider failure of a turn (issue 144), read from the attempt's stream
 * log. The shapes below are the real pi stdout lines (verbatim `agent-raw`
 * entries): `stopReason: "error"` with the provider's `errorMessage`, and the
 * surrounding `message_start` / `turn_end` / `agent_end` repeats.
 */

const AT = 1_792_571_444_513;
const AT_ISO = new Date(AT).toISOString();

describe("the provider failure of a turn, read from the attempt's stream log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-provider-error-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One raw pi stdout line, as the runtime records it. */
  function raw(inner: Record<string, unknown>): void {
    appendAttemptEvent(dir, 1, { event: "agent-raw", line: JSON.stringify(inner) });
  }

  function assistantMessage(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      role: "assistant",
      content: [],
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      timestamp: AT,
      ...extra,
    };
  }

  test("an assistant message with stopReason error and a provider message is the failure", async () => {
    raw({ type: "message_start", message: assistantMessage({ stopReason: "error", errorMessage: "429: upstream unavailable" }) });
    raw({ type: "turn_end", message: assistantMessage({ stopReason: "error", errorMessage: "429: upstream unavailable" }), toolResults: [] });

    assert.deepEqual(await readTurnProviderError(dir, 1), {
      message: "429: upstream unavailable",
      at: AT_ISO,
    });
  });

  test("the LAST assistant message decides: an error the session outlived is not a provider failure", async () => {
    raw({ type: "message_start", message: assistantMessage({ stopReason: "error", errorMessage: "503: unavailable" }) });
    raw({ type: "message_start", message: assistantMessage({ stopReason: "stop", content: [{ type: "text", text: "done" }] }) });

    assert.equal(await readTurnProviderError(dir, 1), null);
  });

  test("a turn ended by an abort (the idle limit) is not a provider failure", async () => {
    raw({ type: "message_end", message: assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" }) });

    assert.equal(await readTurnProviderError(dir, 1), null);
  });

  test("agent_end's messages array is read too — the terminal event of the real stream", async () => {
    raw({
      type: "agent_end",
      messages: [
        { role: "user", content: [] },
        assistantMessage({ stopReason: "error", errorMessage: "500: internal server error" }),
      ],
      willRetry: false,
    });

    assert.deepEqual(await readTurnProviderError(dir, 1), {
      message: "500: internal server error",
      at: AT_ISO,
    });
  });

  test("a log without an assistant error, an absent log and a corrupt line all answer null — never a crash", async () => {
    appendAttemptEvent(dir, 1, { event: "session-start" });
    appendAttemptEvent(dir, 1, { event: "agent-raw", line: "{not json" });
    writeFileSync(join(dir, "log-1.jsonl"), "not json at all\n", "utf8");
    assert.equal(await readTurnProviderError(dir, 1), null);
    assert.equal(await readTurnProviderError(dir, 2), null);
  });

  test("without a timestamp the failure's identity is the log's mtime — stable across restarts", async () => {
    mkdirSync(dir, { recursive: true });
    raw({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429: unavailable" } });

    const first = await readTurnProviderError(dir, 1);
    const second = await readTurnProviderError(dir, 1);
    assert.ok(first);
    assert.equal(first.at, second?.at, "two reads of the same settled failure agree");
  });

  test("only the CURRENT session counts: an earlier error is not this session's ending", async () => {
    raw({ type: "message_end", message: assistantMessage({ stopReason: "error", errorMessage: "429: unavailable" }) });
    appendAttemptEvent(dir, 1, { event: "session-start" });
    appendAttemptEvent(dir, 1, { event: "agent-text", message: "working" });

    assert.equal(
      await readTurnProviderError(dir, 1),
      null,
      "a retry killed before any assistant message is an interruption, not the old outage again",
    );
  });
});
