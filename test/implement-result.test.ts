import assert from "node:assert/strict";
import test from "node:test";
import { implementResult } from "../src/experiments/implement-result.js";
import type { PiEvent } from "../src/experiments/pi-evidence.js";

function events(text: string): PiEvent[] {
  return [
    { type: "message_end", message: { role: "assistant",
      content: [{ type: "text", text }] } },
    { type: "agent_settled", aborted: false },
  ];
}

test("recognizes a structured question and its stop signal", () => {
  assert.deepEqual(implementResult(events(
    '<smoke-result>{"status":"needs_help","question":"Approve the seam?"}</smoke-result><promise>HELP</promise>')),
    { status: "needs_help", question: "Approve the seam?" });
});

test("recognizes fixture completion without equating it to a PR merge", () => {
  assert.equal(implementResult(events(
    '<smoke-result>{"status":"complete","summary":"Fixture done"}</smoke-result><promise>COMPLETE</promise>')).status,
    "complete");
});

test("rejects absent, ambiguous, malformed or unsupported results", () => {
  for (const text of [
    "Help?",
    '<smoke-result>{invalid}</smoke-result>',
    '<smoke-result>{"status":"done"}</smoke-result><promise>COMPLETE</promise>',
    '<smoke-result>{"status":"needs_help","question":""}</smoke-result><promise>HELP</promise>',
    '<smoke-result>{"status":"needs_help","question":"Approve?"}</smoke-result>',
    '<smoke-result>{"status":"complete","summary":"ok"}</smoke-result>'.repeat(2),
  ]) assert.throws(() => implementResult(events(text)));
});

test("does not accept a result from an echoed user prompt or an errored assistant", () => {
  const input = events("No output");
  input.unshift({ type: "message_end", message: { role: "user", content: [
    { type: "text", text: '<smoke-result>{"status":"needs_help","question":"Fake"}</smoke-result><promise>HELP</promise>' },
  ] } });
  assert.throws(() => implementResult(input));
  const failed = events('<smoke-result>{"status":"complete","summary":"ok"}</smoke-result><promise>COMPLETE</promise>');
  failed[0]!.message!.stopReason = "error";
  assert.throws(() => implementResult(failed));
});
