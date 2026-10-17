import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOperatorView, nextStepHint, type EstadoVivo, type Fluxo, type OperatorView, type OperatorWork } from "../src/core/operator-view.js";
import type { InstanceConfig } from "../src/config/types.js";
import { encodeRefPart, newJob, transitionJob } from "../src/core/job.js";
import { assistExitRecordPath } from "../src/runtime/assist-exec.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { AttentionKeeper, digestOf, helpPending, pendingId, sessionOpenPending } from "../src/core/attention.js";
import { refKey, type IssueRef, type TrackerPort } from "../src/tracker/port.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";

// O modelo de leitura do operador (issue #61, spec #60): builder de leitura sem renderização,
// derivando o estado vivo do que o núcleo já registrou, sem recomputar admissão nem elegibilidade
// e seguindo a semântica de vaga do núcleo. Os testes semeiam stores reais em diretório temporário
// e afirmam comportamento do builder (estados vivos, medidores, ordem, rodapé); nada de escrita.

const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });

const jobOf = (id: string): ReturnType<typeof newJob> => newJob({ ref: refOf(id), repository: "acme/app" });

const sessionOf = (id: string, state: AssistSession["state"], over: Partial<AssistSession> = {}): AssistSession => ({
  key: refKey(refOf(id)), ref: refOf(id), repository: "acme/app", state,
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

interface Fixture {
  root: string;
  stateDir: string;
  saveJob: (job: ReturnType<typeof newJob>) => Promise<void>;
  saveSession: (session: AssistSession) => Promise<void>;
  savePending: (pending: Parameters<ReturnType<typeof createFileAttentionStore>["save"]>[0]) => Promise<void>;
  enqueue: (command: Parameters<ReturnType<typeof createFileCommandQueue>["enqueue"]>[0]) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  readRaw: () => Promise<{ jobs: string; sessions: string; pendings: string; commands: string; control: string }>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "msf-operator-view-"));
  const stateDir = join(root, "state");
  const sessionsDir = join(stateDir, "assist-sessions");
  const pendingsDir = join(stateDir, "pendencias");
  const saveJob = async (job: ReturnType<typeof newJob>): Promise<void> => { await createFileJobStore(stateDir).save(job); };
  const saveSession = async (session: AssistSession): Promise<void> => { await createFileAssistSessionStore(sessionsDir).save(session); };
  const savePending = async (pending: Parameters<ReturnType<typeof createFileAttentionStore>["save"]>[0]): Promise<void> => {
    await createFileAttentionStore(pendingsDir).save(pending);
  };
  const enqueue = async (command: Parameters<ReturnType<typeof createFileCommandQueue>["enqueue"]>[0]): Promise<void> => {
    await createFileCommandQueue(stateDir).enqueue(command);
  };
  const setPaused = async (paused: boolean): Promise<void> => { await createFileInstanceControl(stateDir).setPaused(paused); };
  const readRaw = async () => ({
    jobs: JSON.stringify(await Promise.all((await readdir(stateDir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => readFile(join(stateDir, name), "utf8")))),
    sessions: JSON.stringify(await Promise.all((await readdir(sessionsDir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => readFile(join(sessionsDir, name), "utf8")))),
    pendings: JSON.stringify(await Promise.all((await readdir(pendingsDir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => readFile(join(pendingsDir, name), "utf8")))),
    commands: JSON.stringify(await (async () => {
      const dir = join(stateDir, "commands");
      return Promise.all((await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => readFile(join(dir, name), "utf8")));
    })()),
    control: await readFile(join(stateDir, "control", "state.json"), "utf8").catch(() => ""),
  });
  return { root, stateDir, saveJob, saveSession, savePending, enqueue, setPaused, readRaw };
}

async function viewFor(fx: Fixture, options: { tracker?: TrackerPort; pausePending?: { type: "pause" } } = {}): Promise<OperatorView> {
  if (options.pausePending !== undefined) await fx.enqueue(options.pausePending);
  return buildOperatorView({ stateDir: fx.stateDir, instance, ...(options.tracker === undefined ? {} : { tracker: options.tracker }) });
}

const statesOf = (view: OperatorView): string[] => view.works.map((work) => work.estadoVivo);

// ── estados vivos de trabalhos autônomos ──────────────────────────────────────────────────────

test("job em execução é em-invocacao", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  const view = await viewFor(fx);
  assert.deepEqual(statesOf(view), ["em-invocacao"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("job aguardando ajuda é pedido-de-ajuda", async () => {
  const fx = await fixture();
  await fx.saveJob(transitionJob(jobOf("1"), "waiting-for-help", { message: "m", question: "qual formato?" }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["pedido-de-ajuda"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("job interrompido e intervention-required são interrompido", async () => {
  const fx = await fixture();
  await fx.saveJob(transitionJob(jobOf("1"), "interrupted", { message: "m", reason: "pane" }));
  await fx.saveJob(transitionJob(jobOf("2"), "intervention-required", { message: "m", reason: "runner falhou" }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["interrompido", "interrompido"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("job com pendência de resume é retomada-autorizada e vence o interrompido", async () => {
  const fx = await fixture();
  const interrupted = transitionJob(jobOf("1"), "interrupted", { message: "m", reason: "pane" });
  await fx.saveJob({ ...interrupted, pending: "resume" });
  assert.deepEqual(statesOf(await viewFor(fx)), ["retomada-autorizada"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("job com pendência de correction é fila", async () => {
  const fx = await fixture();
  const stopped = transitionJob(jobOf("1"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } });
  await fx.saveJob({ ...stopped, pending: "correction" });
  assert.deepEqual(statesOf(await viewFor(fx)), ["fila"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("job aguardando PR é espera-externa: derivação além dos 7 estados, fora da vaga", async () => {
  const fx = await fixture();
  await fx.saveJob(transitionJob(jobOf("1"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } }));
  const view = await viewFor(fx);
  assert.deepEqual(statesOf(view), ["espera-externa"]);
  assert.equal(view.works[0]?.ocupaVaga, false);
  await rm(fx.root, { recursive: true, force: true });
});

test("jobs done e released não aparecem na lista de trabalhos", async () => {
  const fx = await fixture();
  const done = transitionJob(jobOf("1"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } });
  await fx.saveJob(transitionJob(done, "done", { message: "m" }));
  const interrupted = transitionJob(jobOf("2"), "interrupted", { message: "m", reason: "r" });
  await fx.saveJob(transitionJob(interrupted, "released", { message: "m" }));
  assert.deepEqual(statesOf(await viewFor(fx)), []);
  await rm(fx.root, { recursive: true, force: true });
});

// ── estados vivos de atendimentos assistidos ──────────────────────────────────────────────────

test("sessão opening e open são sessao-aberta", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "opening"));
  await fx.saveSession(sessionOf("2", "open"));
  assert.deepEqual(statesOf(await viewFor(fx)), ["sessao-aberta", "sessao-aberta"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão pending sem retomada é interrompido", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "pending", { reason: "execução sem resultado" }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["interrompido"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão pending com retomada não consumida é retomada-autorizada", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "pending", {
    reason: "execução sem resultado",
    scheduledResume: { at: "2026-10-14T12:05:00.000Z", command: "c1", answer: "sim" },
  }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["retomada-autorizada"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão pending com retomada consumida volta a interrompido", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "pending", {
    reason: "execução sem resultado",
    scheduledResume: { at: "2026-10-14T12:05:00.000Z", command: "c1", answer: "sim", consumed: { at: "2026-10-14T12:06:00.000Z", attempt: "a1" } },
  }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["interrompido"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão proposed é aguardando-aprovacao: derivação além dos 7 estados", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "proposed", { result: { summary: "triagem feita" } as never }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["aguardando-aprovacao"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão concluding é atendimento-concluido", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "concluding", { approval: { at: "2026-10-14T12:05:00.000Z", command: "c1" } }));
  assert.deepEqual(statesOf(await viewFor(fx)), ["atendimento-concluido"]);
  await rm(fx.root, { recursive: true, force: true });
});

// ── #77 — o registro de fim de execução por sessão assistida ──────────────────────────────────
// A pré-checagem da TUI precisa aceitar a retomada mesmo quando o estado GRAVADO ainda diz
// sessão aberta: o canal de fim (`msf-exit.json` no diretório de estado da execução) é lido
// pelo mesmo dono de fs do fluxo e exposto por sessão em três valores — presente, ausente,
// ilegível. A leitura só é significativa em opening/open (os únicos estados com execução
// viva); o builder continua puro leitor.

// O diretório de estado da execução de uma sessão, como o fluxo o grava.
const execStateDirOf = (stateDir: string, key: string): string => join(stateDir, "assist", encodeRefPart(key), "state");

// Semeia o canal de fim com o texto dado (registro real ou lixo, para o veredito ilegível).
const seedExitRecord = async (stateDir: string, key: string, text: string): Promise<void> => {
  const execStateDir = execStateDirOf(stateDir, key);
  await mkdir(execStateDir, { recursive: true });
  await writeFile(assistExitRecordPath(execStateDir), text);
};

test("sessão aberta com o registro de fim no canal expõe registroDeFim presente", async () => {
  const fx = await fixture();
  const session = sessionOf("1", "open", { execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("1"))) });
  await fx.saveSession(session);
  await seedExitRecord(fx.stateDir, session.key, '{"exitCode":130,"at":"2026-10-14T12:05:00.000Z"}');
  const view = await viewFor(fx);
  assert.equal(view.works[0]?.estadoVivo, "sessao-aberta");
  assert.equal(view.works[0]?.registroDeFim, "presente");
  await rm(fx.root, { recursive: true, force: true });
});

test("sessão aberta sem registro no canal (ou sem diretório registrado) expõe registroDeFim ausente", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "open", { execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("1"))) }));
  await fx.saveSession(sessionOf("2", "opening"));
  const view = await viewFor(fx);
  assert.deepEqual(view.works.map((work) => work.registroDeFim), ["ausente", "ausente"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("registro de fim ilegível é ilegível, nunca ausente nem terminado", async () => {
  const fx = await fixture();
  const session = sessionOf("1", "open", { execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("1"))) });
  await fx.saveSession(session);
  await seedExitRecord(fx.stateDir, session.key, "não é json");
  const view = await viewFor(fx);
  assert.equal(view.works[0]?.registroDeFim, "ilegível");
  await rm(fx.root, { recursive: true, force: true });
});

test("o registro de fim só é lido em opening/open: nos demais estados é ausente", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "pending", { execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("1"))) }));
  await fx.saveSession(sessionOf("2", "proposed", { result: { summary: "s" } as never, execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("2"))) }));
  await fx.saveSession(sessionOf("3", "concluding", { approval: { at: "t", command: "c" }, execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("3"))) }));
  for (const session of ["1", "2", "3"]) {
    await seedExitRecord(fx.stateDir, refKey(refOf(session)), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  }
  await fx.saveJob(jobOf("4"));
  const view = await viewFor(fx);
  assert.deepEqual(view.works.map((work) => work.registroDeFim), ["ausente", "ausente", "ausente", "ausente"]);
  await rm(fx.root, { recursive: true, force: true });
});

test("ler o registro de fim não escreve em store nenhum", async () => {
  const fx = await fixture();
  const session = sessionOf("1", "open", { execStateDir: execStateDirOf(fx.stateDir, refKey(refOf("1"))) });
  await fx.saveSession(session);
  await seedExitRecord(fx.stateDir, session.key, '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  const before = await fx.readRaw();
  assert.equal((await viewFor(fx)).works[0]?.registroDeFim, "presente");
  const after = await fx.readRaw();
  assert.deepEqual(after, before);
  await rm(fx.root, { recursive: true, force: true });
});

// ── medidores pela semântica de vaga do núcleo ────────────────────────────────────────────────

test("dois jobs em execução ocupam 2 de 2 vagas de implementação", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  await fx.saveJob(jobOf("2"));
  const view = await viewFor(fx);
  assert.deepEqual(view.meters.implementation, { used: 2, limit: 2 });
  await rm(fx.root, { recursive: true, force: true });
});

test("pedido de ajuda, interrupção e espera externa não ocupam vaga de implementação", async () => {
  const fx = await fixture();
  await fx.saveJob(transitionJob(jobOf("1"), "waiting-for-help", { message: "m", question: "q" }));
  await fx.saveJob(transitionJob(jobOf("2"), "interrupted", { message: "m", reason: "r" }));
  await fx.saveJob(transitionJob(jobOf("3"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } }));
  const view = await viewFor(fx);
  assert.deepEqual(view.meters.implementation, { used: 0, limit: 2 });
  await rm(fx.root, { recursive: true, force: true });
});

test("sessões abertas e opening contam no medidor de assistidas, inclusive aguardando o humano", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "open"));
  await fx.saveSession(sessionOf("2", "opening"));
  const view = await viewFor(fx);
  assert.deepEqual(view.meters.assisted, { used: 2, limit: 3 });
  await rm(fx.root, { recursive: true, force: true });
});

test("sessões pending, proposed e concluding não contam no medidor de assistidas", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "pending"));
  await fx.saveSession(sessionOf("2", "proposed", { result: { summary: "s" } as never }));
  await fx.saveSession(sessionOf("3", "concluding", { approval: { at: "t", command: "c" } }));
  const view = await viewFor(fx);
  assert.deepEqual(view.meters.assisted, { used: 0, limit: 3 });
  await rm(fx.root, { recursive: true, force: true });
});

