import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operatorCommand } from "../src/core/operator-actions.js";
import { buildOperatorView, type OperatorView, type OperatorWork } from "../src/core/operator-view.js";
import type { CommandBody, CommandQueue } from "../src/core/commands.js";
import type { InstanceConfig } from "../src/config/types.js";
import { newJob, transitionJob } from "../src/core/job.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { applyOperatorAction } from "../src/cli/tui.js";

// Ações do operador na TUI (issue #63, spec #60): o mapa ação↔comando é puro e derivado da
// visão de leitura; a TUI enfileira pela MESMA fila do CLI e nunca escreve fora dela. Os testes
// semeiam stores reais, afirmam o CommandBody exato produzido (deepEqual) e, na escrita, usam
// uma fila falsa injetada (ou a fila real de arquivos) — nada de testes de renderização.

const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });
const keyOf = (id: string): string => refKey(refOf(id));

const jobOf = (id: string): ReturnType<typeof newJob> => newJob({ ref: refOf(id), repository: "acme/app" });

const sessionOf = (id: string, state: AssistSession["state"], over: Partial<AssistSession> = {}): AssistSession => ({
  key: keyOf(id), ref: refOf(id), repository: "acme/app", state,
  promptKind: "needs-triage", model: "p/m", image: "img", cloneDir: "/c",
  startedAt: "2026-10-14T12:00:00.000Z", log: [], ...over,
});

const instance: InstanceConfig = {
  name: "pessoal", maxConcurrent: 2, maxAssisted: 3, pollIntervalSeconds: 300, maxIterations: 5,
  modelAuth: "copilot",
  projects: [{
    name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
    prIntegration: "github.com", runtimeProfile: "docker-default", githubAccount: "acme",
    labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
    models: { implementer: "a/b", "reviewer-standards": "a/b", "reviewer-spec": "a/b", default: "a/b" },
  }],
};

// Um cenário semeado com um trabalho real de cada estado vivo relevante para as validações:
// autônomos 1–5 (em-invocacao, pedido-de-ajuda, interrompido, retomada-autorizada, espera-externa)
// e sessões assistidas 6–10 (proposed, open, pending, pending com retomada, concluding).
interface Scenario {
  root: string;
  stateDir: string;
  view: OperatorView;
}

async function scenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "msf-operator-actions-"));
  const stateDir = join(root, "state");
  const jobs = createFileJobStore(stateDir);
  const sessions = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  await jobs.save(jobOf("1"));
  await jobs.save(transitionJob(jobOf("2"), "waiting-for-help", { message: "m", question: "qual formato?" }));
  await jobs.save(transitionJob(jobOf("3"), "interrupted", { message: "m", reason: "pane" }));
  await jobs.save({ ...transitionJob(jobOf("4"), "interrupted", { message: "m", reason: "pane" }), pending: "resume" });
  await jobs.save(transitionJob(jobOf("5"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } }));
  await sessions.save(sessionOf("6", "proposed"));
  await sessions.save(sessionOf("7", "open"));
  await sessions.save(sessionOf("8", "pending"));
  await sessions.save(sessionOf("9", "pending", { scheduledResume: { at: "2026-10-14T13:00:00.000Z", command: "c", answer: "s" } }));
  await sessions.save(sessionOf("10", "concluding"));
  const view = await buildOperatorView({ stateDir, instance });
  return { root, stateDir, view };
}

const cleanup = async (s: Scenario): Promise<void> => { await rm(s.root, { recursive: true, force: true }); };

const workOf = (s: Scenario, id: string): OperatorWork => {
  const work = s.view.works.find((candidate) => candidate.key === keyOf(id));
  assert.ok(work !== undefined, `trabalho ${id} deve estar na visão`);
  return work;
};

// Fila falsa injetada no lugar da TUI: registra cada enqueue (comando + instante) em ordem.
interface FakeQueue extends CommandQueue {
  calls: { command: CommandBody; at: Date }[];
}

const fakeQueue = (): FakeQueue => {
  const calls: { command: CommandBody; at: Date }[] = [];
  let sequence = 0;
  return {
    calls,
    async enqueue(command: CommandBody): Promise<string> {
      sequence += 1;
      calls.push({ command, at: new Date() });
      return `c-${sequence}`;
    },
    async pending() { return { commands: [], unreadable: [] }; },
    async done() {},
  };
};

