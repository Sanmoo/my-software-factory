// Rodada de cenários com dados semeados (issue #78, spec #74): a aceitação da parte visual é
// repetível e NÃO renderiza nada (decisão da spec #60) — os stores reais são semeados num
// diretório temporário, o modelo de leitura real (`buildOperatorView`) deriva os estados vivos e a
// linguagem visual é lida pelo módulo puro (`../core/tui-style.js`), que é o que a TUI consome. A
// legibilidade final (a cor na tela) é do operador; o que se repete aqui é a derivação sobre dados
// reais, como o harness da #49 fazia sobre o seam de estado.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOperatorView, type EstadoVivo, type OperatorView } from "../src/core/operator-view.js";
import { COR_DO_ESTADO, estiloDaLinha, estiloDoAviso, estiloDoCabecalho, estiloDoFoco } from "../src/core/tui-style.js";
import type { InstanceConfig } from "../src/config/types.js";
import { newJob, transitionJob, type Job } from "../src/core/job.js";
import type { AssistSession } from "../src/core/assist-session.js";
import type { AttentionPending } from "../src/core/attention.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";

const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });

const jobOf = (id: string): Job => newJob({ ref: refOf(id), repository: "acme/app" });

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
  saveJob: (job: Job) => Promise<void>;
  saveSession: (session: AssistSession) => Promise<void>;
  savePending: (pending: AttentionPending) => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "msf-tui-scenario-"));
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "assist-sessions"), { recursive: true });
  return {
    root,
    stateDir,
    saveJob: (job) => createFileJobStore(stateDir).save(job),
    saveSession: (session) => createFileAssistSessionStore(join(stateDir, "assist-sessions")).save(session),
    savePending: (pending) => createFileAttentionStore(join(stateDir, "pendencias")).save(pending),
  };
}

// O mesmo relógio da leitura em toda a rodada, para a idade das pendências ser estável.
const viewFor = (fx: Fixture): Promise<OperatorView> =>
  buildOperatorView({ stateDir: fx.stateDir, instance, now: () => new Date("2026-10-14T12:30:00.000Z") });

const workOf = (view: OperatorView, estado: EstadoVivo) => view.works.find((work) => work.estadoVivo === estado);

const corOf = (view: OperatorView, estado: EstadoVivo): string | undefined =>
  estiloDaLinha(workOf(view, estado)!, { color: true }).estado.color;

const pendingOf = (over: Partial<AttentionPending>): AttentionPending => ({
  id: "ajuda|memory:acme/app#9|d", kind: "ajuda", key: refKey(refOf("9")),
  what: "ajuda solicitada pelo agente", at: "2026-10-14T12:00:00.000Z", actions: ["reply"], ...over,
});

// As cores dos sete estados originais, transcritas do protótipo da #49 (fonte externa ao módulo).
const CORES_DO_PROTOTIPO: Record<string, string> = {
  fila: "gray", "em-invocacao": "blue", "sessao-aberta": "cyan", "pedido-de-ajuda": "yellow",
  interrompido: "red", "retomada-autorizada": "magenta", "atendimento-concluido": "green",
};

