import assert from "node:assert/strict";
import test from "node:test";
import { parseEvent, verifyPhase, type PiEvent } from "../src/experiments/pi-evidence.js";

function events(phase: "initial" | "resume" = "initial"): PiEvent[] {
  return [
    ...(phase === "initial" ? [
      { type: "tool_execution_start", toolName: "subagent",
        args: { agent: "smoke-marker", async: true } },
      { type: "tool_execution_end", toolName: "subagent", isError: false },
    ] : []),
    { type: "message_end", message: { role: "assistant",
      content: [{ type: "text", text: "hidden-marker COMPLETE" }] } },
    { type: "agent_settled", aborted: false },
  ];
}

test("accepts delegation and session-only resume evidence", () => {
  assert.equal(verifyPhase(events(), "hidden-marker", "initial").childLaunches, 1);
  assert.equal(verifyPhase(events("resume"), "hidden-marker", "resume").childLaunches, 0);
});

test("rejects failed model requests even when settled and a marker is present", () => {
  const input = events();
  input[2]!.message!.stopReason = "error";
  input[2]!.message!.errorMessage = "fetch failed";
  assert.throws(() => verifyPhase(input, "hidden-marker", "initial"), /fetch failed/);
});

test("a completion token in the echoed prompt is not assistant evidence", () => {
  const input = events("resume");
  input.unshift({ type: "message_end", message: { role: "user",
    content: [{ type: "text", text: "hidden-marker <promise>COMPLETE</promise>" }] } });
  input[1]!.message!.content = [];
  assert.throws(() => verifyPhase(input, "hidden-marker", "resume"));
});

test("agent_end alone does not establish settled completion", () => {
  assert.throws(() => verifyPhase(events().slice(0, -1), "hidden-marker", "initial"));
});

test("rejects marker assertions without actual delegation", () => {
  assert.throws(() => verifyPhase(events("resume"), "hidden-marker", "initial"));
});

test("rejects a fresh child launch masquerading as a resume", () => {
  assert.throws(() => verifyPhase(events(), "hidden-marker", "resume"));
});

test("rejects hidden-marker retrieval through agent inspection", () => {
  const input = events();
  input.splice(0, 0, { type: "tool_execution_start", toolName: "subagent",
    args: { action: "get" } });
  assert.throws(() => verifyPhase(input, "hidden-marker", "initial"));
});

test("rejects missing marker, abort, failed tools and unexpected tools", () => {
  assert.throws(() => verifyPhase(events(), "different-marker", "initial"));
  const aborted = events();
  aborted.at(-1)!.aborted = true;
  assert.throws(() => verifyPhase(aborted, "hidden-marker", "initial"));
  const failed = events();
  failed[1]!.isError = true;
  assert.throws(() => verifyPhase(failed, "hidden-marker", "initial"));
  const unexpected = events();
  unexpected[0]!.toolName = "bash";
  assert.throws(() => verifyPhase(unexpected, "hidden-marker", "initial"));
});

test("parses JSONL events without treating diagnostics as evidence", () => {
  assert.deepEqual(parseEvent('{"type":"agent_settled","aborted":false}'),
    { type: "agent_settled", aborted: false });
  for (const line of ["diagnostic", "{}", "null", '"text"']) {
    assert.equal(parseEvent(line), undefined);
  }
});