// Snapshot cru dos stores de trabalhos, sessões e pendências — para provar que a ação da TUI
// não reescreve nada fora da fila de comandos.
const rawStores = async (stateDir: string): Promise<{ jobs: string; sessions: string; pendings: string }> => {
  const readAll = async (dir: string): Promise<string> => JSON.stringify(await Promise.all(
    (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readFile(join(dir, name), "utf8")),
  ));
  return {
    jobs: await readAll(stateDir),
    sessions: await readAll(join(stateDir, "assist-sessions")),
    pendings: await readAll(join(stateDir, "pendencias")),
  };
};

// ── mapa ação ↔ comando (puro, derivado da visão) ─────────────────────────────────────────────

test("responder enfileira reply com o texto informado", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("responder", workOf(s, "2"), s.view, "use o formato X"),
    { ok: true, command: { type: "reply", job: keyOf("2"), message: "use o formato X" } },
  );
  await cleanup(s);
});

test("responder sem texto é recusado com resposta vazia", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("responder", workOf(s, "2"), s.view), { ok: false, reason: "resposta vazia" });
  assert.deepEqual(operatorCommand("responder", workOf(s, "2"), s.view, ""), { ok: false, reason: "resposta vazia" });
  assert.deepEqual(operatorCommand("responder", workOf(s, "2"), s.view, "   "), { ok: false, reason: "resposta vazia" });
  await cleanup(s);
});

test("aprovar resultado enfileira approve para atendimento assistido com resultado proposto", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("aprovar-resultado", workOf(s, "6"), s.view),
    { ok: true, command: { type: "approve", job: keyOf("6") } },
  );
  await cleanup(s);
});

test("aprovar resultado é recusado sem resultado proposto (sessão pendente)", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("aprovar-resultado", workOf(s, "8"), s.view),
    { ok: false, reason: "aprovar sem resultado proposto" },
  );
  await cleanup(s);
});

test("aprovar resultado em conclusão em curso recusa com o motivo do núcleo", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("aprovar-resultado", workOf(s, "10"), s.view),
    { ok: false, reason: "aprovação já em andamento: a conclusão continua sendo tentada; nada é registrado duas vezes" },
  );
  await cleanup(s);
});

test("aprovar resultado é recusado em trabalho autônomo", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("aprovar-resultado", workOf(s, "2"), s.view),
    { ok: false, reason: "aprovação se aplica apenas a atendimento assistido" },
  );
  await cleanup(s);
});

test("autorizar retomada enfileira resume para trabalho interrompido", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("autorizar-retomada", workOf(s, "3"), s.view),
    { ok: true, command: { type: "resume", job: keyOf("3") } },
  );
  await cleanup(s);
});

test("autorizar retomada enfileira resume para sessão assistida interrompida", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("autorizar-retomada", workOf(s, "8"), s.view),
    { ok: true, command: { type: "resume", job: keyOf("8") } },
  );
  await cleanup(s);
});

test("autorizar retomada é recusado quando a retomada já está autorizada", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("autorizar-retomada", workOf(s, "4"), s.view), { ok: false, reason: "retomada já autorizada" });
  assert.deepEqual(operatorCommand("autorizar-retomada", workOf(s, "9"), s.view), { ok: false, reason: "retomada já autorizada" });
  await cleanup(s);
});

test("autorizar retomada é recusado em trabalho não interrompido", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("autorizar-retomada", workOf(s, "1"), s.view), { ok: false, reason: "trabalho não interrompido" });
  assert.deepEqual(operatorCommand("autorizar-retomada", workOf(s, "5"), s.view), { ok: false, reason: "trabalho não interrompido" });
  await cleanup(s);
});

test("autorizar retomada é recusado em sessão assistida sem interrupção", async () => {
  const s = await scenario();
  assert.deepEqual(
    operatorCommand("autorizar-retomada", workOf(s, "7"), s.view),
    { ok: false, reason: "sessão sem autorização para reabrir" },
  );
  await cleanup(s);
});

test("liberar enfileira release para trabalho parado", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("liberar", workOf(s, "3"), s.view), { ok: true, command: { type: "release", job: keyOf("3") } });
  // Pedido de ajuda não ocupa vaga: a liberação é permitida (RELEASABLE do núcleo).
  assert.deepEqual(operatorCommand("liberar", workOf(s, "2"), s.view), { ok: true, command: { type: "release", job: keyOf("2") } });
  await cleanup(s);
});

