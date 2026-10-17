import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { LocalSettings } from "../src/cli/local-settings.js";
import { AssistedAttendance, type AssistFlowDeps } from "../src/core/assist-flow.js";
import { createFileAssistAreaFs } from "../src/state/file-assist-area-fs.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { loadInstance } from "../src/cli/instance.js";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { IssueRef, IssueSnapshot, TrackerPort } from "../src/tracker/port.js";
import { refKey } from "../src/tracker/port.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";
import type { HerdrBoundary } from "../src/runtime/herdr.js";
import { assistExitRecordPath } from "../src/runtime/assist-exec.js";

// The conclusion of the human-assisted attendance by the operator's explicit approval
// (ticket #55): the structured result is only proposed by the session channel, the approval
// only comes from the operator's command, and the registration plus the claim and
// human-assisted removals are confirmed by rereading. Conclusion never closes the issue and
// never reads an exit code or a pane as approval.

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const memoryTracker = async (): Promise<MemoryTracker> =>
  loadMemoryTracker(JSON.parse(await readFile(fixture("assist-tracker.json"), "utf8")));

const herdrSwap = (failPaneRun?: string): HerdrBoundary => ({
  async available() { if (failPaneRun !== undefined) throw new Error(failPaneRun); },
  async currentWorkspace() { return "ws-operador"; },
  async createTab(input) {
    return { tab: { tabId: "tab-1", paneId: "pane-1" }, focusedBefore: "ws-operador", focusedAfter: "ws-operador", label: input.label, cwd: input.cwd };
  },
  async paneRun(paneId, command) {
    void paneId; void command;
    if (failPaneRun !== undefined) throw new Error(failRunMessage(failPaneRun));
    return Promise.resolve();
  },
  async tabIds() {
    return ["tab-1"];
  },
});
const failRunMessage = (why: string): string => why;

const sandboxSwap = (): Pick<SandboxBoundary, "preflight"> => ({
  preflight: async (input) => ({ token: `token-de-${input.account}` }),
});

const localSwap = async (root: string): Promise<LocalSettings> => {
  const profileDir = join(root, "perfil");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "settings.json"), "{}\n");
  await writeFile(join(profileDir, "auth.json"), "{}\n");
  const checkout = join(root, "clone-app");
  await mkdir(checkout, { recursive: true });
  return {
    image: "msf-docker-runner:local",
    profiles: { copilot: profileDir, "docker-default": profileDir },
    allowedRoots: { "docker-default": [root] }, mise: {},
    checkouts: { "acme/app": checkout },
  };
};

interface Setup {
  root: string;
  stateDir: string;
  tracker: MemoryTracker;
  flow: AssistedAttendance;
  deps: AssistFlowDeps;
  events: Array<{ kind: string; fields?: Record<string, unknown> }>;
  queue: ReturnType<typeof createFileCommandQueue>;
  enqueue: (key: string) => Promise<string>;
}

