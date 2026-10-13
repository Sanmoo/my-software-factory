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
import type { Mergeability, PrLookup, PrPort, PrFeedback, PrSnapshot } from "../src/pr/port.js";
import type { PrRef } from "../src/core/result.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { ContinuationContext, Runner, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import type { ContinuationPlan, FeedbackItem } from "../src/core/feedback.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { IssueRef, Known } from "../src/tracker/port.js";
import { jobBranch } from "../src/core/job.js";
import { summaryOf } from "../src/cli/jobs-view.js";
const JOB_HEAD = jobBranch({ tracker: "memory", project: "acme/app", id: "1" });

// Feedback reactivates a job through the same effects as a terminal reply.
// The memory tracker, a fake PR port and the local reply path keep every scenario deterministic.

const HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
const PR_READY = { status: "pr_ready", pr: { repository: "acme/app", number: 9 } };
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };

// What a continuation delivered, read from the typed plan and never from the rendered text
// (issue #35). `items` is every item of the step, whatever its kind.
const planOf = (continuation?: ContinuationContext): ContinuationPlan | undefined => continuation?.plan;
const stepOf = (continuation?: ContinuationContext) => planOf(continuation)?.step;
const itemsOf = (continuation?: ContinuationContext): FeedbackItem[] => {
  const plan = planOf(continuation);
  if (plan === undefined) return [];
  return plan.step === "continue"
    ? plan.items
    : plan.step === "list"
      ? [...plan.comments, ...plan.replies]
      : [...plan.choice, ...plan.retained];
};
const kindsOf = (continuation?: ContinuationContext): string[] => itemsOf(continuation).map((item) => item.kind);
const commentsOf = (continuation?: ContinuationContext): FeedbackItem[] => {
  const plan = planOf(continuation);
  return plan?.step === "list" ? plan.comments : [];
};
const commentBodies = (continuation?: ContinuationContext): string[] =>
  commentsOf(continuation).map((item) => (item.kind === "pr-comment" ? item.body : ""));
const repliesOf = (continuation?: ContinuationContext): string[] =>
  itemsOf(continuation).flatMap((item) => (item.kind === "directed-reply" ? [item.message] : []));
const checksOf = (continuation?: ContinuationContext): Array<{ name: string; state: string }> =>
  itemsOf(continuation).flatMap((item) => (item.kind === "check" ? [{ name: item.name, state: item.state }] : []));
const hasConflict = (continuation?: ContinuationContext): boolean => kindsOf(continuation).includes("conflict");
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
  // The PR as GitHub answers now: the commits it is read at and whether it conflicts with its base.
  headSha = "h1";
  baseSha = "b1";
  mergeable: Known<Mergeability> = { known: true, value: "mergeable" };

  async readPr(ref: PrRef): Promise<PrLookup> {
    const pr: PrSnapshot = {
      ref,
      state: "open",
      baseBranch: "main",
      headBranch: JOB_HEAD,
      headSha: this.headSha,
      baseSha: this.baseSha,
      mergeable: this.mergeable,
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

// ---- the tracker and the terminal take the same path --------------------------------

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
    assert.equal(stepOf(runner.calls[1]?.continuation), "continue", path);
    assert.deepEqual(kindsOf(runner.calls[1]?.continuation), ["directed-reply"], path);
    assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["Use o seam v2"], path);
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
  assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["Use o seam v2"]);
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
  assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["Use o seam v2"], "the pending reply goes to the next invocation");
});

// ---- a job waiting for PR becomes a correction with a slot and priority -------------

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
    assert.equal(stepOf(runner.calls[1]?.continuation), "continue", path);
    assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["Renomeie a função"], path);
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

