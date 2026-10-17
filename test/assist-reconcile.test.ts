import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { loadInstance } from "../src/cli/instance.js";
import type { LocalSettings } from "../src/cli/local-settings.js";
import { AssistedAttendance, type AssistFlowDeps, type AssistReconcileReport } from "../src/core/assist-flow.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { assistResultDigest } from "../src/core/assist-result.js";
import { AttentionKeeper } from "../src/core/attention.js";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { createFileAssistAreaFs } from "../src/state/file-assist-area-fs.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import { refKey, type IssueRef, type TrackerPort } from "../src/tracker/port.js";
import { assistContainerName, assistExitRecordPath } from "../src/runtime/assist-exec.js";
import type { HerdrBoundary } from "../src/runtime/herdr.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";
import type { AssistExecProbe, AssistExecObservation } from "../src/runtime/assist-exec-probe.js";

// Reconciliation after an orchestrator restart (ticket #58, spec #48 item 5), on the public
// entry: every persisted identity is decided against the REAL execution in the container —
// docker inspect by the recorded name with the daemon's reachability proven in the same look,
// plus the container-written end record — never a PID alone, never the pane. Controlled doubles
// here; the real metal path is `npm run smoke:assist-reconcile` (HERDR_ENV=1, never npm test).

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const memoryTracker = async (): Promise<MemoryTracker> =>
  loadMemoryTracker(JSON.parse(await readFile(fixture("assist-tracker.json"), "utf8")));

interface HerdrCalls {
  tabs: Array<{ workspace: string; cwd: string; label: string }>;
  panes: Array<{ paneId: string; command: string }>;
}

const herdrOf = (calls: HerdrCalls): HerdrBoundary => ({
  async available() {},
  async currentWorkspace() {
    return "ws-operador";
  },
  async createTab(input) {
    calls.tabs.push(input);
    return { tab: { tabId: `tab-${calls.tabs.length}`, paneId: `pane-${calls.tabs.length}` },
      focusedBefore: "ws-operador", focusedAfter: "ws-operador", label: input.label, cwd: input.cwd };
  },
  async paneRun(paneId, command) {
    calls.panes.push({ paneId, command });
  },
  async tabIds() {
    // The seeded session's tab stays hosted: the reconcile tests never close one.
    return ["tab-0"];
  },
});

const sandboxOf = (): Pick<SandboxBoundary, "preflight"> => ({
  preflight: async (input) => ({ token: `token-de-${input.account}` }),
});

interface Setup {
  stateDir: string;
  sessionsDir: string;
  tracker: MemoryTracker;
  herdrCalls: HerdrCalls;
  // The probe verdicts the next reconcile reads, by container name: the tests flip them.
  verdicts: Record<string, AssistExecObservation["verdict"]>;
  flow: () => AssistedAttendance;
  restartedFlow: (verdicts?: Record<string, AssistExecObservation["verdict"]>) => AssistedAttendance;
  pendings: () => Promise<string[]>;
  events: Array<{ kind: string; fields?: Record<string, unknown> }>;
  commands: { enqueue: (type: "approve", job: string) => Promise<string> };
  writeInstance: (over: { maxAssisted?: number }) => void;
  seed: (over: Partial<AssistSession>, ref?: IssueRef) => Promise<AssistSession>;
}

