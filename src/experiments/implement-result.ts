import assert from "node:assert/strict";
import { finalAssistantText, type PiEvent } from "./pi-evidence.js";

export type ImplementResult =
  | { status: "needs_help"; question: string }
  | { status: "complete"; summary: string };

export function implementResult(events: PiEvent[]): ImplementResult {
  const text = finalAssistantText(events);
  const matches = [...text.matchAll(/<smoke-result>([\s\S]*?)<\/smoke-result>/g)];
  assert.equal(matches.length, 1, "expected exactly one smoke-result in final response");
  const body = matches[0]?.[1];
  assert.ok(body, "empty smoke-result");
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch (error) {
    throw new Error("invalid JSON in smoke-result", { cause: error });
  }
  assert.ok(result && typeof result === "object", "result must be an object");
  const value = result as Record<string, unknown>;
  if (value.status === "needs_help") {
    assert.ok(typeof value.question === "string" && value.question.trim());
    assert.ok(text.includes("<promise>HELP</promise>"), "missing help signal");
    return { status: "needs_help", question: value.question };
  }
  assert.equal(value.status, "complete", "unsupported status");
  assert.ok(typeof value.summary === "string" && value.summary.trim());
  assert.ok(text.includes("<promise>COMPLETE</promise>"), "missing completion signal");
  return { status: "complete", summary: value.summary };
}