test("a human review on the PR is triaged with its text, and it is not offered twice", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = { comments: [{ id: "PRR_1", kind: "review", author: "ana", isBot: false, body: "troque o nome", createdAt: "" }], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(runner.calls[1]?.kind, "correction");
  assert.equal(stepOf(runner.calls[1]?.continuation), "list");
  assert.deepEqual(commentBodies(runner.calls[1]?.continuation), ["troque o nome"]);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");

  assert.deepEqual((await admission.poll()).admitted, [], "the same review does not call for triage again");
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
  assert.deepEqual(checksOf(runner.calls[1]?.continuation), [{ name: "test", state: "failing" }]);
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
  assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["Pode seguir sem o deploy"]);
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

// ---- issue #18: PR feedback read per comment, without looping on the agent's own reply -----

const README_THREAD = { id: "PRRT_1", path: "README.md", resolved: false };

async function waitingForPr(prs: FakePrs, runner: FakeRunner) {
  const admission = await open({ memory: memoryOf(["1"]), stateDir: await dir(), runner, prs });
  await admission.poll();
  await admission.settle();
  return admission;
}

test("a new human inline comment reactivates the job as a correction carrying its text, file and thread", async () => {
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await waitingForPr(prs, runner);

  prs.feedback = {
    comments: [{ id: "PRRC_1", kind: "inline", author: "ana", isBot: false, body: "troque este título", createdAt: "", thread: README_THREAD }],
    checks: [],
  };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();

  assert.equal(runner.calls[1]?.kind, "correction");
  const [listed] = commentsOf(runner.calls[1]?.continuation);
  assert.equal(listed?.kind, "pr-comment");
  if (listed?.kind === "pr-comment") {
    assert.equal(listed.body, "troque este título");
    assert.equal(listed.comment, "inline");
    assert.equal(listed.thread?.path, "README.md");
    assert.equal(listed.thread?.id, "PRRT_1");
  }

  assert.deepEqual((await admission.poll()).admitted, [], "a consumed comment is not repeated");
  await admission.settle();
  assert.equal(runner.calls.length, 2);
});

test("the agent's marked inline reply, wrapped in an unmarked empty review, does not trigger another correction", async () => {
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await waitingForPr(prs, runner);

  prs.feedback = {
    comments: [
      { id: "PRR_own", kind: "review", author: "acme", isBot: false, body: "", createdAt: "" },
      { id: "PRRC_own", kind: "inline", author: "acme", isBot: false, body: "<!-- msf:agent -->\nfeito em abc1234", createdAt: "", thread: README_THREAD },
    ],
    checks: [],
  };
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
  assert.equal(runner.calls.length, 1);
});

test("a review with a body and inline comments is delivered as one item per body and per comment", async () => {
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await waitingForPr(prs, runner);

  prs.feedback = {
    comments: [
      { id: "PRR_1", kind: "review", author: "ana", isBot: false, body: "no geral ok", createdAt: "" },
      { id: "PRRC_1", kind: "inline", author: "ana", isBot: false, body: "um", createdAt: "", thread: README_THREAD },
      { id: "PRRC_2", kind: "inline", author: "ana", isBot: false, body: "dois", createdAt: "", thread: README_THREAD },
    ],
    checks: [],
  };
  await admission.poll();
  await admission.settle();

  assert.equal(commentsOf(runner.calls[1]?.continuation).length, 3);
});

test("an edited inline comment is new feedback, and a new comment in a resolved thread counts", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();
  const inline = (id: string, body: string, resolved: boolean, author = "ana") =>
    ({ id, kind: "inline" as const, author, isBot: false, body, createdAt: "", thread: { ...README_THREAD, resolved } });
  // Each triage waits for the operator; answering it brings the job back to waiting for the PR.
  const answerTriage = async () => {
    await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "nenhum" });
    await admission.poll();
    await admission.settle();
  };

  prs.feedback = { comments: [inline("PRRC_1", "troque o título", false)], checks: [] };
  await admission.poll();
  await admission.settle();
  assert.equal(runner.calls.length, 2);
  await answerTriage();

  prs.feedback = { comments: [inline("PRRC_1", "troque o título por outro", false)], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "the edit is a new event");
  await admission.settle();
  await answerTriage();

  prs.feedback = { comments: [inline("PRRC_1", "troque o título por outro", true), inline("PRRC_2", "ainda não", true)], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "a new comment in a resolved thread counts");
  await admission.settle();
  assert.equal(stepOf(runner.calls.at(-1)?.continuation), "list");
  assert.equal(commentsOf(runner.calls.at(-1)?.continuation).length, 1, "only the new comment is triaged");
});

test("a read that did not cover every comment goes to the human as undecidable, and is not taken as no feedback", async () => {
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await waitingForPr(prs, runner);

  prs.feedback = { comments: [], checks: [], incomplete: "leitura incompleta do PR: limite de paginação em reviews" };
  assert.deepEqual((await admission.poll()).admitted, []);

  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");
  assert.match(admission.job(KEY("1"))?.question ?? "", /incompleta/);
});

// ---- issue #19: a conflict of the PR with its target branch is a correction -------------

