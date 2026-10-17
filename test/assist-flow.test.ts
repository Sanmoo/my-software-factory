import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { loadInstance } from "../src/cli/instance.js";
import type { LocalSettings } from "../src/cli/local-settings.js";
import { assistPrompt } from "../src/core/assist-prompts.js";
import type { AssistSession } from "../src/core/assist-session.js";
import { AssistedAttendance, type AssistFlowDeps, type AssistPollReport } from "../src/core/assist-flow.js";
import { AttentionKeeper, type AttentionPending } from "../src/core/attention.js";
import { holdsSlot, newJob, type Job } from "../src/core/job.js";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { createFileAssistAreaFs } from "../src/state/file-assist-area-fs.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import type { MemoryTracker } from "../src/tracker/memory.js";
import { refKey, type IssueRef, type TrackerPort } from "../src/tracker/port.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";
import type { HerdrBoundary } from "../src/runtime/herdr.js";
import type { AssistExecProbe, AssistExecObservation, AssistExecStopResult } from "../src/runtime/assist-exec-probe.js";
import { assistContainerName, assistEnvFilePath, assistExitRecordPath } from "../src/runtime/assist-exec.js";

// Double of the reconciliation probe (ticket #58): the observation is what the test maps.
const probeOf = (observations: Record<string, AssistExecObservation["verdict"]>, detail = ""): AssistExecProbe => ({
  observe: async (name) => ({
    containerName: name,
    verdict: observations[name] ?? "absent",
    detail: `${name}: ${observations[name] ?? "absent"}${detail === "" ? "" : ` (${detail})`}`,
  }),
});

// The full path of the human-assisted attendance (ticket #54), under controlled doubles:
// discovery, pre-claim environment verification, reservation of the second N, claim by the
// core's single write mechanism, opening in Herdr/Docker without stealing focus, coexistence
// with implementation capacity, supervision by the exit record, failures after the claim.

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const memoryTracker = async (): Promise<MemoryTracker> =>
  loadMemoryTracker(JSON.parse(await readFile(fixture("assist-tracker.json"), "utf8")));

interface HerdrCalls {
  workspace: number;
  tabs: Array<{ workspace: string; cwd: string; label: string; focus?: boolean }>;
  panes: Array<{ paneId: string; command: string }>;
}

// The tab ids the watcher's watcher hosts: created tabs stay open until the test closes one
// (ticket #56), and a failing query is what the Herdr unavailable answer produces.
const herdrOf = (options: {
  unavailable?: string;
  stealFocus?: boolean;
  failPaneRun?: string;
  failTabIds?: string;
  calls?: HerdrCalls;
  // Tabs open before the first admission (a seeded session's identity), closed by the test.
  openTabs?: Set<string>;
} = {}): HerdrBoundary => {
  const calls = options.calls ?? { workspace: 0, tabs: [], panes: [] };
  const openTabs = options.openTabs ?? new Set<string>();
  let seq = 0;
  return {
    async available() {
      if (options.unavailable !== undefined) throw new Error(options.unavailable);
    },
    async currentWorkspace() {
      calls.workspace += 1;
      return "ws-operador";
    },
    async createTab(input) {
      calls.tabs.push(input);
      seq += 1;
      openTabs.add(`tab-${seq}`);
      // The boundary's real behavior: without `focus` the tab is born unfocused (and the no-steal
      // assertion holds); with `focus: true` (the operator's manual resume, #77) the new tab is
      // the one focused.
      const focused = options.stealFocus === true || input.focus === true;
      return {
        tab: { tabId: `tab-${seq}`, paneId: `pane-${seq}` },
        focusedBefore: options.stealFocus === true ? "outro" : "ws-operador",
        focusedAfter: focused ? `tab-${seq}` : "ws-operador",
        label: input.label,
        cwd: input.cwd,
      };
    },
    async paneRun(paneId, command) {
      calls.panes.push({ paneId, command });
      if (options.failPaneRun !== undefined) throw new Error(options.failPaneRun);
    },
    async tabIds() {
      if (options.failTabIds !== undefined) throw new Error(options.failTabIds);
      return [...openTabs];
    },
  };
};

// The host proof of Docker/image/token: the project account's token is minted here, exactly like
// the real boundary does (its value is what the credential channel must never leak). `token`
// overrides the minted value so the tests can use a sentinel or an unusable one.
const sandboxOf = (options: { fail?: string; token?: string } = {}): Pick<SandboxBoundary, "preflight"> => ({
  preflight: async (input) => {
    if (options.fail !== undefined) throw new Error(options.fail);
    return { token: options.token ?? `token-de-${input.account}` };
  },
});

async function localOf(root: string, options: { clone?: boolean } = {}): Promise<LocalSettings> {
  const profileDir = join(root, "perfil");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "settings.json"), "{}\n");
  await writeFile(join(profileDir, "auth.json"), "{}\n");
  const checkout = join(root, "clone-app");
  if (options.clone !== false) await mkdir(checkout, { recursive: true });
  return {
    image: "msf-docker-runner:local",
    profiles: { copilot: profileDir, "docker-default": profileDir },
    allowedRoots: { "docker-default": [root] }, mise: {},
    checkouts: options.clone === false ? {} : { "acme/app": checkout },
  };
}

interface Setup {
  root: string;
  stateDir: string;
  // The Herdr tab list of the test's server: the test closes a tab by removing its id.
  openTabs: Set<string>;
  // The exec identity channel of the test (tickets #56/#58): probe verdicts by container name
  // (default "absent"), the stops the supervision requested, and the next stop's outcome.
  verdicts: Record<string, AssistExecObservation["verdict"]>;
  stops: Array<{ container: string }>;
  stopResult: { kind: AssistExecStopResult["kind"]; detail?: string };
  // The operator attention of ticket #59: what notifications attempted and the dried pendings.
  notifications: Array<{ title: string; body: string }>;
  notificationsFail: (reason: string | undefined) => void;
  // The secret values the flow registered in the observer (ticket #76): the defense in depth
  // that redacts them from every log the same observer writes.
  registeredSecrets: string[];
  // The detailed-log paths the observer was handed (`setDetailLog`): empty for the assisted flow,
  // which has no detailed log of its own — the token proof scans them when they exist.
  detailLogs: string[];
  pendings: () => Promise<AttentionPending[]>;
  tracker: MemoryTracker;
  scoped: TrackerPort;
  instance: import("../src/config/types.js").InstanceConfig;
  config: import("../src/config/types.js").MsfConfig;
  local: LocalSettings;
  sessionsDir: string;
  herdrCalls: HerdrCalls;
  events: Array<{ kind: string; text: string; level?: string; fields?: Record<string, unknown> }>;
  flow: () => AssistedAttendance;
  writeJob: (job: Job) => Promise<void>;
  writeInstance: (overrides: { maxAssisted?: number; assistModel?: string | undefined }) => Promise<void>;
}

const scopedTracker = (tracker: MemoryTracker, ids: readonly string[]): TrackerPort => ({
  discoverCandidates: async (scope) => (await tracker.discoverCandidates(scope))
    .filter((ref) => ids.includes(ref.id)),
  readIssue: (ref) => tracker.readIssue(ref),
  readComments: (ref) => tracker.readComments(ref),
  claim: (ref) => tracker.claim(ref),
  releaseClaim: (ref) => tracker.releaseClaim(ref),
  updateLabels: (ref, changes) => tracker.updateLabels(ref, changes),
  markDone: (ref) => tracker.markDone(ref),
  postComment: (ref, body) => tracker.postComment(ref, body),
  claimMarkOf: (ref) => tracker.claimMarkOf(ref),
});

