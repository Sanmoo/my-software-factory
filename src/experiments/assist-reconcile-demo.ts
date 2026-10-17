import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InstanceConfig, RuntimeProfileConfig } from "../config/types.js";
import {
  assistContainerName, assistExecCommand, assistExitRecordPath, parseAssistExecExitRecord, runtimeImageDirOf,
} from "../runtime/assist-exec.js";
import type { AssistExecProbe } from "../runtime/assist-exec-probe.js";
import { dockerExecProbe } from "../runtime/assist-exec-probe.js";
import { describePlan, planSnapshot, writeSnapshot } from "../runtime/profile-snapshot.js";
import { herdrBoundary } from "../runtime/herdr.js";
import { assistPrompt } from "../core/assist-prompts.js";
import { assistResultDigest, recognizeAssistResult } from "../core/assist-result.js";
import { AssistedAttendance } from "../core/assist-flow.js";
import { AttentionKeeper } from "../core/attention.js";
import { projectEligibility } from "../config/project-eligibility.js";
import type { MsfConfig } from "../config/types.js";
import type { LocalSettings } from "../cli/local-settings.js";
import { createFileAssistAreaFs } from "../state/file-assist-area-fs.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileAttentionStore } from "../state/file-attention-store.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { MemoryTracker, type StoredIssue } from "../tracker/memory.js";
import type { AssistSession } from "../core/assist-session.js";
import type { IssueRef } from "../tracker/port.js";

// Controlled real-runtime demonstration of the post-restart reconciliation (ticket #58, spec
// #48 item 5) over the metal the #52 proof validated: a real exec inside a real Docker container
// hosted by a Herdr tab, the real docker probe by the recorded container identity, and the
// production reconciler itself over the persisted session files. The restart points:
//
//   1. persist-then-crash opening: a REAL exec running while the orchestrator's record still
//      says `opening` — the restart reconciles it back under supervision, executing nothing;
//   2. docker daemon away: the probe is inconclusive -> unknown, capacity reserved;
//   3. ended during downtime: the container-written exit record -> delegated to supervision;
//   4. an identity the daemon proves absent with no end record, past the opening grace ->
//      ended by identity; the structured result decides, pending per #56;
//   5. a consumed one-time authorization -> nothing opens; the consumption is never restored;
//   6. a partially registered approval -> completed exactly once, by digest dedupe.
//
//   npm run smoke:assist-reconcile      # INSIDE a Herdr pane (HERDR_ENV=1); never npm test
//
// Disposable fixture + clone + areas under .smoke/assist-reconcile-demo/<slug>/; cleanup removes
// the container (by the recorded name), the tabs and the demo dirs (MSF_DEMO_KEEP=1 keeps all).

const MODEL = "opencode-go/gpt-6-luna";
const IMAGE = "msf-docker-runner:local";
const PROFILE_SOURCE = join(homedir(), ".pi", "agent");
const ALLOWED_ROOTS = [join(homedir(), ".agents"), join(homedir(), "dev")];
const PROFILE_DECLARATION: RuntimeProfileConfig = {
  required: { files: ["settings.json", "auth.json"], packages: [], skills: [], agents: [], tools: [] },
  excludePackages: ["npm:pi-lens"],
};
// The model's first turn is the long pole (~100 s of cold pi + provider); a slow provider is a
// documented limitation of the metal, not a failure (the #52 proof measured it). The exec's real
// end waits on operator input and the container-written record, like every assisted exec.
const WAIT_MS = 420_000;
const PROMISE = "<promise>MSF-RESULT</promise>";

const slug = randomUUID().slice(0, 8);
const demoDir = resolve(".smoke", "assist-reconcile-demo", slug);
const fixtureDir = join(demoDir, "fixture");
const cloneDir = join(demoDir, "clone");
const orchestrationDir = join(demoDir, "orchestration"); // the demo instance's state directory
const sessionsStoreDir = join(orchestrationDir, "assist-sessions");
const liveSessionsDir = join(demoDir, "sessions");
const liveExecStateDir = join(demoDir, "live-state");
const liveProfileDir = join(demoDir, "live-profile");