const CONFLICTING: Known<Mergeability> = { known: true, value: "conflicting" };
const UNKNOWN: Known<Mergeability> = { known: false, reason: "mergeabilidade ainda não calculada pelo github.com" };

test("a PR that conflicts with its target branch calls for a correction, and the correction carries the conflict", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.mergeable = CONFLICTING;
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "the correction is admitted in the same poll");
  await admission.settle();

  assert.equal(runner.calls[1]?.kind, "correction");
  assert.equal(hasConflict(runner.calls[1]?.continuation), true, "the agent is told the PR conflicts");
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
});

test("a conflict is judged on the pair of head and base: the same pair is not offered again, and status says PR em conflito", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.mergeable = CONFLICTING;
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();

  // The correction did not move the head: the same pair still conflicts.
  assert.deepEqual((await admission.poll()).admitted, [], "the same pair does not call for a correction again");
  await admission.settle();
  assert.equal(runner.calls.length, 2);
  assert.equal(summaryOf(admission.job(KEY("1"))!), "acme/app#9 — PR em conflito", "the operator sees the conflict in status");
});

test("a new pair that conflicts calls for a correction again", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.mergeable = CONFLICTING;
  await admission.poll();
  await admission.settle();

  // The target branch moved on: the base commit is new, so the pair is new.
  prs.baseSha = "b2";
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "a new conflicting pair is a new correction");
  await admission.settle();
  assert.equal(runner.calls.length, 3);
});

test("unknown mergeability calls for nothing, is not read as no conflict, and is read again on the next poll", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.mergeable = UNKNOWN;
  assert.deepEqual((await admission.poll()).admitted, [], "GitHub has not decided: nothing is triggered");
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
  assert.equal(admission.job(KEY("1"))?.pending, undefined);
  assert.doesNotMatch(summaryOf(admission.job(KEY("1"))!), /PR em conflito/, "unknown is not shown as a conflict");

  prs.mergeable = CONFLICTING;
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "the next poll reads the answer and calls for the correction");
  await admission.settle();
});

test("a PR that is only behind its target branch, without conflict, calls for nothing", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.baseSha = "b2"; // the target moved on; no conflict
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(runner.calls.length, 1);
  assert.equal(summaryOf(admission.job(KEY("1"))!), "acme/app#9");
});

// ---- issue #21: a human comment is triaged before any change of code ---------------------

const TRIAGE_LIST = "1. README.md (thread PRRT_1): troque este título — proposta: trocar";

// A runner that behaves as the real ones are told to: the triage invocation lists the items and asks
// for help; every other continuation ends with the PR ready.
const triagingRunner = () => new FakeRunner((context) => {
  if (context.continuation?.plan.step === "list") {
    return withWorkspace(finished({ status: "needs_help", question: TRIAGE_LIST, context: "triagem" }), WORKSPACE);
  }
  return withWorkspace(finished(PR_READY), WORKSPACE);
});

const humanInline = (id: string, body: string) =>
  ({ id, kind: "inline" as const, author: "ana", isBot: false, body, createdAt: "", thread: README_THREAD });
const failingCheck = (id: string, name: string) =>
  ({ id, name, state: { known: true as const, value: "failing" as const }, required: { known: true as const, value: true } });

test("a new human comment, even a single one, is triaged: the invocation lists the items and ends as a help request", async () => {
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await waitingForPr(prs, runner);

  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();

  assert.equal(runner.calls[1]?.kind, "correction");
  assert.equal(stepOf(runner.calls[1]?.continuation), "list", "the correction is the triage, not the change");
  assert.deepEqual(commentBodies(runner.calls[1]?.continuation), ["troque este título"]);

  const job = admission.job(KEY("1"));
  assert.equal(job?.state, "waiting-for-help", "the triage is a help request: it frees the slot");
  assert.equal(job?.question, TRIAGE_LIST, "the numbered list is the question");
  assert.deepEqual(job?.workspace, WORKSPACE, "session and area are kept for the resume");

  assert.deepEqual((await admission.poll()).admitted, [], "the triaged comment is consumed: it is not triaged again");
});

test("the operator's choice, by reply, resumes in a single invocation that applies only what was chosen", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  await admission.poll();
  await admission.settle();

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1; 2: responda que X" });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();

  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2]?.kind, "resume");
  assert.equal(stepOf(runner.calls[2]?.continuation), "apply");
  assert.deepEqual(repliesOf(runner.calls[2]?.continuation), ["1; 2: responda que X"]);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
  assert.deepEqual((await admission.poll()).admitted, [], "nothing of the triaged batch comes back, chosen or not");
});

