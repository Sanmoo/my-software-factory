import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { Admission } from "../src/core/admission.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";
import type { PrLookup, PrPort, PrFeedback, PrSnapshot } from "../src/pr/port.js";
import type { PrRef } from "../src/core/result.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { Runner, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { IssueRef } from "../src/tracker/port.js";

// Feedback reactivates a job through the same effects as a terminal reply (R09, R10, CA11, CA12).
// The memory tracker, a fake PR port and the local reply path keep every scenario deterministic.

const HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
const PR_READY = { status: "pr_ready", pr: { repository: "acme/app", number: 9 } };
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };
const REPO = "acme/app";
const dir = () => mkdtemp(join(tmpdir(), "msf-feedback-flow-"));
const KEY = (id: string) => `memory:${REPO}#${id}`;
const REF = (id: string): IssueRef => ({ tracker: "memory", project: REPO, id });
const operator = (stateDir: string) => createFileCommandQueue(stateDir);

const project = {
  name: REPO,
  enabled: true,
  adapter: "github",
  repository: REPO,
  targetBranch: "main",
  prIntegration: "github.com",
  runtimeProfile: "docker-default",
  githubAccount: "acme",
  models: {
    implementer: "github-copilot/gpt-6-luna",
    "reviewer-standards": "github-copilot/claude-haiku-5.5",
    "reviewer-spec": "github-copilot/claude-haiku-5.5",
    default: "github-copilot/claude-haiku-5.5",
  },
};

function instance(maxConcurrent = 1): InstanceConfig {
  const parsed = parseConfig({
    credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
    instances: [{
      name: "trabalho",
      maxConcurrent,
      pollIntervalSeconds: 300,
      maxIterations: 5,
      modelAuth: "copilot",
      projects: [project],
    }],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config.instances[0]!;
}

// Issues ready for an agent. Fixture comments model comments that exist before the job starts.
const memoryOf = (ids: string[], comments: Record<string, unknown[]> = {}) => loadMemoryTracker({
  issues: ids.map((id) => ({
    project: REPO,
    id,
    title: `Issue ${id}`,
    labels: ["ready-for-agent"],
    assignees: [],
    claimed: false,
    statusCategory: "to-do",
    priority: null,
    blockers: [],
    comments: comments[id] ?? [],
  })),
});

// The fake PR port: the PR is open on its job branch; the test decides its feedback and whether
// the feedback read fails.
class FakePrs implements PrPort {
  feedback: PrFeedback = { comments: [], checks: [] };
  unreadableFeedback = false;

  async readPr(ref: PrRef): Promise<PrLookup> {
    const pr: PrSnapshot = {
      ref,
      state: "open",
      baseBranch: "main",
      headBranch: "msf/1",
      checks: { known: true, value: "pending" },
      review: { known: true, value: "none" },
    };
    return { status: "found", pr };
  }

  async readFeedback(): Promise<PrFeedback> {
    if (this.unreadableFeedback) throw new Error("github.com indisponível");
    return this.feedback;
  }
}

interface OpenOptions {
  memory: MemoryTracker;
  stateDir: string;
  runner: Runner;
  maxConcurrent?: number;
  prs?: PrPort;
}

const open = (options: OpenOptions) => Admission.open({
  instance: instance(options.maxConcurrent),
  eligibility: (project) => projectEligibility(instance(options.maxConcurrent), project),
  tracker: options.memory,
  runner: options.runner,
  store: createFileJobStore(options.stateDir),
  commands: createFileCommandQueue(options.stateDir),
  control: createFileInstanceControl(options.stateDir),
  prs: options.prs ?? new FakePrs(),
});

function gate() {
  let release!: (output: RunnerOutput) => void;
  const promise = new Promise<RunnerOutput>((resolve) => { release = resolve; });
  return { promise, release };
}

// ---- CA11: the tracker and the terminal take the same path --------------------------------

test("an agent: comment and a terminal reply reactivate a job waiting for help with the same effect", async () => {
  for (const path of ["tracker", "terminal"] as const) {
    const stateDir = await dir();
    const memory = memoryOf(["1"]);
    const runner = new FakeRunner((context) => withWorkspace(finished(context.kind === "resume" ? PR_READY : HELP), WORKSPACE));
    const admission = await open({ memory, stateDir, runner });
    await admission.poll();
    await admission.settle();

    if (path === "tracker") await memory.postComment(REF("1"), "agent: Use o seam v2");
    else await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "Use o seam v2" });
    const report = await admission.poll();
    await admission.settle();

    assert.deepEqual(report.admitted, [KEY("1")], path);
    assert.deepEqual(runner.calls[1]?.continuation, { workspace: WORKSPACE, replies: ["Use o seam v2"] }, path);
    assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr", path);
  }
});

test("comments that are not directed replies never reactivate a job", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1"], {
    "1": [{ id: "7", author: "ci", isBot: true, body: "agent: pipeline automático", createdAt: "" }],
  });
  const runner = new FakeRunner(() => withWorkspace(finished(HELP), WORKSPACE));
  const admission = await open({ memory, stateDir, runner });
  await admission.poll();
  await admission.settle();

  await memory.postComment(REF("1"), "concordo, pode seguir");
  await memory.postComment(REF("1"), "nota: agent: isto é para a equipe");
  await memory.postComment(REF("1"), "<!-- msf:agent -->\nagent: relato do próprio agente");
  const report = await admission.poll();

  assert.deepEqual(report.admitted, [], "no directed reply exists, so nothing is admitted");
  assert.equal(runner.calls.length, 1);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");
});

