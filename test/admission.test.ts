import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { Admission } from "../src/core/admission.js";
import { ISSUE_BODY_LIMIT } from "../src/core/issue-context.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { Runner, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import type { PrLookup, PrPort } from "../src/pr/port.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { ClaimOutcome, TrackerPort } from "../src/tracker/port.js";
import { jobBranch } from "../src/core/job.js";
const JOB_HEAD = jobBranch({ tracker: "memory", project: "acme/app", id: "1" });

const NEEDS_HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
// Session and area reported by the runner; a resume needs them to continue the conversation.
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };
const dir = () => mkdtemp(join(tmpdir(), "msf-admission-"));

const github = (repository: string) => ({
  name: repository,
  enabled: true,
  adapter: "github",
  repository,
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
});

function instanceFor(repos: string[], limits: { maxConcurrent?: number; maxIterations?: number } = {}): InstanceConfig {
  const parsed = parseConfig({
    credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
    instances: [{
      name: "trabalho",
      maxConcurrent: limits.maxConcurrent ?? 1,
      pollIntervalSeconds: 300,
      maxIterations: limits.maxIterations ?? 5,
      modelAuth: "copilot",
      projects: repos.map(github),
    }],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config.instances[0]!;
}

interface IssueSpec {
  repo: string;
  id: string;
  priority?: unknown;
  claimed?: boolean;
  body?: string;
}

const issue = ({ repo, id, priority = null, claimed = false, body }: IssueSpec) => ({
  project: repo,
  id,
  title: `Issue ${id}`,
  ...(body === undefined ? {} : { body }),
  labels: ["ready-for-agent"],
  assignees: [],
  claimed,
  statusCategory: "to-do",
  priority,
  blockers: [],
});

const memoryOf = (issues: IssueSpec[]) => loadMemoryTracker({ issues: issues.map(issue) });
const keyOf = (repo: string, id: string) => `memory:${repo}#${id}`;
const refOf = (repo: string, id: string) => ({ tracker: "memory" as const, project: repo, id });

// A tracker port that delegates to the memory adapter, with selected operations overridden
// to model write errors and writes that are accepted but not visible.
function trackerWith(base: MemoryTracker, overrides: Partial<TrackerPort>): TrackerPort {
  return {
    discoverCandidates: (scope) => base.discoverCandidates(scope),
    readIssue: (ref) => base.readIssue(ref),
    claim: (ref) => base.claim(ref),
    releaseClaim: (ref) => base.releaseClaim(ref),
    readComments: (ref) => base.readComments(ref),
    postComment: (ref, body) => base.postComment(ref, body),
    markDone: (ref) => base.markDone(ref),
    ...overrides,
  };
}

interface OpenOptions {
  memory: MemoryTracker;
  stateDir: string;
  runner: Runner;
  repos: string[];
  maxConcurrent?: number;
  maxIterations?: number;
  tracker?: (base: MemoryTracker) => TrackerPort;
  prs?: PrPort;
}

// Without PR state of its own a test sees no PR: a ready result is then refused.
const NO_PRS: PrPort = { readPr: async (): Promise<PrLookup> => ({ status: "not-found" }), readFeedback: async () => ({ comments: [], checks: [] }), };

const open = (options: OpenOptions) => Admission.open({
  instance: instanceFor(options.repos, { maxConcurrent: options.maxConcurrent, maxIterations: options.maxIterations }),
  eligibility: (project) => projectEligibility(instanceFor(options.repos, { maxConcurrent: options.maxConcurrent, maxIterations: options.maxIterations }), project),
  tracker: options.tracker ? options.tracker(options.memory) : options.memory,
  runner: options.runner,
  store: createFileJobStore(options.stateDir),
  commands: createFileCommandQueue(options.stateDir),
  control: createFileInstanceControl(options.stateDir),
  prs: options.prs ?? NO_PRS,
});

function gate() {
  let release!: (output: RunnerOutput) => void;
  const promise = new Promise<RunnerOutput>((resolve) => { release = resolve; });
  return { promise, release };
}

const runKinds = (runner: FakeRunner) => runner.calls.map((call) => `${call.ref.id}:${call.kind}:${call.iteration}/${call.maxIterations}`);

// ---- CA05: admission, claim and confirmation -------------------------------------

test("an eligible issue is claimed and confirmed before the runner starts, then waits for help", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  let seenByRunner: unknown;
  const runner = new FakeRunner(async (context) => {
    seenByRunner = await memory.readIssue(context.ref);
    return finished(NEEDS_HELP);
  });
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  const report = await admission.poll();
  assert.deepEqual(report.admitted, [keyOf("acme/app", "1")]);
  assert.deepEqual(await admission.settle(), []);

  const seen = seenByRunner as { claimed: { value: boolean }; statusCategory: { value: string } };
  assert.equal(seen.claimed.value, true, "claim is visible to the tracker when the runner starts");
  assert.equal(seen.statusCategory.value, "in-progress", "doing state is visible when the runner starts");
  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "waiting-for-help");
  assert.equal(job?.question, "Which seam?");
  assert.equal(job?.context, "slugify");
  assert.deepEqual(runKinds(runner), ["1:new:1/5"]);
});