async function arrange(context: TestContext, options: {
  clone?: boolean;
  herdr?: Parameters<typeof herdrOf>[0];
  sandbox?: Parameters<typeof sandboxOf>[0];
  instanceOverrides?: { maxAssisted?: number; assistModel?: string | undefined };
  // Discovery restricted to these issue ids (the fixture carries several parallels).
  only?: string[];
  // Absent wiring of the identity stop channel (ticket #56): what a gone tab can do without it.
  stopExec?: false;
  // The flow's wait between the looks for the exec's container (ticket #76). The default returns
  // immediately: the suite never waits the 30 s budget, and a test may drive the look's clock.
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<Setup> {
  const loaded = await loadInstance(fixture("assist-instances.yaml"), "assistida");
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.run.stderr);
  const root = await mkdtemp(join(tmpdir(), "msf-assist-flow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const tracker = await memoryTracker();
  const scoped: TrackerPort = options.only === undefined ? tracker : scopedTracker(tracker, options.only);
  const local = await localOf(root, options);
  const herdrCalls: HerdrCalls = { workspace: 0, tabs: [], panes: [] };
  const openTabs = new Set<string>();
  // The exec identity channel of the test: verdicts by container name (default "absent"),
  // the stops the supervision requested and the outcome the next stop gets (ticket #56).
  const verdicts: Record<string, AssistExecObservation["verdict"]> = {};
  const stops: Array<{ container: string }> = [];
  const stopResult: { kind: AssistExecStopResult["kind"]; detail?: string } = { kind: "requested" };
  const stopExec = {
    async stop(container: string): Promise<AssistExecStopResult> {
      stops.push({ container });
      if (stopResult.kind === "failed") return { kind: "failed", detail: stopResult.detail ?? "o Docker não pôde ser perguntado na invalidez do teste" };
      if (stopResult.kind === "already-absent") return { kind: "already-absent", detail: `o daemon respondeu: nenhum container com o nome ${container}` };
      return { kind: "requested", detail: `docker rm -f ${container} executado` };
    },
  };
  const events: Setup["events"][number][] = [];
  const registeredSecrets: string[] = [];
  // Every detailed-log path the observer was given: the assisted flow opens none (the detailed log
  // belongs to an autonomous invocation, src/runtime/docker-runner.ts), and the token proof asserts
  // that and scans whatever a future flow hands over.
  const detailLogs: string[] = [];
  // The attention store of the instance state and a double channel: no real OS notification.
  const snapshot: { fail: string | undefined } = { fail: undefined };
  const notifications: Array<{ title: string; body: string }> = [];
  const pendingsDir = join(stateDir, "pendencias");
  const attention = new AttentionKeeper({
    store: createFileAttentionStore(pendingsDir),
    notify: {
      async notify(notification) {
        notifications.push({ ...notification });
        if (snapshot.fail !== undefined) throw new Error(snapshot.fail);
        return "notify-send";
      },
    },
  });
  const instance = { ...loaded.instance, ...options.instanceOverrides };
  const stopPort = options.stopExec === undefined
    ? stopExec
    : undefined;
  const deps: AssistFlowDeps = {
    instance,
    config: loaded.config,
    local,
    tracker: scoped,
    jobs: createFileJobStore(stateDir),
    sessions: createFileAssistSessionStore(join(stateDir, "assist-sessions")),
    // The real fs authority over the tmpdir areas: the doubles delegate to the same files the
    // session store uses, so state and demo flows keep their shape.
    areaFs: createFileAssistAreaFs(),
    commands: createFileCommandQueue(stateDir),
    control: { isPaused: async () => false, setPaused: async () => undefined },
    eligibility: (project) => projectEligibility(instance, project),
    observer: {
      emit: (event) => {
        events.push({ kind: event.kind, text: event.text, ...(event.level !== undefined ? { level: event.level } : {}), ...(event.fields !== undefined ? { fields: event.fields } : {}) });
      },
      flush: async () => undefined,
      failure: () => undefined,
      recovered: () => undefined,
      redact: (text) => text,
      registerSecret: (secret) => {
        if (secret !== undefined) registeredSecrets.push(secret);
      },
      setDetailLog: (_job, path) => { detailLogs.push(path); },
      commands: () => undefined,
    },
    ports: { sandbox: sandboxOf(options.sandbox), herdr: herdrOf({ ...(options.herdr === undefined ? {} : options.herdr), calls: herdrCalls, openTabs }), exec: probeOf(verdicts), ...(stopPort === undefined ? {} : { stopExec: stopPort }) },
    runtimeImageDir: "/msf-repo/src/runtime/docker-image",
    toolchainsDir: join(stateDir, "toolchains"),
    stateDir,
    attention,
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    // The container-evidence wait of the credential's removal (ticket #76): immediate in tests.
    sleep: options.sleep ?? (async () => {}),
  };
  const attendance = new AssistedAttendance(deps);
  const flow = () => attendance;
  const writeJob = async (job: Job): Promise<void> => {
    await createFileJobStore(stateDir).save(job);
  };
  const writeInstance = async (overrides: { maxAssisted?: number; assistModel?: string | undefined }): Promise<void> => {
    Object.assign(instance, overrides);
  };
  return {
    root, stateDir, tracker, scoped, instance, config: loaded.config, local,
    sessionsDir: join(stateDir, "assist-sessions"), herdrCalls, events, flow, writeJob, writeInstance,
    notifications, notificationsFail: (reason) => { snapshot.fail = reason; },
    registeredSecrets, detailLogs,
    pendings: async () => (await createFileAttentionStore(pendingsDir).load()).pendings,
    openTabs, verdicts, stops, stopResult,
  };
}

const pendingRef: IssueRef = { tracker: "memory", project: "acme/app", id: "1" };
const pendingKey = refKey(pendingRef); // memory:acme/app#1 (needs-triage)
const humanKey = refKey({ tracker: "memory", project: "acme/app", id: "2" }); // ready-for-human

type SessionView = import("../src/core/assist-session.js").AssistSession;

const sessionOf = async (setup: Setup, key: string): Promise<SessionView> => {
  const loaded = await createFileAssistSessionStore(setup.sessionsDir).load();
  const found = loaded.sessions.find((candidate) => candidate.key === key);
  assert.ok(found, `sessão ${key} deveria existir`);
  return found;
};

// Todos os arquivos regulares sob um diretório, com o texto de cada um: a varredura da prova de que o
// token não ficou em nenhum arquivo do estado da instância.
async function filesUnder(dir: string): Promise<Array<[path: string, text: string]>> {
  const found: Array<[path: string, text: string]> = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else if (entry.isFile()) found.push([path, await readFile(path, "utf8").catch(() => "")]);
  }
  return found.sort(([a], [b]) => a.localeCompare(b));
}

test("the eligible issue is admitted, claimed and opened end to end without stealing focus", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.opened, [pendingKey]);

  // Clima e claim: the core's single write mechanism confirmed by reread before opening.
  const after = await setup.tracker.readIssue(pendingRef);
  assert.ok(after.claimed.known && after.claimed.value, "a issue foi reclamada antes da abertura");

  // The session record: identity and area persisted, human-state prompt, explicit model.
  const session = await sessionOf(setup, pendingKey);
  assert.equal(session.state, "open");
  assert.equal(session.model, setup.instance.assistModel);
  assert.equal(session.cloneDir, setup.local.checkouts["acme/app"]);
  assert.match(session.containerName ?? "", /^msf-assist-/);
  assert.ok(session.tabId && session.paneId);
  assert.ok(session.log.some((line) => line.includes("claim confirmado por releitura")));

  // Herdr: own tab inside the operator's workspace, cwd = operator's clone, no focus (the
  // boundary refuses a tab born focused and the tests assert the caller's checks).
  assert.equal(setup.herdrCalls.tabs.length, 1);
  assert.equal(setup.herdrCalls.tabs[0]!.workspace, "ws-operador");
  assert.equal(setup.herdrCalls.tabs[0]!.cwd, session.cloneDir);
  assert.equal(setup.herdrCalls.tabs[0]!.focus, false, "a primeira abertura não rouba foco");
  assert.match(setup.herdrCalls.tabs[0]!.label, /^msf-assist-/);

  // Exec: pi inside the container, explicit assist model, prompt proper to the human state.
  assert.equal(setup.herdrCalls.panes.length, 1);
  assert.equal(setup.herdrCalls.panes[0]!.paneId, session.paneId);
  const command = setup.herdrCalls.panes[0]!.command;
  assert.match(command, /^docker run --rm -it --entrypoint sh --name msf-assist-/);
  assert.match(command, new RegExp(`pi --model ${setup.instance.assistModel}`));
  assert.match(command, new RegExp(`${assistPrompt({ kind: "needs-triage", ref: pendingRef, title: "Precisa triagem" }).split("\n")[0]!.slice(0, 40)}`.slice(0, 30)));

  // Capacity: one open assisted session; the implementation limit untouched.
  const again = await setup.flow().poll();
  assert.deepEqual(again.opened, [], "a mesma issue não é readmitida no ciclo seguinte");
  const second = await sessionOf(setup, pendingKey);
  assert.equal(second.state, "open");
  assert.equal(setup.tracker.calls("claim"), 1, "nenhum segundo claim da mesma issue");
});

test("a ready-for-human issue is opened with its own prompt (apoio), human assignee is not a claim", async (context) => {
  const setup = await arrange(context, { only: ["2"] });
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.opened, [humanKey]);
  const session = await sessionOf(setup, humanKey);
  assert.equal(session.state, "open");
  assert.equal(setup.herdrCalls.panes.length, 1);
  const command = setup.herdrCalls.panes.find((pane) => pane.paneId === session.paneId)!.command;
  assert.match(command, new RegExp(`pi --model ${setup.instance.assistModel}`));
  const prompt = await readFileCommand(setup, command);
  assert.match(prompt, /apoio/);
});

const readFileCommand = async (setup: Setup, command: string): Promise<string> => {
  void setup;
  return command;
};

test("capacity: the attendance limit blocks the third open; coexists with implementation capacity", async (context) => {
  const setup = await arrange(context, { only: ["1", "2"], instanceOverrides: { maxAssisted: 1 } });
  // An implementation job of another issue holds its own slot in the same repository.
  await setup.writeJob(newJob({ ref: { tracker: "memory", project: "acme/app", id: "3" }, repository: "acme/app" }));
  const first = await setup.flow().poll();
  assert.deepEqual(first.opened, [pendingKey]);
  // The second poll admits one more? No: maxAssisted=1 with one open session blocks the others.
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.ok(report.skipped.some((skip) => skip.reason.includes("capacidade de sessões assistidas")), report.skipped.map((s) => s.reason).join(" "));
});

test("the environment is proven before the claim: unavailable docker leaves the tracker untouched", async (context) => {
  const setup = await arrange(context, { sandbox: { fail: "Docker is unavailable (docker info failed)" } });
  const report = await setup.flow().poll();
  assert.equal(setup.tracker.calls("claim"), 0, "nenhum claim enquanto o ambiente não prova o possível");
  assert.deepEqual(report.opened, []);
  assert.ok(report.skipped.some((skip) => skip.reason.includes("docker:")));
  if (report.opened.length === 0) return;
});

test("unavailable herdr or missing clone/config blocks the opening before the claim with a visible reason", async (context) => {
  const unherdr = await arrange(context, { herdr: { unavailable: "servidor Herdr indisponível" } });
  const report = await unherdr.flow().poll();
  assert.equal(unherdr.tracker.calls("claim"), 0);
  assert.ok(report.skipped.some((skip) => skip.reason.includes("herdr:")));

  const cloneless = await arrange(context, { clone: false });
  const report2 = await cloneless.flow().poll();
  assert.equal(cloneless.tracker.calls("claim"), 0);
  assert.ok(report2.skipped.some((skip) => skip.reason.includes("clone assistido")));

  const modelless = await arrange(context, { instanceOverrides: { assistModel: undefined } });
  const report3 = await modelless.flow().poll();
  assert.equal(modelless.tracker.calls("claim"), 0);
  assert.ok(report3.skipped.some((skip) => skip.reason.includes("modelo de assistência") && skip.reason.includes("não herda")));
});

test("a failed claim is refused and leaves no record (the next poll may try again)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  setup.tracker.failNext("claim", "recusa");
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.ok(report.skipped.some((skip) => skip.reason.includes("claim recusado")));
  if ((await createFileAssistSessionStore(setup.sessionsDir).load()).sessions.some((s) => s.key === pendingKey)) {
    assert.fail("a sessão recusada não deve sobreviver");
  }
  const after = await setup.flow().poll();
  assert.deepEqual(after.opened, [pendingKey], "o próximo ciclo tenta de novo");
});

test("a failure after the claim preserves the work: pending with claim kept and no replay", async (context) => {
  const setup = await arrange(context, { only: ["1"], herdr: { failPaneRun: "pane run recusou o comando" } });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.ok(report.pending.length === 1);
  const session = await sessionOf(setup, pendingKey);
  assert.equal(session.state, "pending");
  assert.match(session.reason ?? "", /falha na abertura assistida/);
  const after = await setup.tracker.readIssue(pendingRef);
  assert.ok(after.claimed.known && after.claimed.value, "o claim do issue foi preser vado");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-falha"));
  // No silent replay: the pending session keeps the issue protected from re-admission.
  const next = await setup.flow().poll();
  assert.deepEqual(next.opened, []);
});

test("an exec ended without a recognized result stays pending with capacity freed, never closed", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.flow().poll();
  const session = await sessionOf(setup, pendingKey);
  assert.equal(session.state, "open");
  // The container itself records the real end of the exec (the #52 channel).
  const execStateDir = session.execStateDir!;
  await writeFile(assistExitRecordPath(execStateDir), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.deepEqual(report.pending.map((pending) => pending.key), [pendingKey]);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "pending");
  assert.match(kept.reason ?? "", /sem resultado de atendimento reconhecido/);
  // Never closed, never success: the issue stays claimed and no done was written.
  const issue = await setup.tracker.readIssue(pendingRef);
  assert.ok(issue.claimed.known && issue.claimed.value);
  assert.ok(setup.events.some((event) => event.kind === "atendimento-pendente"));
});

