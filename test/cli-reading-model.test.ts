// Um modelo de leitura, duas faces de texto (issue #65): status e logs deixam de montar a
// própria visão de stores e consomem OperatorView. Estes testes provam a fonte dos dados: com a
// MESMA semente de stores, buildOperatorView dá a lista bruta completa de trabalhos
// (done/released inclusos), as sessões assistidas, as listas de arquivos ilegíveis por
// armazenamento e as falhas de observabilidade; e provam o corte (nenhuma fábrica de store
// dentro dos dois CLIs). Os outputs seguem byte-estáveis: os testes existentes ficam verdes
// sem uma única asserção tocada.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOperatorView } from "../src/core/operator-view.js";
import type { InstanceConfig } from "../src/config/types.js";
import { newJob, transitionJob, type Job } from "../src/core/job.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { createFileHistory } from "../src/state/history.js";

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
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "msf-cli-reading-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  return {
    root, stateDir,
    saveJob: (job) => createFileJobStore(stateDir).save(job),
    saveSession: (session) => createFileAssistSessionStore(join(stateDir, "assist-sessions")).save(session),
  };
}

// (a) Todos os estados brutos de que os CLIs precisam saem de UM buildOperatorView:
// status enumera trabalhos acompanhados, encerrados (done/released) e sessões assistidas.
test("o modelo carrega jobs brutos em todos os estados e as sessões assistidas", async () => {
  const fx = await fixture();
  try {
    await fx.saveJob(jobOf("1")); // running
    const help = transitionJob(jobOf("2"), "waiting-for-help", { message: "m", question: "qual?" });
    await fx.saveJob(help);
    const done = transitionJob(jobOf("3"), "done", { message: "m", reason: "efeito aplicado" });
    await fx.saveJob(done);
    // release applies to stopped states: running goes through interrupted first.
    const released = transitionJob(transitionJob(jobOf("4"), "interrupted", { message: "m", reason: "pane" }), "released", { message: "m", reason: "liberado pelo operador" });
    await fx.saveJob(released);
    await fx.saveSession(sessionOf("1", "open"));

    const view = await buildOperatorView({ stateDir: fx.stateDir, instance });
    // A ordem é a da carga do store (arquivos por chave codificada): a mesma lista que
    // status e logs já consumiam, agora vinda do modelo.
    assert.deepEqual(view.jobs.map((job) => [job.key, job.state]), [
      [jobOf("1").key, "running"], [help.key, "waiting-for-help"], [done.key, "done"], [released.key, "released"],
    ]);
    assert.equal(view.sessions.length, 1);
    assert.equal(view.sessions[0].state, "open");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// (b) A carga de logs (um trabalho pela chave) passa pela mesma fonte: a chave é encontrada
// entre os trabalhos brutos do modelo, com estado e conteúdo idênticos aos do store.
test("o trabalho de logs vem da mesma leitura: a chave resolve pelo modelo", async () => {
  const fx = await fixture();
  try {
    const job = transitionJob(jobOf("1"), "interrupted", { message: "m", reason: "pane do pi" });
    await fx.saveJob(job);
    const view = await buildOperatorView({ stateDir: fx.stateDir, instance });
    const loaded = view.jobs.find((candidate) => candidate.key === job.key);
    assert.ok(loaded, "a chave completa existe na leitura");
    assert.equal(loaded?.state, "interrupted");
    assert.equal(loaded?.reason, "pane do pi");
    // A busca que logs faz (chave completa) não acha nada quando não existe.
    assert.equal(view.jobs.find((candidate) => candidate.key === "memory:acme/app#404"), undefined);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// (c) As listas de ilegíveis por armazenamento seguem no modelo: status usa uma linha por
// armazenamento e elas devem vir da leitura, não de nova leitura CLI-side.
test("arquivos ilegíveis por armazenamento vêm do modelo", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.stateDir, "quebrado.json"), "{ não é json", "utf8");
    await mkdir(join(fx.stateDir, "assist-sessions"), { recursive: true });
    await writeFile(join(fx.stateDir, "assist-sessions", "ruim.json"), "{ não é json", "utf8");
    await mkdir(join(fx.stateDir, "pendencias"), { recursive: true });
    await writeFile(join(fx.stateDir, "pendencias", "pior.json"), "{ não é json", "utf8");

    const view = await buildOperatorView({ stateDir: fx.stateDir, instance });
    assert.deepEqual(view.storeReads.jobs.unreadable, ["quebrado.json"]);
    assert.deepEqual(view.storeReads.sessions.unreadable, ["ruim.json"]);
    assert.deepEqual(view.storeReads.attention.unreadable, ["pior.json"]);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// (d) As falhas de observabilidade que o status mostra no rodapé saem da mesma leitura.
test("falhas de observabilidade vêm no modelo", async () => {
  const fx = await fixture();
  try {
    await createFileAttentionStore(join(fx.stateDir, "pendencias")).save({
      id: "ajuda|x|y", kind: "ajuda", key: refKey(refOf("1")), what: "w", at: "2026-10-14T12:00:00.000Z", actions: [],
    });
    await createFileHistory(fx.stateDir).append({
      at: "2026-10-14T12:00:00.000Z", instance: "pessoal", kind: "ajuda-solicitada", text: "t",
      fields: {}, lines: [],
    });
    // The failure sink writes through its own store; status reads the same file via the model.
    const { createFileFailureStore } = await import("../src/state/history.js");
    await createFileFailureStore(fx.stateDir).record({ at: "2026-10-14T12:01:00.000Z", sink: "github", message: "quota" });

    const view = await buildOperatorView({ stateDir: fx.stateDir, instance });
    assert.deepEqual(view.observability.failures, [{ at: "2026-10-14T12:01:00.000Z", sink: "github", message: "quota" }]);
    assert.equal(view.observability.failuresUnreadable, undefined);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// (e) O corte, no estilo do core-boundary (leitura do fonte dos dois CLIs): nenhum fábrica de
// armazenamento local dentro de status.ts ou logs.ts — eles não interrogam store direto; a
// leitura sai do modelo (issue #65, critério 1). Por logs, a carga do trabalho entra via
// OperatorView; a linha do tempo continua no CLI (é o formato do histórico, não uma leitura
// de estado de trabalho). Os logs usam a MESMA costura que status.
test("status e logs não interrogam armazenamento direto (estilo core-boundary)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const source = async (name: string): Promise<string> =>
    readFile(fileURLToPath(new URL(`../src/cli/${name}`, import.meta.url)), "utf8");
  const status = await source("status.ts");
  const logs = await source("logs.ts");
  // Nem status nem logs montam leitura própria: nada de fábrica de store no corpo.
  for (const factory of ["createFileJobStore", "createFileAssistSessionStore", "createFileAttentionStore", "createFileCommandQueue", "createFileInstanceControl"]) {
    assert.doesNotMatch(status, new RegExp(factory), `src/cli/status.ts interpela o armazenamento por ${factory}`);
    assert.doesNotMatch(logs, new RegExp(factory), `src/cli/logs.ts interpela o armazenamento por ${factory}`);
  }
  // O modelo pode ler as falhas de observabilidade; o CLI não pode (mesmo arquivo, mesma regra).
  assert.doesNotMatch(status, /readFailures/, "src/cli/status.ts lê failures.json por conta própria");
  assert.doesNotMatch(logs, /readFailures/, "src/cli/logs.ts lê failures.json por conta própria");
});