test("liberar é recusado em trabalho em execução", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("liberar", workOf(s, "1"), s.view), { ok: false, reason: "liberar trabalho em execução" });
  await cleanup(s);
});

test("liberar é recusado em sessão assistida aberta", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("liberar", workOf(s, "7"), s.view), { ok: false, reason: "liberação só quando parado" });
  await cleanup(s);
});

test("liberar enfileira release para sessão assistida parada", async () => {
  const s = await scenario();
  assert.deepEqual(operatorCommand("liberar", workOf(s, "8"), s.view), { ok: true, command: { type: "release", job: keyOf("8") } });
  await cleanup(s);
});

// ── caminho de escrita da TUI (fila injetada) ──────────────────────────────────────────────────

test("ação correta enfileira o comando na fila injetada e confirma", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  const notice = await applyOperatorAction("responder", workOf(s, "2"), s.view, queue, "pessoal", "use o formato X");
  assert.equal(queue.calls.length, 1);
  assert.deepEqual(queue.calls[0]?.command, { type: "reply", job: keyOf("2"), message: "use o formato X" });
  assert.ok(queue.calls[0]?.at instanceof Date);
  assert.equal(notice.kind, "ok");
  assert.match(notice.text, /resposta para acme\/app#2: enfileirado na fila da instância pessoal/);
  assert.match(notice.text, /comando=c-1/);
  assert.match(notice.text, /será aplicado no próximo ciclo — aguarde o scanner da instância/);
  await cleanup(s);
});

test("recusa não enfileira nada e mostra o motivo", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  const notice = await applyOperatorAction("liberar", workOf(s, "1"), s.view, queue, "pessoal");
  assert.deepEqual(queue.calls, []);
  assert.deepEqual(notice, { kind: "recusa", text: "liberar trabalho em execução" });
  await cleanup(s);
});

test("duas ações enfileiram na ordem chamada", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  await applyOperatorAction("responder", workOf(s, "2"), s.view, queue, "pessoal", "primeira");
  await applyOperatorAction("liberar", workOf(s, "3"), s.view, queue, "pessoal");
  assert.deepEqual(queue.calls.map((call) => call.command.type), ["reply", "release"]);
  await cleanup(s);
});

// ── honestidade da escrita: só a fila muda ─────────────────────────────────────────────────────

test("a TUI não escreve nada fora da fila de comandos", async () => {
  const s = await scenario();
  const before = await rawStores(s.stateDir);
  const notice = await applyOperatorAction("responder", workOf(s, "2"), s.view, createFileCommandQueue(s.stateDir), "pessoal", "texto da resposta");
  assert.equal(notice.kind, "ok");
  const after = await rawStores(s.stateDir);
  assert.equal(after.jobs, before.jobs);
  assert.equal(after.sessions, before.sessions);
  assert.equal(after.pendings, before.pendings);
  const queued = await createFileCommandQueue(s.stateDir).pending();
  assert.equal(queued.commands.length, 1);
  assert.equal(queued.commands[0]?.type, "reply");
  assert.equal(queued.commands[0]?.job, keyOf("2"));
  assert.equal(queued.commands[0]?.message, "texto da resposta");
  await cleanup(s);
});

test("a fila preserva a ordem dos comandos enfileirados", async () => {
  const s = await scenario();
  const queue = createFileCommandQueue(s.stateDir);
  await applyOperatorAction("responder", workOf(s, "2"), s.view, queue, "pessoal", "primeira");
  await applyOperatorAction("liberar", workOf(s, "3"), s.view, queue, "pessoal");
  const queued = await queue.pending();
  assert.deepEqual(queued.commands.map((command) => command.type), ["reply", "release"]);
  const reply = queued.commands[0];
  assert.ok(reply !== undefined && reply.type === "reply");
  assert.equal(reply.job, keyOf("2"));
  assert.equal(reply.message, "primeira");
  const release = queued.commands[1];
  assert.ok(release !== undefined && release.type === "release");
  assert.equal(release.job, keyOf("3"));
  await cleanup(s);
});

test("resposta vazia é recusada e nada entra na fila", async () => {
  const s = await scenario();
  const notice = await applyOperatorAction("responder", workOf(s, "2"), s.view, createFileCommandQueue(s.stateDir), "pessoal", "   ");
  assert.deepEqual(notice, { kind: "recusa", text: "resposta vazia" });
  const queued = await createFileCommandQueue(s.stateDir).pending();
  assert.deepEqual(queued.commands, []);
  await cleanup(s);
});