test("every invocation names the repository of the job, so the runner never guesses it from the ref", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(async () => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();
  assert.deepEqual(runner.calls.map((call) => call.repository), ["acme/app"]);
});

test("the implementation invocation carries the issue title and body as context, not only ids", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1", body: "Implementar slugify.\nVer docs/spec.md" }]);
  const runner = new FakeRunner(async () => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();

  assert.deepEqual(runner.calls[0]?.issue, {
    title: "Issue 1",
    body: { known: true, value: "Implementar slugify.\nVer docs/spec.md" },
  });
});

test("a long issue body reaches the runner bounded, with its truncation marker", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1", body: "b".repeat(ISSUE_BODY_LIMIT + 1000) }]);
  const runner = new FakeRunner(async () => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();

  const body = runner.calls[0]?.issue?.body;
  assert.equal(body?.known, true);
  if (body?.known !== true) return;
  assert.ok(body.value.length < ISSUE_BODY_LIMIT + 200, "bounded size");
  assert.match(body.value, /truncado: 1000 caracteres omitidos/);
});

test("the runner does not start when the tracker does not confirm the claim and doing state", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/app"],
    tracker: (base) => trackerWith(base, { claim: async () => ({ status: "accepted" }) }),
  });

  await admission.poll();
  await admission.settle();
  assert.deepEqual(runner.calls, []);
  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "intervention-required");
  assert.match(job?.reason ?? "", /não confirmado/);
});

test("an issue claimed by someone else is never taken", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1", claimed: true }]);
  let claimCalls = 0;
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/app"],
    tracker: (base) => trackerWith(base, { claim: (ref) => { claimCalls += 1; return base.claim(ref); } }),
  });

  assert.deepEqual((await admission.poll()).admitted, []);
  assert.deepEqual(runner.calls, []);
  assert.equal(claimCalls, 0);
  assert.equal(admission.job(keyOf("acme/app", "1")), undefined);
  assert.equal((await memory.readIssue(refOf("acme/app", "1"))).claimed.known && true, true);
});

test("a claim the tracker rejects starts nothing and leaves no job behind", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const rejected: ClaimOutcome = { status: "rejected", reason: "already claimed" };
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/app"],
    tracker: (base) => trackerWith(base, { claim: async () => rejected }),
  });

  assert.deepEqual((await admission.poll()).admitted, []);
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(admission.allJobs(), []);
});

test("a write error before the write landed is followed by a reread, and the next poll retries", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  let failures = 1;
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/app"],
    tracker: (base) => trackerWith(base, {
      claim: (ref) => {
        if (failures > 0) { failures -= 1; return Promise.reject(new Error("connection reset")); }
        return base.claim(ref);
      },
    }),
  });

  const first = await admission.poll();
  assert.deepEqual(first.admitted, []);
  assert.match(first.errors[0]?.message ?? "", /erro de escrita/);
  assert.deepEqual(runner.calls, []);
  assert.equal(admission.job(keyOf("acme/app", "1")), undefined);

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
  assert.deepEqual(runKinds(runner), ["1:new:1/5"]);
});

test("a write error after the claim landed is not retried blindly: it becomes intervention-required", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  let claimCalls = 0;
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/app"],
    tracker: (base) => trackerWith(base, {
      claim: async (ref) => {
        claimCalls += 1;
        await base.claim(ref);
        throw new Error("timeout after write");
      },
    }),
  });

  await admission.poll();
  await admission.poll();
  await admission.settle();
  assert.equal(claimCalls, 1, "no repeated claim after an ambiguous write");
  assert.deepEqual(runner.calls, []);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "intervention-required");
  assert.match(admission.job(keyOf("acme/app", "1"))?.reason ?? "", /origem não comprovada/);
});

