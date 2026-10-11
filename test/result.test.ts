import assert from "node:assert/strict";
import test from "node:test";
import { parseRunOutput } from "../src/core/result.js";
import { implementResult } from "../src/experiments/implement-result.js";
import type { PiEvent } from "../src/experiments/pi-evidence.js";

test("a single needs_help result carries the question and its context", () => {
  assert.deepEqual(
    parseRunOutput([{ status: "needs_help", question: "Which seam?", context: "slugify tests" }]),
    { ok: true, result: { status: "needs_help", question: "Which seam?", context: "slugify tests" } },
  );
});

test("the experiment's needs_help shape is accepted as a help request by this contract too", () => {
  const text = '<smoke-result>{"status":"needs_help","question":"Approve the seam?"}</smoke-result><promise>HELP</promise>';
  const experiment = implementResult([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
    { type: "agent_settled", aborted: false } satisfies PiEvent,
  ]);
  assert.equal(experiment.status, "needs_help");
  assert.deepEqual(parseRunOutput([{ status: "needs_help", question: "Approve the seam?" }]),
    { ok: true, result: { status: "needs_help", question: "Approve the seam?", context: "" } });
});

test("pr_ready needs a PR reference with repository and number", () => {
  assert.deepEqual(
    parseRunOutput([{ status: "pr_ready", pr: { repository: "acme/app", number: 12 } }]),
    { ok: true, result: { status: "pr_ready", pr: { repository: "acme/app", number: 12 } } },
  );
  assert.equal(parseRunOutput([{ status: "pr_ready", pr: { repository: "acme/app" } }]).ok, false);
  assert.equal(parseRunOutput([{ status: "pr_ready", pr: { repository: "acme/app", number: "12" } }]).ok, false);
});

test("interrupted carries a non-empty reason", () => {
  assert.deepEqual(parseRunOutput([{ status: "interrupted", reason: "tool crashed" }]),
    { ok: true, result: { status: "interrupted", reason: "tool crashed" } });
  assert.equal(parseRunOutput([{ status: "interrupted", reason: "  " }]).ok, false);
});

test("absent output is never a success", () => {
  const outcome = parseRunOutput([]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.reason, /ausente/);
});

test("ambiguous output with more than one result is never a success", () => {
  const outcome = parseRunOutput([
    { status: "interrupted", reason: "a" },
    { status: "interrupted", reason: "b" },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.reason, /ambígua/);
});

test("invalid results are rejected: unknown status, the experiment's complete, non-objects", () => {
  for (const value of [
    { status: "done" },
    { status: "complete", summary: "all green" },
    "needs_help",
    null,
    { status: "needs_help", question: "" },
  ]) {
    assert.equal(parseRunOutput([value]).ok, false, JSON.stringify(value));
  }
});
