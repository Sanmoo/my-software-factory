import assert from "node:assert/strict";
import test from "node:test";
import { IssueWrites } from "../src/core/issue-writes.js";
import { noopObserver, type Observer, type OpsEvent } from "../src/core/observability.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { ClaimMark, IssueRef } from "../src/tracker/port.js";

// The orchestrator's write sequence on an issue, tested through the module's public interface:
// the decision it returns, the events it emits and what the tracker was asked to do.

const REPO = "acme/app";
const REF = (id: string): IssueRef => ({ tracker: "memory", project: REPO, id });

interface FixtureOptions {
  claimMark?: ClaimMark;
  claimed?: unknown;
  labels?: string[];
  assignees?: string[];
}

const memoryOf = (ids: string[], options: FixtureOptions = {}) => loadMemoryTracker({
  ...(options.claimMark === undefined ? {} : { claimMark: options.claimMark }),
  issues: ids.map((id) => ({
    project: REPO,
    id,
    title: `Issue ${id}`,
    labels: options.labels ?? ["ready-for-agent"],
    assignees: options.assignees ?? [],
    claimed: options.claimed ?? false,
    statusCategory: "to-do",
    priority: null,
    blockers: [],
    comments: [],
  })),
});

const capture = (): { observer: Observer; events: OpsEvent[] } => {
  const events: OpsEvent[] = [];
  return { observer: { ...noopObserver, emit: (event) => events.push(event) }, events };
};

const moduleOf = (memory: MemoryTracker) => {
  const captured = capture();
  return { writes: new IssueWrites(memory, captured.observer), events: captured.events };
};

const kinds = (events: OpsEvent[]) => events.map((event) => event.kind);

test("a claim the reread confirms is accepted, and the attempt is announced before the changes", async () => {
  const memory = memoryOf(["1"]);
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.start(REF("1"), { job: "memory:acme/app#1", reason: "admissão" }), { status: "accepted" });
  assert.deepEqual(kinds(events), [
    "issue-escrita-tentativa",
    "issue-alteração-confirmed",
    "issue-alteração-confirmed",
  ]);
  const claim = events[1]?.fields ?? {};
  assert.equal(claim["operação"], "adicionar-label");
  assert.equal(claim["alvo"], "claim");
  assert.equal(claim["estado"], "ausente→presente");
  assert.equal(claim["motivo"], "admissão");
  assert.equal(claim["issue"], "memory:acme/app#1");
});

test("a claim the tracker refuses is refused with its reason, and nothing is written", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "recusa", "already claimed");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.start(REF("1"), { reason: "admissão" }), { status: "refused", reason: "already claimed" });
  assert.deepEqual(kinds(events), ["issue-escrita-tentativa"]);
});

test("a claim the reread cannot see starts nothing and is left for an operator", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "invisível");
  const { writes } = moduleOf(memory);

  const decision = await writes.start(REF("1"), { reason: "admissão" });
  assert.equal(decision.status, "intervention");
  assert.match(decision.status === "intervention" ? decision.reason : "", /início não confirmado/);
  assert.equal(decision.status === "intervention" ? decision.kind : "", "unconfirmed-start");
  assert.equal(memory.calls("claim"), 1);
});

test("a claim that never landed may be retried, and the tracker is reread before deciding", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "falha-antes");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.start(REF("1"), { reason: "admissão" }), {
    status: "retry",
    reason: "erro de escrita no claim; nada registrado no tracker, nova tentativa no próximo polling",
  });
  assert.equal(memory.calls("claim"), 1);
  assert.ok(memory.calls("readIssue") >= 1, "the tracker was reread before the retry decision");
  assert.deepEqual(kinds(events), ["issue-escrita-tentativa", "issue-escrita-incerta"]);
});