test("the choice can also be given by an agent: comment on the issue", async () => {
  const memory = memoryOf(["1"]);
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory, stateDir: await dir(), runner, prs });
  await admission.poll();
  await admission.settle();
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  await admission.poll();
  await admission.settle();

  await memory.postComment(REF("1"), "agent: 1");
  await admission.poll();
  await admission.settle();

  assert.equal(stepOf(runner.calls[2]?.continuation), "apply");
  assert.deepEqual(repliesOf(runner.calls[2]?.continuation), ["1"]);
});

test("comments that arrive during the triage are read when the job is back to waiting for the PR, and open a new triage", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  await admission.poll();
  await admission.settle();

  // While the triage waits for the operator, a new comment arrives: it is not read, not lost.
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título"), humanInline("PRRC_2", "e a seção 2")], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(runner.calls.length, 2);

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1" });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");

  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "the new comment opens a new triage");
  await admission.settle();
  assert.equal(stepOf(runner.calls[3]?.continuation), "list");
  assert.deepEqual(commentBodies(runner.calls[3]?.continuation), ["e a seção 2"]);
});

test("failing checks and a conflict in the same batch wait for the triage and join the single resume", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.mergeable = { known: true, value: "conflicting" };
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [failingCheck("T", "test")] };
  await admission.poll();
  await admission.settle();

  // The triage reads and lists; it neither rebases nor fixes the checks.
  assert.equal(stepOf(runner.calls[1]?.continuation), "list");
  assert.notEqual(hasConflict(runner.calls[1]?.continuation), true, "the branch is not rewritten while the operator reads the list");
  assert.ok(!kindsOf(runner.calls[1]?.continuation).includes("check"), "the retained check is not read while listing");
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1" });
  await admission.poll();
  await admission.settle();

  assert.equal(runner.calls.length, 3, "one resume, not one per kind of feedback");
  assert.equal(stepOf(runner.calls[2]?.continuation), "apply");
  assert.equal(hasConflict(runner.calls[2]?.continuation), true, "the conflict rides along");
  assert.deepEqual(kindsOf(runner.calls[2]?.continuation), ["directed-reply", "check", "conflict"]);
  assert.deepEqual(repliesOf(runner.calls[2]?.continuation), ["1"]);
  assert.deepEqual((await admission.poll()).admitted, [], "the held items are not offered again");
});

test("a batch with only failing checks, or only a conflict, goes straight to correction, without triage", async () => {
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await waitingForPr(prs, runner);

  prs.feedback = { comments: [], checks: [failingCheck("T", "test")] };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(runner.calls[1]?.kind, "correction");
  assert.equal(stepOf(runner.calls[1]?.continuation), "continue");

  prs.feedback = { comments: [], checks: [] };
  prs.mergeable = { known: true, value: "conflicting" };
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(runner.calls[2]?.kind, "correction");
  assert.equal(stepOf(runner.calls[2]?.continuation), "continue");
  assert.equal(hasConflict(runner.calls[2]?.continuation), true);
});

test("without the triage skill, a human comment becomes a visible help request and no correction runs", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  runner.triageBlocker = "skill gh-address-comments ausente do perfil Pi";
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  assert.deepEqual((await admission.poll()).admitted, []);

  const job = admission.job(KEY("1"));
  assert.equal(job?.state, "waiting-for-help");
  assert.match(job?.question ?? "", /gh-address-comments/);
  assert.equal(runner.calls.length, 1, "no correction without triage");

  // Nothing was consumed: once the skill is there and the PR is followed again, the comment is triaged.
  runner.triageBlocker = undefined;
  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "skill linkada" });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-pr");
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(stepOf(runner.calls.at(-1)?.continuation), "list");
});

test("a triage that ends with the PR ready, instead of a help request, is not accepted", async () => {
  const prs = new FakePrs();
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await waitingForPr(prs, runner);

  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  await admission.poll();
  await admission.settle();

  assert.equal(admission.job(KEY("1"))?.state, "intervention-required", "the operator never chose; the comment is not silently dropped");
});

// ---- issue #34: the triage phase is explicit, so an unfinished listing is never applied -----