test("maxAssisted ausente é medidor sem limite: nenhuma sessão é aberta, mas a leitura não inventa número", async () => {
  const fx = await fixture();
  await fx.saveSession(sessionOf("1", "open"));
  const view = await buildOperatorView({
    stateDir: fx.stateDir,
    instance: { ...instance, maxAssisted: undefined },
  });
  assert.deepEqual(view.meters.assisted, { used: 1, limit: null });
  await rm(fx.root, { recursive: true, force: true });
});

// ── fluxo, referência e ordem de exibição ─────────────────────────────────────────────────────

test("cada trabalho carrega fluxo, repositório e referência curta", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  await fx.saveSession(sessionOf("2", "open"));
  const view = await viewFor(fx);
  const autonomous = view.works.find((work) => work.fluxo === "implementacao-autonoma");
  const assisted = view.works.find((work) => work.fluxo === "humano-assistido");
  assert.equal(autonomous?.issueRef, "acme/app#1");
  assert.equal(autonomous?.repository, "acme/app");
  assert.equal(assisted?.issueRef, refKey(refOf("2")));
  await rm(fx.root, { recursive: true, force: true });
});

test("a ordem de exibição segue a prioridade do protótipo: retomada-autorizada primeiro, fila por último, empate por id", async () => {
  const fx = await fixture();
  // ids escolhidos para provar o desempate por id crescente dentro do mesmo peso.
  await fx.saveJob(transitionJob(jobOf("4"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } })); // peso 1
  await fx.saveJob(jobOf("2")); // em-invocacao, peso 2
  await fx.saveJob(jobOf("1")); // em-invocacao, peso 2
  await fx.saveSession(sessionOf("3", "open")); // sessao-aberta, peso 1
  const pending = transitionJob(jobOf("5"), "interrupted", { message: "m", reason: "r" });
  await fx.saveJob({ ...pending, pending: "resume" }); // retomada-autorizada, peso 0
  const view = await viewFor(fx);
  assert.deepEqual(view.works.map((work) => work.key), [
    "memory:acme/app#5", // retomada-autorizada (0)
    "memory:acme/app#3", "memory:acme/app#4", // peso 1, id crescente
    "memory:acme/app#1", "memory:acme/app#2", // peso 2, id crescente
  ]);
  await rm(fx.root, { recursive: true, force: true });
});