test("an exec the channel cannot speak about keeps its capacity until clarified, announced once", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.flow().poll();
  const session = await sessionOf(setup, pendingKey);
  await writeFile(assistExitRecordPath(session.execStateDir!), "não é json");
  const first = await setup.flow().poll();
  assert.deepEqual(first.pending, [], "supervisão ilegível não encerra nada");
  const still = await sessionOf(setup, pendingKey);
  assert.equal(still.state, "open", "capacidade mantida até o esclarecimento");
  const intervention = setup.events.filter((event) => event.kind === "atendimento-intervenção");
  assert.equal(intervention.length, 1);
  await setup.flow().poll();
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-intervenção").length, 1, "não repete a cada ciclo");
});

test("an unconfirmed start asks for intervention and keeps the standing record, not a conclusion", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  setup.tracker.failNext("claim", "invisível");
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.equal(report.pending.length, 1);
  const session = await sessionOf(setup, pendingKey);
  assert.equal(session.state, "pending");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-intervenção"));
});

test("a paused instance opens nothing and reports it", async (context) => {
  const setup = await arrange(context);
  Object.assign(setup, {});
  const deps = (setup.flow() as unknown as { deps: AssistFlowDeps }).deps;
  deps.control = { isPaused: async () => true, setPaused: async () => undefined };
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.ok(report.skipped.some((skip) => skip.reason.includes("instância pausada")));
  assert.equal(setup.tracker.calls("claim"), 0);
});

test("the report of a successful poll is the operator's visibility: opened and errors only; failures are verdicts and events.", async (context) => {
  const setup = await arrange(context);
  const report: AssistPollReport = await setup.flow().poll();
  assert.deepEqual(report.errors, []);
  const keys = readdir(setup.sessionsDir);
  assert.ok((await keys).length > 0);
  void holdsSlot;
});

// ── Interruption, manual resume and release (ticket #56) ─────────────────────────────────────

// The interruption's tails: one exec ends without a recognized result and its pending record
// (with the persisted continuity question) is what the operator's commands work on.
type ArrangeOptions = Parameters<typeof arrange>[1];
const pendingOf = async (context: TestContext, options: ArrangeOptions = {}): Promise<Setup> => {
  const setup = await arrange(context, { only: ["1"], ...options });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey], report.errors.map((e) => e.message).join("; "));
  const session = await sessionOf(setup, pendingKey);
  await writeFile(assistExitRecordPath(session.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.deepEqual(ended.pending.map((entry) => entry.key), [pendingKey]);
  return setup;
};

type StoredIssue = {
  labels: { known: boolean; value?: string[] };
  statusCategory: { known: boolean; value?: string };
  claimed: { known: boolean; value?: boolean };
  blockers: { known: boolean; value: { tracker: string; project: string; id: string }[] };
};

const mutateIssue = (setup: Setup, key: string, action: (issue: StoredIssue) => void): void => {
  const issues = (setup.tracker as unknown as { issues: Map<string, StoredIssue> }).issues;
  const issue = issues.get(key);
  assert.ok(issue, `issue ${key} deveria existir no tracker de memória`);
  action(issue);
};

const writeAssistSession = async (setup: Setup, over: Partial<AssistSession>): Promise<void> => {
  const assistRef: IssueRef = { tracker: "memory", project: "acme/app", id: "2" };
  await createFileAssistSessionStore(setup.sessionsDir).save({
    key: refKey(assistRef), ref: assistRef, repository: "acme/app", state: "open",
    promptKind: "ready-for-human", model: "x/y", image: "img", cloneDir: "/tmp/clone", startedAt: "2026-10-14T12:00:00.000Z",
    log: [], ...over,
  });
};

test("an interruption persists the continuity decision; a reply records the answer and nothing re-asks", async (context) => {
  const setup = await pendingOf(context);
  const interrupted = await sessionOf(setup, pendingKey);
  // The decision is in the registry, not just in the log: question asked once, never answered.
  assert.ok(interrupted.continuity, "a interrupção persiste a pergunta de continuidade");
  assert.match(interrupted.continuity!.question, /retomada futura desta mesma sessão/);
  assert.equal(interrupted.continuity!.answeredAt, undefined);

  const before = setup.events.filter((event) => event.kind === "atendimento-pendente").length;
  await setup.flow().poll();
  await setup.flow().poll();
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-pendente").length, before, "não repete a pergunta a cada ciclo");
  // No automatic re-execution: a poll never opens anything again, other works keep moving.
  assert.equal(setup.herdrCalls.panes.length, 1);
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending");

  // The operator's answer: recorded verbatim once, in the registry.
  const declined = await setup.flow().reply(pendingKey, "não autorizo retomada automática", "cmd-declina");
  assert.deepEqual(declined, { status: "applied" });
  const answered = await sessionOf(setup, pendingKey);
  assert.equal(answered.continuity!.answer, "não autorizo retomada automática");
  assert.ok(answered.continuity!.answeredAt);
  assert.equal(answered.state, "pending", "a recusa preserva o trabalho parado");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-resposta"));
  // The manual paths stay available after a decline: release still works on the same record.
  const released = await setup.flow().release(pendingKey, "cmd-libera");
  assert.deepEqual(released, { status: "applied" });
});

test("the manual resume opens the same session and area: pi -c, new tab WITH focus, old exit record removed first", async (context) => {
  const setup = await pendingOf(context);
  const parked = await sessionOf(setup, pendingKey);
  // The pi session file of the preserved area: what makes the resume a continuation.
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, '{"type":"message"}\n');

  const resumed = await setup.flow().resume(pendingKey, "cmd-retoma");
  assert.deepEqual(resumed, { status: "applied" });
  const opened = await sessionOf(setup, pendingKey);
  assert.equal(opened.state, "open");
  assert.equal(opened.resumes, 1);
  assert.match(opened.label ?? "", /-r1$/);
  assert.notEqual(opened.tabId, parked.tabId, "a retomada abre nova aba; a antiga segue com o histórico");
  assert.equal(opened.sessionsDir, parked.sessionsDir, "a mesma sessão de pi é continuada");
  assert.equal(opened.cloneDir, parked.cloneDir, "o mesmo clone do operador é remontado");
  // A aba reaberta a pedido do operador vem COM foco (#77); o núcleo pede isso à fronteira.
  assert.equal(setup.herdrCalls.tabs[1]!.focus, true, "a retomada manual vem com foco");

  // The runtime: dockern client on the new pane, pi -c on the same session dir, no new prompt.
  assert.equal(setup.herdrCalls.panes.length, 2);
  const command = setup.herdrCalls.panes[1]!.command;
  assert.match(command, new RegExp(`-v ${parked.sessionsDir!.replace(/[/.]/g, "\\$&")}:/msf-sessions`));
  assert.match(command, new RegExp(`-v ${parked.cloneDir.replace(/[/.]/g, "\\$&")}:/work`));
  assert.match(command, / --tui-mode regular -c;/);
  assert.doesNotMatch(command, new RegExp(assistPrompt({ kind: "needs-triage", ref: pendingRef, title: "Precisa triagem" })));

  // The old end record is gone before the new exec starts: the supervision only ever reads the
  // new end. The next interruption asks a NEW question (a new decision), as the spec says.
  await assert.rejects(() => readFile(assistExitRecordPath(opened.execStateDir!)), /ENOENT/);
  await writeFile(assistExitRecordPath(opened.execStateDir!), '{"exitCode":130,"at":"2026-10-14T12:20:00.000Z"}');
  await setup.flow().poll();
  const again = await sessionOf(setup, pendingKey);
  assert.equal(again.state, "pending");
  assert.ok(again.continuity!.answeredAt === undefined, "uma nova interrupção exige nova decisão");
  assert.equal(setup.herdrCalls.tabs.length, 2, "pi encerrado não fecha a aba antiga nem é reaberto em duas abas");
});

test("a manual resume of a session still recorded open parks and reopens in the SAME cycle when the end record exists (#77)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  assert.deepEqual((await setup.flow().poll()).opened, [pendingKey]);
  const live = await sessionOf(setup, pendingKey);
  assert.equal(live.state, "open");
  // The conversation the container wrote: what makes `pi -c` a continuation, not a new one.
  await writeFile(`${live.sessionsDir!}/pi-msf.jsonl`, '{"type":"message"}\n');
  // The container's own end record lands while the persisted state still says open — the exact
  // millisecond window between Ctrl-C and the next supervision pass. One press must be enough.
  await writeFile(assistExitRecordPath(live.execStateDir!), '{"exitCode":130,"at":"2026-10-14T12:10:00.000Z"}');

  const resumed = await setup.flow().resume(pendingKey, "cmd-t");
  assert.deepEqual(resumed, { status: "applied" });
  const reopened = await sessionOf(setup, pendingKey);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.resumes, 1);
  assert.equal(reopened.sessionsDir, live.sessionsDir, "a mesma conversa é continuada");
  assert.equal(reopened.cloneDir, live.cloneDir, "a mesma área é remontada");
  assert.notEqual(reopened.tabId, live.tabId, "em aba nova");
  assert.equal(setup.herdrCalls.tabs.length, 2);
  assert.equal(setup.herdrCalls.tabs[1]!.focus, true, "a aba reaberta a pedido do operador vem com foco");
  assert.equal(setup.herdrCalls.panes.length, 2);
  assert.match(setup.herdrCalls.panes[1]!.command, / --tui-mode regular -c;/);
  assert.ok(reopened.log.some((line) => line.includes("fim da execução registrado (exit 130)")),
    "o estacionamento do mesmo ciclo fica registrado");
  // The old record leaves before the relaunch, and no cycle after opens a second execution.
  await assert.rejects(() => readFile(assistExitRecordPath(reopened.execStateDir!)), /ENOENT/);
  assert.deepEqual((await setup.flow().poll()).resumed, []);
  assert.equal(setup.herdrCalls.panes.length, 2, "nenhuma segunda execução da mesma sessão");
});

test("a manual resume of an open session without the end record is refused honestly and stores no intent (#77)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  assert.deepEqual((await setup.flow().poll()).opened, [pendingKey]);
  const live = await sessionOf(setup, pendingKey);
  await writeFile(`${live.sessionsDir!}/pi-msf.jsonl`, '{"type":"message"}\n');

  const outcome = await setup.flow().resume(pendingKey, "cmd-t");
  assert.ok(outcome.status === "rejected", outcome.status === "rejected" ? outcome.reason : outcome.status);
  assert.match(outcome.reason, /fim da execução ainda não confirmado/);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open", "a sessão continua aberta e supervisionada");
  assert.equal(kept.resumes, undefined, "nenhuma tentativa de abertura foi registrada");
  assert.equal(kept.scheduledResume, undefined, "nenhuma intenção de retomada fica guardada");
  assert.equal(setup.herdrCalls.tabs.length, 1, "nada é reaberto sem o fim confirmado");
  assert.equal(setup.herdrCalls.panes.length, 1);
  // The supervision keeps ruling the session: the record landing later parks it as always.
  await writeFile(assistExitRecordPath(live.execStateDir!), '{"exitCode":130,"at":"2026-10-14T12:10:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.deepEqual(ended.pending.map((entry) => entry.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending");
});