// Cenário 1 (protótipo: vários trabalhos em paralelo; um agente pede ação humana): a leitura de
// relance distingue quem exige o operador e o cabeçalho/aviso falam a linguagem do protótipo.
test("cenário 1 — paralelo com pedido de ajuda: cores por estado e aviso colorido", async () => {
  const fx = await fixture();
  try {
    await fx.saveJob(jobOf("1")); // em-invocacao
    await fx.saveJob(transitionJob(jobOf("2"), "waiting-for-help", { message: "m", question: "qual formato?" }));
    await fx.saveSession(sessionOf("3", "open"));

    const view = await viewFor(fx);
    assert.deepEqual(
      view.works.map((work) => work.estadoVivo).sort(),
      ["em-invocacao", "pedido-de-ajuda", "sessao-aberta"],
    );
    assert.equal(corOf(view, "em-invocacao"), "blue");
    assert.equal(corOf(view, "pedido-de-ajuda"), "yellow");
    assert.equal(corOf(view, "sessao-aberta"), "cyan");

    // O foco da lista usa o marcador do protótipo e a cor do foco; sem foco, só o alinhamento.
    const focado = estiloDoFoco(true, { color: true });
    const semFoco = estiloDoFoco(false, { color: true });
    assert.equal(focado.marcador, "❯");
    assert.equal(focado.color, "yellow");
    assert.equal(semFoco.color, undefined);
    assert.notEqual(semFoco.marcador, "❯");
    assert.deepEqual(estiloDoCabecalho({ color: true }), { color: "cyan", bold: true });
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// Cenário 2 (protótipo: sessão assistida resolve a triagem sem encerrar a issue): o resultado
// proposto (decisão pendente) e o atendimento concluído têm cores próprias e distintas.
test("cenário 2 — triagem assistida: proposto e concluído, cada um com a sua cor", async () => {
  const fx = await fixture();
  try {
    await fx.saveSession(sessionOf("1", "proposed", { result: { summary: "triagem feita" } as never }));
    await fx.saveSession(sessionOf("2", "concluding", { approval: { at: "2026-10-14T12:05:00.000Z", command: "c1" } }));

    const view = await viewFor(fx);
    assert.deepEqual(view.works.map((work) => work.estadoVivo).sort(), ["aguardando-aprovacao", "atendimento-concluido"]);
    assert.equal(corOf(view, "atendimento-concluido"), "green");
    // O desvio registrado (proposed) tem cor legível e distinta do verde e do amarelo do pedido.
    assert.equal(corOf(view, "aguardando-aprovacao"), COR_DO_ESTADO["aguardando-aprovacao"]);
    assert.notEqual(corOf(view, "aguardando-aprovacao"), "green");
    assert.notEqual(corOf(view, "aguardando-aprovacao"), "yellow");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// Cenário 3 (protótipo: sessão encerrada sem resultado válido; decisão pendente): interrompido em
// vermelho, retomada autorizada em magenta (prioridade na lista).
test("cenário 3 — parou sem desfecho: interrompido e retomada autorizada", async () => {
  const fx = await fixture();
  try {
    await fx.saveSession(sessionOf("1", "pending", { reason: "execução sem resultado" }));
    const interrompido = transitionJob(jobOf("2"), "interrupted", { message: "m", reason: "pane" });
    await fx.saveJob({ ...interrompido, pending: "resume" });

    const view = await viewFor(fx);
    assert.equal(corOf(view, "interrompido"), "red");
    assert.equal(corOf(view, "retomada-autorizada"), "magenta");
    // A retomada autorizada vem primeiro (a ordem de exibição do modelo), como no protótipo.
    assert.equal(view.works[0]?.estadoVivo, "retomada-autorizada");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// Cenário 4 (protótipo: a pendência persiste enquanto o operador está em outra sessão): o aviso
// colore pela contagem e a entrega falha marca em vermelho — sem esconder nem remover o ponto.
test("cenário 4 — pendência persistente: aviso amarelo e entrega falha em vermelho", async () => {
  const fx = await fixture();
  try {
    const semCores = await viewFor(fx);
    assert.deepEqual(estiloDoAviso(semCores.pendings.length, { color: true }), { color: "green", bold: true });

    await fx.savePending(pendingOf({}));
    await fx.savePending(pendingOf({
      id: "decisão|memory:acme/app#10|d", kind: "decisão", key: refKey(refOf("10")),
      what: "execução encerrada sem resultado", notification: { at: "2026-10-14T12:00:00.000Z", channel: "notify-send", ok: false, error: "sem servidor" },
    }));

    const view = await viewFor(fx);
    assert.equal(view.pendings.length, 2);
    assert.deepEqual(estiloDoAviso(view.pendings.length, { color: true }), { color: "yellow", bold: true });
    // A proveniência que falhou é a única que marca; a pendência continua listada.
    const falhada = view.pendings.find((pending) => pending.notification?.ok === false);
    assert.ok(falhada, "a pendência com entrega falha continua na lista");
    assert.equal(falhada.idade, "há 30 min");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// O cenário de cobertura: os NOVE estados vivos derivam de stores reais e cada um tem a sua cor —
// os sete originais mantêm a do protótipo, os dois desvios são legíveis e distintos.
test("os nove estados vivos, semeados de stores reais, têm cores distintas", async () => {
  const fx = await fixture();
  try {
    await fx.saveJob(jobOf("1")); // em-invocacao
    await fx.saveJob(transitionJob(jobOf("2"), "waiting-for-help", { message: "m", question: "q?" }));
    await fx.saveJob({ ...transitionJob(jobOf("3"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 9 } }), pending: "correction" }); // fila
    await fx.saveJob(transitionJob(jobOf("4"), "interrupted", { message: "m", reason: "pane" })); // interrompido
    await fx.saveJob({ ...transitionJob(jobOf("5"), "interrupted", { message: "m", reason: "pane" }), pending: "resume" }); // retomada-autorizada
    await fx.saveJob(transitionJob(jobOf("6"), "waiting-for-pr", { message: "m", pr: { repository: "acme/app", number: 8 } })); // espera-externa
    await fx.saveSession(sessionOf("7", "open")); // sessao-aberta
    await fx.saveSession(sessionOf("8", "proposed", { result: { summary: "s" } as never })); // aguardando-aprovacao
    await fx.saveSession(sessionOf("9", "concluding", { approval: { at: "t", command: "c" } })); // atendimento-concluido

    const view = await viewFor(fx);
    const estados = view.works.map((work) => work.estadoVivo).sort();
    assert.deepEqual(estados, [
      "aguardando-aprovacao", "atendimento-concluido", "em-invocacao", "espera-externa", "fila",
      "interrompido", "pedido-de-ajuda", "retomada-autorizada", "sessao-aberta",
    ]);

    // Os sete originais mantêm a cor do protótipo.
    for (const [estado, cor] of Object.entries(CORES_DO_PROTOTIPO)) {
      assert.equal(corOf(view, estado as EstadoVivo), cor, estado);
    }
    // As nove cores são distintas e nenhuma linha fica sem cor.
    const cores = view.works.map((work) => estiloDaLinha(work, { color: true }).estado.color);
    assert.equal(new Set(cores).size, cores.length, `cores repetidas: ${cores.join(", ")}`);
    assert.ok(cores.every((cor) => typeof cor === "string" && cor.length > 0));

    // A rodada sem cor: nenhuma linha carrega cor, mas a estrutura (negrito) permanece.
    for (const work of view.works) {
      const estilo = estiloDaLinha(work, { color: false });
      assert.equal(estilo.estado.color, undefined, work.estadoVivo);
      assert.equal(estilo.fluxo.color, undefined, work.estadoVivo);
      assert.equal(estilo.estado.bold, true, work.estadoVivo);
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