// ── status da issue pelo port de tracker injetado ─────────────────────────────────────────────

const trackerWith = (issues: Array<Record<string, unknown>>): TrackerPort => {
  const tracker = loadMemoryTracker({ issues } as never);
  return tracker;
};

test("tracker injetado: o status da issue passa para o trabalho", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("8"));
  const view = await viewFor(fx, { tracker: trackerWith([{ project: "acme/app", id: "8", title: "t", labels: [], assignees: [], claimed: false, statusCategory: "in-progress", priority: null, blockers: [] }]) });
  assert.equal(view.works[0]?.issue.status, "in-progress");
  await rm(fx.root, { recursive: true, force: true });
});

test("tracker ausente: o status da issue é indisponível", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  const view = await viewFor(fx);
  assert.equal(view.works[0]?.issue.status, "indisponível");
  await rm(fx.root, { recursive: true, force: true });
});

test("tracker que falha: o status da issue é indisponível, nunca uma exceção", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  const tracker = trackerWith([{ project: "acme/app", id: "1", title: "t", labels: [], assignees: [], claimed: false, statusCategory: "to-do", priority: null, blockers: [] }]) as TrackerPort & { failNext: (operation: "readIssue", scenario: "releitura-falha") => void };
  tracker.failNext("readIssue", "releitura-falha");
  const view = await viewFor(fx, { tracker });
  assert.equal(view.works[0]?.issue.status, "indisponível");
  await rm(fx.root, { recursive: true, force: true });
});

