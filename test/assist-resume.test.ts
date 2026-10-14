import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeResume, interpretContinuityAnswer, isSession, unconsumedResume, type AssistSession,
} from "../src/core/assist-session.js";

// The single-use resume authorization of the interruption answer (ticket #57): the verdict of
// the verbatim answer, the record field that schedules it and the consumption that ties the
// authorization to exactly one opening attempt identity.

const sessionOf = (over: Partial<AssistSession> = {}): AssistSession => ({
  key: "memory:acme/app#1", ref: { tracker: "memory", project: "acme/app", id: "1" },
  repository: "acme/app", state: "pending", promptKind: "needs-triage", model: "m", image: "img",
  cloneDir: "/tmp/clone", startedAt: "2026-10-15T12:00:00.000Z", log: [], ...over,
});

const scheduled = sessionOf({
  scheduledResume: { at: "2026-10-15T12:01:00.000Z", command: "cmd-1", answer: "sim" },
});

test("the answer is an authorization only when it is explicitly affirmative", () => {
  for (const answer of ["sim", "Sim", "SIM", "sim, pode retomar", "pode", "ok", "autorizo",
    "AUTORIZADO", "yes, resume it", "s"]) {
    assert.equal(interpretContinuityAnswer(answer), "authorized", answer);
  }
  // A negative is never turned into an authorization, even with resume words in it.
  for (const answer of ["não", "não autorizo retomada automática", "não pode", "nao", "nunca",
    "no", "declino", "recuso a retomada", "not now"]) {
    assert.equal(interpretContinuityAnswer(answer), "declined", answer);
  }
  // Doubtful words authorize nothing: preserving the session alone never authorizes execution.
  for (const answer of ["talvez depois", "que pena", "vou pensar", "preciso do relatório", "123"]) {
    assert.equal(interpretContinuityAnswer(answer), "doubtful", answer);
  }
});

test("the scheduling keeps the verbatim evidence and is unconsumed until one attempt takes it", () => {
  assert.equal(unconsumedResume(sessionOf({})), undefined, "uma sessão sem interrupção nada agenda");
  const pending = unconsumedResume(scheduled);
  assert.ok(pending && pending.answer === "sim" && pending.command === "cmd-1");
  // The consumption pins the opening attempt: the reread decides whose attempt won the race.
  const consumed = consumeResume(scheduled, "msf-assist-memory-acme-app-1-r1#abc12345", "2026-10-15T12:05:00.000Z");
  assert.equal(consumed.scheduledResume!.consumed!.attempt, "msf-assist-memory-acme-app-1-r1#abc12345");
  assert.equal(unconsumedResume(consumed), undefined, "consumida uma vez, não abre segunda execução");
  assert.equal(consumeResume(consumed, "outro-ciclo", "2026-10-15T12:06:00.000Z"), consumed,
    "o consumo não é sobrescrito");
});

test("the record with the authorization round-trips through the store's validation", () => {
  assert.equal(isSession(scheduled), true, "uma retomada agendada é uma sessão válida");
  assert.equal(isSession(consumeResume(scheduled, "tentativa", "2026-10-15T12:05:00.000Z")), true,
    "uma retomada consumida é uma sessão válida");
  assert.equal(isSession({ ...scheduled, scheduledResume: { at: "t", command: "c" } }), false,
    "sem a resposta verbatim o registro não valida");
  assert.equal(isSession({ ...scheduled, scheduledResume: { ...scheduled.scheduledResume, consumed: { at: "t" } } }), false,
    "consumo sem a identidade da tentativa não valida");
});