test("repeated and concurrent polls never duplicate a job", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"], maxConcurrent: 2 });

  await Promise.all([admission.poll(), admission.poll(), admission.poll()]);
  await admission.settle();
  await admission.poll();
  await admission.settle();
  assert.equal(admission.allJobs().length, 1);
  assert.deepEqual(runKinds(runner), ["1:new:1/5"]);
});

// ---- CA06: capacity, one implementation per repository, waiting releases the slot -----

test("with N=1 a second candidate waits until the running job frees the slot", async () => {
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }]);
  const blocked = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "1" ? blocked.promise : finished(NEEDS_HELP)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"] });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")]);
  assert.deepEqual((await admission.poll()).admitted, [], "no free slot while job 1 runs");
  assert.deepEqual(runKinds(runner), ["1:new:1/5"]);

  blocked.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/b", "2")]);
  await admission.settle();
  assert.equal(runner.calls.length, 2);
});

test("parallel starts never exceed N", async () => {
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }, { repo: "acme/c", id: "3" }]);
  const blocked = gate();
  const runner = new FakeRunner(() => blocked.promise);
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b", "acme/c"], maxConcurrent: 2,
  });

  await Promise.all([admission.poll(), admission.poll()]);
  assert.equal(runner.calls.length, 2);
  assert.equal(admission.allJobs().filter((job) => job.state === "running").length, 2);

  blocked.release(finished(NEEDS_HELP));
  await admission.settle();
  await admission.poll();
  await admission.settle();
  assert.deepEqual(runKinds(runner).slice(2), ["3:new:1/5"]);
});

test("only one active implementation runs per repository even with free capacity", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }, { repo: "acme/app", id: "2" }]);
  const blocked = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "1" ? blocked.promise : finished(NEEDS_HELP)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"], maxConcurrent: 2 });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  assert.deepEqual((await admission.poll()).admitted, [], "same repository already has an active implementation");

  blocked.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "2")]);
});

test("waiting for help releases the slot without readmitting the issue", async () => {
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }]);
  const first = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "1" ? first.promise : finished(NEEDS_HELP)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"] });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")]);
  assert.deepEqual((await admission.poll()).admitted, [], "job 1 holds the only slot while it runs");

  first.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/a", "1"))?.state, "waiting-for-help");
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/b", "2")]);
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, []);
  await admission.settle();
  assert.deepEqual(runKinds(runner).filter((kind) => kind.startsWith("1:")), ["1:new:1/5"]);
});

// ---- CA07: resumes and corrections first, same limits -----------------------------------

test("a requested resume runs before new work, even when the new work has higher priority", async () => {
  const memory = memoryOf([
    { repo: "acme/a", id: "1", priority: 3 },
    { repo: "acme/b", id: "2", priority: 1, claimed: true },
  ]);
  const resumed = gate();
  const runner = new FakeRunner((context) => (context.kind === "resume" ? resumed.promise : withWorkspace(finished(NEEDS_HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"] });

  await admission.poll();
  await admission.settle();
  await memory.releaseClaim(refOf("acme/b", "2"));
  assert.equal((await admission.requestContinuation(keyOf("acme/a", "1"), "resume")).status, "queued");

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")], "resume outranks the new job 2");
  assert.deepEqual((await admission.poll()).admitted, [], "job 2 waits for the slot held by the resume");
  assert.deepEqual(runKinds(runner), ["1:new:1/5", "1:resume:1/1"]);

  resumed.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/b", "2")]);
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/b", "2"))?.state, "waiting-for-help");
});

test("a resume waits for the slot held by another active job", async () => {
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }]);
  const first = gate();
  const second = gate();
  const runner = new FakeRunner((context) => {
    if (context.kind === "new") return withWorkspace(context.ref.id === "1" ? first.promise : second.promise, WORKSPACE);
    return finished(NEEDS_HELP);
  });
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"] });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")]);
  first.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/a", "1"))?.state, "waiting-for-help");

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/b", "2")], "new job 2 takes the slot");
  assert.equal((await admission.requestContinuation(keyOf("acme/a", "1"), "resume")).status, "queued");
  assert.deepEqual((await admission.poll()).admitted, [], "resume 1 waits while job 2 runs");

  second.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")]);
  await admission.settle();
  assert.deepEqual(runKinds(runner).filter((kind) => kind.startsWith("1:")), ["1:new:1/5", "1:resume:1/1"]);
});