// ── rodapé: contagens e estado da instância ───────────────────────────────────────────────────

test("o rodapé conta concluídos, liberados, pendências, comandos pendentes e pausa", async () => {
  const fx = await fixture();
  const done = transitionJob(jobOf("1"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } });
  await fx.saveJob(transitionJob(done, "done", { message: "m" }));
  const released = transitionJob(jobOf("2"), "interrupted", { message: "m", reason: "r" });
  await fx.saveJob(transitionJob(released, "released", { message: "m" }));
  await fx.saveJob(jobOf("3"));
  await fx.savePending(helpPending({ key: refKey(refOf("3")), ref: refOf("3"), repository: "acme/app", question: "q?" }, "2026-10-14T12:00:00.000Z"));
  await fx.enqueue({ type: "resume", job: refKey(refOf("3")) });
  const view = await viewFor(fx, { pausePending: { type: "pause" } });
  assert.equal(view.footer.jobsDone, 1);
  assert.equal(view.footer.jobsReleased, 1);
  assert.equal(view.footer.pendings, 1);
  assert.equal(view.footer.pendingCommands, 2); // resume + pause
  assert.deepEqual(view.footer.pause, { paused: true, pending: true });
  await rm(fx.root, { recursive: true, force: true });
});

test("pausa sem comando na fila é pausada sem pendência; instância ativa não é pausada", async () => {
  const fx = await fixture();
  await fx.setPaused(true);
  const paused = await viewFor(fx);
  assert.deepEqual(paused.footer.pause, { paused: true, pending: false });
  await fx.setPaused(false);
  const active = await viewFor(fx);
  assert.deepEqual(active.footer.pause, { paused: false, pending: false });
  await rm(fx.root, { recursive: true, force: true });
});