const startedAt = new Date().toISOString();
const liveKey = "memory:demo/app#1";
const liveRef: IssueRef = { tracker: "memory", project: "demo/app", id: "1" };
const liveContainerName = assistContainerName(liveKey, startedAt);
// No container exists for this identity on purpose: the daemon itself proves the absence by name.
const recordlessStartedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const recordlessKey = "memory:demo/app#2";
const recordlessRef: IssueRef = { tracker: "memory", project: "demo/app", id: "2" };
const recordlessContainerName = assistContainerName(recordlessKey, recordlessStartedAt);
const consumedKey = "memory:demo/app#3";
const consumedRef: IssueRef = { tracker: "memory", project: "demo/app", id: "3" };
const concludingKey = "memory:demo/app#4";
const concludingRef: IssueRef = { tracker: "memory", project: "demo/app", id: "4" };

const execFileP = (command: string, args: readonly string[], timeoutMs = 120_000): Promise<string> =>
  new Promise((ok, fail) => execFile(command, [...args],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 << 20 },
    (error, stdout, stderr) => error == null
      ? ok(stdout)
      : fail(new Error(`${command} ${args.join(" ")}: ${stderr || String(error)}`, { cause: error }))));

const herdr = (args: readonly string[], timeoutMs = 60_000): Promise<string> => execFileP("herdr", args, timeoutMs);

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

const saveJson = (name: string, value: unknown): Promise<void> =>
  writeFile(join(demoDir, name), JSON.stringify(value, null, 2) + "\n");

const openedTabs: string[] = [];

async function cleanup(): Promise<void> {
  if (process.env.MSF_DEMO_KEEP === "1") return;
  for (const name of [liveContainerName, recordlessContainerName]) {
    await execFileP("docker", ["rm", "-f", name], 15_000).catch(() => undefined);
  }
  for (const tabId of openedTabs.splice(0)) {
    await herdr(["tab", "close", tabId]).catch(() => undefined);
  }
}

async function sessionTexts(dir: string): Promise<string[]> {
  const walk = async (path: string): Promise<string[]> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await walk(join(path, entry.name)));
      else if (entry.name.endsWith(".jsonl")) files.push(join(path, entry.name));
    }
    return files.sort();
  };
  const files = await walk(dir);
  return Promise.all(files.map(async (file) => readFile(file, "utf8")));
}

async function waitAssistantMarker(token: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    for (const text of await sessionTexts(liveSessionsDir)) {
      if (text.includes(token) && text.includes(PROMISE)) return text;
    }
    // A container that died before answering says so by its record; waiting out the full window
    // would only hide the real cause.
    const ended = await readFile(assistExitRecordPath(liveExecStateDir), "utf8").catch(() => undefined);
    if (ended !== undefined) {
      const { exitCode } = parseAssistExecExitRecord(ended);
      throw new Error(`o container encerrou (exit ${exitCode}) antes de guardar a resposta com ${token}; registro: ${ended.trim()}`);
    }
    await sleep(2_000);
  }
  throw new Error(`a sessão do container não guardou a resposta do modelo com ${token} em ${WAIT_MS} ms`);
}

// The operator's own input solicits the end; the container-written record says the real end. No
// docker stop, no timeout kill — exactly what the #52 proof validated.
async function endPiByInput(paneId: string): Promise<number> {
  const exitPath = assistExitRecordPath(liveExecStateDir);
  for (const keys of [["ctrl+c"], ["esc", "ctrl+c"], ["ctrl+d"], ["ctrl+d"], ["ctrl+c"], ["ctrl+c"]]) {
    const written = await readFile(exitPath, "utf8").catch(() => undefined);
    if (written !== undefined) break;
    await herdr(["pane", "send-keys", paneId, ...keys]).catch(() => undefined);
    for (let waited = 0; waited < 12_000; waited += 1_000) {
      const text = await readFile(exitPath, "utf8").catch(() => undefined);
      if (text !== undefined) return parseAssistExecExitRecord(text.trim()).exitCode;
      await sleep(1_000);
    }
  }
  throw new Error("nenhum encerramento por entrada terminou o pi; veja o estado em .smoke/assist-reconcile-demo");
}