test("a resume waits while another active implementation runs in the same repository", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }, { repo: "acme/app", id: "2" }]);
  const first = gate();
  const second = gate();
  const runner = new FakeRunner((context) => {
    if (context.kind === "new") return withWorkspace(context.ref.id === "1" ? first.promise : second.promise, WORKSPACE);
    return finished(NEEDS_HELP);
  });
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"], maxConcurrent: 2 });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  first.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "2")]);
  assert.equal((await admission.requestContinuation(keyOf("acme/app", "1"), "resume")).status, "queued");
  assert.deepEqual((await admission.poll()).admitted, [], "resume 1 waits: job 2 is active in the same repository");

  second.release(finished(NEEDS_HELP));
  await admission.settle();
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
});

test("a resume after the claim was released outside the factory goes to intervention, not to a new claim", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();
  await memory.releaseClaim(refOf("acme/app", "1"));
  await admission.requestContinuation(keyOf("acme/app", "1"), "resume");
  assert.deepEqual((await admission.poll()).admitted, []);
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "intervention-required");
  assert.match(admission.job(keyOf("acme/app", "1"))?.reason ?? "", /claim/);
  assert.equal(runner.calls.length, 1);
  assert.equal((await memory.readIssue(refOf("acme/app", "1"))).claimed.known && true, true);
});

test("a continuation is refused for a job that needs an operator decision", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished({ status: "interrupted" }));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "intervention-required");
  const outcome = await admission.requestContinuation(keyOf("acme/app", "1"), "resume");
  assert.equal(outcome.status, "rejected");
});

// ---- P05: priority and stable tie-break ------------------------------------------------

test("new work follows normalized priority, then a stable identity tie-break, not discovery order", async () => {
  const memory = memoryOf([
    { repo: "acme/d", id: "4", priority: 1 },
    { repo: "acme/c", id: "3", priority: 2 },
    { repo: "acme/b", id: "2", priority: null },
    { repo: "acme/a", id: "1", priority: 1 },
  ]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({
    memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b", "acme/c", "acme/d"], maxConcurrent: 4,
  });

  await admission.poll();
  await admission.settle();
  assert.deepEqual(runKinds(runner).map((kind) => kind.split(":")[0]), ["1", "4", "3", "2"]);
});

test("a missing priority does not remove the candidate", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1", priority: null }]);
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
});

test("unknown priority does not remove the candidate and ranks after the known priorities", async () => {
  const memory = loadMemoryTracker({ issues: [
    { ...issue({ repo: "acme/a", id: "1" }), priority: { unknown: "priority field not read" } },
    issue({ repo: "acme/b", id: "2", priority: 2 }),
  ] });
  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"], maxConcurrent: 2 });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/b", "2"), keyOf("acme/a", "1")]);
  await admission.settle();
});

// ---- CA10 and R08: result contract, interruption and iteration limit -------------------

test("a PR-ready result moves the job to waiting-for-pr with its reference and releases the slot", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }, { repo: "acme/app", id: "2" }]);
  const runner = new FakeRunner((context) => (context.ref.id === "1"
    ? finished({ status: "pr_ready", pr: { repository: "acme/app", number: 9 } })
    : finished(NEEDS_HELP)));
  const prs: PrPort = { readPr: async () => ({ status: "found", pr: {
    ref: { repository: "acme/app", number: 9 }, state: "open", baseBranch: "main", headBranch: JOB_HEAD,
    checks: { known: true, value: "pending" }, review: { known: true, value: "none" },
  } }), readFeedback: async () => ({ comments: [], checks: [] }), };
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"], prs });

  await admission.poll();
  await admission.settle();
  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "waiting-for-pr");
  assert.deepEqual(job?.pr, { repository: "acme/app", number: 9 });
});

test("an interrupted result moves the job to interrupted with its reason", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished({ status: "interrupted", reason: "tool crashed" }));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "interrupted");
  assert.equal(admission.job(keyOf("acme/app", "1"))?.reason, "tool crashed");
});

