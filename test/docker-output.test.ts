import assert from "node:assert/strict";
import test from "node:test";
import type { PiEvent } from "../src/runtime/pi-events.js";
import { interpretOutput, type InterpretInput } from "../src/runtime/docker-output.js";

const GPT = "github-copilot/gpt-6-luna";
const HAIKU = "github-copilot/claude-haiku-5.5";
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const DIFF = "d".repeat(64);
const SPEC = "a".repeat(64);
const STANDARDS = "b".repeat(64);

const input = (events: PiEvent[], overrides: Partial<InterpretInput> = {}): InterpretInput => ({
  events,
  completed: true,
  models: { implementer: GPT, "reviewer-standards": GPT, "reviewer-spec": GPT, default: HAIKU },
  baseSha: BASE,
  headSha: HEAD,
  diffSha256: DIFF,
  specSha256: SPEC,
  standardsSha256: STANDARDS,
  ...overrides,
});

const settled: PiEvent = { type: "agent_settled", aborted: false };
const finalText = (text: string): PiEvent => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const result = (json: unknown): string => `<msf-result>${JSON.stringify(json)}</msf-result>\n<promise>MSF-RESULT</promise>`;

const review = (axis: "standards" | "spec", overrides: Record<string, unknown> = {}) => ({
  axis, model: GPT, verdict: "approved", base: BASE, head: HEAD,
  diffSha256: DIFF, specSha256: SPEC, standardsSha256: STANDARDS, ...overrides,
});
const prReady = (reviews: unknown[]) => ({ status: "pr_ready", pr: { repository: "acme/app", number: 7 }, reviews });

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

test("pr_ready with approved reviews bound to the final base, head and digests is passed on", () => {
  const out = interpretOutput(input([
    finalText(result(prReady([review("standards"), review("spec")]))), settled,
  ]));
  assert.deepEqual(out.output, { kind: "finished", results: [prReady([review("standards"), review("spec")])] });
});

test("pr_ready without an approved review on one axis is an interruption, not a success", () => {
  const out = interpretOutput(input([
    finalText(result(prReady([review("standards")]))), settled,
  ]));
  assert.match(reasonOf(out.output) ?? "", /sem revisão aprovada.*spec/);
});

test("a review of an older diff does not approve the final diff", () => {
  const stale = [review("standards"), review("spec", { diffSha256: "e".repeat(64) })];
  const out = interpretOutput(input([finalText(result(prReady(stale))), settled]));
  assert.match(reasonOf(out.output) ?? "", /sem revisão aprovada.*spec/);
});

test("a review without the spec and standards digests did not receive that material and does not count", () => {
  const withoutMaterial = [review("standards", { specSha256: undefined, standardsSha256: undefined }), review("spec")];
  const out = interpretOutput(input([finalText(result(prReady(withoutMaterial))), settled]));
  assert.match(reasonOf(out.output) ?? "", /sem revisão aprovada.*standards/);
});

test("a review by a model that is not the configured reviewer does not count, and neither does an inconclusive one", () => {
  const wrongModel = [review("standards", { model: HAIKU }), review("spec")];
  assert.match(reasonOf(interpretOutput(input([finalText(result(prReady(wrongModel))), settled])).output) ?? "", /standards/);
  const inconclusive = [review("standards"), review("spec", { verdict: "inconclusive" })];
  assert.match(reasonOf(interpretOutput(input([finalText(result(prReady(inconclusive))), settled])).output) ?? "", /spec/);
});

function reasonOf(output: { kind: "finished"; results: unknown[] } | { kind: "continue" }): string | undefined {
  if (output.kind !== "finished") return undefined;
  const first = output.results[0] as { status?: string; reason?: string } | undefined;
  return first?.status === "interrupted" ? first.reason : undefined;
}