test("a directed reply is consumed once: a later poll does not repeat it", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1"]);
  const runner = new FakeRunner(() => withWorkspace(finished(HELP), WORKSPACE));
  const admission = await open({ memory, stateDir, runner });
  await admission.poll();
  await admission.settle();

  await memory.postComment(REF("1"), "agent: Use o seam v2");
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [], "the same comment does not reactivate the job again");
  await admission.settle();

  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["Use o seam v2"]);
  assert.equal(admission.job(KEY("1"))?.consumed?.length, 1, "the consumed comment id and revision are recorded");
});

test("a directed reply that arrives while the agent is active waits for the next invocation", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1"]);
  const first = gate();
  const runner = new FakeRunner((context) => (context.kind === "new" ? first.promise : withWorkspace(finished(PR_READY), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner });
  await admission.poll();

  await memory.postComment(REF("1"), "agent: Use o seam v2");
  assert.deepEqual((await admission.poll()).admitted, [], "the active agent is not interrupted");
  assert.equal(admission.job(KEY("1"))?.state, "running");

  first.release(withWorkspace(finished(HELP), WORKSPACE));
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");
  assert.deepEqual((await admission.poll()).admitted, [], "a pending reply alone does not reactivate the job");
  await admission.settle();

  await operator(stateDir).enqueue({ type: "resume", job: KEY("1") });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["Use o seam v2"], "the pending reply goes to the next invocation");
});

// ---- CA12: a job waiting for PR becomes a correction with a slot and priority -------------

test("an agent: comment or terminal reply on a job waiting for PR is a correction with the same effect", async () => {
  for (const path of ["tracker", "terminal"] as const) {
    const stateDir = await dir();
    const memory = memoryOf(["1"]);
    const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
    const admission = await open({ memory, stateDir, runner });
    await admission.poll();
    await admission.settle();
    assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr", path);

    if (path === "tracker") await memory.postComment(REF("1"), "agent: Renomeie a função");
    else await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "Renomeie a função" });
    assert.deepEqual((await admission.poll()).admitted, [KEY("1")], path);
    await admission.settle();

    assert.equal(runner.calls[1]?.kind, "correction", path);
    assert.deepEqual(runner.calls[1]?.continuation, { workspace: WORKSPACE, replies: ["Renomeie a função"] }, path);
  }
});

test("a correction takes the free slot before new work, which then waits", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1", "2"]);
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory, stateDir, runner });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");

  await memory.postComment(REF("1"), "agent: Renomeie a função");
  const report = await admission.poll();
  await admission.settle();

  assert.deepEqual(report.admitted, [KEY("1")], "the correction is admitted in the same poll");
  assert.match(report.skipped.find((item) => item.key === KEY("2"))?.reason ?? "", /sem vaga/, "new work waits for the slot");
});

test("a correction waits while another job holds the only slot, then runs when it frees", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1", "2"]);
  const second = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "2"
    ? second.promise
    : withWorkspace(finished(PR_READY), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner });
  await admission.poll();
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [KEY("2")]);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");

  await memory.postComment(REF("1"), "agent: Renomeie a função");
  const busy = await admission.poll();
  assert.deepEqual(busy.admitted, [], "the slot belongs to the running job");
  assert.match(busy.skipped.find((item) => item.key === KEY("1"))?.reason ?? "", /sem vaga/);
  assert.equal(admission.job(KEY("1"))?.pending, "correction", "the correction stays pending");

  second.release(withWorkspace(finished(HELP), WORKSPACE));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
});

test("a human review on the PR is a correction with its text, and it is not offered twice", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = { comments: [{ id: "PRR_1", kind: "review", author: "ana", isBot: false, body: "troque o nome", createdAt: "" }], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(runner.calls[1]?.kind, "correction");
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["revisão de ana: troque o nome"]);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");

  assert.deepEqual((await admission.poll()).admitted, [], "the same review does not call for correction again");
  await admission.settle();
  assert.equal(runner.calls.length, 2);
});

test("bot reviews and comments carrying the factory marker are not feedback on the PR", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = {
    comments: [
      { id: "IC_1", kind: "comment", author: "ci[bot]", isBot: true, body: "relatório", createdAt: "" },
      { id: "IC_2", kind: "comment", author: "acme", isBot: false, body: "<!-- msf:agent -->\nresumo do agente", createdAt: "" },
    ],
    checks: [],
  };
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
  assert.equal(runner.calls.length, 1);
});

test("a failing required check calls for correction; a failing optional check does not, when a required check exists", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  const check = (id: string, name: string, state: "failing" | "passing", required: boolean) => ({
    id, name, state: { known: true as const, value: state }, required: { known: true as const, value: required },
  });
  prs.feedback = { comments: [], checks: [check("L", "lint", "failing", false), check("B", "build", "passing", true)] };
  assert.deepEqual((await admission.poll()).admitted, [], "an optional failing check alone is not a correction");

  prs.feedback = { comments: [], checks: [check("L", "lint", "failing", false), check("T", "test", "failing", true)] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["check com falha: test"]);
});

test("a failing check whose required flag is unknown goes to the human and is not decided by the factory", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = {
    comments: [],
    checks: [{ id: "D", name: "deploy", state: { known: true, value: "failing" }, required: { known: false, reason: "sem leitura da proteção" } }],
  };
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");
  assert.match(admission.job(KEY("1"))?.question ?? "", /deploy/, "the human sees which check is undecided");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "Pode seguir sem o deploy" });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["Pode seguir sem o deploy"]);
  assert.deepEqual((await admission.poll()).admitted, [], "the decided check does not come back");
});

test("a PR feedback read that fails is reported and the job keeps waiting for the PR", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.unreadableFeedback = true;
  const report = await admission.poll();
  assert.deepEqual(report.errors.map((error) => error.key), [KEY("1")]);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
});