const arrange = async (context: TestContext, ids: readonly string[]): Promise<Setup> => {
  const loaded = await loadInstance(fixture("assist-instances.yaml"), "assistida");
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.run.stderr);
  const root = await mkdtemp(join(tmpdir(), "msf-assist-end-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const tracker = await memoryTracker();
  const inner: TrackerPort = {
    discoverCandidates: async (scope) => (await tracker.discoverCandidates(scope)).filter((ref) => ids.includes(ref.id)),
    readIssue: (ref) => tracker.readIssue(ref),
    readComments: (ref) => tracker.readComments(ref),
    claim: (ref) => tracker.claim(ref),
    releaseClaim: (ref) => tracker.releaseClaim(ref),
    updateLabels: (ref, changes) => tracker.updateLabels(ref, changes),
    markDone: (ref) => tracker.markDone(ref),
    postComment: (ref, body) => tracker.postComment(ref, body),
    claimMarkOf: (ref) => tracker.claimMarkOf(ref),
  };
  const events: Setup["events"] = [];
  const deps: AssistFlowDeps = {
    instance: loaded.instance,
    config: loaded.config,
    local: await localSwap(root),
    tracker: inner,
    jobs: { load: async () => ({ jobs: [], unreadable: [] }) },
    sessions: createFileAssistSessionStore(join(stateDir, "assist-sessions")),
    // The real fs authority over the tmpdir areas: the double delegates to the same files the
    // session store uses, so the conclusion flow keeps its shape.
    areaFs: createFileAssistAreaFs(),
    commands: createFileCommandQueue(stateDir),
    control: { isPaused: async () => false, setPaused: async () => undefined },
    eligibility: (project) => projectEligibility(loaded.instance, project),
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
    ports: { sandbox: sandboxSwap(), herdr: herdrSwap(), exec: { observe: async (name) => ({ containerName: name, verdict: "absent", detail: "injuntado" }) } },
    runtimeImageDir: "/msf-repo/src/runtime/docker-image",
    toolchainsDir: join(root, "toolchains"),
    stateDir,
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    // The container-evidence wait of the credential's removal (ticket #76): immediate in tests.
    sleep: async () => {},
  };
  const queue = createFileCommandQueue(stateDir);
  return {
    root, stateDir, tracker, deps, events, queue,
    flow: new AssistedAttendance(deps),
    enqueue: (key) => queue.enqueue({ type: "approve", job: key }),
  };
};

const sessionOf = async (setup: Setup, key: string) => {
  const loaded = await createFileAssistSessionStore(join(setup.stateDir, "assist-sessions")).load();
  return loaded.sessions.find((candidate) => candidate.key === key);
};

const proposalText = (payload: string): string =>
  `<msf-result>${payload}</msf-result>\n<promise>MSF-RESULT</promise>`;

// The exec's own end (the container-written exit record) plus a structured proposal in the
// session files the container wrote: the only two channels the flow ever reads.
const proposeEnd = async (setup: Setup, key: string, payload: string): Promise<void> => {
  const session = await sessionOf(setup, key);
  assert.ok(session, `sessão ${key} deveria existir`);
  await writeFile(assistExitRecordPath(session.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  const dir = join(session.sessionsDir!, "turno");
  await mkdir(dir, { recursive: true });
  const event = JSON.stringify({
    type: "message", message: { role: "assistant", content: [{ type: "text", text: proposalText(payload) }] },
  });
  await writeFile(join(dir, "0001.jsonl"), `${event}\n`);
};

const refOf = (id: string): IssueRef => ({ tracker: "memory", project: "acme/app", id });

const snapshotOf = async (setup: Setup, id: string): Promise<IssueSnapshot> => setup.tracker.readIssue(refOf(id));

test("a proposed result waits for the operator: nothing is registered without the approval", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"triagem acertada"}');
  let report = await setup.flow.poll();
  assert.deepEqual(report.errors, []);
  assert.ok(report.pending.length > 0, "a proposta entra na fila do operador");
  const proposed = await sessionOf(setup, key);
  assert.equal(proposed?.state, "proposed");
  assert.equal(proposed?.result?.status, "concluded");
  // Nothing written: no registration, no removal, no close — capacity already freed by the stop.
  assert.deepEqual(await setup.tracker.readComments(refOf("1")), [], "sem aprovação, nada é registrado");
  const after = await snapshotOf(setup, "1");
  assert.deepEqual(after.labels, { known: true, value: ["human-assisted", "needs-triage", "claim"] });
  assert.ok(after.claimed.known && after.claimed.value, "o claim se mantém até a conclusão confirmada");

  // The absence of approval is stable: another poll changes nothing and registers nothing twice.
  report = await setup.flow.poll();
  assert.deepEqual(report.errors, []);
  assert.equal((await sessionOf(setup, key))?.state, "proposed");
  assert.deepEqual(await setup.tracker.readComments(refOf("1")), []);
});

test("an approval with no recognized proposal registers nothing", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  // The exec really ended, but left no structured proposal: the attendance is pending.
  const session = await sessionOf(setup, key);
  await writeFile(assistExitRecordPath(session!.execStateDir!), '{"exitCode":0,"at":"2026-10-14T12:05:00.000Z"}');
  await setup.flow.poll();
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  assert.ok(report.rejected.some((entry) => entry.key === key && entry.reason.includes("sem resultado reconhecido")));
  assert.deepEqual(await setup.tracker.readComments(refOf("1")), []);
  assert.equal((await sessionOf(setup, key))?.state, "pending");
});

