import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantTexts, COMPLETION_LINE, recognizeAssistResult, type AssistResult,
} from "../src/core/assist-result.js";

// The proposal channel of the human-assisted attendance (ticket #55): the agent proposes the
// result as a structured payload that ends with the exact completion line, in the assistant's
// message of the session JSONL the container wrote (the channel the #52 proof validated).
// An output-zero exit, a closed pane, or an agent declaration anywhere else is never a proposal.

const proposal = (payload: string): string =>
  `<msf-result>${payload}</msf-result>\n<promise>MSF-RESULT</promise>`;

const entry = (role: string, text: string): string =>
  JSON.stringify({ id: Math.random().toString(36).slice(2), type: "message", message: { role, content: [{ type: "text", text }] } });

const jsonlOf = (...entries: readonly string[]): string => `${entries.join("\n")}\n`;

test("the assistant message with a payload ended on the completion line is the proposal", async () => {
  const payload = '{"status":"concluded","summary":"triagem acordada","forward":"ready-for-agent"}';
  const log = jsonlOf(
    entry("user", "faça a triagem comigo"),
    entry("assistant", `Primeiro li a issue.\n${proposal(payload)}`),
  );
  const recognized = recognizeAssistResult([log]);
  assert.equal(recognized.kind, "recognized");
  if (recognized.kind !== "recognized") return;
  assert.deepEqual(recognized.result, {
    status: "concluded", summary: "triagem acordada", forward: "ready-for-agent",
  } satisfies AssistResult);
  // The digest is stable: the dedup of the registration is by digest, never by trust.
  assert.match(recognized.digest, /^[0-9a-f]{16}$/);
});

test("the same payload delivered again is the same proposal (same digest, last one wins)", async () => {
  const payload = '{"status":"external_wait","summary":"perguntas publicadas; aguardamos o reporter"}';
  const logA = jsonlOf(entry("assistant", `a b\n${proposal(payload)}`));
  const logB = jsonlOf(entry("assistant", `c d\n${proposal(payload)}`));
  const first = recognizeAssistResult([logA]);
  const both = recognizeAssistResult([logA, logB]);
  assert.ok(first.kind === "recognized" && both.kind === "recognized");
  assert.equal(first.digest, both.digest);
  assert.deepEqual(first.result, { status: "external_wait", summary: "perguntas publicadas; aguardamos o reporter" });
});

test("interruption is an outcome of its own, never a conclusion", async () => {
  const payload = '{"status":"interrupted","reason":"operador suspendeu o atendimento"}';
  const log = jsonlOf(entry("assistant", proposal(payload)));
  const recognized = recognizeAssistResult([log]);
  assert.ok(recognized.kind === "recognized");
  assert.deepEqual(recognized.result, { status: "interrupted", reason: "operador suspendeu o atendimento" });
});

test("a revision after a rejected proposal: the last proposal is the current one", async () => {
  const log = jsonlOf(
    entry("assistant", proposal('{"status":"concluded","summary":"primeira"}')),
    entry("user", "não, corrija"),
    entry("assistant", proposal('{"status":"concluded","summary":"segunda"}')),
    entry("assistant", "entre a proposta e a revisão o agente só conversa, sem linha final: nunca é proposta"),
  );
  const recognized = recognizeAssistResult([log]);
  assert.ok(recognized.kind === "recognized");
  if (recognized.kind !== "recognized") return;
  assert.equal(recognized.result.status, "concluded");
  assert.equal(recognized.result.summary, "segunda");
});

test("an agent declaration without the exact final line is not even a proposal", async () => {
  const withoutLine = recognizeAssistResult([jsonlOf(entry("assistant", '<msf-result>{"status":"concluded","summary":"x"}</msf-result>\n mas sem a linha'))]);
  assert.equal(withoutLine.kind, "none", "uma resposta sem a linha final ainda é conversa");
});

test("a standalone agent declaration in the terminal or the pane is never a proposal (only the session channel)", async () => {
  // The recognition reads only what the session files carried; the flow never infers a result
  // from exit codes or pane state. A message that does not end on the exact line is not even a proposal.
  const noise = jsonlOf(entry("assistant", "<promise>MSF-RESULT</promise> no meio do texto"));
  assert.equal(recognizeAssistResult([noise]).kind, "none");
});

test("the completion line in a user message is not the agent's proposal", async () => {
  const log = jsonlOf(entry("user", `funciona assim: ${proposal('{"status":"concluded","summary":"x"}')}`));
  assert.equal(recognizeAssistResult([log]).kind, "none");
});

test("invalid payloads are named, never guessed into a conclusion", async () => {
  const cases: Array<[string, string]> = [
    ["status desconhecido", '{"status":"cancelled","summary":"x"}'],
    ["concluded sem resumo", '{"status":"concluded"}'],
    ["encaminhamento inválido", '{"status":"concluded","summary":"x","forward":"deploy"}'],
    ["espera externa sem resumo", '{"status":"external_wait"}'],
    ["interrupção sem motivo", '{"status":"interrupted"}'],
    ["não é objeto", '"concluded"'],
  ];
  for (const [what, payload] of cases) {
    const recognized = recognizeAssistResult([jsonlOf(entry("assistant", proposal(payload)))]);
    assert.equal(recognized.kind, "invalid", what);
    if (recognized.kind === "invalid") assert.ok(recognized.reason.length > 0, what);
  }
});

test("two different payloads on the same final message are ambiguous, failed closed", async () => {
  const text = [
    '<msf-result>{"status":"interrupted","reason":"a"}</msf-result>',
    '<msf-result>{"status":"concluded","summary":"b"}</msf-result>',
    COMPLETION_LINE,
  ].join("\n");
  const recognized = recognizeAssistResult([jsonlOf(entry("assistant", text))]);
  assert.ok(recognized.kind === "invalid");
  if (recognized.kind === "invalid") assert.match(recognized.reason, /ambígu/);
});

test("assistantTexts mirrors the validated parsing of the #52 proof", async () => {
  const log = jsonlOf(
    'linha qualquer que não é json',
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "b" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "c" }] } }),
  );
  assert.deepEqual(assistantTexts(log), ["a", "b"]);
});
