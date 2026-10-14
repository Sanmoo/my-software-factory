import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOperatorView, comandoAtender, type OperatorView, type OperatorWork } from "../src/core/operator-view.js";
import { jobCommands, shellQuote, type CliHints } from "../src/core/observability.js";
import { helpPending } from "../src/core/attention.js";
import { newJob } from "../src/core/job.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import type { InstanceConfig } from "../src/config/types.js";

// Atender (issue #64, spec #60): a derivação do comando copiável por trabalho — linha de
// contexto do Herdr para o assistido (a partir da identidade gravada na sessão) e o comando
// de log para o autônomo (exatamente os hints que `status` imprime). Leitura pura: derivar
// NÃO enfileira, NÃO resolve pendência e NÃO escreve em store nenhum.

const FIX_AT = "2026-10-14T12:00:00.000Z";
const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });
const keyOf = (id: string): string => refKey(refOf(id));

const jobOf = (id: string): ReturnType<typeof newJob> => newJob({ ref: refOf(id), repository: "acme/app" });

const sessionOf = (id: string, state: AssistSession["state"], over: Partial<AssistSession> = {}): AssistSession => ({
  key: keyOf(id), ref: refOf(id), repository: "acme/app", state,
  promptKind: "needs-triage", model: "p/m", image: "img", cloneDir: "/clone/acme/app",
  startedAt: FIX_AT, log: [], ...over,
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

interface Scenario {
  root: string;
  stateDir: string;
  view: OperatorView;
}

// Cenário semeado: um trabalho autônomo em execução, uma sessão assistida com identidade de
// área completa (aba/pane/container), uma sessão pendente SEM identidade de área e uma
// pendência persistida (para provar que atender não a resolve).
async function scenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "msf-atender-"));
  const stateDir = join(root, "state");
  await createFileJobStore(stateDir).save(jobOf("1"));
  await createFileAssistSessionStore(join(stateDir, "assist-sessions")).save(
    sessionOf("2", "open", { tabId: "t-2", paneId: "p-2", containerName: "msf-app-2", label: "Sessão — acme/app#2" }),
  );
  await createFileAssistSessionStore(join(stateDir, "assist-sessions")).save(sessionOf("3", "pending"));
  await createFileAttentionStore(join(stateDir, "pendencias")).save(helpPending(
    { key: keyOf("1"), ref: refOf("1"), repository: "acme/app", question: "qual formato?" }, FIX_AT,
  ));
  const view = await buildOperatorView({ stateDir, instance });
  return { root, stateDir, view };
}

const cleanup = async (s: Scenario): Promise<void> => { await rm(s.root, { recursive: true, force: true }); };

const workOf = (s: Scenario, id: string): OperatorWork => {
  const work = s.view.works.find((candidate) => candidate.key === keyOf(id));
  assert.ok(work !== undefined, `trabalho ${id} deve estar na visão`);
  return work;
};

// O mesmo contexto que a TUI compõe, por fluxo: o assistido entrega a sessão gravada; o
// autônomo entrega os comandos do observável com as MESMAS CliHints que `status` usa.
const atendidoDe = (s: Scenario, id: string, cli: CliHints): string | null => {
  const work = workOf(s, id);
  return comandoAtender(work, work.fluxo === "humano-assistido"
    ? { session: s.view.sessions.find((session) => session.key === work.key) }
    : { commands: jobCommands(cli, work.key, s.view.works.map((row) => row.key)) });
};

// Snapshot cru dos stores (trabalhos, sessões, pendências, fila) — para provar que derivar o
// atender não escreve em nenhum deles.
const rawStores = async (stateDir: string): Promise<string> => {
  const readAll = async (dir: string): Promise<string> => JSON.stringify(await Promise.all(
    (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readFile(join(dir, name), "utf8")),
  ));
  return JSON.stringify([
    await readAll(stateDir),
    await readAll(join(stateDir, "assist-sessions")),
    await readAll(join(stateDir, "pendencias")),
    await readAll(join(stateDir, "commands")),
  ]);
};

// ── trabalho autônomo: o contexto é o log (formato exato dos hints do observável) ─────────────

test("atender autônomo devolve o comando de logs no mesmo formato que o status imprime", async () => {
  const s = await scenario();
  const cli: CliHints = { instance: "pessoal" };
  const work = workOf(s, "1");
  const keys = s.view.works.map((row) => row.key);
  assert.equal(atendidoDe(s, "1", cli), jobCommands(cli, work.key, keys).logs);
  assert.equal(atendidoDe(s, "1", cli), "./msf pessoal logs '#1'");
  await cleanup(s);
});