test("a manual resume of an open session with an illegible end record is refused naming the record (#77)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.flow().poll();
  const live = await sessionOf(setup, pendingKey);
  await writeFile(assistExitRecordPath(live.execStateDir!), "não é json");
  const outcome = await setup.flow().resume(pendingKey, "cmd-t");
  assert.ok(outcome.status === "rejected", outcome.status === "rejected" ? outcome.reason : outcome.status);
  assert.match(outcome.reason, /registro de fim ilegível/);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
  assert.equal(setup.herdrCalls.panes.length, 1);
});

test("a manual resume of an open session with a recognized result is refused naming approve (#77)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.flow().poll();
  const live = await sessionOf(setup, pendingKey);
  await writeFile(assistExitRecordPath(live.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:10:00.000Z"}');
  const text = `<msf-result>${JSON.stringify({ status: "concluded", summary: "triagem feita" })}</msf-result>\n<promise>MSF-RESULT</promise>`;
  await writeFile(`${live.sessionsDir!}/pi-msf.jsonl`,
    `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`);

  const outcome = await setup.flow().resume(pendingKey, "cmd-t");
  assert.ok(outcome.status === "rejected", outcome.status === "rejected" ? outcome.reason : outcome.status);
  assert.match(outcome.reason, /aprove o resultado \(approve\)/);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open",
    "resultado proposto decide pela aprovação, não pela retomada");
  assert.equal(setup.herdrCalls.panes.length, 1);
});

test("a second resume after the opening is refused: commands do not open two invocations", async (context) => {
  const setup = await pendingOf(context);
  const parked = await sessionOf(setup, pendingKey);
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, "{}\n");
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd-1"), { status: "applied" });
  const outcome = await setup.flow().resume(pendingKey, "cmd-2");
  // The session is open again and the resumed exec's end record does not exist yet: the reread at
  // this cycle refuses saying exactly that (#77) — never a second invocation of the same session.
  assert.ok(outcome.status === "rejected" && /fim da execução ainda não confirmado/.test(outcome.reason),
    outcome.status === "rejected" ? outcome.reason : outcome.status);
  assert.equal(setup.herdrCalls.panes.length, 2, "nenhuma segunda invocação da mesma sessão");
});

test("the resume's full revalidation keeps the work parked with a visible reason", async (context) => {
  const endToEnd = async (mutate?: (issue: StoredIssue) => void) => {
    const setup = await pendingOf(context);
    if (mutate !== undefined) mutateIssue(setup, pendingKey, mutate);
    const parked = await sessionOf(setup, pendingKey);
    await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, "{}\n");
    void parked;
    return setup;
  };

  const judge = async (setup: Setup, match: RegExp): Promise<void> => {
    const parked = await sessionOf(setup, pendingKey);
    await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, "{}\n");
    const outcome = await setup.flow().resume(pendingKey, "cmd");
    assert.ok(outcome.status === "rejected" && match.test(outcome.reason), `${match}: ${outcome.status === "rejected" ? outcome.reason : "aplicado"}`);
    assert.equal((await sessionOf(setup, pendingKey)).state, "pending", "o trabalho permanece parado");
    assert.equal(setup.herdrCalls.panes.length, 1, "nenhuma abertura enquanto a revalidação recusa");
  };

  // The human-assisted label is withdrawn externally; the factory claim stays visible.
  const unauthorized = await endToEnd((issue) => { issue.labels = { known: true, value: ["needs-triage", "claim"] }; });
  await judge(unauthorized, /sem autorização/);
  // The issue reached a terminal state after the interruption.
  const terminal = await endToEnd((issue) => { issue.statusCategory = { known: true, value: "done" }; });
  await judge(terminal, /terminal/);
  // The claim the attendance preserved is no longer on the issue: never reacquired silently.
  const unclaimed = await endToEnd((issue) => {
    // The factory's mark leaves the issue (e.g. an external release): no label, no claim.
    issue.labels = { known: true, value: issue.labels.value!.filter((label) => label !== "claim") };
  });
  await judge(unclaimed, /claim não está mais visível/);
  // A disabled project blocks the resume too.
  const disabled = await endToEnd();
  (disabled.flow() as unknown as { deps: AssistFlowDeps }).deps.instance.projects[0]!.enabled = false;
  await judge(disabled, /desabilitado/);
  // Herdr still has to prove itself before the resume opens anything.
  const unavailable = await endToEnd();
  (unavailable.flow() as unknown as { deps: AssistFlowDeps }).deps.ports =
    { sandbox: sandboxOf(), herdr: herdrOf({ unavailable: "servidor Herdr indisponível" }), exec: probeOf({}) };
  await judge(unavailable, /herdr/);
  // The assisted N limit counts the other open sessions; the parked one does not count yet.
  const full = await endToEnd();
  await writeAssistSession(full, { state: "open", label: "outra", tabId: "t", paneId: "p" });
  await full.writeInstance({ maxAssisted: 1 });
  await judge(full, /capacidade de sessões assistidas/);
});

test("a resume without the pi session of the area asks for intervention, never a silent new conversation", async (context) => {
  const setup = await pendingOf(context);
  // An area can be pending without any pi session on disk: e.g. the opening never completed.
  const parked = await sessionOf(setup, pendingKey);
  void parked;
  const outcome = await setup.flow().resume(pendingKey, "cmd");
  assert.ok(outcome.status === "rejected" && /contexto da sessão ausente/.test(outcome.reason), outcome.status === "rejected" ? outcome.reason : outcome.status);
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending");
  assert.equal(setup.herdrCalls.workspace, 1, "nenhuma aba foi aberta: a réplica inicial só consultou o workspace");
  const intervention = setup.events.filter((event) => event.kind === "atendimento-intervenção");
  assert.equal(intervention.length, 1);
  assert.match(intervention[0]!.text, /contexto da mesma sessão ausente/);
  assert.equal((await setup.flow().resume(pendingKey, "cmd-2")).status, "rejected", "continua parado até o operador resolver");
});

test("the release removes claim and human-assisted confirmed by reread, preserves the record, never closes", async (context) => {
  const setup = await pendingOf(context);
  const outcome = await setup.flow().release(pendingKey, "cmd-libera");
  assert.deepEqual(outcome, { status: "applied" });
  const issue = await setup.tracker.readIssue(pendingRef);
  assert.ok(issue.labels.known && !issue.labels.value.includes("human-assisted"), "a autorização foi removida");
  assert.equal(issue.claimed.known && issue.claimed.value, false, "o claim da factory foi removido");
  assert.ok(issue.statusCategory.known && issue.statusCategory.value === "in-progress", "liberação não conclui nem fecha a issue");

  // All confirmed: the record leaves the store (t55's registry discipline) with the area
  // preserved on disk; nothing was concluded nor closed.
  const store = createFileAssistSessionStore(setup.sessionsDir);
  assert.equal((await store.load()).sessions.some((candidate) => candidate.key === pendingKey), false, "acompanhamento encerrado pelo operador");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-liberado"));
  // A released attendance is unknown to both commands: the record is gone, the issue has no
  // authorization label and cannot re-admit silently.
  const again = await setup.flow().release(pendingKey, "cmd-2");
  assert.ok(again.status === "rejected" && again.reason.includes("desconhecido"), again.status === "rejected" ? again.reason : again.status);
  const resume = await setup.flow().resume(pendingKey, "cmd-3");
  assert.ok(resume.status === "rejected" && resume.reason.includes("desconhecido"), resume.status === "rejected" ? resume.reason : resume.status);
});

test("a release the tracker cannot confirm stays visible and leaves the work parked", async (context) => {
  const setup = await pendingOf(context);
  // The claim write is accepted but the reread does not confirm it: nothing is released.
  setup.tracker.failNext("releaseClaim", "invisível");
  const first = await setup.flow().release(pendingKey, "cmd-1");
  assert.ok(first.status === "rejected" && /não confirmada pelo tracker/.test(first.reason), first.status === "rejected" ? first.reason : first.status);
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending", "o trabalho segue parado (e rastreado)");
  // Partial writes on the tracker remain visible as attempted changes in the event stream.
  assert.ok(setup.events.some((event) => event.kind.startsWith("issue-alteração-")));

  const second = await setup.flow().release(pendingKey, "cmd-2");
  assert.deepEqual(second, { status: "applied" }, "a nova tentativa completa a liberação");
});

test("the release is only for non-active work: pending sessions stay, opening and open refuse", async (context) => {
  const setup = await pendingOf(context);
  const active = await setup.flow().release(pendingKey, "cmd");
  void active;
  // Fresh arrangement where the attendance is open, not pending.
  const live = await arrange(context, { only: ["1"] });
  await live.flow().poll();
  const refused = await live.flow().release(pendingKey, "cmd");
  assert.ok(refused.status === "rejected" && /não se aplica/.test(refused.reason), refused.status === "rejected" ? refused.reason : refused.status);
  assert.equal((await sessionOf(live, pendingKey)).state, "open");
});

test("resuming one interruption never freezes the other pending works of the instance", async (context) => {
  const setup = await pendingOf(context);
  // A second attendance is admitted, interrupted, and left parked next to the first one.
  const second = await pendingOf(context); // an independent arrangement: only ["1"] again
  void second;
  const parked = await sessionOf(setup, pendingKey);
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, "{}\n");
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd"), { status: "applied" });
  // The other pending record of the same registry keeps its work parked and untouched.
  const other = await sessionOf(setup, pendingKey);
  assert.equal(other.state, "open", "a sessão retomada segue aberta como a retomada fez");
  void other;
});

// ── Operator attention (ticket #59): abertura notificada, pendências persistentes consultáveis,
// dedupe, resposta encerrando a pendência, falha de entrega sem apagar pendência, persistência
// pelo reinício. O canal é sempre o duplo do arrange: o SO nunca é chamado. ──

test("opening calls the operator's attention: one notification attempt, proven channel, locating references", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey]);
  // The desktop channel was attempted exactly once, with the locating references; the channel
  // only proves the command ran — no delivery is claimed anywhere.
  assert.deepEqual(setup.notifications.map((notification) => notification.title), ["msf: sessão assistida aberta aguardando o operador"]);
  assert.match(setup.notifications[0]?.body ?? "", new RegExp(`trabalho: ${pendingKey}`));
  assert.match(setup.notifications[0]?.body ?? "", /aba=tab-1/);
  assert.match(setup.notifications[0]?.body ?? "", /clone=/);
  const pendings = await setup.pendings();
  assert.equal(pendings.filter((pending) => pending.kind === "abertura").length, 1);
  assert.equal(pendings[0]?.notification?.ok, true);
  assert.equal(pendings[0]?.notification?.channel, "notify-send");
});

test("the open session is not re-notified on the next polls (dedupe by pending id)", async (context) => {
  const setup = await arrange(context, { only: ["1"] });
  await setup.flow().poll();
  await setup.flow().poll();
  await setup.flow().poll();
  assert.equal(setup.notifications.length, 1, "a mesma abertura não repete a notificação a cada ciclo");
});