test("a claim that landed but lost its answer is intervention, never a blind retry", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "resposta-perdida");
  const { writes } = moduleOf(memory);

  const decision = await writes.start(REF("1"), { reason: "admissão" });
  assert.equal(decision.status, "intervention");
  assert.match(decision.status === "intervention" ? decision.reason : "", /origem não comprovada/);
  assert.equal(decision.status === "intervention" ? decision.kind : "", "uncertain-write");
  assert.equal(memory.calls("claim"), 1, "the ambiguous write is not repeated");
});

test("a partial claim failure reports the write that landed before the failure", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "parcial", "segunda escrita falhou");
  const { writes, events } = moduleOf(memory);

  const decision = await writes.start(REF("1"), { reason: "admissão" });
  assert.equal(decision.status, "intervention");
  assert.match(decision.status === "intervention" ? decision.reason : "", /origem não comprovada/);
  assert.deepEqual(kinds(events), [
    "issue-escrita-tentativa",
    "issue-alteração-attempted",
    "issue-escrita-incerta",
  ]);
  assert.equal(events[1]?.fields?.["operação"], "adicionar-label");
  assert.equal(events[2]?.fields?.["erro"], "segunda escrita falhou");
});

test("a claim whose write failed and whose reread failed is intervention", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("claim", "falha-antes");
  memory.failNext("readIssue", "releitura-falha");
  const { writes } = moduleOf(memory);

  const decision = await writes.start(REF("1"), { reason: "admissão" });
  assert.equal(decision.status, "intervention");
  assert.equal(
    decision.status === "intervention" ? decision.reason : "",
    "erro de escrita no claim e estado externo ilegível",
  );
  assert.equal(memory.calls("claim"), 1);
});

test("a claim whose write failed over an unknown claim state is intervention", async () => {
  const memory = memoryOf(["1"], { claimed: { unknown: "não lido" } });
  memory.failNext("claim", "falha-antes");
  const { writes } = moduleOf(memory);

  const decision = await writes.start(REF("1"), { reason: "admissão" });
  assert.equal(decision.status, "intervention");
  assert.equal(
    decision.status === "intervention" ? decision.reason : "",
    "erro de escrita no claim e estado externo desconhecido",
  );
});

// ---- release: confirmed by the absence of the factory's claim mark ----

const marked = (options: FixtureOptions = {}) =>
  memoryOf(["1"], { labels: ["ready-for-agent", "claim"], ...options });

test("a release the reread confirms is released, each removal reported", async () => {
  const memory = marked();
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.release(REF("1"), { job: "memory:acme/app#1", reason: "liberado-pelo-operador" }), { status: "released" });
  assert.deepEqual(kinds(events), ["issue-escrita-tentativa", "issue-alteração-confirmed"]);
  assert.equal(events[1]?.fields?.["operação"], "remover-label");
  assert.equal(events[1]?.fields?.["alvo"], "claim");
  assert.deepEqual((await memory.readIssue(REF("1"))).labels, { known: true, value: ["ready-for-agent"] });
});

test("a release confirms by reread the removals the adapter only attempted", async () => {
  const memory = marked();
  memory.failNext("releaseClaim", "sem-confirmacao");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.release(REF("1"), { reason: "liberado-pelo-operador" }), { status: "released" });
  const change = events.find((event) => event.kind === "issue-alteração-confirmed");
  assert.equal(change?.fields?.["alvo"], "claim");
  assert.equal(events.some((event) => event.kind === "issue-alteração-attempted"), false, "the reread confirms the removal");
});

test("a release the reread still shows the mark on is not confirmed, and the part left is attempted", async () => {
  const memory = memoryOf(["1"], {
    claimMark: { labels: ["agent-claimed"], assignees: ["acme"] },
    labels: ["agent-claimed"],
    assignees: ["acme"],
  });
  memory.failNext("releaseClaim", "ultima-invisivel");
  const { writes, events } = moduleOf(memory);

  const decision = await writes.release(REF("1"), { reason: "liberado-pelo-operador" });
  assert.deepEqual(decision, { status: "not-confirmed", reason: "liberação não confirmada pelo tracker: claim ainda visível na releitura" });
  assert.equal(events.find((event) => event.kind === "issue-alteração-attempted")?.fields?.["alvo"], "acme");
  assert.equal(events.find((event) => event.kind === "issue-alteração-confirmed")?.fields?.["alvo"], "agent-claimed");
});