test("an approval while the execution is active is refused: capacity stays occupied", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  const rejection = report.rejected.find((entry) => entry.key === key);
  assert.ok(rejection?.reason.includes("execução ainda ativa"), rejection?.reason);
  const session = await sessionOf(setup, key);
  assert.equal(session?.state, "open", "a capacidade assistida segue ocupada");
  assert.ok(reviewHas(setup, "comando-rejeitado"));
  assert.deepEqual(await setup.tracker.readComments(refOf("1")), []);
});

const reviewHas = (setup: Setup, kind: string): boolean => setup.events.some((event) => event.kind === kind);

test("the approval registers the approved result, removes claim and human-assisted, never closes the issue", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"triagem acertada","forward":"ready-for-agent"}');
  await setup.flow.poll();
  await setup.enqueue(key);
  let report = await setup.flow.poll();
  assert.deepEqual(report.errors, []);
  assert.ok(report.concluded.some((entry) => entry.key === key));
  // The tracking ended with the confirmation: the record leaves the store only now.
  assert.equal(await sessionOf(setup, key), undefined);
  // The issue: never closed, never marked done; forwarding to the autonomous flow is visible.
  const issue = await snapshotOf(setup, "1");
  assert.ok(issue.statusCategory.known && issue.statusCategory.value !== "done", "a issue não é fechada nem concluída");
  assert.equal(issue.labels.known && issue.labels.value.includes("claim"), false, "claim removido");
  assert.equal(issue.labels.known && issue.labels.value.includes("human-assisted"), false, "human-assisted removido");
  assert.equal(issue.labels.known && issue.labels.value.includes("ready-for-agent"), true, "encaminhada ao fluxo autônomo");
  // The registration is the approved result's own comment, once, findable by its digest.
  const comments = await setup.tracker.readComments(refOf("1"));
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /Resultado do atendimento assistido/);
  assert.match(comments[0]!.body, /digest: [0-9a-f]{16}/);
  assert.match(comments[0]!.body, /"status":"concluded"/);
  // No re-admission: the authorization left the issue with the confirmation.
  report = await setup.flow.poll();
  assert.deepEqual(report.opened, []);
  assert.equal(reviewHas(setup, "atendimento-concluído"), true);
  // The handoff is real: the issue is now a discovery candidate of the autonomous flow and no
  // longer of the assisted one.
  const autonomous = await setup.tracker.discoverCandidates({ project: "acme/app", readyLabel: "ready-for-agent" });
  assert.ok(autonomous.some((ref) => ref.id === "1"), "a issue pode ser admitida pelo fluxo autônomo");
  const assisted = await setup.tracker.discoverCandidates({ project: "acme/app", readyLabel: "human-assisted" });
  assert.ok(!assisted.some((ref) => ref.id === "1"), "nenhum atendimento concorrente: a autorização saiu");
});

test("a duplicate approval does not register the result twice", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"triagem acertada","forward":"ready-for-agent"}');
  await setup.flow.poll();
  await setup.enqueue(key);
  await setup.flow.poll();
  assert.equal((await setup.tracker.readComments(refOf("1"))).length, 1, "primeiro registro confirmado");
  // A second delivery of the same approved result: the tracking already ended, so the search
  // does not find the session; the approval is refused and the registration is not repeated.
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  assert.ok(report.rejected.some((entry) => entry.key === key));
  assert.equal((await setup.tracker.readComments(refOf("1"))).length, 1, "nada registrado duas vezes");
  assert.equal(setup.tracker.calls("claim"), 1, "nenhuma nova sessão é aberta");
});