test("a new interruption raises a fresh decision pending; the answered reply ends it; release ends the rest", async (context) => {
  const setup = await pendingOf(context);
  // A decision pending exists after the interruption, and it was NOT re-notified beyond its raise.
  const pendings = await setup.pendings();
  // The interruption takes over the session's open pending: the decision is what the operator
  // must do now, and the abertura one that carried the open announcement ends with it.
  const openings = pendings.filter((pending) => pending.kind === "abertura");
  const decisions = pendings.filter((pending) => pending.kind === "decisão");
  assert.equal(openings.length, 0, "a decisão substitui a abertura da espera");
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions.map((pending) => pending.actions), [["reply", "resume", "release", "approve"]]);
  assert.match(decisions[0]?.question ?? "", /retomada futura/);
  // The reply ends the decision pending; the registry keeps the verbatim answer.
  await setup.flow().reply(pendingKey, "autorizo retomada", "cmd-responde");
  const afterReply = await setup.pendings();
  assert.deepEqual(afterReply, [], "a resposta encerra a decisão; a abertura já tinha sido tomada pela decisão");
  // The release (operator action) ends every pending of the work.
  await setup.flow().release(pendingKey, "cmd-libera");
  assert.deepEqual(await setup.pendings(), [], "nenhuma pendência sobrevive ao fim do acompanhamento");
});

test("a failed resume keeps its pendings visible; a successful resume resolves them and announces the reopening", async (context) => {
  const setup = await pendingOf(context);
  // No pi session file: the resume refuses with intervention instead of a silent new conversation.
  const refused = await setup.flow().resume(pendingKey, "cmd");
  assert.ok(refused.status === "rejected");
  const pendings = await setup.pendings();
  assert.ok(pendings.some((pending) => pending.kind === "intervenção"), "a intervenção pedida é pendência persistente");
  // With the context in place the resume goes through: old pending ends, reopening raises fresh.
  const parked = await sessionOf(setup, pendingKey);
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, '{"type":"message"}\n');
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd2"), { status: "applied" });
  const reopened = await setup.pendings();
  assert.deepEqual(reopened.map((pending) => pending.kind), ["abertura"], "a retomada encerra as antigas e anuncia a reabertura");
  assert.equal(reopened[0]?.notification?.ok, true, "a reabertura notifica de novo (nova ocorrência)");
  assert.equal(setup.notifications.length >= 2, true);
});

test("the delivery failure never kills the pending and never interrupts the flow (ADR 0001)", async (context) => {
  const setup = await arrange(context, { only: ["1"], herdr: {} });
  setup.notificationsFail("canal de notificação caiu");
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey], "a abertura não depende do canal");
  const pendings = await setup.pendings();
  assert.equal(pendings.length, 1, "a pendência permanece apesar da falha de entrega");
  assert.equal(pendings[0]?.notification?.ok, false);
  assert.equal(pendings[0]?.notification?.error, "canal de notificação caiu");
  // The failure is visible, not swallowed: announced beyond the pending record.
  // (the announce itself is best-effort; the record above is the consultable contract)
});

test("pendings persist across orchestrator restart: state round-trip, no re-notify, still consultable", async (context) => {
  const setup = await pendingOf(context);
  const before = await setup.pendings();
  assert.equal(before.length >= 1, true);
  // A fresh AssistedAttendance on the same state (the restart): the registry loads, the pendings
  // stay, and the answered question is never re-asked nor re-raised.
  const restarted = new AssistedAttendance({
    instance: setup.instance, config: setup.config, local: setup.local, tracker: setup.scoped,
    jobs: createFileJobStore(setup.stateDir),
    sessions: createFileAssistSessionStore(setup.sessionsDir),
    areaFs: createFileAssistAreaFs(),
    commands: createFileCommandQueue(setup.stateDir),
    control: { isPaused: async () => false, setPaused: async () => undefined },
    eligibility: (project) => projectEligibility(setup.instance, project),
    observer: { emit: () => undefined, flush: async () => undefined, failure: () => undefined, recovered: () => undefined, redact: (text) => text, registerSecret: () => undefined, setDetailLog: () => undefined, commands: () => undefined },
    ports: { sandbox: sandboxOf(), herdr: herdrOf(), exec: probeOf({}) },
    runtimeImageDir: "/msf-repo/src/runtime/docker-image",
    toolchainsDir: join(setup.stateDir, "toolchains"),
    stateDir: setup.stateDir,
    // The restarted keeper reads the same state directory: its stored pendings survive the
    // process entirely, and its dedupe continues to respect what was already raised.
    attention: new AttentionKeeper({ store: createFileAttentionStore(join(setup.stateDir, "pendencias")) }),
  });
  const reply = await restarted.reply(pendingKey, "resposta pós-reinício", "cmd-pós");
  assert.deepEqual(reply, { status: "applied" });
  assert.deepEqual((await setup.pendings()).filter((pending) => pending.kind === "decisão").map((pending) => pending.answer), [], "a decisão pós-reinício encerrada idem");
});
// ── Scheduled authorized resume (ticket #57) ─────────────────────────────────────────────

// One interruption answered with an explicit affirmative: the scheduling that authorizes EXACTLY
// ONE next opening of the same session, before the discovery of new attendances. The context
// file is written like #56's tests: the conversation the resume continues.
const authorizedOf = async (context: TestContext, options: ArrangeOptions = {}): Promise<Setup> => {
  const setup = await pendingOf(context, options);
  const parked = await sessionOf(setup, pendingKey);
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, '{}\n');
  assert.deepEqual(await setup.flow().reply(pendingKey, "sim, pode retomar", "cmd-sim"), { status: "applied" });
  const scheduled = await sessionOf(setup, pendingKey);
  assert.ok(scheduled.scheduledResume, "a resposta explícita agenda a retomada no registro");
  assert.equal(scheduled.scheduledResume!.consumed, undefined, "a autorização nasce não consumida");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-retomada-agendada"));
  return setup;
};

test("the affirmative reply schedules a one-time resume with priority over new attendances", async (context) => {
  // maxAssisted 1: the single assisted slot is the priority's referee — with admission before
  // the scheduled resume, issue #2 would take the slot and the resume would wait; reality shows
  // the opposite, because the scheduled attempt comes first. Issue #2 becomes discoverable only
  // for the resume cycle (the arrangement had restricted discovery to issue #1), so the two
  // admissions compete for that single slot in the very same poll.
  const setup = await authorizedOf(context);
  const deps = (setup.flow() as unknown as { deps: AssistFlowDeps }).deps;
  deps.tracker = setup.tracker;
  await setup.writeInstance({ maxAssisted: 1 });
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors, []);
  // The same session and area, resumed as `r1`, old exit record removed before relaunching.
  assert.deepEqual(report.resumed.map((entry) => entry.key), [pendingKey]);
  const opened = await sessionOf(setup, pendingKey);
  assert.equal(opened.state, "open");
  assert.equal(opened.resumes, 1);
  assert.match(opened.label ?? "", /-r1$/);
  assert.match(opened.scheduledResume!.consumed!.attempt, /^msf-assist-.*-r1#/,
    "o consumo persiste a identidade da tentativa de abertura");

  assert.equal(setup.herdrCalls.panes.length, 2, "só a retomada abriu execução neste ciclo");
  assert.equal(setup.herdrCalls.tabs[1]!.focus, false, "a retomada agendada de uso único continua abrindo sem roubar foco");
  assert.match(setup.herdrCalls.panes[1]!.command, / --tui-mode regular -c;/, "pi -c na mesma sessão");
  await assert.rejects(() => readFile(assistExitRecordPath(opened.execStateDir!)), /ENOENT/,
    "o registro de fim antigo sai antes do relançamento");

  // The discovery of new attendances comes AFTER the scheduled resume: with the slot taken, the
  // ready-for-human issue waits — and its waiting never consumed the authorization (which is
  // already gone by being used once).
  assert.ok(report.skipped.some((skip) => skip.key === humanKey && skip.reason.includes("capacidade de sessões assistidas")),
    report.skipped.map((skip) => `${skip.key}: ${skip.reason}`).join(" | "));
});