// ── pontos de atenção: tipos presentes, sem exibição nesta etapa ──────────────────────────────

test("as pendências carregadas acompanham o modelo de leitura", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("3"));
  await fx.savePending(helpPending({ key: refKey(refOf("3")), ref: refOf("3"), repository: "acme/app", question: "q?" }, "2026-10-14T12:00:00.000Z"));
  const view = await viewFor(fx);
  assert.equal(view.pendings.length, 1);
  assert.equal(view.pendings[0]?.id, pendingId("ajuda", refKey(refOf("3")), digestOf(["ajuda", "q?", undefined])));
  await rm(fx.root, { recursive: true, force: true });
});

test("a sessão aberta levanta pendência de abertura; o modelo a carrega", async () => {
  const fx = await fixture();
  const session = sessionOf("2", "open");
  await fx.saveSession(session);
  await fx.savePending(sessionOpenPending(session, "2026-10-14T12:00:00.000Z"));
  const view = await viewFor(fx);
  assert.equal(view.pendings.length, 1);
  assert.equal(view.pendings[0]?.kind, "abertura");
  await rm(fx.root, { recursive: true, force: true });
});

// ── o builder não escreve nada ────────────────────────────────────────────────────────────────

test("o builder é puro leitor: reler todos os stores depois do build dá exatamente o mesmo conteúdo", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("1"));
  await fx.saveSession(sessionOf("2", "open"));
  await fx.savePending(helpPending({ key: refKey(refOf("1")), ref: refOf("1"), repository: "acme/app" }, "2026-10-14T12:00:00.000Z"));
  await fx.enqueue({ type: "resume", job: refKey(refOf("1")) });
  await fx.setPaused(true);
  const before = await fx.readRaw();
  await viewFor(fx, { tracker: trackerWith([{ project: "acme/app", id: "1", title: "t", labels: [], assignees: [], claimed: false, statusCategory: "to-do", priority: null, blockers: [] }]) });
  const after = await fx.readRaw();
  assert.deepEqual(after, before);
  await rm(fx.root, { recursive: true, force: true });
});

// ── #62 — idade do ponto de atenção (derivada de `at` versus agora injetado) ─────────────────

