import assert from "node:assert/strict";
import test from "node:test";
import type { PiEvent } from "../src/runtime/pi-events.js";
import { interpretOutput, type InterpretInput } from "../src/runtime/docker-output.js";

const GPT = "github-copilot/gpt-6-luna";
const HAIKU = "github-copilot/claude-haiku-5.5";

const input = (events: PiEvent[], overrides: Partial<InterpretInput> = {}): InterpretInput => ({
  events,
  completed: true,
  models: { implementer: GPT, "reviewer-standards": GPT, "reviewer-spec": GPT, default: HAIKU },
  ...overrides,
});

const settled: PiEvent = { type: "agent_settled", aborted: false };
const finalText = (text: string): PiEvent => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const result = (json: unknown): string => `<msf-result>${JSON.stringify(json)}</msf-result>\n<promise>MSF-RESULT</promise>`;

const prReady = { status: "pr_ready", pr: { repository: "acme/app", number: 7 } };

const launch = (toolCallId: string, args: Record<string, unknown>): PiEvent => ({
  type: "tool_execution_start", toolName: "subagent", toolCallId, args,
});
const notify = (agent: string): PiEvent => ({
  type: "message_start",
  message: { role: "custom", customType: "subagent-notify", content: `Background task completed: **${agent}**\n\n${agent}:\nreply` },
});

test("a help request with a valid result is passed on as the finished result", () => {
  const out = interpretOutput(input([
    finalText(result({ status: "needs_help", question: "Which seam?", context: "slugify" })),
    settled,
  ]));
  assert.deepEqual(out.output, {
    kind: "finished",
    results: [{ status: "needs_help", question: "Which seam?", context: "slugify" }],
  });
});

test("no structured result is passed on as an absent result, never as success", () => {
  const out = interpretOutput(input([finalText("I am done, no tag"), settled]));
  assert.deepEqual(out.output, { kind: "finished", results: [] });
});

test("more than one structured result is passed on so the result contract reports ambiguity", () => {
  const out = interpretOutput(input([
    finalText(`${result({ status: "interrupted", reason: "a" })}${result({ status: "interrupted", reason: "b" })}`),
    settled,
  ]));
  assert.equal(out.output.kind, "finished");
  assert.equal(out.output.kind === "finished" ? out.output.results.length : 0, 2);
});

test("a result that is not valid JSON is passed on as an invalid entry", () => {
  const out = interpretOutput(input([finalText("<msf-result>{not json}</msf-result>"), settled]));
  assert.equal(out.output.kind, "finished");
  assert.equal(out.output.kind === "finished" ? typeof out.output.results[0] : "", "string");
});

test("a parent that did not settle is an interruption, even when a result is printed", () => {
  const out = interpretOutput(input([finalText(result({ status: "needs_help", question: "q" }))]));
  assert.deepEqual(out.output, {
    kind: "finished",
    results: [{ status: "interrupted", reason: "agente não chegou a estado assentado (agent_settled ausente)" }],
  });
});

test("an async child without its completion report is not reconciled, so the run is interrupted", () => {
  const out = interpretOutput(input([
    launch("c1", { agent: "spike-child", async: true, model: GPT }),
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.match(reasonOf(out.output) ?? "", /spike-child.*sem desfecho/);
});

test("an async child reported as completed is reconciled before the slot is released", () => {
  const out = interpretOutput(input([
    launch("c1", { agent: "spike-child", async: true, model: GPT }),
    notify("spike-child"),
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.equal(out.output.kind === "finished" ? out.output.results.length : 0, 1);
  assert.equal(reasonOf(out.output), undefined);
});

test("a synchronous child without its tool result is not reconciled", () => {
  const out = interpretOutput(input([
    launch("c2", { agent: "reviewer", model: GPT }),
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.match(reasonOf(out.output) ?? "", /reviewer.*sem desfecho/);
});

test("a subagent without an explicit model is refused: there is no fallback to Pi's own default", () => {
  const out = interpretOutput(input([
    launch("c3", { agent: "helper", async: false }),
    { type: "tool_execution_end", toolCallId: "c3", toolName: "subagent" },
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.match(reasonOf(out.output) ?? "", /helper.*sem modelo explícito/);
});

test("a subagent on a model that is not configured for any role is refused", () => {
  const out = interpretOutput(input([
    launch("c4", { agent: "helper", async: false, model: "openai/other" }),
    { type: "tool_execution_end", toolCallId: "c4", toolName: "subagent" },
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.match(reasonOf(out.output) ?? "", /openai\/other.*não é um dos papéis configurados/);
});

test("every use of the default model is logged, with the subagent that used it", () => {
  const out = interpretOutput(input([
    launch("c5", { agent: "researcher", async: false, model: HAIKU }),
    { type: "tool_execution_end", toolCallId: "c5", toolName: "subagent" },
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ]));
  assert.ok(out.audit.some((line) => /default/.test(line) && /researcher/.test(line)), out.audit.join("\n"));
});

test("a model shared by a reviewer and the default role is logged as a default use too", () => {
  const out = interpretOutput(input([
    launch("c6", { agent: "reviewer-a", async: false, model: GPT }),
    { type: "tool_execution_end", toolCallId: "c6", toolName: "subagent" },
    finalText(result({ status: "needs_help", question: "q" })),
    settled,
  ], { models: { implementer: GPT, "reviewer-standards": GPT, "reviewer-spec": GPT, default: GPT } }));
  assert.ok(out.audit.some((line) => /default/.test(line) && /reviewer-a/.test(line)), out.audit.join("\n"));
});

test("a run that ended without the completion signal has no valid result, and the limit is recorded", () => {
  const out = interpretOutput(input([finalText(result({ status: "needs_help", question: "q" })), settled], { completed: false }));
  assert.deepEqual(out.output, { kind: "finished", results: [] });
  assert.ok(out.audit.some((line) => /sem sinal de conclusão/.test(line)));
});

// The review belongs to /implement inside the same invocation: the runner does not gate on it.
// The PR itself is confirmed later by the admission, on the PR port (R08, CA19).
test("a pr_ready result is passed on as it is; the review is the agent's, the PR is confirmed by the admission", () => {
  const out = interpretOutput(input([finalText(result(prReady)), settled]));
  assert.deepEqual(out.output, { kind: "finished", results: [prReady] });
});

function reasonOf(output: { kind: "finished"; results: unknown[] } | { kind: "continue" }): string | undefined {
  if (output.kind !== "finished") return undefined;
  const first = output.results[0] as { status?: string; reason?: string } | undefined;
  return first?.status === "interrupted" ? first.reason : undefined;
}