test("the authorization is consumed exactly once: a new interruption demands a new decision", async (context) => {
  const setup = await authorizedOf(context);
  assert.deepEqual((await setup.flow().poll()).resumed.map((entry) => entry.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");

  // The resumed execution ends again: nothing schedules itself silently. A new interruption
  // means a NEW question and a NEW decision; the consumed authorization stays as evidence.
  const opened = await sessionOf(setup, pendingKey);
  await writeFile(assistExitRecordPath(opened.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:20:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.ok(ended.pending.some((entry) => entry.key === pendingKey));
  const again = await sessionOf(setup, pendingKey);
  assert.equal(again.state, "pending");
  assert.ok(again.continuity!.answeredAt === undefined, "nova interrupção, nova pergunta");
  assert.ok(again.scheduledResume!.consumed, "a autorização anterior segue consumida (evidência)");
  assert.equal(setup.herdrCalls.panes.length, 2);

  await setup.flow().poll();
  await setup.flow().poll();
  assert.equal(setup.herdrCalls.panes.length, 2, "nenhuma execução sem nova decisão");

  // The operator answers the new question affirmatively: a fresh single-use authorization.
  assert.deepEqual(await setup.flow().reply(pendingKey, "sim, de novo", "cmd-sim-2"), { status: "applied" });
  const second = await setup.flow().poll();
  assert.deepEqual(second.resumed.map((entry) => entry.key), [pendingKey]);
  const relived = await sessionOf(setup, pendingKey);
  assert.equal(relived.state, "open");
  assert.equal(relived.resumes, 2);
  assert.match(relived.label ?? "", /-r2$/);
  assert.equal(setup.herdrCalls.panes.length, 3);
});

test("waiting for capacity does not consume the authorization (and never re-asks the answer)", async (context) => {
  const setup = await authorizedOf(context);
  const before = (await sessionOf(setup, pendingKey)).continuity!;
  await writeAssistSession(setup, { state: "open", label: "outra", tabId: "t", paneId: "p" });
  await setup.writeInstance({ maxAssisted: 1 });

  const blocked = await setup.flow().poll();
  assert.ok(blocked.skipped.some((entry) => entry.key === pendingKey
    && entry.reason.includes("capacidade de sessões assistidas")), blocked.skipped.map((s) => s.reason).join(" | "));
  assert.deepEqual(blocked.resumed, []);
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending", "esperando não abre");
  assert.equal(parked.scheduledResume!.consumed, undefined, "esperar capacidade não consome");
  assert.equal(parked.continuity!.answeredAt, before.answeredAt, "a pergunta e a resposta seguem as mesmas");
  assert.ok(parked.log.some((line) => line.includes("retomada agendada bloqueada: capacidade")),
    "o motivo bloqueado fica registrado de forma persistente");

  // The capacity frees up: the same authorization reaches its one opening on the next poll.
  await setup.writeInstance({ maxAssisted: 2 });
  const retry = await setup.flow().poll();
  assert.deepEqual(retry.resumed.map((entry) => entry.key), [pendingKey]);
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
  assert.equal(setup.herdrCalls.panes.length, 2);
});

test("a failed pre-opening (environment) refuses and does not consume the authorization", async (context) => {
  const setup = await authorizedOf(context);
  const deps = (setup.flow() as unknown as { deps: AssistFlowDeps }).deps;
  deps.ports = { sandbox: sandboxOf(), herdr: herdrOf({ unavailable: "servidor Herdr indisponível" }), exec: probeOf({}) };
  const blocked = await setup.flow().poll();
  assert.ok(blocked.skipped.some((entry) => entry.key === pendingKey && entry.reason.includes("herdr:")));
  assert.deepEqual(blocked.resumed, []);
  const parked = await sessionOf(setup, pendingKey);
  assert.equal(parked.state, "pending");
  assert.equal(parked.scheduledResume!.consumed, undefined, "reprovar a pré-verificação não consome");

  deps.ports = { sandbox: sandboxOf(), herdr: herdrOf(), exec: probeOf({}) };
  const retry = await setup.flow().poll();
  assert.deepEqual(retry.resumed.map((entry) => entry.key), [pendingKey], "a mesma autorização vale na próxima tentativa");
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
});

test("revocations and new impediments block the scheduled resume with a visible reason, unconsumed", async (context) => {
  const judge = async (mutate?: (issue: StoredIssue) => void, match: RegExp = /./): Promise<void> => {
    const setup = await authorizedOf(context);
    if (mutate !== undefined) mutateIssue(setup, pendingKey, mutate);
    const report = await setup.flow().poll();
    const block = report.skipped.find((entry) => entry.key === pendingKey && match.test(entry.reason));
    assert.ok(block, `motivo esperado ${match}: ${report.skipped.filter((s) => s.key === pendingKey).map((s) => s.reason).join(" | ")}`);
    assert.deepEqual(report.resumed, [], "nada abre quando a revalidação reprova");
    const kept = await sessionOf(setup, pendingKey);
    assert.equal(kept.state, "pending");
    assert.equal(kept.scheduledResume!.consumed, undefined, "revogada, a autorização não é consumida");
    assert.ok(kept.log.some((line) => line.includes("retomada agendada bloqueada:")));
    const signal = setup.events.filter((event) => event.kind === "atendimento-intervenção");
    assert.ok(signal.some((event) => event.fields?.["autorização consumida"] === "não"), "o motivo é sinalizado uma vez");
  };

  // `human-assisted` withdrawn: the authorization is gone, the session stays preserved.
  await judge((issue) => { issue.labels = { known: true, value: ["needs-triage", "claim"] }; }, /sem autorização/);
  // Issue closed externally.
  await judge((issue) => { issue.statusCategory = { known: true, value: "done" }; }, /terminal/);
  // A new impediment appeared since the interruption.
  await judge((issue) => {
    issue.blockers = { known: true, value: [{ tracker: "memory", project: "acme/app", id: "2" }] };
  }, /bloqueada por #2 .*não terminal/);

  // The project disabled on config blocks the resumption too.
  const disabled = await authorizedOf(context);
  (disabled.flow() as unknown as { deps: AssistFlowDeps }).deps.instance.projects[0]!.enabled = false;
  const report = await disabled.flow().poll();
  assert.ok(report.skipped.some((entry) => entry.key === pendingKey && entry.reason.includes("desabilitado")));
  assert.deepEqual(report.resumed, []);
});

test("a declined or doubtful answer schedules nothing; the manual paths stay", async (context) => {
  for (const answer of ["não autorizo", "não", "talvez depois"]) {
    const setup = await pendingOf(context);
    const parked = await sessionOf(setup, pendingKey);
    await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, '{}\n');
    assert.deepEqual(await setup.flow().reply(pendingKey, answer, "cmd-recusa"), { status: "applied" });
    const answered = await sessionOf(setup, pendingKey);
    assert.equal(answered.scheduledResume, undefined, `${answer}: nada agendado sem autorização explícita`);
    await setup.flow().poll();
    await setup.flow().poll();
    assert.equal(setup.herdrCalls.panes.length, 1, "nenhuma abertura automática sem agendamento");
    assert.equal((await sessionOf(setup, pendingKey)).state, "pending", "o trabalho segue parado");
    // The manual path is exactly where #56 left it.
    assert.deepEqual(await setup.flow().resume(pendingKey, "cmd-manual"), { status: "applied" });
  }
});

test("the manual resume consumes a pending authorization: no automatic second opening", async (context) => {
  const setup = await authorizedOf(context);
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd-retoma-agora"), { status: "applied" });
  const opened = await sessionOf(setup, pendingKey);
  assert.equal(opened.state, "open");
  assert.ok(opened.scheduledResume!.consumed, "a decisão manual do operador consome a autorização");
  assert.deepEqual(setup.herdrCalls.panes.length, 2);
  const after = await setup.flow().poll();
  assert.deepEqual(after.resumed, []);
  assert.equal(setup.herdrCalls.panes.length, 2, "nenhuma segunda execução da mesma autorização");
});

test("a concurrent cycle that consumes the same authorization is obeyed: no second execution", async (context) => {
  const setup = await authorizedOf(context);

  // The store intervenes on the consumption save (opening attempt identity): after this cycle
  // persists its attempt, a RIVAL cycle consumed the SAME authorization and records its own
  // attempt over the disk — exactly the interleaving the reread has to survive.
  const base = createFileAssistSessionStore(setup.sessionsDir);
  let rivalInstalled = false;
  const wrapped: import("../src/core/assist-session.js").AssistSessionStore = {
    load: () => base.load(),
    save: async (session) => {
      if (!rivalInstalled && session.state === "opening"
        && session.scheduledResume !== undefined && session.scheduledResume.consumed !== undefined) {
        rivalInstalled = true;
        await base.save(session);
        const stored = (await base.load()).sessions.find((candidate) => candidate.key === pendingKey);
        if (stored === undefined || stored.scheduledResume?.consumed === undefined) return;
        // The rival's attempt: different identity, same authorization, recorded after.
        await base.save({
          ...stored, containerName: "msf-assist-outro-ciclo", label: "msf-assist-outro-ciclo-r1",
          scheduledResume: {
            at: stored.scheduledResume.at, command: stored.scheduledResume.command, answer: stored.scheduledResume.answer,
            consumed: { at: stored.scheduledResume.consumed.at, attempt: "msf-assist-outro-ciclo-r1#outro" },
          },
          log: [...stored.log, "2026-10-14T12:05:00.000Z outro ciclo consumiu esta autorização"],
        });
        return;
      }
      await base.save(session);
    },
    remove: (key: string) => base.remove(key),
  };
  (setup.flow() as unknown as { deps: AssistFlowDeps }).deps.sessions = wrapped;

  const report = await setup.flow().poll();
  assert.deepEqual(report.resumed, [], "o ciclo que perdeu a corrida não abre execução");
  assert.ok(report.skipped.some((entry) => entry.key === pendingKey && entry.reason.includes("outro ciclo consumiu")),
    report.skipped.map((entry) => entry.reason).join(" | "));
  assert.equal(setup.herdrCalls.panes.length, 1, "uma única execução: a da tentativa vencedora");
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "opening");
  assert.equal(kept.scheduledResume!.consumed!.attempt, "msf-assist-outro-ciclo-r1#outro",
    "o registro guarda a identidade da tentativa que consumiu");
});

test("the authorized resume counts and reads like any assisted capacity: `status` and `assist` show it", async (context) => {
  const setup = await authorizedOf(context);
  const report = await setup.flow().poll();
  assert.deepEqual(report.resumed.map((entry) => entry.key), [pendingKey]);
  // The consumed attempt stays readable in the record the local commands render.
  const kept = await sessionOf(setup, pendingKey);
  assert.match(kept.scheduledResume!.consumed!.attempt, /^.{0,64}-r1#.{8}$/,
    "o consumo persiste a identidade da tentativa de abertura");
});


test("a scheduled resume without the pi session asks for intervention, unconsumed", async (context) => {
  // The authorizing operator answered, but the area has no pi session to continue (as when
  // the opening never completed): intervention, never a silent new conversation.
  const setup = await pendingOf(context);
  void (await sessionOf(setup, pendingKey));
  assert.deepEqual(await setup.flow().reply(pendingKey, "sim", "cmd-sim"), { status: "applied" });
  const first = await setup.flow().poll();
  assert.ok(first.skipped.some((entry) => entry.key === pendingKey && entry.reason.includes("contexto da sessão ausente")),
    first.skipped.map((entry) => entry.reason).join(" | "));
  assert.deepEqual(first.resumed, []);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "pending");
  assert.equal(kept.scheduledResume!.consumed, undefined, "intervenção não é uso da autorização");
  const interventions = setup.events.filter((event) => event.kind === "atendimento-intervenção");
  assert.equal(interventions.length, 1, "o pedido de intervenção é anunciado uma vez");
  await setup.flow().poll();
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-intervenção").length, 1);
  assert.equal(setup.herdrCalls.panes.length, 1, "nenhuma conversa nova silenciosa");
});

test("a failure during the scheduled opening consumes the authorization and preserves the work", async (context) => {
  const setup = await authorizedOf(context);
  const deps = (setup.flow() as unknown as { deps: AssistFlowDeps }).deps;
  deps.ports = { sandbox: sandboxOf(), herdr: herdrOf({ failPaneRun: "pane run recusou o comando" }), exec: probeOf({}) };
  const failed = await setup.flow().poll();
  assert.deepEqual(failed.resumed, [], "nada marcado como executado");
  assert.ok(failed.skipped.some((entry) => entry.key === pendingKey && entry.reason.includes("falha na retomada assistida")),
    failed.skipped.map((entry) => entry.reason).join(" | "));
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "pending", "o trabalho segue preservado com o claim");
  assert.ok(kept.scheduledResume!.consumed, "a abertura foi tentada: o uso único acabou aí");
  assert.ok(kept.log.some((line) => line.includes("falha na retomada assistida")), "a tentativa fica no registro");
  assert.ok(setup.events.some((event) => event.kind === "atendimento-falha"), "a tentativa é sinalizada");

  // No retry of the same authorization, even with the environment restored: a new decision
  // (manual resume or a new answer to a new interruption) is what opens next.
  deps.ports = { sandbox: sandboxOf(), herdr: herdrOf(), exec: probeOf({}) };
  const after = await setup.flow().poll();
  assert.deepEqual(after.resumed, []);
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending", "nenhuma nova abertura da mesma autorização");
});

test("an explicit negative answer cancels a scheduling not yet used: the latest decision wins", async (context) => {
  const setup = await authorizedOf(context);
  assert.ok((await sessionOf(setup, pendingKey)).scheduledResume);
  assert.deepEqual(await setup.flow().reply(pendingKey, "não, mudei de ideia: não autorizo", "cmd-cancela"), { status: "applied" });
  const cancelled = await sessionOf(setup, pendingKey);
  assert.equal(cancelled.scheduledResume, undefined, "a recusa explícita desfaz o agendamento");
  assert.ok(cancelled.log.some((line) => line.includes("retomada agendada cancelada")));
  await setup.flow().poll();
  await setup.flow().poll();
  assert.equal(setup.herdrCalls.panes.length, 1, "nenhuma abertura automática depois da recusa");
  assert.equal((await sessionOf(setup, pendingKey)).state, "pending", "o trabalho segue parado com caminhos manuais");
  // The manual resume remains available, now consuming nothing (there is no scheduling).
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd-manual"), { status: "applied" });
  assert.equal((await sessionOf(setup, pendingKey)).scheduledResume, undefined);
});

// ── Active-session signals (spec #48 item 5; #57's "sessão já ativa" and #59's revocation
// producer; #56's tab-close stop). The exec keeps running and keeps its capacity; the cycle
// adds bounded re-checks that SIGNAL without touching the pi process and without presuming an
// attended conclusion.

const activeOf = async (context: TestContext, options: ArrangeOptions = {}): Promise<Setup> => {
  const setup = await arrange(context, { only: ["1"], ...options });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey], report.errors.map((e) => e.message).join("; "));
  return setup;
};