const FIX_AT = "2026-01-20T12:00:00.000Z"; // instante fixo das sementes de idade
const nowPlus = (minutes: number): Date => new Date(new Date(FIX_AT).getTime() + minutes * 60_000);

async function viewWithAgedPending(fx: Fixture, waitingMinutes: number): Promise<OperatorView> {
  await fx.savePending(helpPending(
    { key: refKey(refOf("3")), ref: refOf("3"), repository: "acme/app", question: "q?" },
    FIX_AT,
  ));
  return buildOperatorView({ stateDir: fx.stateDir, instance, now: () => nowPlus(waitingMinutes) });
}

const idadeOf = (view: OperatorView): string | undefined => view.pendings[0]?.idade;

test("pendência aberta há menos de um minuto é 'há segundos'", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, 0.4);
  assert.equal(idadeOf(view), "há segundos");
  await rm(fx.root, { recursive: true, force: true });
});

test("pendência aberta há 3 minutos é 'há 3 min'", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, 3);
  assert.equal(idadeOf(view), "há 3 min");
  await rm(fx.root, { recursive: true, force: true });
});

test("pendência aberta há 1 hora é 'há 1h'", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, 60);
  assert.equal(idadeOf(view), "há 1h");
  await rm(fx.root, { recursive: true, force: true });
});


test("pendência aberta há 2 horas e meia é 'há 2h'", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, 150);
  assert.equal(idadeOf(view), "há 2h");
  await rm(fx.root, { recursive: true, force: true });
});

test("pendência aberta há 3 dias é 'há 3 dias'", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, 3 * 24 * 60);
  assert.equal(idadeOf(view), "há 3 dias");
  await rm(fx.root, { recursive: true, force: true });
});

test("agora anterior a `at` não produz idade negativa", async () => {
  const fx = await fixture();
  const view = await viewWithAgedPending(fx, -5);
  assert.equal(idadeOf(view), "há segundos");
  await rm(fx.root, { recursive: true, force: true });
});

// ── #62 — a fila de pendências nunca é alterada pela notificação ─────────────────────────────

test("falha de entrega de notificação não remove nem esconde a pendência", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("3"));
  const failed = { ...helpPending({ key: refKey(refOf("3")), ref: refOf("3"), repository: "acme/app", question: "q?" }, FIX_AT),
    notification: { at: FIX_AT, channel: "tentado", ok: false, error: "comando de notificação falhou" } };
  const noChannel = { ...helpPending({ key: refKey(refOf("4")), ref: refOf("4"), repository: "acme/app", question: "q2?" }, FIX_AT),
    notification: { at: FIX_AT, channel: "nenhum", ok: false, error: "canal de notificação ausente ou desabilitado" } };
  await fx.savePending(failed);
  await fx.savePending(noChannel);
  const view = await viewFor(fx);
  assert.equal(view.pendings.length, 2);
  assert.deepEqual(view.pendings.map((pending) => pending.notification?.ok), [false, false]);
  await rm(fx.root, { recursive: true, force: true });
});

// ── #62 — o ponto se encerra quando o agente retoma (caminho real: AttentionKeeper.resolve) ──

test("agente retoma e o ponto se encerra: resolve(key) remove a pendência e a leitura reflete a ausência", async () => {
  const fx = await fixture();
  await fx.saveJob(jobOf("3"));
  const store = createFileAttentionStore(join(fx.stateDir, "pendencias"));
  const keeper = new AttentionKeeper({ store });
  await keeper.raise(helpPending(
    { key: refKey(refOf("3")), ref: refOf("3"), repository: "acme/app", question: "q?" }, FIX_AT));
  const before = await buildOperatorView({ stateDir: fx.stateDir, instance });
  assert.equal(before.pendings.length, 1);
  await keeper.resolve(refKey(refOf("3")));
  const after = await buildOperatorView({ stateDir: fx.stateDir, instance });
  assert.equal(after.pendings.length, 0);
  assert.equal(after.footer.pendings, 0);
  await rm(fx.root, { recursive: true, force: true });
});

// ── #62 — dica do próximo passo por estado vivo × fluxo (pura, sem store nem renderização) ───

