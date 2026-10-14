import assert from "node:assert/strict";
import test from "node:test";
import { assistPrompt } from "../src/core/assist-prompts.js";
import { HUMAN_STATES, type HumanState } from "../src/core/assist-eligibility.js";

// #48 consolidated item 3: the initial prompt is proper to the attendance; the operator
// conducts the attendance and approves the result; there is no hard write prohibition.

test("each human state has its own prompt, named after the work at hand (triagem/esclarecimento/apoio)", () => {
  const byState = new Map<HumanState, string>(
    HUMAN_STATES.map((state) => {
      const prompt = assistPrompt({ kind: state, ref: { tracker: "github" as const, project: "acme/app", id: "1" }, title: "Título" });
      return [state, prompt];
    }),
  );
  assert.match(byState.get("needs-triage")!, /\btriagem\b/);
  assert.match(byState.get("needs-info")!, /\besclarecimento\b/);
  assert.match(byState.get("ready-for-human")!, /\bapoio\b/);
  // Different states, different prompts: the state directedness never drifts silently between attendances.
  assert.ok(new Set(byState.values()).size === HUMAN_STATES.length);
});

test("the prompt frames the operator conducting and approves the result, without a hard prohibition", () => {
  const prompt = assistPrompt({ kind: "needs-triage", ref: { tracker: "github" as const, project: "acme/app", id: "7" }, title: "Prova" });
  // Operator leading the attendance.
  assert.match(prompt, /O operador humano conduz o atendimento/);
  // Nothing forbidden: changes need the operator's authorization; they are not banned outright.
  assert.match(prompt, /nada é proibido automaticamente/);
  assert.ok(!/proibição|proibido de alterar|nunca alterar/i.test(prompt), "um bloqueio duro não pode aparecer no prompt");
});

test("the prompt carries the structured proposal contract and names the issue (status of the opening)", () => {
  const prompt = assistPrompt({ kind: "needs-info", ref: { tracker: "github" as const, project: "acme/app", id: "9" }, title: "Esclarecer" });
  assert.match(prompt, /<promise>MSF-RESULT<\/promise>/);
  assert.match(prompt, /#9 Esclarecer/);
  // The three outcomes the result distinguishes, each with its own proposed shape (ticket #55).
  assert.match(prompt, /<msf-result>\{"status":"concluded","summary":"\.\.\."\}<\/msf-result>/);
  assert.match(prompt, /<msf-result>\{"status":"external_wait","summary":"\.\.\."\}<\/msf-result>/);
  assert.match(prompt, /<msf-result>\{"status":"interrupted","reason":"\.\.\."\}<\/msf-result>/);
  assert.match(prompt, /"forward":"ready-for-agent"/);
  // The external waiting is a legitimate outcome; the approval is always the operator's.
  assert.match(prompt, /aguardamos o reporter/);
  assert.match(prompt, /A aprovação é sempre do operador/);
});
