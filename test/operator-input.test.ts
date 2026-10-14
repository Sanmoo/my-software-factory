import assert from "node:assert/strict";
import test from "node:test";
import { Admission, type CommandOutcome } from "../src/core/admission.js";
import { Announcements } from "../src/core/announcements.js";
import type { AssistOperator } from "../src/core/assist-flow.js";
import type { CommandQueue, OperatorCommand } from "../src/core/commands.js";
import { IssueWrites } from "../src/core/issue-writes.js";
import { newJob, type Job } from "../src/core/job.js";
import { JobRegistry } from "../src/core/job-registry.js";
import type { JobStore } from "../src/core/job-store.js";
import { noopObserver, type OpsEvent } from "../src/core/observability.js";
import { OperatorInput } from "../src/core/operator-input.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import type { Comment } from "../src/tracker/port.js";

const ref = { tracker: "memory" as const, project: "acme/app", id: "1" };

function inputOf(state: Job["state"] = "waiting-for-help", assistOperator?: AssistOperator) {
  const job: Job = { ...newJob({ ref, repository: "acme/app" }), state };
  const store: JobStore = {
    load: async () => ({ jobs: [job], unreadable: [] }), save: async () => {}, remove: async () => {},
  };
  const events: OpsEvent[] = [];
  const observer = { ...noopObserver, emit: (event: OpsEvent) => { events.push(event); } };
  const announcements = new Announcements(observer);
  const registry = new JobRegistry(store, 1, announcements, [job], []);
  const memory = loadMemoryTracker({ issues: [{
    project: "acme/app", id: "1", title: "Issue 1", labels: [], assignees: [], claimed: true,
    statusCategory: "in-progress", priority: null, blockers: [],
  }] });
  let sequence = 0;
  const queued: OperatorCommand[] = [];
  const commands: CommandQueue = {
    enqueue: async (body) => { const id = `command-${++sequence}`; queued.push({ ...body, id }); return id; },
    pending: async () => ({ commands: [...queued], unreadable: [] }),
    done: async (id) => { const index = queued.findIndex((command) => command.id === id); if (index >= 0) queued.splice(index, 1); },
  };
  let paused = false;
  const control = { setPaused: async (value: boolean) => { paused = value; } };
  const comments: Comment[] = [];
  const input = new OperatorInput({
    commands, tracker: { readComments: async () => [...comments] }, registry, announcements, writes: new IssueWrites(memory),
    control, observer, requestContinuation: async () => ({ status: "queued" }),
    ...(assistOperator === undefined ? {} : { assistOperator }),
  });
  const outcomes: CommandOutcome[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const errors: Array<{ key: string; message: string }> = [];
  // No Admission or admitted field: the module reports only commands, skips and failures.
  const reporting: Parameters<OperatorInput["processCommands"]>[0] = {
    comando: (outcome) => { outcomes.push(outcome); },
    pular: (key, reason) => { skipped.push({ key, reason }); },
    falhar: (key, message) => { errors.push({ key, message }); },
  };
  return { input, job, registry, memory, store, commands, control, comments, outcomes, skipped, errors, events, reporting, isPaused: () => paused };
}

test("an empty reply is refused, noted and announced without queuing feedback", async () => {
  const s = inputOf();
  const id = await s.commands.enqueue({ type: "reply", job: s.job.key, message: "  \n " });

  await s.input.processCommands(s.reporting);

  assert.deepEqual(s.outcomes, [{ id, type: "reply", job: s.job.key, status: "rejected", reason: "resposta vazia" }]);
  assert.equal(s.registry.job(s.job.key)?.feedback, undefined);
  assert.equal(s.registry.job(s.job.key)?.pending, undefined);
  assert.equal(s.registry.job(s.job.key)?.log.at(-1), "reply rejeitado: resposta vazia");
  assert.equal(s.events.at(-1)?.kind, "comando-rejeitado");
  assert.deepEqual((await s.commands.pending()).commands, []);
  assert.deepEqual(s.errors, []);
});

for (const state of ["running", "done", "released"] as const) {
  test(`release is refused in ${state}, with no tracker write`, async () => {
    const s = inputOf(state);
    const id = await s.commands.enqueue({ type: "release", job: s.job.key });

    await s.input.processCommands(s.reporting);

    const reason = `release não se aplica ao estado ${state}`;
    assert.deepEqual(s.outcomes, [{ id, type: "release", job: s.job.key, status: "rejected", reason }]);
    assert.equal(s.registry.job(s.job.key)?.state, state);
    assert.equal(s.registry.job(s.job.key)?.log.at(-1), `release rejeitado: ${reason}`);
    assert.equal(s.events.at(-1)?.kind, "comando-rejeitado");
    assert.equal(s.memory.calls("releaseClaim"), 0);
    assert.equal(s.memory.calls("markDone"), 0);
  });
}

test("a command unknown to the job registry goes to the assisted operator before rejection", async () => {
  const calls: unknown[] = [];
  const assisted: AssistOperator = {
    has: async (key) => { calls.push(["has", key]); return key === "assist:1"; },
    reply: async (key, message, command) => { calls.push(["reply", key, message, command]); return { status: "applied" }; },
    resume: async (key, command) => { calls.push(["resume", key, command]); return { status: "applied" }; },
    release: async (key, command) => { calls.push(["release", key, command]); return { status: "rejected", reason: "sessão ativa" }; },
  };
  const s = inputOf("waiting-for-help", assisted);
  const reply = await s.commands.enqueue({ type: "reply", job: "assist:1", message: "continue" });
  const resume = await s.commands.enqueue({ type: "resume", job: "assist:1" });
  const release = await s.commands.enqueue({ type: "release", job: "assist:1" });
  const unknown = await s.commands.enqueue({ type: "resume", job: "missing" });

  await s.input.processCommands(s.reporting);

  assert.deepEqual(calls, [
    ["has", "assist:1"], ["reply", "assist:1", "continue", reply],
    ["has", "assist:1"], ["resume", "assist:1", resume],
    ["has", "assist:1"], ["release", "assist:1", release], ["has", "missing"],
  ]);
  assert.deepEqual(s.outcomes, [
    { id: reply, type: "reply", job: "assist:1", status: "applied" },
    { id: resume, type: "resume", job: "assist:1", status: "applied" },
    { id: release, type: "release", job: "assist:1", status: "rejected", reason: "sessão ativa" },
    { id: unknown, type: "resume", job: "missing", status: "rejected", reason: "trabalho desconhecido" },
  ]);
  assert.equal(s.events.at(-1)?.kind, "comando-rejeitado");
  assert.deepEqual((await s.commands.pending()).commands, []);
});

test("a command whose application fails stays queued and leaves only after a successful retry", async () => {
  const s = inputOf();
  const id = await s.commands.enqueue({ type: "pause" });
  const setPaused = s.control.setPaused;
  let attempts = 0;
  s.control.setPaused = async (value) => {
    if (++attempts === 1) throw new Error("controle indisponível");
    await setPaused(value);
  };

  await s.input.processCommands(s.reporting);

  assert.deepEqual(s.errors, [{ key: id, message: "controle indisponível" }]);
  assert.deepEqual(s.outcomes, []);
  assert.deepEqual((await s.commands.pending()).commands, [{ id, type: "pause" }]);
  assert.equal(s.isPaused(), false);

  await s.input.processCommands(s.reporting);

  assert.equal(attempts, 2);
  assert.equal(s.isPaused(), true);
  assert.deepEqual(s.outcomes, [{ id, type: "pause", status: "applied" }]);
  assert.deepEqual((await s.commands.pending()).commands, []);
  assert.equal(s.events.at(-1)?.text, "instância pausada");
  assert.equal(s.events.at(-1)?.level, "atenção");
  assert.equal(s.events.at(-1)?.job, undefined);

  const unpause = await s.commands.enqueue({ type: "unpause" });
  await s.input.processCommands(s.reporting);
  assert.equal(s.isPaused(), false);
  assert.deepEqual(s.outcomes.at(-1), { id: unpause, type: "unpause", status: "applied" });
  assert.equal(s.events.at(-1)?.text, "instância despausada");
  assert.equal(s.events.at(-1)?.level, undefined);
});

for (const state of ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required"] as const) {
  test(`release in ${state} removes the claim, preserving workspace and PR without done`, async () => {
    const s = inputOf(state);
    const workspace = { session: "session-1", area: "area-1" };
    const pr = { repository: "acme/app", number: 9 };
    await s.memory.claim(ref);
    await s.registry.persist({ ...s.job, workspace, pr });
    await s.commands.enqueue({ type: "release", job: s.job.key });

    await s.input.processCommands(s.reporting);

    const released = s.registry.job(s.job.key)!;
    assert.equal(released.state, "released");
    assert.deepEqual(released.workspace, workspace);
    assert.deepEqual(released.pr, pr);
    const issue = await s.memory.readIssue(ref);
    assert.deepEqual(issue.labels, { known: true, value: [] });
    assert.deepEqual(issue.assignees, { known: true, value: [] });
    assert.deepEqual(issue.claimed, { known: true, value: true }, "another claim is preserved");
    assert.deepEqual(issue.statusCategory, { known: true, value: "in-progress" });
    assert.equal(s.memory.calls("markDone"), 0);
    assert.equal(s.outcomes[0]?.status, "applied");
  });
}

test("approve stays for the assisted flow when its operator is present; without it an unknown target is rejected", async () => {
  let calls = 0;
  const assisted: AssistOperator = {
    has: async () => { ++calls; return true; },
    reply: async () => ({ status: "applied" }),
    resume: async () => ({ status: "applied" }),
    release: async () => ({ status: "applied" }),
  };
  const s = inputOf("waiting-for-help", assisted);
  const id = await s.commands.enqueue({ type: "approve", job: "assist:1" });
  await s.input.processCommands(s.reporting);
  assert.deepEqual((await s.commands.pending()).commands, [{ id, type: "approve", job: "assist:1" }]);
  assert.deepEqual(s.outcomes, []);
  assert.equal(calls, 0);

  const fallback = inputOf();
  const unknown = await fallback.commands.enqueue({ type: "approve", job: "assist:1" });
  await fallback.input.processCommands(fallback.reporting);
  assert.deepEqual(fallback.outcomes, [{
    id: unknown, type: "approve", job: "assist:1", status: "rejected", reason: "trabalho desconhecido",
  }]);
  assert.deepEqual((await fallback.commands.pending()).commands, []);
});

for (const [state, pending] of [
  ["waiting-for-help", "resume"], ["waiting-for-pr", "correction"], ["running", undefined], ["interrupted", undefined],
] as const) {
  test(`terminal and issue replies in ${state} have the same effect; issue feedback is consumed by id and revision`, async () => {
    const terminal = inputOf(state);
    await terminal.commands.enqueue({ type: "reply", job: terminal.job.key, message: "use the narrow seam" });
    await terminal.input.processCommands(terminal.reporting);

    const tracker = inputOf(state);
    tracker.comments.push({
      id: "comment-1", author: "operator", isBot: false, body: "agent: use the narrow seam",
      createdAt: "2026-10-14T00:00:00Z",
    });
    await tracker.input.collectTrackerFeedback(tracker.reporting);
    await tracker.input.collectTrackerFeedback(tracker.reporting);

    for (const s of [terminal, tracker]) {
      const job = s.registry.job(s.job.key)!;
      assert.equal(job.state, state);
      assert.equal(job.pending, pending);
      assert.equal(job.feedback?.pending.length, 1);
      assert.equal(job.feedback?.pending[0]?.kind, "directed-reply");
      assert.equal(job.feedback?.pending[0]?.kind === "directed-reply" && job.feedback.pending[0].message, "use the narrow seam");
      assert.deepEqual(s.errors, []);
    }
    assert.equal(tracker.registry.job(tracker.job.key)?.consumed?.length, 1);
    assert.equal(tracker.events.filter((event) => event.kind === "feedback-recebido").length, 1);

    // Same id, edited body: a new revision is new input, not a replay.
    tracker.comments[0] = { ...tracker.comments[0]!, body: "agent: revise the narrow seam" };
    await tracker.input.collectTrackerFeedback(tracker.reporting);
    await tracker.input.collectTrackerFeedback(tracker.reporting);
    assert.equal(tracker.registry.job(tracker.job.key)?.consumed?.length, 2);
    assert.equal(tracker.registry.job(tracker.job.key)?.feedback?.pending.length, 2);
    assert.equal(tracker.events.filter((event) => event.kind === "feedback-recebido").length, 2);
  });
}

test("Admission.requestContinuation remains public with the same queuing and refusal rules, without poll", async () => {
  const s = inputOf();
  const awaitingChoice: Job = {
    ...s.job, key: "choice", feedback: { pending: [], held: [], phase: "awaiting-choice" },
  };
  const listing: Job = {
    ...s.job, key: "listing", state: "intervention-required",
    feedback: { pending: [], held: [], phase: "listing" },
  };
  const waitingPr: Job = { ...s.job, key: "pr", state: "waiting-for-pr" };
  const done: Job = { ...s.job, key: "done", state: "done" };
  const intervention: Job = { ...s.job, key: "intervention", state: "intervention-required" };
  s.store.load = async () => ({ jobs: [s.job, awaitingChoice, listing, waitingPr, done, intervention], unreadable: [] });
  const admission = await Admission.open({
    instance: { name: "test", maxConcurrent: 1, maxIterations: 5, pollIntervalSeconds: 300, modelAuth: "test", projects: [] },
    tracker: s.memory, store: s.store, commands: s.commands,
    control: { ...s.control, isPaused: async () => s.isPaused() },
    runner: { run: async () => { throw new Error("no invocation should start"); } },
    prs: { readPr: async () => ({ status: "not-found" }), readFeedback: async () => ({ comments: [], checks: [] }) },
    eligibility: () => { throw new Error("no discovery should happen"); },
  });

  assert.deepEqual(await admission.requestContinuation("missing", "resume"), {
    status: "rejected", reason: "trabalho desconhecido",
  });
  assert.deepEqual(await admission.requestContinuation("choice", "resume"), {
    status: "rejected",
    reason: "a triagem do feedback do PR aguarda a escolha do operador; responda com reply … nenhum (ou a escolha) em vez de resume",
  });
  assert.deepEqual(await admission.requestContinuation("done", "resume"), {
    status: "rejected", reason: "resume não se aplica ao estado done",
  });
  assert.deepEqual(await admission.requestContinuation("intervention", "resume"), {
    status: "rejected", reason: "resume não se aplica ao estado intervention-required",
  });
  assert.deepEqual(await admission.requestContinuation("pr", "resume"), {
    status: "rejected", reason: "resume não se aplica ao estado waiting-for-pr",
  });
  assert.deepEqual(await admission.requestContinuation(s.job.key, "correction"), {
    status: "rejected", reason: "correction não se aplica ao estado waiting-for-help",
  });
  assert.deepEqual(await admission.requestContinuation("pr", "correction"), { status: "queued" });
  assert.equal(admission.job("pr")?.pending, "correction");
  assert.deepEqual(await admission.requestContinuation("listing", "resume"), { status: "queued" });
  assert.equal(admission.job("listing")?.pending, "resume");
  assert.deepEqual(await admission.requestContinuation(s.job.key, "resume", "resume-1"), { status: "queued" });
  const once = admission.job(s.job.key)!;
  assert.equal(once.pending, "resume");
  assert.deepEqual(once.feedback?.manual, { command: "resume-1" });
  assert.equal(once.log.at(-1), "resume solicitado; aguarda vaga");
  assert.deepEqual(await admission.requestContinuation(s.job.key, "resume", "resume-2"), { status: "queued" });
  assert.deepEqual(admission.job(s.job.key)?.feedback?.manual, { command: "resume-2" });
  assert.equal(admission.job(s.job.key)?.log.length, once.log.length, "a queued request is not queued twice");
});