// A runner whose first listing ends as given and whose redo ends with the numbered list.
const retryingListRunner = (first: unknown) => {
  let lists = 0;
  const runner = new FakeRunner((context) => {
    if (context.continuation?.plan.step === "list") {
      lists += 1;
      return withWorkspace(finished(lists === 1 ? first : { status: "needs_help", question: TRIAGE_LIST, context: "triagem" }), WORKSPACE);
    }
    return withWorkspace(finished(PR_READY), WORKSPACE);
  });
  return runner;
};

test("a listing that ends interrupted is redone on resume, without applying the choice", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = retryingListRunner({ status: "interrupted", reason: "queda do runtime" });
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [failingCheck("T", "test")] };
  await admission.poll();
  await admission.settle();
  assert.equal(stepOf(runner.calls[1]?.continuation), "list");
  assert.equal(admission.job(KEY("1"))?.state, "interrupted");

  await operator(stateDir).enqueue({ type: "resume", job: KEY("1") });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(stepOf(runner.calls[2]?.continuation), "list", "the resume redoes the listing, never applies");
  assert.deepEqual(commentBodies(runner.calls[2]?.continuation), ["troque este título"]);
  assert.ok(!kindsOf(runner.calls[2]?.continuation).includes("check"), "the retained check is not read while listing");
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1" });
  await admission.poll();
  await admission.settle();
  assert.equal(stepOf(runner.calls[3]?.continuation), "apply");
  assert.deepEqual(kindsOf(runner.calls[3]?.continuation), ["directed-reply", "check"], "the retained check rides along");
});

test("a listing that ends with the PR ready stays in the listing phase: the resume redoes it and preserves the retained items", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = retryingListRunner(PR_READY);

  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [failingCheck("T", "test")] };
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "intervention-required", "the operator never chose");

  await operator(stateDir).enqueue({ type: "resume", job: KEY("1") });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")], "a resume of a listing-phase triage is accepted from intervention-required");
  await admission.settle();
  assert.equal(stepOf(runner.calls[2]?.continuation), "list");
  assert.ok(!kindsOf(runner.calls[2]?.continuation).includes("check"), "the retained check is preserved");
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1" });
  await admission.poll();
  await admission.settle();
  assert.deepEqual(kindsOf(runner.calls[3]?.continuation), ["directed-reply", "check"], "the retained check survived the redo");
});

test("a resume is rejected while the triage waits for the choice, and the reason tells how to answer", async () => {
  const stateDir = await dir();
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory: memoryOf(["1"]), stateDir, runner, prs });
  await admission.poll();
  await admission.settle();
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [] };
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "resume", job: KEY("1") });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "rejected");
  assert.match(report.commands[0]?.reason ?? "", /reply … nenhum/);
  assert.equal(admission.job(KEY("1"))?.state, "waiting-for-help", "the refused resume changed nothing");
  await admission.settle();
  assert.equal(runner.calls.length, 2, "the refused resume starts no invocation");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "nenhum" });
  assert.deepEqual((await admission.poll()).admitted, [KEY("1")]);
  await admission.settle();
  assert.equal(stepOf(runner.calls[2]?.continuation), "apply");
});

test("a directed reply that spells out a check's description is not matched with the check", async () => {
  const stateDir = await dir();
  const memory = memoryOf(["1"]);
  const prs = new FakePrs();
  const runner = triagingRunner();
  const admission = await open({ memory, stateDir, runner, prs });
  await admission.poll();
  await admission.settle();

  await memory.postComment(REF("1"), "agent: check com falha: test");
  prs.feedback = { comments: [humanInline("PRRC_1", "troque este título")], checks: [failingCheck("T", "test")] };
  await admission.poll();
  await admission.settle();

  assert.equal(stepOf(runner.calls[1]?.continuation), "list");
  assert.deepEqual(commentBodies(runner.calls[1]?.continuation), ["troque este título"], "the comment is listed");
  assert.deepEqual(repliesOf(runner.calls[1]?.continuation), ["check com falha: test"], "the directed reply reaches the listing as guidance");
  assert.equal(checksOf(runner.calls[1]?.continuation).length, 0, "the check itself is not delivered while listing");

  await operator(stateDir).enqueue({ type: "reply", job: KEY("1"), message: "1" });
  await admission.poll();
  await admission.settle();
  assert.deepEqual(kindsOf(runner.calls[2]?.continuation), ["directed-reply", "directed-reply", "check"], "the held check is applied with the retained reply");
  assert.deepEqual(repliesOf(runner.calls[2]?.continuation), ["1", "check com falha: test"]);
  assert.deepEqual(checksOf(runner.calls[2]?.continuation), [{ name: "test", state: "failing" }]);
});