const trabalho = (estadoVivo: EstadoVivo, fluxo: Fluxo = "implementacao-autonoma"): OperatorWork => ({
  key: refKey(refOf("3")), repository: "acme/app", fluxo, estadoVivo, registroDeFim: "ausente",
  issueRef: "acme/app#3", ref: refOf("3"), ocupaVaga: false, issue: { status: "in-progress" },
});

const COMANDO_REPLY = "./msf minha reply '#3' --message '<resposta>'";
const COMANDO_RESUME = "./msf minha resume '#3'";
const COMANDO_APPROVE = "./msf minha approve 'memory:acme/app#3'";

test("pedido-de-ajuda: a resposta vai pelo reply do orquestrador e o ponto só termina na retomada do agente", () => {
  const hint = nextStepHint(trabalho("pedido-de-ajuda"), { reply: COMANDO_REPLY });
  assert.match(hint, /reply do orquestrador/);
  assert.ok(hint.includes(COMANDO_REPLY));
  assert.match(hint, /o ponto de atenção só termina quando o agente retomar o trabalho/);
});

test("pedido-de-ajuda sem comando passado ainda nomeia o reply como caminho da resposta", () => {
  const hint = nextStepHint(trabalho("pedido-de-ajuda"), {});
  assert.match(hint, /comando de reply do orquestrador/);
  assert.match(hint, /quando o agente retomar/);
});

test("interrompido: autorize retomada (resume) ou libere (release), com o comando de resume quando passado", () => {
  const hint = nextStepHint(trabalho("interrompido"), { resume: COMANDO_RESUME });
  assert.match(hint, /autorize a retomada/);
  assert.ok(hint.includes(COMANDO_RESUME));
  assert.match(hint, /libere o trabalho \(release\)/);
});

test("interrompido sem comando passado nomeia resume e release por palavra", () => {
  const hint = nextStepHint(trabalho("interrompido"), {});
  assert.match(hint, /resume/);
  assert.match(hint, /release/);
});

test("retomada-autorizada autônoma: continuidade única, primeiro da fila, consumida na próxima invocação", () => {
  const hint = nextStepHint(trabalho("retomada-autorizada", "implementacao-autonoma"), {});
  assert.match(hint, /continuidade única/);
  assert.match(hint, /primeiro da fila/);
  assert.match(hint, /se consome na próxima invocação/);
});

test("retomada-autorizada assistida: continuidade única consumida ao reabrir a sessão", () => {
  const hint = nextStepHint(trabalho("retomada-autorizada", "humano-assistido"), {});
  assert.match(hint, /continuidade única/);
  assert.match(hint, /se consome ao reabrir a sessão/);
});

test("aguardando-aprovacao: aprove quando o resultado for aceitável, com o comando de approve quando passado", () => {
  const hint = nextStepHint(trabalho("aguardando-aprovacao", "humano-assistido"), { approve: COMANDO_APPROVE });
  assert.match(hint, /aprove quando ele for aceitável/);
  assert.ok(hint.includes(COMANDO_APPROVE));
});

test("atendimento-concluido: fim do acompanhamento e a issue permanece aberta", () => {
  const hint = nextStepHint(trabalho("atendimento-concluido", "humano-assistido"), {});
  assert.match(hint, /fim do acompanhamento/);
  assert.match(hint, /a issue permanece aberta/);
});

test("sessao-aberta: você conduz pelo Herdr, aprove para concluir e a issue não fecha", () => {
  const hint = nextStepHint(trabalho("sessao-aberta", "humano-assistido"), { approve: COMANDO_APPROVE });
  assert.match(hint, /pelo Herdr/);
  assert.match(hint, /a issue não fecha/);
  assert.ok(hint.includes(COMANDO_APPROVE));
});

test("em-invocacao: executando agora, nada exige você", () => {
  const hint = nextStepHint(trabalho("em-invocacao"), {});
  assert.match(hint, /executando agora/);
  assert.match(hint, /nada exige você/);
});

test("espera-externa: aguardando CI/revisão e sem vaga ocupada", () => {
  const hint = nextStepHint(trabalho("espera-externa"), {});
  assert.match(hint, /CI\/revisão/);
  assert.match(hint, /não ocupa vaga/);
});

test("fila: aguardando capacidade para continuação", () => {
  const hint = nextStepHint(trabalho("fila"), {});
  assert.match(hint, /aguardando capacidade para continuação/);
});
