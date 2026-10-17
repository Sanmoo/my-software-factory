import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atenderFoco } from "../src/cli/tui.js";
import type { CommandBody, CommandQueue } from "../src/core/commands.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { encodeRefPart, newJob } from "../src/core/job.js";
import type { InstanceConfig } from "../src/config/types.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";
import { assistExitRecordPath } from "../src/runtime/assist-exec.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";

// A tecla `t` da TUI (issue #77, spec #74): para trabalho humano assistido interrompido — e
// também quando o registro de fim já existe mesmo com o estado gravado ainda sendo sessão
// aberta —, `t` ENFILEIRA a retomada manual (mesma fila injetada de sempre) e confirma no
// banner; nos demais estados segue a exibição pura do contexto copiável (#64), SEM enfileirar
// nada. O teste exercita a costura pública `atenderFoco` (decisão da spec #60: sem teste de
// renderização da TUI), com stores reais semeados e uma fila falsa.
//
// O que a costura prova em especial: o modelo de leitura é RELIDO no momento da tecla — semear o
// registro de fim DEPOIS da última leitura da tela e apertar `t` já enfileira, que é o que faz a
// janela entre Ctrl-C e o estacionamento ser de milissegundos.

const FIX_AT = "2026-10-14T12:00:00.000Z";
const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });
const keyOf = (id: string): string => refKey(refOf(id));

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

// A fila falsa injetada no lugar da TUI da instância: registra cada enqueue.
interface FakeQueue extends CommandQueue {
  calls: CommandBody[];
}

const fakeQueue = (): FakeQueue => {
  const calls: CommandBody[] = [];
  let sequence = 0;
  return {
    calls,
    async enqueue(command: CommandBody): Promise<string> {
      sequence += 1;
      calls.push(command);
      return `c-${sequence}`;
    },
    async pending() { return { commands: [], unreadable: [] }; },
    async done() {},
  };
};

// O diretório de estado da execução de uma sessão, como o fluxo o grava.
const execStateDirOf = (stateDir: string, key: string): string => join(stateDir, "assist", encodeRefPart(key), "state");

interface Scenario {
  root: string;
  stateDir: string;
  sessionStore: ReturnType<typeof createFileAssistSessionStore>;
}

// Cenário semeado: um trabalho autônomo (1) e sessões assistidas — 2 aberta COM o registro de fim,
// 3 aberta sem registro, 4 aberta com registro ilegível, 5 pending (interrompido sem retomada),
// 6 proposed (resultado aguardando aprovação).
async function scenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "msf-tui-retomar-"));
  const stateDir = join(root, "state");
  await createFileJobStore(stateDir).save(newJob({ ref: refOf("1"), repository: "acme/app" }));
  const sessionStore = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  const withRecord = execStateDirOf(stateDir, keyOf("2"));
  const illegible = execStateDirOf(stateDir, keyOf("4"));
  await sessionStore.save(sessionOf("2", "open", { execStateDir: withRecord }));
  // A sessão 3 tem o diretório do canal registrado (a abertura o grava) mas ainda sem registro.
  await sessionStore.save(sessionOf("3", "open", { execStateDir: execStateDirOf(stateDir, keyOf("3")) }));
  await sessionStore.save(sessionOf("4", "open", { execStateDir: illegible }));
  await sessionStore.save(sessionOf("5", "pending", { reason: "execução sem resultado" }));
  await sessionStore.save(sessionOf("6", "proposed", { result: { summary: "s" } as never }));
  await mkdir(withRecord, { recursive: true });
  await writeFile(assistExitRecordPath(withRecord), '{"exitCode":130,"at":"2026-10-14T12:05:00.000Z"}');
  await mkdir(illegible, { recursive: true });
  await writeFile(assistExitRecordPath(illegible), "não é json");
  return { root, stateDir, sessionStore };
}

const depsOf = (s: Scenario, queue: CommandQueue): Parameters<typeof atenderFoco>[1] =>
  ({ stateDir: s.stateDir, instance, queue, instanceName: instance.name });

// Snapshot cru dos stores fora da fila: a tecla `t` só pode escrever na fila de comandos.
const rawStores = async (stateDir: string): Promise<string> => {
  const readAll = async (dir: string): Promise<string> => JSON.stringify(await Promise.all(
    (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readFile(join(dir, name), "utf8")),
  ));
  return JSON.stringify([await readAll(stateDir), await readAll(join(stateDir, "assist-sessions"))]);
};