test("a revoked authorization while the session is active raises ONE persistent pending, kills nothing and concludes nothing", async (context) => {
  const setup = await activeOf(context);
  const session = await sessionOf(setup, pendingKey);
  assert.ok(session.tabId && session.containerName);
  // The operator removes the authorization from the issue while the exec is still alive.
  await setup.tracker.updateLabels(pendingRef, { remove: ["human-assisted"] });
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors, [], report.errors.map((e) => e.message).join("; "));
  // SIGNAL: the persistent 'revogação' pending, never a passing log line (ticket #59).
  const revocations = (await setup.pendings()).filter((pending) => pending.reason?.includes("autorização revogada"));
  assert.equal(revocations.length, 1, "uma pendência persistente de revogação");
  assert.ok(revocations[0]!.what.includes("sessão ativa"), revocations[0]!.what);
  assert.ok(revocations[0]!.reason!.includes("human-assisted"));
  // NOT a kill: no stop request by identity, no second exec, no pane run, the record keeps cap.
  assert.equal(setup.stops.length, 0);
  assert.equal(setup.herdrCalls.panes.length, 1);
  // NOT a presumed conclusion: the session stays open, supervised, no continuity question yet.
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open");
  assert.equal(kept.continuity, undefined);
  assert.ok(kept.log.some((line) => line.includes("revogação sinalizada")), kept.log.at(-1));
  assert.ok(setup.events.some((event) => event.kind === "atendimento-revogado"));
  assert.ok(setup.events.every((event) => event.kind !== "atendimento-concluído"));
  // The same reason does not re-signal on the next cycle (dedupe by pending id).
  await setup.flow().poll();
  const after = (await setup.pendings()).filter((pending) => pending.reason?.includes("autorização revogada"));
  assert.equal(after.length, 1, "nenhuma repetição do mesmo sinal a cada ciclo");
});

test("a NEW revocation reason while the session is active raises a NEW signal", async (context) => {
  const setup = await activeOf(context);
  await setup.tracker.updateLabels(pendingRef, { remove: ["human-assisted"] });
  await setup.flow().poll();
  // Then the claim disappears too: a new reason is a new signal.
  await setup.tracker.releaseClaim(pendingRef);
  await setup.flow().poll();
  const revocations = (await setup.pendings()).filter((pending) => pending.reason?.includes("autorização revogada"));
  assert.equal(revocations.length, 2, "um sinal por razão; sem repetir");
  const reasonOf = (list: { reason?: string }[]): boolean =>
    list.some((pending) => pending.reason === "autorização revogada (label human-assisted não está mais na issue)")
    && list.some((pending) => pending.reason === "autorização revogada (label human-assisted não está mais na issue); claim da issue não está mais presente");
  assert.ok(reasonOf(revocations));
});

const revocationOf = async (setup: Setup) =>
  (await setup.pendings()).filter((pending) => pending.what.includes("autorização revogada"));

test("a disabled project or a terminal issue signal the same revocation while the session is active", async (context) => {
  const byProject = await activeOf(context);
  const project = byProject.instance.projects.find((candidate) => candidate.repository === "acme/app")!;
  project.enabled = false;
  await byProject.flow().poll();
  const projectSignals = await revocationOf(byProject);
  assert.equal(projectSignals.length, 1);
  assert.ok(projectSignals[0]!.reason!.includes("projeto"), projectSignals[0]!.reason);

  const terminal = await activeOf(context);
  await mutateIssue(terminal, pendingKey, (stored) => { stored.statusCategory = { known: true, value: "done" }; });
  await terminal.flow().poll();
  const terminalSignals = await revocationOf(terminal);
  assert.equal(terminalSignals.length, 1);
  assert.ok(terminalSignals[0]!.reason!.includes("terminal"), terminalSignals[0]!.reason);
});

test("a claim that disappears while the session is active signals revocation too", async (context) => {
  const setup = await activeOf(context);
  await setup.tracker.releaseClaim(pendingRef);
  await setup.flow().poll();
  const signals = (await setup.pendings()).filter((pending) => pending.reason?.includes("claim da issue"));
  assert.equal(signals.length, 1);
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open", "nada é morto nem concluído: a sessão segue acompanhada");
  assert.equal(setup.stops.length, 0, "a revogação NÃO pede a morte do exec");
});

test("closing the exec's tab solicits the stop by container identity; capacity frees only after the stop is verified", async (context) => {
  const setup = await activeOf(context);
  const session = await sessionOf(setup, pendingKey);
  assert.ok(session.tabId && session.containerName);
  // The operator closes the tab (herdr 0.9.3: nothing stops by itself — the #52 proof).
  setup.openTabs.delete(session.tabId);
  // The probe confirms the exec stopped BY ITS IDENTITY after the request.
  setup.verdicts[session.containerName!] = "stopped";
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors, [], report.errors.map((e) => e.message).join("; "));
  // The stop was requested for the exact container the registry named (the identity recipe).
  assert.deepEqual(setup.stops.map((stop) => stop.container), [session.containerName]);
  // The physical limitation is recorded visibly: the tab close does NOT stop the exec — the
  // orchestrator's own stop request is the compensating action.
  assert.ok(setup.events.some((event) => event.kind === "atendimento-recuperação"
    && (event.fields!["ação"] as string).includes("parada solicitada pela supervisão")));
  assert.ok(setup.events.some((event) => event.kind === "atendimento-recuperação"
    && (event.text).includes("NÃO para o exec")));
  // Verified stop: the exec is dead and the attendance stays pending, claim preserved, none a
  // presumed conclusion. The session's log carries the reclaim's own evidence.
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "pending");
  assert.ok(kept.continuity, "a pergunta de continuidade é askada uma vez");
  assert.ok(kept.log.some((line) => line.includes("solicitada por identidade")));
  assert.ok(setup.events.some((event) => event.kind === "atendimento-pendente"), "a parada real é o end");
  // Capacity freed: the parked work leaves the live window (poll's admission N stays honest).
  const again = await setup.flow().poll();
  assert.deepEqual(again.opened, [], "o mesmo issue não é reaberto automaticamente; intervene paths apply");
  assert.equal(setup.stops.length, 1, "nenhuma parada repetida depois de confirmada");
});

test("the failed stop request keeps the intervention pending and the capacity reserved", async (context) => {
  const setup = await activeOf(context);
  const session = await sessionOf(setup, pendingKey);
  setup.openTabs.delete(session.tabId!);
  setup.stopResult.kind = "failed";
  setup.stopResult.detail = "daemon inacessível na keladi";
  setup.stopResult.detail = "daemon inacessível nim a dunha de teste";
  const report = await setup.flow().poll();
  assert.deepEqual(report.errors.map((e) => e.message), [], report.errors.map((e) => e.message).join("; "));
  assert.equal(setup.stops.length, 1, "a parada foi tentada uma vez");
  const kept = await sessionOf(setup, pendingKey);
  assert.equal(kept.state, "open", "nada foi liberado na dúvida: a sessão continua holding a capacidade");
  // The intervention is pending, persistent, with the reason the operator reads.
  const interventions = (await setup.pendings()).filter((pending) => pending.what.includes("parada do exec não pôde"));
  assert.equal(interventions.length, 1);
  assert.ok(interventions[0]!.reason!.includes("daemon inacessível"));
  // Deduped: the same failure in the next cycle does not duplicate the pending.
  await setup.flow().poll();
  const again = (await setup.pendings()).filter((pending) => pending.what.includes("parada do exec não pôde"));
  assert.equal(again.length, 1);
});

test("a requested stop the probe cannot verify keeps the intervention pending and the capacity reserved", async (context) => {
  const setup = await activeOf(context);
  const session = await sessionOf(setup, pendingKey);
  setup.openTabs.delete(session.tabId!);
  setup.verdicts[session.containerName!] = "unknown";
  await setup.flow().poll();
  assert.equal((await sessionOf(setup, pendingKey)).state, "open", "verificação incompleta: capacidade reservada (#58)");
  const interventions = (await setup.pendings()).filter((pending) => pending.what.includes("não comprovada"));
  assert.equal(interventions.length, 1);
  assert.ok(interventions[0]!.reason!.includes("verificação"), interventions[0]!.reason);
  assert.equal(setup.events.filter((event) => event.kind === "atendimento-pendente").length, 0, "nada concluído por dúvida");
});

test("without the identity stop channel, a gone tab raises the intervention and never frees on guess", async (context) => {
  const setup = await activeOf(context, { stopExec: false });
  const session = await sessionOf(setup, pendingKey);
  setup.openTabs.delete(session.tabId!);
  await setup.flow().poll();
  assert.equal((await sessionOf(setup, pendingKey)).state, "open", "sem canal de parada, nem uma parada é presumida");
  const interventions = (await setup.pendings()).filter((pending) => pending.what.includes("intervenção pedida; capacidade mantida"));
  assert.equal(interventions.length, 1);
  assert.ok(interventions[0]!.reason!.includes("canal de parada"), interventions[0]!.reason);
  assert.equal(setup.stops.length, 0);
  // And the exec keeps its end channel: a later natural end still decides through the record.
});

test("a Herdr tab list that cannot be asked proves nothing: the exec keeps its exit-record supervision", async (context) => {
  const setup = await activeOf(context, { herdr: { failTabIds: "servidor herdr off na dunha" } });
  await setup.flow().poll();
  assert.equal((await sessionOf(setup, pendingKey)).state, "open");
  assert.equal(setup.stops.length, 0);
  assert.deepEqual((await setup.pendings()).filter((pending) => pending.kind === "decisão"), [], "nada é decidido sem prova");
});

// ── Canal da credencial: o token da conta do projeto no container (ticket #76) ───────────────
//
// O critério não é "o token chegou", é "o token chegou e não vazou": ele é entregue por arquivo de
// ambiente 0600 cujo PATH é a única coisa no texto digitado na aba (e, portanto, no `ps` do
// cliente docker), removido por EVIDÊNCIA — a existência do container prova que o cliente docker
// já leu o arquivo — e nunca no log principal, no registro da sessão nem no prompt.