test("absent, ambiguous and invalid outputs are never success: each becomes intervention-required", async () => {
  const cases: Array<[string, RunnerOutput, RegExp]> = [
    ["absent", finished(), /ausente/],
    ["ambiguous", finished(NEEDS_HELP, NEEDS_HELP), /ambígua/],
    ["invalid", finished({ status: "complete", summary: "all green" }), /resultado inválido/],
    ["PR without reference", finished({ status: "pr_ready" }), /sem referência/],
  ];
  for (const [label, output, reason] of cases) {
    const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
    const runner = new FakeRunner(() => output);
    const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });
    await admission.poll();
    await admission.settle();
    const job = admission.job(keyOf("acme/app", "1"));
    assert.equal(job?.state, "intervention-required", label);
    assert.match(job?.reason ?? "", reason, label);
    assert.deepEqual(runKinds(runner), ["1:new:1/5"], label);
  }
});

test("a runner that throws without a structured result becomes intervention-required", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => new Error("process exited"));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  assert.deepEqual(await admission.settle(), []);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "intervention-required");
});

test("an invalid job does not block other candidates", async () => {
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }]);
  const runner = new FakeRunner((context) => (context.ref.id === "1" ? finished() : finished(NEEDS_HELP)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/a", "acme/b"] });

  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1"), keyOf("acme/b", "2")],
    "the invalid job releases its slot at once, so job 2 is not blocked");
  assert.deepEqual(await admission.settle(), []);
  assert.equal(admission.job(keyOf("acme/a", "1"))?.state, "intervention-required");
  assert.equal(admission.job(keyOf("acme/b", "2"))?.state, "waiting-for-help");
});

test("reaching maxIterations without a valid result is intervention-required, with iterations 1..N", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => ({ kind: "continue" }));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"], maxIterations: 3 });

  await admission.poll();
  assert.deepEqual(await admission.settle(), []);
  assert.deepEqual(runKinds(runner), ["1:new:1/3", "1:new:2/3", "1:new:3/3"]);
  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "intervention-required");
  assert.match(job?.reason ?? "", /limite de iterações \(3\)/);
});

test("a result found before the limit ends the invocation early", async () => {
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner((context) => (context.iteration < 2 ? { kind: "continue" } : finished(NEEDS_HELP)));
  const admission = await open({ memory, stateDir: await dir(), runner, repos: ["acme/app"] });

  await admission.poll();
  await admission.settle();
  assert.equal(runner.calls.length, 2);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");
});

// ---- R12 / P01: persistence across restarts and crashes --------------------------------

test("the state of a waiting job survives a restart and is not re-admitted", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = await open({ memory, stateDir, runner: new FakeRunner(() => finished(NEEDS_HELP)), repos: ["acme/app"] });
  await first.poll();
  await first.settle();

  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const restarted = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  const job = restarted.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "waiting-for-help");
  assert.equal(job?.question, "Which seam?");
  assert.deepEqual((await restarted.poll()).admitted, []);
  assert.deepEqual(runner.calls, []);
});

test("a job active during a crash becomes interrupted and is not re-executed", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const crashed = await open({ memory, stateDir, runner: new FakeRunner(() => gate().promise), repos: ["acme/app"] });
  await crashed.poll();
  assert.equal(crashed.job(keyOf("acme/app", "1"))?.state, "running");

  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const restarted = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  const job = restarted.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "interrupted");
  assert.match(job?.reason ?? "", /orquestrador caiu/);
  assert.deepEqual((await restarted.poll()).admitted, []);
  await restarted.settle();
  assert.deepEqual(runner.calls, []);
});

test("an unreadable job file is reported on restart without hiding the other jobs", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = await open({ memory, stateDir, runner: new FakeRunner(() => finished(NEEDS_HELP)), repos: ["acme/app"] });
  await first.poll();
  await first.settle();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(stateDir, "broken.json"), "{");

  const restarted = await open({ memory, stateDir, runner: new FakeRunner(() => finished(NEEDS_HELP)), repos: ["acme/app"] });
  assert.deepEqual(restarted.unreadable, ["broken.json"]);
  assert.equal(restarted.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");
});

test("an issue whose job file is unreadable is not admitted again, even though the tracker shows no claim", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = await open({ memory, stateDir, runner: new FakeRunner(() => finished(NEEDS_HELP)), repos: ["acme/app"] });
  await first.poll();
  await first.settle();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(stateDir, `${encodeURIComponent(keyOf("acme/app", "1"))}.json`), "{");
  await memory.releaseClaim(refOf("acme/app", "1"));

  const runner = new FakeRunner(() => finished(NEEDS_HELP));
  const restarted = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  const report = await restarted.poll();
  assert.deepEqual(report.admitted, []);
  assert.match(report.skipped[0]?.reason ?? "", /ilegível/);
  assert.deepEqual(runner.calls, []);
});