const arrange = async (context: TestContext, options: {
  only?: string[];
  instanceOverrides?: { maxAssisted?: number };
  now?: string;
} = {}): Promise<Setup> => {
  const loaded = await loadInstance(fixture("assist-instances.json"), "assistida");
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.run.stderr);
  const root = await mkdtemp(join(tmpdir(), "msf-assist-reconcile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const sessionsDir = join(stateDir, "assist-sessions");
  const tracker = await memoryTracker();
  const scoped: TrackerPort = options.only === undefined ? tracker : scopedOf(tracker, options.only);
  const local = await localOf(root);
  const herdrCalls: HerdrCalls = { tabs: [], panes: [] };
  const events: Setup["events"] = [];
  const instance = { ...loaded.instance, ...options.instanceOverrides };
  const writeInstance = (over: { maxAssisted?: number }): void => { Object.assign(instance, over); };
  const pendingsDir = join(stateDir, "pendencias");
  const attentionOf = () => new AttentionKeeper({ store: createFileAttentionStore(pendingsDir) });
  const probe = (map: Record<string, AssistExecObservation["verdict"]>): AssistExecProbe => ({
    observe: async (name) => {
      const verdict = map[name] ?? "absent";
      return { containerName: name, verdict, detail: `${name}: ${verdict}` };
    },
  });
  const commands = createFileCommandQueue(stateDir);
  const verdicts: Record<string, AssistExecObservation["verdict"]> = {};
  const flowOf = (map: Record<string, AssistExecObservation["verdict"]>): AssistedAttendance => {
    const deps: AssistFlowDeps = {
      instance,
      config: loaded.config,
      local,
      tracker: scoped,
      jobs: createFileJobStore(stateDir),
      sessions: createFileAssistSessionStore(sessionsDir),
      // The real fs authority over the tmpdir areas: the double delegates to the same files the
      // session store uses, so the reconciliation's state keeps its shape.
      areaFs: createFileAssistAreaFs(),
      commands,
      control: { isPaused: async () => false, setPaused: async () => undefined },
      eligibility: (project) => projectEligibility(instance, project),
      observer: {
        emit: (event) => events.push({ kind: event.kind, fields: event.fields }),
        flush: async () => undefined,
        failure: () => undefined,
        recovered: () => undefined,
        redact: (text) => text,
        registerSecret: () => undefined,
        setDetailLog: () => undefined,
        commands: () => undefined,
      },
      ports: { sandbox: sandboxOf(), herdr: herdrOf(herdrCalls), exec: probe(map) },
      runtimeImageDir: "/msf-repo/src/runtime/docker-image",
      toolchainsDir: join(stateDir, "toolchains"),
      stateDir,
      attention: attentionOf(),
      ...(options.now === undefined ? {} : { now: () => new Date(options.now!) }),
    };
    return new AssistedAttendance(deps);
  };
  const seed = async (over: Partial<AssistSession>, ref: IssueRef = pendingRef): Promise<AssistSession> => {
    const key = refKey(ref);
    const area = join(stateDir, "assist", key);
    const sessions = join(area, "sessions");
    const state = join(area, "state");
    await mkdir(sessions, { recursive: true });
    await mkdir(state, { recursive: true });
    const startedAt = "2026-10-14T08:00:00.000Z";
    const session: AssistSession = {
      key, ref, repository: "acme/app",
      state: "open", promptKind: "needs-triage",
      model: "github-copilot/claude-haiku-5.5", image: local.image,
      cloneDir: local.checkouts["acme/app"]!,
      containerName: assistContainerName(key, startedAt),
      label: `msf-assist-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      tabId: "tab-0", paneId: "pane-0",
      profileDir: join(area, "profile"), sessionsDir: sessions, execStateDir: state,
      startedAt, log: [],
      ...over,
    };
    if (session.containerName !== undefined) verdicts[session.containerName] = "absent";
    await createFileAssistSessionStore(sessionsDir).save(session);
    return session;
  };
  // The same instance per arrangement (a process of the orchestrator): only a restart makes
  // a new one, via `restartedFlow` — announce-once and dedupe semantics count per process.
  let flow: AssistedAttendance | undefined;
  return {
    stateDir, sessionsDir, tracker, herdrCalls, verdicts,
    flow: () => (flow ??= flowOf(verdicts)),
    restartedFlow: (map) => flowOf(map ?? verdicts),
    pendings: async () => (await createFileAttentionStore(pendingsDir).load()).pendings.map((pending) => pending.kind),
    events, writeInstance, seed,
    commands: {
      enqueue: async (type, job) => commands.enqueue({ type, job }),
    },
  };
};

const scopedOf = (tracker: MemoryTracker, ids: readonly string[]): TrackerPort => ({
  discoverCandidates: async (scope) => (await tracker.discoverCandidates(scope)).filter((ref) => ids.includes(ref.id)),
  readIssue: (ref) => tracker.readIssue(ref),
  readComments: (ref) => tracker.readComments(ref),
  claim: (ref) => tracker.claim(ref),
  releaseClaim: (ref) => tracker.releaseClaim(ref),
  updateLabels: (ref, changes) => tracker.updateLabels(ref, changes),
  markDone: (ref) => tracker.markDone(ref),
  postComment: (ref, body) => tracker.postComment(ref, body),
  claimMarkOf: (ref) => tracker.claimMarkOf(ref),
});

const localOf = async (root: string): Promise<LocalSettings> => {
  const profileDir = join(root, "perfil");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "settings.json"), "{}\n");
  const checkout = join(root, "clone-app");
  await mkdir(checkout, { recursive: true });
  return {
    image: "msf-docker-runner:local",
    profiles: { copilot: profileDir, "docker-default": profileDir },
    allowedRoots: { "docker-default": [root] }, mise: {},
    checkouts: { "acme/app": checkout },
  };
};

const pendingRef: IssueRef = { tracker: "memory", project: "acme/app", id: "1" };
const pendingKey = refKey(pendingRef); // needs-triage
const humanKey = refKey({ tracker: "memory", project: "acme/app", id: "2" }); // ready-for-human

const sessionOf = async (setup: Setup, key: string): Promise<AssistSession> => {
  const loaded = await createFileAssistSessionStore(setup.sessionsDir).load();
  const found = loaded.sessions.find((candidate) => candidate.key === key);
  assert.ok(found, `sessão ${key} deveria existir`);
  return found;
};

const proposalText = (payload: string): string =>
  `<msf-result>${payload}</msf-result>\n<promise>MSF-RESULT</promise>`;

const proposeEnd = async (session: AssistSession, payload: string): Promise<void> => {
  const dir = join(session.sessionsDir!, "turno");
  await mkdir(dir, { recursive: true });
  const event = JSON.stringify({
    type: "message", message: { role: "assistant", content: [{ type: "text", text: proposalText(payload) }] },
  });
  await writeFile(join(dir, "0001.jsonl"), `${event}\n`);
};

const totalOf = (report: AssistReconcileReport): number =>
  report.recovered.length + report.unknown.length + report.pending.length + report.ended.length;

// ── Proven-alive recovery ────────────────────────────────────────────────────────────────────

test("a persisted identity of an exec proven alive returns under supervision, keeps its capacity, and never opens a second pi", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.tracker.claim(pendingRef);
  const seeded = await setup.seed({ state: "opening" });
  setup.verdicts[seeded.containerName!] = "running";
  const report = await setup.flow().reconcile();
  assert.equal(report.errors.length, 0, report.errors.map((e) => e.message).join("; "));
  assert.deepEqual(report.recovered.map((r) => r.key), [pendingKey]);
  const recovered = await sessionOf(setup, pendingKey);
  assert.equal(recovered.state, "open", "a abertura deitada volta a ser acompanhada");
  assert.ok(recovered.log.some((line) => line.includes("comprovadamente viva")), recovered.log.slice(-2).join(" | "));
  // No second pi for the same work: reconcile NEVER launches an exec (no tab, no pane run).
  assert.equal(setup.herdrCalls.tabs.length, 0);
  assert.equal(setup.herdrCalls.panes.length, 0);
  // The operator attention (ticket #59): the recovered session raises its open pending again.
  assert.deepEqual(await setup.pendings(), ["abertura"]);
  assert.ok(setup.events.some((event) => event.kind === "atendimento-recuperado"));

  // Idempotent: a second reconciliation in the same process neither reopens nor re-announces.
  const again = await setup.flow().reconcile();
  assert.equal(totalOf(again), 1);
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-recuperado").length, 1);
  assert.equal(setup.herdrCalls.panes.length, 0);
});

test("an open session runs on as itself after the restart: supervision continues, nothing re-executes", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  const seeded = await setup.seed({ state: "open" });
  setup.verdicts[seeded.containerName!] = "running";
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.recovered.map((r) => r.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
  assert.deepEqual(report.unknown, []);
  assert.equal(setup.herdrCalls.panes.length, 0);

  // The recovered supervision works: the exec's later end arrives through the record channel and
  // the same #56 decision path answers — one session, one continuation, no re-execution.
  setup.verdicts[seeded.containerName!] = "absent";
  await writeFile(assistExitRecordPath(seeded.execStateDir!), '{"exitCode":3,"at":"2026-10-14T11:00:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.ok(ended.pending.some((entry) => entry.key === pendingKey));
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.match(parked.reason ?? "", /exit 3/);
});

test("a live exec wins over a readable stale end record: the record is superseded and a later genuine end decides", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  const seeded = await setup.seed({ state: "open" });
  setup.verdicts[seeded.containerName!] = "running";
  // A readable record under a LIVE exec can only be stale (the relaunch removes the old record
  // before the new exec starts): ending by it would free the capacity of a live execution.
  await writeFile(assistExitRecordPath(seeded.execStateDir!), '{"exitCode":0,"at":"2026-10-14T07:00:00.000Z"}');
  const report = await setup.flow().reconcile();
  assert.equal(totalOf(report) - report.recovered.length, 0, "nenhum encerramento a partir do registro obsoleto");
  assert.equal((await sessionOf(setup, pendingKey)).state, "open", "a execução segue viva");
  await assert.rejects(() => readFile(assistExitRecordPath(seeded.execStateDir!)), /ENOENT/,
    "o registro obsoleto sai de cena: um fim verdadeiro escreve um registro novo");

  // The genuine end, later: the flow reacts to the NEW record, not to the discarded one.
  setup.verdicts[seeded.containerName!] = "absent";
  await writeFile(assistExitRecordPath(seeded.execStateDir!), '{"exitCode":0,"at":"2026-10-14T11:30:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.ok(ended.pending.some((entry) => entry.key === pendingKey));
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending");
});

// ── Ended during downtime: the structured result decides, never the exit ─────────────────────

test("an exec ended during the downtime with a readable record is handed to supervision, which verifies the result (#56 path)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  // The claim the crash preserved: exactly what the interruption keeps on the issue.
  assert.ok("made" in (await setup.tracker.claim(pendingRef)), "a claim foi aceita");
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T07:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "absent";
  await writeFile(assistExitRecordPath(seeded.execStateDir!), '{"exitCode":0,"at":"2026-10-14T07:30:00.000Z"}');
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.ended.map((e) => e.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open", "a supervisão decide pelo resultado");
  assert.equal(setup.herdrCalls.panes.length, 0, "nenhuma reexecução");

  const polled = await setup.flow().poll();
  assert.ok(polled.pending.some((entry) => entry.key === pendingKey));
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.match(parked.reason ?? "", /sem resultado de atendimento reconhecido/);
  assert.ok(parked.continuity, "a decisão do operador é persistida: o fim não é conclusão");
  const issue = await setup.tracker.readIssue(pendingRef);
  assert.ok(issue.claimed.known && issue.claimed.value, "o claim segue até a casa decidir a retenção");
});

test("an ended-during-downtime execution whose result is recognized keeps the approved flow (#55): proposed, approval, one registration", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T07:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "absent";
  await writeFile(assistExitRecordPath(seeded.execStateDir!), '{"exitCode":0,"at":"2026-10-14T07:30:00.000Z"}');
  await proposeEnd(seeded, '{"status":"concluded","summary":"triagem acertada"}');
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.ended.map((e) => e.key), [pendingKey]);

  await setup.flow().poll();
  const proposed = await sessionOf(setup, pendingKey);
  assert.equal(proposed.state, "proposed", "o resultado proposto aguarda o operador, não a saída do processo");
  assert.ok(proposed.resultDigest);
  assert.ok((await setup.pendings()).some((kind) => kind === "decisão"));
  assert.deepEqual(await setup.tracker.readComments(pendingRef), [], "nada é registrado antes da aprovação");

  void await setup.commands.enqueue("approve", pendingKey);
  await setup.flow().poll();
  await setup.flow().poll();
  const comments = await setup.tracker.readComments(pendingRef);
  assert.equal(comments.length, 1, "registro único mesmo com repetição (dedupe por digest)");
  assert.ok(comments[0]?.body.includes(`digest: ${proposed.resultDigest}`));
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-concluído").length, 1);
  assert.equal((await createFileAssistSessionStore(setup.sessionsDir).load()).sessions.some((s) => s.key === pendingKey), false,
    "o acompanhamento acaba quando cada ação aprovada está confirmada");
});

test("proven absence without a record ends by identity beyond the opening grace; the structured result decides", async (context) => {
  const setup = await arrange(context, { only: ["1"], now: "2026-10-14T12:30:00.000Z" });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T08:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "absent";
  const report = await setup.flow().reconcile();
  assert.equal(report.pending.length, 1);
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.ok(parked.log.some((line) => line.includes("fim comprovado pela identidade do container")), parked.log.at(-1));
  assert.ok(parked.continuity, "o atendimento pede a decisão do operador; nunca conclui pelo fim");
  assert.equal(parked.scheduledResume, undefined, "a recuperação não consome nem cria autorização");
});

test("a recognized proposal survives even a recordless end: reconciliation keeps the approved path alive", async (context) => {
  const setup = await arrange(context, { only: ["1"], now: "2026-10-14T12:30:00.000Z" });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T08:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "absent";
  await proposeEnd(seeded, '{"status":"concluded","summary":"triagem acertada"}');
  const report = await setup.flow().reconcile();
  const proposed = await sessionOf(setup, pendingKey);
  assert.equal(proposed.state, "proposed", "a saída do processo (sem registro) não decide: a proposta sim");
  assert.ok(proposed.resultDigest);
  assert.equal(report.pending.length, 1, "o desfecho aparece no relato da reconciliação");
});

// ── Unknown: capacity reserved, never freed nor exceeded ─────────────────────────────────────

test("a young open session inside the opening grace is unknown: capacity reserved, no admission over N", async (context) => {
  const setup = await arrange(context, { only: ["2"], now: "2026-10-14T08:10:00.000Z", instanceOverrides: { maxAssisted: 1 } });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T08:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "absent";
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.unknown.map((u) => u.key), [pendingKey]);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open", "capacidade reservada pelo estado existente");
  assert.equal(setup.herdrCalls.panes.length, 0);

  // Number consistency beyond restart: N=1 with one unknown session -> the ready issue waits.
  const polled = await setup.flow().poll();
  assert.ok(polled.skipped.some((skip) => skip.key === humanKey && skip.reason.includes("capacidade de sessões assistidas")),
    polled.skipped.map((s) => s.reason).join(" | "));
  assert.deepEqual(polled.opened, []);
  assert.ok(setup.events.some((event) => event.kind === "atendimento-intervenção"));
  assert.ok((await setup.pendings()).some((kind) => kind === "intervenção"), "intervenção persistente");
});

test("an unreachable docker daemon keeps the execution unknown: capacity reserved until clarified, announced once", async (context) => {
  const setup = await arrange(context, { only: ["1"], now: "2026-10-14T12:30:00.000Z", instanceOverrides: { maxAssisted: 1 } });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T08:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "unknown";
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.unknown.map((u) => u.key), [pendingKey]);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open");
  assert.ok(kept.log.some((line) => line.includes("execução desconhecida")), kept.log.at(-1));
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-intervenção").length, 1);

  // Repeated with the same reason: no spam; the persistent pending stays consultable regardless.
  const second = await setup.flow().reconcile();
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-intervenção").length, 1);
  assert.equal(totalOf(second), 1);
  // A clarifying restart never frees a possibly-alive exec: reserved until Docker answers.
  const healed = await setup.restartedFlow({ [seeded.containerName!]: "running" }).reconcile();
  assert.deepEqual(healed.recovered.map((r) => r.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
});

test("clarification across restarts resolves an unknown into the real state of the execution", async (context) => {
  const setup = await arrange(context, { only: ["1"], now: "2026-10-14T12:30:00.000Z" });
  const seeded = await setup.seed({ state: "open", startedAt: "2026-10-14T08:00:00.000Z" });
  setup.verdicts[seeded.containerName!] = "unknown";
  await setup.tracker.claim(pendingRef);
  assert.equal((await setup.flow().reconcile()).unknown.length, 1);

  // The restart with Docker answering: proven absence (older than the grace) ends the exec and
  // the pending asks the operator — capacity is decided by the result, not by the daemon's miss.
  const healed = await setup.restartedFlow({ [seeded.containerName!]: "absent" }).reconcile();
  assert.deepEqual(healed.unknown, []);
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.ok(parked.log.some((line) => line.includes("reconciliação pós-reinício")), parked.log.at(-1));
  assert.equal(parked.containerName, seeded.containerName, "a identidade do registro é mantida para o histórico");
});

// ── Persistence that must not replay: consumed authorization, never-launched opening, partial cleanups ──

test("a consumed one-time authorization reappears neither unconsumed nor executed after a restart", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.tracker.claim(pendingRef);
  await setup.seed({
    state: "pending",
    sessionsDir: undefined, execStateDir: undefined, profileDir: undefined, tabId: undefined, paneId: undefined,
    label: undefined, containerName: undefined,
    scheduledResume: { at: "2026-10-14T09:00:00.000Z", command: "cmd", answer: "sim",
      consumed: { at: "2026-10-14T09:01:00.000Z", attempt: "msf-assist-memory-acme-app-1-r1#abc12345" } },
    continuity: { question: "p?", askedAt: "2026-10-14T08:55:00.000Z", answeredAt: "2026-10-14T09:00:00.000Z", answer: "sim" },
  });
  const report = await setup.flow().reconcile();
  assert.equal(totalOf(report), 0, "nada a recuperar: a sessão pendente não guarda execução nenhuma");
  const kept = await sessionOf(setup, pendingKey);
  assert.ok(kept.scheduledResume?.consumed, "o consumo segue consumido (nunca reaparece)");
  assert.equal(kept.state, "pending");
  const polled = await setup.flow().poll();
  assert.deepEqual(polled.resumed, [], "a autorização consumida não agenda retomada");
  assert.equal(setup.herdrCalls.panes.length, 0, "nenhuma execução sem nova decisão");
});

test("an opening persisted before the crash without a launched exec parks the work pending, claim kept, never re-executed", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  assert.ok("made" in (await setup.tracker.claim(pendingRef)), "a claim foi aceita");
  const seeded = await setup.seed({
    state: "opening", tabId: undefined, paneId: undefined, label: undefined,
    startedAt: "2026-10-14T07:00:00.000Z",
  });
  setup.verdicts[seeded.containerName!] = "absent";
  void seeded;
  const report = await setup.flow().reconcile();
  assert.deepEqual(report.pending.map((p) => p.key), [pendingKey]);
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.match(parked.reason ?? "", /exec não foi lançado|não foi lançado/);
  const issue = await setup.tracker.readIssue(pendingRef);
  assert.ok(issue.claimed.known && issue.claimed.value, "o claim (quando confirmado antes da queda) segue preservado");
  assert.equal(setup.herdrCalls.panes.length, 0);
  // No silent re-execution and no silent re-admission: the operator decides.
  const later = await setup.flow().poll();
  assert.ok(later.skipped.some((skip) => skip.key === pendingKey), later.skipped.map((s) => s.reason).join(" | "));
});

test("a partially registered approval survives the restart and is completed without duplicate registration", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.tracker.claim(pendingRef);
  const payload = '{"status":"concluded","summary":"triagem acertada"}';
  const seeded = await setup.seed({
    state: "concluding", startedAt: "2026-10-14T07:00:00.000Z",
    result: { status: "concluded", summary: "triagem acertada" },
    resultPayload: payload,
    resultDigest: assistResultDigest(payload),
    approval: { at: "2026-10-14T07:40:00.000Z", command: "cmd-antes" },
  });
  setup.verdicts[seeded.containerName!] = "absent";
  const report = await setup.flow().reconcile();
  assert.equal(totalOf(report), 0, "a conclusão pendente não é obra da reconciliação: o fluxo dela completa");

  await setup.flow().poll();
  assert.equal((await createFileAssistSessionStore(setup.sessionsDir).load()).sessions.some((s) => s.key === pendingKey), false,
    "acompanhamento encerrado só quando tudo está confirmado");
  await setup.flow().poll();
  const comments = await setup.tracker.readComments(pendingRef);
  assert.equal(comments.length, 1, "um registro: o payload e o digest já persistidos não duplicam");
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-concluído").length, 1);
});

test("an unreadable session file stays tracked through the restart and blocks a second admission", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await mkdir(setup.sessionsDir, { recursive: true });
  await writeFile(join(setup.sessionsDir, encodeURIComponent(pendingKey) + ".json"), "não é json");
  const report = await setup.flow().reconcile();
  assert.ok(report.errors.some((error) => error.message.includes("ilegível")));
  const polled = await setup.flow().poll();
  assert.ok(polled.skipped.some((skip) => skip.key === pendingKey), "a issue de arquivo ilegível não é readmitida");
  assert.deepEqual(polled.opened, []);
});

// The two flows' recoveries stay separate: the assisted reconciliation never touches the
// implementation jobs — their crash recovery remains Admission.open's (interrupt, no replay).
test("the reconciliation only answers for assisted identities: the implementation jobs pass untouched", async (context) => {
  const setup = await arrange(context, { only: [] });
  const jobKey = "memory:acme/app#9";
  const job: import("../src/core/job.js").Job = {
    key: jobKey, ref: { tracker: "memory", project: "acme/app", id: "9" }, repository: "acme/app",
    state: "running", startedAt: "2026-10-14T11:00:00.000Z", log: [], events: [],
  } as import("../src/core/job.js").Job;
  await createFileJobStore(setup.stateDir).save(job);
  const report = await setup.flow().reconcile();
  assert.equal(totalOf(report), 0, "nada a fazer: nenhum atendimento assistido é guardado");
  const after = await createFileJobStore(setup.stateDir).load();
  const kept = after.jobs.find((candidate) => candidate.key === jobKey);
  assert.ok(kept, "o trabalho segue no store");
  assert.equal(kept.state, "running", "nem interrompido nem reexecutado pela reconciliação assistida");
});