const sessionOf = async (store: ReturnType<typeof createFileAssistSessionStore>, key: string): Promise<AssistSession> => {
  const found = (await store.load()).sessions.find((candidate) => candidate.key === key);
  assert.ok(found, `sessão ${key} deveria existir`);
  return found;
};

async function main(): Promise<void> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("a demonstração roda dentro de uma pane do Herdr (HERDR_ENV=1); nunca é parte de npm test");
  }
  for (const dir of [demoDir, join(fixtureDir, "src"), cloneDir, liveSessionsDir, liveExecStateDir,
    liveProfileDir, orchestrationDir, sessionsStoreDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(fixtureDir, "README.md"), "Fixture descartável da demonstração de reconciliação (#58).\n");
  await writeFile(join(fixtureDir, "src", "demo.ts"), "export const demo = 'assist-reconcile';\n");
  const gitFixture = (args: readonly string[]) => execFileP("git", ["-C", fixtureDir, ...args], 30_000);
  await gitFixture(["init", "-q", "-b", "main"]);
  await gitFixture(["config", "user.name", "Demonstração Reconciliação"]);
  await gitFixture(["config", "user.email", "demo@example.invalid"]);
  await gitFixture(["add", "."]);
  await gitFixture(["commit", "-q", "-m", "Fixture descartável da demonstração"]);
  await execFileP("git", ["clone", "-q", fixtureDir, cloneDir], 60_000);

  const plan = await planSnapshot({ dir: PROFILE_SOURCE, allowedRoots: ALLOWED_ROOTS }, PROFILE_DECLARATION);
  assert.ok(plan.blockers.length === 0, `retrato do perfil bloqueado: ${plan.blockers.join("; ")}`);
  await writeSnapshot(plan, liveProfileDir);
  await saveJson("snapshot-plan.json", describePlan(plan));

  const store = createFileAssistSessionStore(sessionsStoreDir);
  const herdrBoundaryForDemo = herdrBoundary();
  await herdrBoundaryForDemo.available();
  const workspace = await herdrBoundaryForDemo.currentWorkspace();

  // ── 1. The real exec of a persistence-then-crash opening: abba real, record `opening`. ────
  const opening = await herdrBoundaryForDemo.createTab({ workspace, cwd: cloneDir, label: `msf-reconcile-${slug}` });
  openedTabs.push(opening.tab.tabId);
  assert.equal(opening.focusedBefore, opening.focusedAfter, "abrir a aba não roubou o foco");
  const token = `RECON_${randomUUID().slice(0, 8).toUpperCase()}`;
  const execCommand = assistExecCommand({
    name: liveContainerName, image: IMAGE, model: MODEL,
    agentUidGid: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    startedAt,
    cloneHostDir: cloneDir, sessionsHostDir: liveSessionsDir, stateHostDir: liveExecStateDir,
    snapshotHostDir: liveProfileDir, runtimeHostDir: runtimeImageDirOf(),
    npmHostDir: join(demoDir, "toolchains", "npm"), miseHostDir: join(demoDir, "toolchains", "mise"),
    requiredPackages: PROFILE_DECLARATION.required.packages, requiredTools: PROFILE_DECLARATION.required.tools,
    prompt: `${assistPrompt({ kind: "needs-triage", ref: liveRef, title: `demonstração de reconciliação ${slug}` })}\n\n`
      + `Primeira mensagem do operador (demonstração ${slug}): registre os passos desta triagem, `
      + `mencione o token ${token} e termine com a linha <promise>MSF-RESULT</promise>.`,
  });
  await saveJson("exec-command.json", { command: execCommand, containerName: liveContainerName, tabId: opening.tab.tabId });
  await herdrBoundaryForDemo.paneRun(opening.tab.paneId, execCommand);
  const firstTurn = await waitAssistantMarker(token);
  await saveJson("first-turn.json", { token, containsStructuredResult: firstTurn.includes(PROMISE) });

  // The orchestrator "crashed" here: identity persisted, state still `opening`.
  const liveSession: AssistSession = {
    key: liveKey, ref: liveRef, repository: "demo/app", state: "opening", promptKind: "needs-triage",
    model: MODEL, image: IMAGE, cloneDir,
    containerName: liveContainerName, label: `msf-reconcile-${slug}`, tabId: opening.tab.tabId, paneId: opening.tab.paneId,
    profileDir: liveProfileDir, sessionsDir: liveSessionsDir, execStateDir: liveExecStateDir,
    startedAt, log: [],
  };
  await store.save(liveSession);
  await saveJson("persisted-opening.json", { ...liveSession, note: "a queda chegou antes do estado open; só o disco é verdade" });

  // The production pieces of a restarted orchestrator, with a knob: `daemonProbe` simulates a
  // Docker the reconciliation cannot ask (unknown is reserved, never a guess).
  const local: LocalSettings = {
    image: IMAGE, profiles: { "docker-default": liveProfileDir }, allowedRoots: {}, mise: {}, checkouts: { "demo/app": cloneDir },
  };
  const instanceConfig = {
    name: "reconcile-demo", maxConcurrent: 1, maxAssisted: 3, assistModel: MODEL,
    pollIntervalSeconds: 300, maxIterations: 5, modelAuth: "copilot",
    projects: [{
      name: "app", enabled: true, adapter: "github", repository: "demo/app", targetBranch: "main",
      prIntegration: "github.com", runtimeProfile: "docker-default", githubAccount: "demo",
      labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
      models: { implementer: MODEL, "reviewer-standards": MODEL, "reviewer-spec": MODEL, default: MODEL },
    }],
  } as unknown as InstanceConfig;
  const config: MsfConfig = { credentials: {}, runtimeProfiles: { "docker-default": PROFILE_DECLARATION } } as unknown as MsfConfig;
  const issues: StoredIssue[] = [
    {
      ref: liveRef, title: "atendimento vivo de demonstração",
      labels: { known: true, value: ["human-assisted", "needs-triage"] },
      assignees: { known: true, value: [] }, claimed: { known: true, value: true },
      blockers: { known: true, value: [] }, statusCategory: { known: true, value: "to-do" },
      priority: { known: true, value: null }, comments: [],
    },
    {
      ref: recordlessRef, title: "atendimento sem execução pendente de demonstração",
      labels: { known: true, value: ["human-assisted", "needs-info"] },
      assignees: { known: true, value: [] }, claimed: { known: true, value: true },
      blockers: { known: true, value: [] }, statusCategory: { known: true, value: "to-do" },
      priority: { known: true, value: null }, comments: [],
    },
    {
      ref: consumedRef, title: "atendimento com autorização consumida de demonstração",
      labels: { known: true, value: ["human-assisted", "needs-triage"] },
      assignees: { known: true, value: [] }, claimed: { known: true, value: true },
      blockers: { known: true, value: [] }, statusCategory: { known: true, value: "to-do" },
      priority: { known: true, value: null }, comments: [],
    },
    {
      ref: concludingRef, title: "atendimento parcialmente concluído de demonstração",
      labels: { known: true, value: ["human-assisted", "needs-info", "claim"] },
      assignees: { known: true, value: [] }, claimed: { known: true, value: true },
      blockers: { known: true, value: [] }, statusCategory: { known: true, value: "to-do" },
      priority: { known: true, value: null }, comments: [],
    },
  ];
  const tracker = new MemoryTracker(issues);
  await createFileInstanceControl(orchestrationDir).setPaused(false);
  const attendance = (daemonProbe: AssistExecProbe = dockerExecProbe()): AssistedAttendance =>
    new AssistedAttendance({
      instance: instanceConfig,
      config,
      local,
      tracker,
      jobs: createFileJobStore(orchestrationDir),
      sessions: store,
      areaFs: createFileAssistAreaFs(),
      commands: createFileCommandQueue(orchestrationDir),
      control: createFileInstanceControl(orchestrationDir),
      eligibility: (project) => projectEligibility(instanceConfig, project),
      ports: { sandbox: { preflight: async (input) => ({ token: `token-de-${input.account}` }) }, herdr: herdrBoundaryForDemo, exec: daemonProbe },
      runtimeImageDir: runtimeImageDirOf(),
      toolchainsDir: join(demoDir, "toolchains"),
      stateDir: orchestrationDir,
      attention: new AttentionKeeper({ store: createFileAttentionStore(join(orchestrationDir, "pendencias")) }),
    });

  // ── 2. Restart #1, real probe: the live exec is rediscovered and re-supervised in place. ─
  const recovered = await attendance().reconcile();
  await saveJson("reconcile-alive.json", recovered);
  assert.equal(recovered.errors.length, 0, recovered.errors.map((e) => `${e.key}: ${e.message}`).join("; "));
  assert.deepEqual(recovered.recovered.map((entry) => entry.key), [liveKey],
    "o exec real é reencontrado vivo: docker inspect por identidade do registro");
  assert.equal((await sessionOf(store, liveKey)).state, "open",
    "a abertura interrompida pelo reinício volta a ser acompanhada");
  assert.equal(openedTabs.length, 1, "nenhuma segunda aba: o exec NÃO é reexecutado");
  assert.equal(recovered.unknown.length + recovered.pending.length + recovered.ended.length, 0,
    "nenhum outro trabalho do reinício caiu noutro desfecho neste passo");

  // ── 3. docker daemon away: unknown, capacity reserved, never a freeing. ──────────────────
  const awayProbe: AssistExecProbe = {
    observe: async (name) => ({
      containerName: name, verdict: "unknown" as const,
      detail: "o Docker não pôde ser perguntado (daemon inacessível na demonstração)",
    }),
  };
  const unknownReport = await attendance(awayProbe).reconcile();
  await saveJson("reconcile-unknown.json", unknownReport);
  assert.deepEqual(unknownReport.unknown.map((entry) => entry.key), [liveKey],
    "sem resposta da daemon, a execução é desconhecida: intervenção persistente e capacidade reservada");
  const stillOpen = await sessionOf(store, liveKey);
  assert.ok(stillOpen.log.some((line) => line.includes("execução desconhecida")), stillOpen.log.at(-1));
  assert.equal((await createFileAttentionStore(join(orchestrationDir, "pendencias")).load()).pendings.some((pending) => pending.kind === "intervenção"),
    true, "a intervenção pedida é pendência persistente, consultável em status");

  // ── 4. The real end of the exec, then the next restart reads the container-written record. ─
  const exit = await endPiByInput(opening.tab.paneId);
  let containerGone = false;
  try { await execFileP("docker", ["inspect", liveContainerName], 15_000); } catch { containerGone = true; }
  assert.ok(containerGone, "o container encerrou de verdade (--rm) e o registro do fim está no mount do host");
  await saveJson("ended.json", { exit, containerGone, note: "código de fim registrado; nunca interpretado como sucesso do atendimento" });
  const endedReport = await attendance().reconcile();
  await saveJson("reconcile-ended.json", endedReport);
  assert.equal(endedReport.errors.length, 0, endedReport.errors.map((e) => `${e.key}: ${e.message}`).join("; "));
  assert.deepEqual(endedReport.ended.map((entry) => entry.key), [liveKey],
    "o fim comprovado vai para a supervisão do ciclo: o RESULTADO estruturado decide, nunca o exit");
  assert.equal((await sessionOf(store, liveKey)).state, "open", "a supervisão é a dona do desfecho do fim registrado");

  // ── 5. A recorded identity the daemon cannot find, without a record, past the opening grace:
  // ended by identity; what the exec left (or not) decides the attendance through #55/#56.
  const recordlessSession: AssistSession = {
    key: recordlessKey, ref: recordlessRef, repository: "demo/app", state: "open", promptKind: "needs-info",
    model: MODEL, image: IMAGE, cloneDir,
    containerName: recordlessContainerName, tabId: "aba-perdida", paneId: "pane-perdida",
    profileDir: "", sessionsDir: "", execStateDir: "",
    startedAt: recordlessStartedAt, log: [],
  };
  await store.save(recordlessSession);
  const recordlessReport = await attendance().reconcile();
  await saveJson("reconcile-recordless.json", recordlessReport);
  const recordlessNow = await sessionOf(store, recordlessKey);
  assert.ok(recordlessNow.log.some((line) => line.includes("fim comprovado pela identidade do container")),
    recordlessNow.log.at(-1));
  assert.notEqual(recordlessNow.state, "open",
    "o fim provado decide: a sessão sai da capacidade aberta; o atendimento segue pelo resultado");
  assert.ok(recordlessNow.continuity !== undefined || recordlessNow.state === "proposed",
    "sem resultado reconhecido, a decisão do operador é pedida (#56)");
  void recordlessReport;

  // ── 6. No replay: the consumed authorization stays consumed; nothing opens. ──────────────
  const consumedSession: AssistSession = {
    key: consumedKey, ref: consumedRef, repository: "demo/app", state: "pending", promptKind: "needs-triage",
    model: MODEL, image: IMAGE, cloneDir,
    profileDir: "", sessionsDir: "", execStateDir: "",
    startedAt, log: [],
    continuity: { question: "q", askedAt: startedAt, answeredAt: startedAt, answer: "sim" },
    scheduledResume: { at: startedAt, command: "cmd", answer: "sim",
      consumed: { at: startedAt, attempt: "msf-assist-demo-app-3-r1#abc12345" } },
  };
  await store.save(consumedSession);
  const consumedReport = await attendance().reconcile();
  await saveJson("reconcile-consumed.json", consumedReport);
  const stillConsumed = await sessionOf(store, consumedKey);
  assert.ok(stillConsumed.scheduledResume?.consumed, "a autorização consumida nunca reaparece");
  assert.equal(openedTabs.length, 1, "nenhuma execução foi aberta pela reconciliação em nenhum passo");

  // ── 7. A partially registered approval completes itself, exactly once, per its own flow. ──
  const approvedPayload = '{"status":"concluded","summary":"triagem de demonstração acertada"}';
  await store.save({
    key: concludingKey, ref: concludingRef, repository: "demo/app", state: "concluding", promptKind: "needs-info",
    model: MODEL, image: IMAGE, cloneDir,
    profileDir: "", sessionsDir: "", execStateDir: "",
    startedAt, log: [],
    result: { status: "concluded", summary: "triagem de demonstração acertada" },
    resultPayload: approvedPayload,
    resultDigest: assistResultDigest(approvedPayload),
    approval: { at: startedAt, command: "cmd-demo" },
  });
  const firstPoll = await attendance().poll();
  const secondPoll = await attendance().poll();
  await saveJson("poll-registers.json", { first: firstPoll.concluded, second: secondPoll.concluded });
  const comments = await tracker.readComments(concludingRef);
  assert.equal(comments.length, 1, "um único registro do resultado, mesmo repetindo o ciclo");
  assert.ok(comments[0]?.body.includes(`digest: ${assistResultDigest(approvedPayload)}`));
  assert.equal((await store.load()).sessions.some((candidate) => candidate.key === concludingKey), false,
    "o acompanhamento acaba quando cada ação aprovada está confirmada pela releitura");

  const recognized = recognizeAssistResult(await sessionTexts(liveSessionsDir));
  await saveJson("result-recognition.json", recognized);
  process.stdout.write(
    `Demo de reconciliação (#58) completa: aba ${opening.tab.tabId}, exec ${liveContainerName} vivo recuperado, ` +
    `desconhecido provado com daemon ausente, fim registrado exit ${exit}, fim por identidade sem registro, ` +
    `autorização consumida intacta e aprovação registrada uma única vez. Estado: ${orchestrationDir}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`demonstração falhou: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void cleanup().then(() => {
      if (process.env.MSF_DEMO_KEEP === "1") return;
      return rm(demoDir, { recursive: true, force: true }).catch(() => undefined);
    });
  });