// ── enfileira: retomada manual (interrompido e sessão aberta com o registro de fim) ───────────

test("t em atendimento interrompido enfileira a retomada e confirma no banner", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  const decision = await atenderFoco(keyOf("5"), depsOf(s, queue));
  assert.equal(decision.kind, "retomada");
  assert.deepEqual(queue.calls, [{ type: "resume", job: keyOf("5") }]);
  assert.ok(decision.kind === "retomada" && decision.notice.kind === "ok");
  assert.match(decision.kind === "retomada" ? decision.notice.text : "", /retomada manual para memory:acme\/app#5/);
  assert.match(decision.kind === "retomada" ? decision.notice.text : "", /comando=c-1/);
  await rm(s.root, { recursive: true, force: true });
});

test("t em sessão aberta com o registro de fim já presente enfileira a retomada", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  const decision = await atenderFoco(keyOf("2"), depsOf(s, queue));
  assert.equal(decision.kind, "retomada");
  assert.deepEqual(queue.calls, [{ type: "resume", job: keyOf("2") }]);
  await rm(s.root, { recursive: true, force: true });
});

test("t relê o modelo na hora: o registro aparecendo depois da tela já basta para enfileirar", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  // A tela foi desenhada antes (sessão 3 sem registro): `t` apenas exibe.
  assert.equal((await atenderFoco(keyOf("3"), depsOf(s, queue))).kind, "exibicao");
  assert.deepEqual(queue.calls, []);
  // O registro de fim chega (o fim real da execução) e o operador aperta `t` de novo: a releitura
  // no momento da tecla aceita, sem depender do estado da tela nem de uma segunda passagem.
  const execStateDir = execStateDirOf(s.stateDir, keyOf("3"));
  await mkdir(execStateDir, { recursive: true });
  await writeFile(assistExitRecordPath(execStateDir), '{"exitCode":130,"at":"2026-10-14T12:06:00.000Z"}');
  assert.equal((await atenderFoco(keyOf("3"), depsOf(s, queue))).kind, "retomada");
  assert.deepEqual(queue.calls, [{ type: "resume", job: keyOf("3") }]);
  await rm(s.root, { recursive: true, force: true });
});

// ── exibição pura: nada entra na fila ────────────────────────────────────────────────────────

test("t sem o registro de fim, com registro ilegível, autônomo ou aguardando aprovação só exibe", async () => {
  const s = await scenario();
  const queue = fakeQueue();
  // Sessão aberta sem o registro (3): a recusa honesta do núcleo vira exibição pura na TUI.
  assert.deepEqual(await atenderFoco(keyOf("3"), depsOf(s, queue)), { kind: "exibicao" });
  // Registro ilegível (4): unknown nunca é ausência nem fim — exibição pura.
  assert.deepEqual(await atenderFoco(keyOf("4"), depsOf(s, queue)), { kind: "exibicao" });
  // Trabalho autônomo (1): `t` continua o contexto copiável da #64.
  assert.deepEqual(await atenderFoco(keyOf("1"), depsOf(s, queue)), { kind: "exibicao" });
  // Resultado proposto aguardando aprovação (6): a decisão é approve, não retomada.
  assert.deepEqual(await atenderFoco(keyOf("6"), depsOf(s, queue)), { kind: "exibicao" });
  // Chave desconhecida ou ausente (nada em foco): exibição, como hoje.
  assert.deepEqual(await atenderFoco(undefined, depsOf(s, queue)), { kind: "exibicao" });
  assert.deepEqual(await atenderFoco("memory:acme/app#99", depsOf(s, queue)), { kind: "exibicao" });
  assert.deepEqual(queue.calls, [], "nenhum dos casos enfileirou coisa alguma");
  await rm(s.root, { recursive: true, force: true });
});

test("t não escreve nada fora da fila de comandos: nem no estado gravado da sessão", async () => {
  const s = await scenario();
  const before = await rawStores(s.stateDir);
  const queue = fakeQueue();
  assert.equal((await atenderFoco(keyOf("5"), depsOf(s, queue))).kind, "retomada");
  const after = await rawStores(s.stateDir);
  assert.equal(after, before, "nenhum byte mudado fora da fila");
  assert.deepEqual(queue.calls, [{ type: "resume", job: keyOf("5") }]);
  await rm(s.root, { recursive: true, force: true });
});