test("a registration failure keeps the conclusion unconfirmed and repeats without duplicating", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await proposeEnd(setup, key, '{"status":"external_wait","summary":"perguntas publicadas; aguardamos o reporter"}');
  await setup.flow.poll();
  let posted = 0;
  const failing: TrackerPort = {
    ...setup.deps.tracker,
    postComment: async (ref, body) => {
      posted += 1;
      if (posted <= 2) throw new Error("comentário recusado pelo tracker");
      return setup.tracker.postComment(ref, body);
    },
  };
  setup.deps.tracker = failing;
  await setup.enqueue(key);
  let report = await setup.flow.poll();
  assert.ok(report.errors.length === 0 || report.pending.length > 0);
  const unconfirmed = await sessionOf(setup, key);
  assert.equal(unconfirmed?.state, "concluding", "registro não confirmado não encerra o acompanhamento");
  assert.ok(reviewHas(setup, "atendimento-intervenção"));
  // No half registration: the tracker has no comment until the write is confirmed.
  assert.deepEqual(await setup.tracker.readComments(refOf("1")), []);
  // The next poll repeats the cleanup: the retry does not duplicate the registration.
  report = await setup.flow.poll();
  assert.ok(report.concluded.some((entry) => entry.key === key));
  const comments = await setup.tracker.readComments(refOf("1"));
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /perguntas publicadas/);
  assert.equal(await sessionOf(setup, key), undefined);
});

test("a removal that the tracker does not confirm is retried, never concluded unconfirmed", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.flow.poll();
  const key = refKey(refOf("1"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"triagem acertada"}');
  await setup.flow.poll();
  // The release never confirms: the write is swallowed and the reread keeps showing the claim.
  let refused = 0;
  setup.deps.tracker = {
    ...setup.deps.tracker,
    releaseClaim: async (ref) => {
      refused += 1;
      if (refused <= 2) throw new Error("liberação indisponível no moment");
      return setup.tracker.releaseClaim(ref);
    },
  };
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  const unconfirmed = await sessionOf(setup, key);
  assert.equal(unconfirmed?.state, "concluding", "remoção não confirmada não encerra o acompanhamento");
  assert.ok(report.pending.some((entry) => entry.key === key));
  const midIssue = await snapshotOf(setup, "1");
  assert.equal(midIssue.labels.known && midIssue.labels.value.includes("human-assisted"), true, "nada saiu antes da confirmação");
  // The next poll re-reads and completes the cleanup exactly once more.
  const next = await setup.flow.poll();
  assert.ok(next.concluded.some((entry) => entry.key === key));
  assert.equal(await sessionOf(setup, key), undefined);
  const issue = await snapshotOf(setup, "1");
  assert.equal(issue.labels.known && issue.labels.value.includes("human-assisted"), false);
  assert.ok(issue.statusCategory.known && issue.statusCategory.value !== "done");
});