test("atender autônomo com home não padrão embute --home como o status faz", async () => {
  const s = await scenario();
  const cli: CliHints = { instance: "pessoal", home: "/root/.msf" };
  const work = workOf(s, "1");
  const keys = s.view.works.map((row) => row.key);
  assert.equal(atendidoDe(s, "1", cli), jobCommands(cli, work.key, keys).logs);
  assert.equal(atendidoDe(s, "1", cli), "./msf --home /root/.msf pessoal logs '#1'");
  await cleanup(s);
});

test("atender autônomo acrescenta a linha tail -f do log detalhado quando o núcleo o registrou", async () => {
  const s = await scenario();
  const work = workOf(s, "1");
  const commands = {
    ...jobCommands({ instance: "pessoal" }, work.key, s.view.works.map((row) => row.key)),
    detail: `tail -f ${shellQuote("/state/areas/acme/logs/2026-10-14.log")}`,
  };
  assert.equal(
    comandoAtender(work, { commands }),
    "./msf pessoal logs '#1'\ntail -f /state/areas/acme/logs/2026-10-14.log",
  );
  await cleanup(s);
});

// ── trabalho assistido: a linha de contexto do Herdr, a partir da sessão gravada ──────────────

test("atender assistido deriva a linha de contexto do Herdr com a identidade gravada na sessão", async () => {
  const s = await scenario();
  assert.equal(atendidoDe(s, "2", { instance: "pessoal" }), "aba t-2 · container msf-app-2 · clone /clone/acme/app");
  await cleanup(s);
});

test("atender assistido sem id de aba usa o rótulo gravado, como os eventos do núcleo fazem", async () => {
  const s = await scenario();
  await createFileAssistSessionStore(join(s.stateDir, "assist-sessions")).save(
    sessionOf("4", "open", { label: "Sessão — acme/app#4" }),
  );
  const view = await buildOperatorView({ stateDir: s.stateDir, instance });
  const work = view.works.find((candidate) => candidate.key === keyOf("4"));
  assert.ok(work !== undefined);
  const session = view.sessions.find((candidate) => candidate.key === work.key);
  assert.ok(session !== undefined);
  assert.equal(comandoAtender(work, { session }), "aba Sessão — acme/app#4 · clone /clone/acme/app");
  await rm(s.root, { recursive: true, force: true });
});

// ── nada derivável: null — a TUI não inventa ──────────────────────────────────────────────────

test("atender assistido sem identidade de área devolve null (sem aba nem container)", async () => {
  const s = await scenario();
  assert.equal(atendidoDe(s, "3", { instance: "pessoal" }), null);
  await cleanup(s);
});

test("atender devolve null sem sessão gravada (assistido) ou sem comandos (autônomo)", async () => {
  const s = await scenario();
  assert.equal(comandoAtender(workOf(s, "3"), {}), null);
  assert.equal(comandoAtender(workOf(s, "1"), {}), null);
  await cleanup(s);
});

// ── a prova do sem side effect: derivar não muda fila, stores nem pendências ──────────────────

test("atender não enfileira comando, não resolve pendência e não escreve em store nenhum", async () => {
  const s = await scenario();
  const queue = createFileCommandQueue(s.stateDir);
  const before = { raw: await rawStores(s.stateDir), queue: await queue.pending() };
  assert.deepEqual(before.queue.commands, []);
  assert.equal(s.view.pendings.length, 1);

  // Simular o atender da TUI sobre cada trabalho que poderia estar em foco:
  const cli: CliHints = { instance: "pessoal" };
  for (const work of s.view.works) {
    comandoAtender(work, work.fluxo === "humano-assistido"
      ? { session: s.view.sessions.find((session) => session.key === work.key) }
      : { commands: jobCommands(cli, work.key, s.view.works.map((row) => row.key)) });
  }

  const after = { raw: await rawStores(s.stateDir), queue: await queue.pending() };
  assert.equal(after.raw, before.raw, "nenhum byte mudado em store nenhum");
  assert.deepEqual(after.queue.commands, [], "nada enfileirado pelo atender");
  const pendings = await createFileAttentionStore(join(s.stateDir, "pendencias")).load();
  assert.equal(pendings.pendings.length, 1, "a pendência persiste: atender não a resolve");
  assert.equal(pendings.pendings[0]?.kind, "ajuda");
  await cleanup(s);
});