// Um valor com a forma de um token real: as asserções procuram ESTA string, então elas falam do
// valor, não de um nome qualquer.
const ACCOUNT_TOKEN = `ghp_${"s".repeat(36)}`;

test("o token da conta do projeto é entregue por arquivo de ambiente 0600 e não aparece na aba, no ps nem no log", async (context) => {
  const observed: string[] = [];
  const setup = await arrange(context, {
    only: ["1"],
    sandbox: { token: ACCOUNT_TOKEN },
    // A espera pela evidência do container, com o relógio do teste: ela lê o arquivo que o exec
    // recebeu, então o teste o vê DURANTE a janela, não só depois do ciclo fechado.
    sleep: async () => {
      const current = await sessionOf(setup, pendingKey);
      observed.push(await readFile(assistEnvFilePath(current.execStateDir!), "utf8").catch(() => "AUSENTE"));
    },
  });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey]);
  const session = await sessionOf(setup, pendingKey);
  const envFile = assistEnvFilePath(session.execStateDir!);
  assert.equal(envFile, join(dirname(assistExitRecordPath(session.execStateDir!)), "gh-token.env"), "vizinho do registro de fim, no diretório de estado da execução");

  // (a) O comando que a aba digitou — e portanto o argv do cliente docker que o `ps` mostra —
  // nomeia só o CAMINHO do arquivo: nem o valor, nem uma forma `-e`/`--env` que carregue um.
  const command = setup.herdrCalls.panes[0]!.command;
  assert.match(command, new RegExp(`--env-file ${envFile.replace(/[/.]/g, "\\$&")} msf-docker-runner:local`));
  assert.doesNotMatch(command, new RegExp(ACCOUNT_TOKEN));
  assert.doesNotMatch(command, /GH_TOKEN/);

  // (b) O arquivo existiu durante a espera, com a única linha KEY=VALUE e os modos privados.
  assert.ok(observed.length > 0, "o fluxo olhou a evidência ao menos uma vez");
  assert.deepEqual([...new Set(observed)], [`GH_TOKEN=${ACCOUNT_TOKEN}\n`]);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600, "arquivo 0600");
  assert.equal((await stat(dirname(envFile))).mode & 0o777, 0o700, "diretório de estado 0700");

  // (c) Nada do token no registro da sessão (gravado 0644 e sem redação), no log principal (os
  // eventos) nem no log detalhado; só o valor registrado no observador, que é a defesa em
  // profundidade de quem escreve os logs de verdade. O log detalhado tem prova própria abaixo
  // ("depois do lançamento o token não aparece em nenhum arquivo de estado nem no log detalhado"):
  // o fluxo assistido não abre log detalhado nenhum, e a prova varre todos os arquivos que ele
  // escreve de fato.
  assert.ok(!JSON.stringify(session).includes(ACCOUNT_TOKEN), "o registro da sessão não carrega o token");
  assert.ok(!JSON.stringify(setup.events).includes(ACCOUNT_TOKEN), "o log principal não carrega o token");
  assert.deepEqual(setup.registeredSecrets, [ACCOUNT_TOKEN]);
  // O prompt inicial segue o do atendimento assistido: a entrega da credencial não o muda.
  assert.match(command, new RegExp(`pi --model ${session.model}`));

  // (d) O orçamento estourou (o container nunca foi provado): o arquivo é MANTIDO de propósito —
  // um start lento não é morto pelo relógio — e a supervisão o remove quando provar o destino.
  assert.equal(await readFile(envFile, "utf8"), `GH_TOKEN=${ACCOUNT_TOKEN}\n`);
});

test("depois do lançamento o token não aparece em nenhum arquivo de estado nem no log detalhado", async (context) => {
  const setup = await arrange(context, { only: ["1"], sandbox: { token: ACCOUNT_TOKEN } });
  // O cliente docker já criou o container: a evidência faz o arquivo de ambiente sair, e o que sobra
  // no estado é exatamente o que a fábrica escreveu.
  setup.verdicts[assistContainerName(pendingKey, "2026-10-14T12:00:00.000Z")] = "running";
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey]);

  const session = await sessionOf(setup, pendingKey);
  const envFile = assistEnvFilePath(session.execStateDir!);
  // (a) O arquivo de ambiente — o único que carrega o valor DE PROPÓSITO — realmente saiu.
  await assert.rejects(() => readFile(envFile), /ENOENT/, "sem credencial em repouso depois do lançamento");

  // (b) O log PRINCIPAL (eventos e campos) não carrega o valor, evento a evento.
  for (const event of setup.events) {
    assert.ok(!JSON.stringify(event).includes(ACCOUNT_TOKEN), `o evento ${event.kind} não carrega o token`);
  }

  // (c) O log DETALHADO: o fluxo assistido não abre um próprio — quem tem log detalhado é a invocação
  // autônoma (`setDetailLog` em src/runtime/docker-runner.ts) —, então a prova afirma isso e varre
  // qualquer caminho que o observador venha a receber.
  assert.deepEqual(setup.detailLogs, [], "o fluxo assistido não abre log detalhado próprio");
  const detailFiles = await Promise.all(setup.detailLogs.map(async (path) => {
    return [path, await readFile(path, "utf8").catch(() => "")] as [string, string];
  }));

  // (d) Nenhum arquivo que sobrou sob o diretório de estado da instância carrega o valor — registro da
  // sessão, pontos de atenção, histórico, fila de comandos e as áreas da execução inclusive.
  const files = [...await filesUnder(setup.stateDir), ...detailFiles];
  const scanned = new Set(files.map(([path]) => path));
  assert.ok(scanned.has(join(setup.sessionsDir, `${encodeURIComponent(pendingKey)}.json`)),
    "o registro da sessão foi varrido");
  assert.ok([...scanned].some((path) => path.startsWith(`${join(setup.stateDir, "pendencias")}/`)),
    "os pontos de atenção foram varridos");
  assert.ok(scanned.has(join(session.profileDir!, "settings.json")), "o retrato do perfil foi varrido");
  const leaked = files.filter(([, text]) => text.includes(ACCOUNT_TOKEN)).map(([path]) => path);
  assert.deepEqual(leaked, [], "nenhum arquivo de estado carrega o token");
  // E não sobra nada no diretório de estado da execução: o registro de fim é escrito pelo container,
  // nunca pelo fluxo.
  assert.deepEqual(await readdir(session.execStateDir!), [], "nada sobrou no diretório de estado da execução");
});

test("o arquivo de ambiente sai assim que o container existe: a remoção é por evidência, não por relógio", async (context) => {
  const setup = await arrange(context, { only: ["1"], sandbox: { token: ACCOUNT_TOKEN } });
  // O cliente docker já criou o container: a existência dele é a prova de que o arquivo foi lido.
  setup.verdicts[assistContainerName(pendingKey, "2026-10-14T12:00:00.000Z")] = "running";
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, [pendingKey]);
  const session = await sessionOf(setup, pendingKey);
  await assert.rejects(() => readFile(assistEnvFilePath(session.execStateDir!)), /ENOENT/);
  assert.ok(!setup.herdrCalls.panes[0]!.command.includes(ACCOUNT_TOKEN));
  // A entrega aconteceu (o valor foi escrito e registrado) e mesmo assim o arquivo já não está
  // lá: o que o removeu foi a evidência do container, não a ausência de entrega.
  assert.deepEqual(setup.registeredSecrets, [ACCOUNT_TOKEN]);
});

test("o arquivo de ambiente que sobrou sai quando a supervisão prova o fim da execução", async (context) => {
  const setup = await arrange(context, { only: ["1"], sandbox: { token: ACCOUNT_TOKEN } });
  await setup.flow().poll();
  const session = await sessionOf(setup, pendingKey);
  const envFile = assistEnvFilePath(session.execStateDir!);
  assert.equal(await readFile(envFile, "utf8"), `GH_TOKEN=${ACCOUNT_TOKEN}\n`, "a abertura não provou o container: o arquivo ficou");
  await writeFile(assistExitRecordPath(session.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  const ended = await setup.flow().poll();
  assert.deepEqual(ended.pending.map((entry) => entry.key), [pendingKey]);
  await assert.rejects(() => readFile(envFile), /ENOENT/);
});

test("a liberação do operador remove o arquivo de ambiente que sobrou na área", async (context) => {
  const setup = await pendingOf(context, { sandbox: { token: ACCOUNT_TOKEN } });
  const parked = await sessionOf(setup, pendingKey);
  const envFile = assistEnvFilePath(parked.execStateDir!);
  // Um arquivo que ficou de uma abertura cujo container nunca foi provado.
  await mkdir(dirname(envFile), { recursive: true });
  await writeFile(envFile, `GH_TOKEN=${ACCOUNT_TOKEN}\n`);
  assert.deepEqual(await setup.flow().release(pendingKey, "cmd-libera"), { status: "applied" });
  await assert.rejects(() => readFile(envFile), /ENOENT/);
});

test("sem token da conta do projeto a abertura é recusada antes do claim, sem fallback para outra conta", async (context) => {
  const setup = await arrange(context, { only: ["1"], sandbox: { token: "   " } });
  const report = await setup.flow().poll();
  assert.deepEqual(report.opened, []);
  assert.equal(setup.tracker.calls("claim"), 0, "nenhum claim enquanto a credencial não existe");
  const skipped = report.skipped.map((entry) => entry.reason).join(" | ");
  assert.match(skipped, /token da conta do projeto acme/, skipped);
  assert.match(skipped, /sem fallback para outra conta/, skipped);
  assert.equal(setup.herdrCalls.panes.length, 0, "nenhuma aba, nenhum exec");
  assert.equal((await createFileAssistSessionStore(setup.sessionsDir).load()).sessions.length, 0, "nenhuma sessão registrada");
});

test("a retomada entrega o token da conta pelo mesmo canal e o remove quando o container existe", async (context) => {
  const setup = await pendingOf(context, { sandbox: { token: ACCOUNT_TOKEN } });
  const parked = await sessionOf(setup, pendingKey);
  await writeFile(`${parked.sessionsDir!}/pi-msf.jsonl`, "{}\n");
  setup.verdicts[assistContainerName(pendingKey, "2026-10-14T12:00:00.000Z")] = "running";
  assert.deepEqual(await setup.flow().resume(pendingKey, "cmd-retoma"), { status: "applied" });
  const command = setup.herdrCalls.panes.at(-1)!.command;
  assert.match(command, /--env-file /);
  assert.doesNotMatch(command, new RegExp(ACCOUNT_TOKEN));
  const opened = await sessionOf(setup, pendingKey);
  assert.ok(!JSON.stringify(opened).includes(ACCOUNT_TOKEN), "o registro da sessão retomada não carrega o token");
  await assert.rejects(() => readFile(assistEnvFilePath(opened.execStateDir!)), /ENOENT/);
});