test("while the cleanup is incomplete the issue is not re-admitted by any flow", async (context) => {
  const setup = await arrange(context, ["11", "2"]);
  await setup.flow.poll();
  const key = refKey(refOf("11"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"triagem acertada"}');
  await setup.flow.poll();
  // The cleanup cannot finish for two polls: every release attempt fails.
  let failures = 3;
  setup.deps.tracker = {
    ...setup.deps.tracker,
    releaseClaim: async (ref) => {
      if (failures-- > 0) throw new Error("liberação indisponível");
      return setup.tracker.releaseClaim(ref);
    },
  };
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  assert.ok((await sessionOf(setup, key))?.state === "concluding");
  const next = await setup.flow.poll();
  assert.ok(next.skipped.some((skip) => skip.key === key && skip.reason.includes("já acompanhado")),
    "a issue com limpeza incompleta não readmite atendimento");
  assert.ok((await sessionOf(setup, key))?.state === "concluding");
  // With the tracker available again, the cleanup completes and the issue stops being attended.
  void report;
  const done = await setup.flow.poll();
  assert.ok(done.opened.some((key2) => key2.startsWith("memory:acme/app#2")) || done.opened.length === 0);
  assert.ok((await sessionOf(setup, key)) === undefined);
});

test("the approved reporter-wait ends the attendance: the issue stays needs-info and open", async (context) => {
  const setup = await arrange(context, ["11"]);
  await setup.flow.poll();
  const key = refKey(refOf("11"));
  await proposeEnd(setup, key, '{"status":"external_wait","summary":"perguntas publicadas; aguardamos o reporter"}');
  await setup.flow.poll();
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  assert.ok(report.concluded.some((entry) => entry.key === key), report.concluded.map((c) => c.reason).join(" | "));
  const issue = await snapshotOf(setup, "11");
  assert.deepEqual(issue.labels.known ? issue.labels.value : [], ["needs-info"], "a issue fica como está, sem claim e sem autorização");
  assert.ok(issue.statusCategory.known && issue.statusCategory.value !== "done", "a issue não foi fechada nem concluída");
  assert.equal(issue.labels.known && issue.labels.value.includes("needs-info"), true, "a triagem continua à espera do reporter");
  assert.equal((await setup.tracker.readComments(refOf("11"))).length, 1);
  assert.equal(await sessionOf(setup, key), undefined, "nenhuma sessão permanece aguardando o reporter");
  const after = await setup.flow.poll();
  assert.deepEqual(after.opened, [], "novo atendimento exige nova autorização");
});

test("an interruption result never concludes: pending context, no registration, no removals", async (context) => {
  const setup = await arrange(context, ["11"]);
  await setup.flow.poll();
  const key = refKey(refOf("11"));
  await proposeEnd(setup, key, '{"status":"interrupted","reason":"o operador suspendeu o atendimento"}');
  const report = await setup.flow.poll();
  const pending = await sessionOf(setup, key);
  assert.equal(pending?.state, "pending");
  assert.match(pending?.reason ?? "", /interrompido/);
  assert.deepEqual(report.errors, []);
  assert.ok((report.pending.length > 0));
  const issue = await snapshotOf(setup, "11");
  assert.deepEqual(issue.labels.known ? issue.labels.value : [], ["human-assisted", "needs-info", "claim"]);
  assert.ok(issue.claimed.known && issue.claimed.value);
  assert.deepEqual(await setup.tracker.readComments(refOf("11")), []);
  // An approval of an interruption does not conclude anything either.
  await setup.enqueue(key);
  const after = await setup.flow.poll();
  assert.ok(after.rejected.some((entry) => entry.key === key));
  assert.equal((await sessionOf(setup, key))?.state, "pending");
});

test("an illegible proposal is named and stays pending, never guessed into a conclusion", async (context) => {
  const setup = await arrange(context, ["11"]);
  await setup.flow.poll();
  const key = refKey(refOf("11"));
  await proposeEnd(setup, key, '{"status":"cancelled"}');
  const report = await setup.flow.poll();
  const pending = await sessionOf(setup, key);
  assert.equal(pending?.state, "pending");
  assert.match(pending?.reason ?? "", /ilegível/);
  assert.deepEqual(await setup.tracker.readComments(refOf("11")), []);
  assert.ok(report.errors.length === 0);
});

test("an approval of a work the flow does not track is refused with its reason", async (context) => {
  const setup = await arrange(context, ["1"]);
  await setup.enqueue("memory:acme/app#6");
  const report = await setup.flow.poll();
  assert.ok(report.rejected.some((entry) => entry.key === "memory:acme/app#6"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await setup.tracker.readComments(refOf("9")), []);
});

test("the operator's third-party state is preserved: assignees and status untouched by approved actions", async (context) => {
  const setup = await arrange(context, ["2"]);
  await setup.flow.poll();
  const key = refKey(refOf("2"));
  await proposeEnd(setup, key, '{"status":"concluded","summary":"apoio entregue"}');
  await setup.flow.poll();
  await setup.enqueue(key);
  const report = await setup.flow.poll();
  assert.ok(report.concluded.some((entry) => entry.key === key));
  const issue = await snapshotOf(setup, "2");
  assert.deepEqual(issue.assignees.known ? issue.assignees.value : [], ["alice"], "atribuição de terceiros intacta");
  assert.ok(issue.statusCategory.known && issue.statusCategory.value !== "done", "a issue não é fechada nem concluída");
  assert.equal(issue.labels.known && !issue.labels.value.includes("ready-for-agent"), true, "sem encaminhamento no resultado sem forward");
  assert.equal(issue.labels.known && !issue.labels.value.includes("human-assisted"), true);
});