test("a release whose write errored but whose reread shows the mark gone is confirmed by evidence", async () => {
  const memory = memoryOf(["1"], {
    claimMark: { labels: ["claim"], assignees: ["acme"] },
    labels: ["claim"],
    assignees: ["acme"],
  });
  memory.failNext("releaseClaim", "resposta-perdida", "resposta perdida");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.release(REF("1"), { reason: "liberado-pelo-operador" }), { status: "released" });
  assert.deepEqual(kinds(events), [
    "issue-escrita-tentativa",
    "issue-escrita-incerta",
    "issue-alteração-confirmed",
    "issue-alteração-confirmed",
  ]);
  for (const change of events.slice(2)) {
    assert.equal(change.fields?.["detalhe"], "confirmada por releitura após erro de escrita");
  }
});

test("a release whose write errored and whose mark is still visible is not confirmed", async () => {
  const memory = marked();
  memory.failNext("releaseClaim", "falha-antes", "fornecedor fora do ar");
  const { writes } = moduleOf(memory);

  assert.deepEqual(await writes.release(REF("1"), { reason: "liberado-pelo-operador" }), {
    status: "not-confirmed",
    reason: "liberação não confirmada pelo tracker: fornecedor fora do ar",
  });
});

test("a release whose reread fails is not confirmed", async () => {
  const memory = marked();
  memory.failNext("readIssue", "releitura-falha");
  const { writes } = moduleOf(memory);

  assert.deepEqual(await writes.release(REF("1"), { reason: "liberado-pelo-operador" }), {
    status: "not-confirmed",
    reason: "liberação não confirmada pelo tracker: releitura indisponível",
  });
});

// ---- complete: done only when the reread shows done ----

test("a done the reread confirms is done, with the change it made", async () => {
  const memory = memoryOf(["1"]);
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.complete(REF("1"), { job: "memory:acme/app#1", reason: "conclusão-após-merge" }), { status: "done" });
  assert.deepEqual(kinds(events), ["issue-escrita-tentativa", "issue-alteração-confirmed"]);
  assert.equal(events[1]?.fields?.["operação"], "fechar");
  assert.equal(events[1]?.fields?.["estado"], "to-do→done");
});

test("a done the adapter only attempted is confirmed by the reread", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("markDone", "sem-confirmacao");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.complete(REF("1"), { reason: "conclusão-após-merge" }), { status: "done" });
  assert.equal(events.at(-1)?.kind, "issue-alteração-confirmed", "the reread is the evidence, not the adapter's word");
});

test("a done the reread does not show stays pending", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("markDone", "invisível");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.complete(REF("1"), { reason: "conclusão-após-merge" }), {
    status: "pending",
    reason: "releitura não mostra done",
  });
  assert.equal(events.at(-1)?.kind, "issue-alteração-attempted");
});

test("a done whose write failed stays pending with the failure as its reason", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("markDone", "falha-antes", "jira fora do ar");
  const { writes, events } = moduleOf(memory);

  assert.deepEqual(await writes.complete(REF("1"), { reason: "conclusão-após-merge" }), {
    status: "pending",
    reason: "jira fora do ar",
  });
  assert.deepEqual(kinds(events), ["issue-escrita-tentativa", "issue-escrita-incerta"]);
});

test("a done whose reread failed stays pending with the reread failure as its reason", async () => {
  const memory = memoryOf(["1"]);
  memory.failNext("markDone", "sem-confirmacao");
  memory.failNext("readIssue", "releitura-falha", "releitura indisponível");
  const { writes } = moduleOf(memory);

  assert.deepEqual(await writes.complete(REF("1"), { reason: "conclusão-após-merge" }), {
    status: "pending",
    reason: "releitura indisponível",
  });
});
