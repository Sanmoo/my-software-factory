import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { Admission, type PollReport } from "../src/core/admission.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";
import type { PrPort } from "../src/pr/port.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { Runner, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { IssueRef } from "../src/tracker/port.js";
import { jobBranch } from "../src/core/job.js";
const JOB_HEAD = jobBranch({ tracker: "memory", project: "acme/app", id: "1" });

// Operator commands of one instance (R09, R12, P02, P03). Commands go through the local
// queue and are applied by the instance's poll; the memory tracker and the fake runner
// keep every scenario deterministic.

const HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
const PR_READY = { status: "pr_ready", pr: { repository: "acme/app", number: 7 } };
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };
const dir = () => mkdtemp(join(tmpdir(), "msf-supervision-"));

// The github.com boundary: every PR the runner reports is open, based on the target branch
// and headed by the job branch (see jobBranch), so a ready result is accepted.
const openPrs: PrPort = {
  async readPr(ref) {
    return {
      status: "found",
      pr: {
        ref,
        state: "open",
        baseBranch: "main",
        headBranch: JOB_HEAD, headSha: "h1", baseSha: "b1", mergeable: { known: true, value: "mergeable" },
        checks: { known: true, value: "pending" },
        review: { known: true, value: "none" },
      },
    };
  },
  readFeedback: async () => ({ comments: [], checks: [] }),
};

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
  claimed?: boolean;
}

const issue = ({ repo, id, claimed = false }: IssueSpec) => ({
  project: repo,
  id,
  title: `Issue ${id}`,
  labels: ["ready-for-agent"],
  assignees: [],
  claimed,
  statusCategory: "to-do",
  priority: null,
  blockers: [],
});

const memoryOf = (issues: IssueSpec[]) => loadMemoryTracker({ issues: issues.map(issue) });
const keyOf = (repo: string, id: string) => `memory:${repo}#${id}`;
const refOf = (repo: string, id: string): IssueRef => ({ tracker: "memory", project: repo, id });

interface OpenOptions {
  memory: MemoryTracker;
  stateDir: string;
  runner: Runner;
  repos: string[];
  maxConcurrent?: number;
  maxIterations?: number;
  prs?: PrPort;
}

const open = (options: OpenOptions) => Admission.open({
  instance: instanceFor(options.repos, { maxConcurrent: options.maxConcurrent, maxIterations: options.maxIterations }),
  eligibility: (project) => projectEligibility(instanceFor(options.repos, { maxConcurrent: options.maxConcurrent, maxIterations: options.maxIterations }), project),
  tracker: options.memory,
  runner: options.runner,
  store: createFileJobStore(options.stateDir),
  commands: createFileCommandQueue(options.stateDir),
  control: createFileInstanceControl(options.stateDir),
  prs: options.prs ?? openPrs,
});

// The operator side: the same queue the CLI writes to.
const operator = (stateDir: string) => createFileCommandQueue(stateDir);

function gate() {
  let release!: (output: RunnerOutput) => void;
  const promise = new Promise<RunnerOutput>((resolve) => { release = resolve; });
  return { promise, release };
}

const runKinds = (runner: FakeRunner) => runner.calls.map((call) => `${call.ref.id}:${call.kind}:${call.iteration}/${call.maxIterations}`);

// ---- R09: reply -------------------------------------------------------------------------

test("a reply to a job waiting for help reactivates it in the same session when a slot is free", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : withWorkspace(finished(HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "reply", job: keyOf("acme/app", "1"), message: "Use the v2 seam" });
  const report = await admission.poll();
  assert.deepEqual(report.commands.map((outcome) => outcome.status), ["applied"]);
  assert.deepEqual(report.admitted, [keyOf("acme/app", "1")]);
  assert.deepEqual(await admission.settle(), []);

  assert.equal(runner.calls[1]?.kind, "resume");
  assert.deepEqual(runner.calls[1]?.continuation, { workspace: WORKSPACE, replies: ["Use the v2 seam"] });
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-pr");
  assert.equal(admission.job(keyOf("acme/app", "1"))?.replies, undefined, "a delivered reply leaves the pending list");
});

test("a reply while the agent is active stays pending and is delivered by the next invocation", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = gate();
  const runner = new FakeRunner((context) => (context.kind === "new" ? first.promise : finished(PR_READY)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();

  await operator(stateDir).enqueue({ type: "reply", job: keyOf("acme/app", "1"), message: "Use the v2 seam" });
  const during = await admission.poll();
  assert.deepEqual(during.commands.map((outcome) => outcome.status), ["applied"]);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "running", "the active agent is not stopped");

  first.release(withWorkspace(finished(HELP), WORKSPACE));
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");
  assert.deepEqual((await admission.poll()).admitted, [], "a pending reply alone does not reactivate the job");
  await admission.settle();

  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
  assert.deepEqual(runner.calls[1]?.continuation?.replies, ["Use the v2 seam"], "the earlier reply goes to the next invocation");
});

test("a reply is refused visibly for a job that is no longer tracked", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();
  await operator(stateDir).enqueue({ type: "release", job: keyOf("acme/app", "1") });
  await admission.poll();

  await operator(stateDir).enqueue({ type: "reply", job: keyOf("acme/app", "1"), message: "too late" });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "rejected");
  assert.match(report.commands[0]?.reason ?? "", /reply não se aplica ao estado released/);
  assert.match(admission.job(keyOf("acme/app", "1"))?.log.at(-1) ?? "", /reply rejeitado/);
});

// ---- P03 / CA14: resume ---------------------------------------------------------------------

test("a resume continues the same session and area without new information", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : withWorkspace(finished(HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
  assert.deepEqual(runKinds(runner), ["1:new:1/5", "1:resume:1/1"]);
  assert.deepEqual(runner.calls[1]?.continuation, { workspace: WORKSPACE, replies: [] });
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-pr");
});

test("a resume without a recorded session asks for help and starts no new conversation", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => finished(HELP));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await admission.poll()).admitted, []);
  await admission.settle();
  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "waiting-for-help");
  assert.match(job?.question ?? "", /sessão/);
  assert.deepEqual(runKinds(runner), ["1:new:1/5"], "no resume and no new invocation was started");
});

test("an interrupted job without a recorded session asks for help when resumed after a crash", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const crashed = await open({ memory, stateDir, runner: new FakeRunner(() => gate().promise), repos: ["acme/app"] });
  await crashed.poll();

  const runner = new FakeRunner(() => finished(PR_READY));
  const restarted = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  assert.equal(restarted.job(keyOf("acme/app", "1"))?.state, "interrupted");
  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await restarted.poll()).admitted, []);
  await restarted.settle();
  assert.equal(restarted.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");
  assert.match(restarted.job(keyOf("acme/app", "1"))?.question ?? "", /sessão/);
  assert.deepEqual(runner.calls, []);
});

test("two resume requests start one invocation only", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : withWorkspace(finished(HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
  assert.deepEqual(await admission.poll().then((report) => report.admitted), []);
  await admission.settle();
  assert.deepEqual(runKinds(runner), ["1:new:1/5", "1:resume:1/1"]);
});

test("a resume is refused visibly while the job is running, so no second main invocation starts", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = gate();
  const runner = new FakeRunner(() => first.promise);
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();

  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "rejected");
  assert.match(report.commands[0]?.reason ?? "", /resume não se aplica ao estado running/);
  assert.deepEqual(report.admitted, []);
  assert.match(admission.job(keyOf("acme/app", "1"))?.log.at(-1) ?? "", /resume rejeitado/);
  first.release(finished(PR_READY));
  await admission.settle();
  assert.deepEqual(runKinds(runner), ["1:new:1/5"]);
});

// ---- R09: pause and unpause -----------------------------------------------------------------

test("pause blocks new admissions without stopping the active job; unpause admits again", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/a", id: "1" }, { repo: "acme/b", id: "2" }]);
  const first = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "1" ? first.promise : withWorkspace(finished(HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/a", "acme/b"] });
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/a", "1")]);

  await operator(stateDir).enqueue({ type: "pause" });
  const paused = await admission.poll();
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.admitted, []);
  assert.equal(admission.job(keyOf("acme/a", "1"))?.state, "running", "the active job keeps running");

  first.release(withWorkspace(finished(HELP), WORKSPACE));
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/a", "1"))?.state, "waiting-for-help");

  assert.deepEqual((await admission.poll()).admitted, [], "a free slot is not used while paused");
  await operator(stateDir).enqueue({ type: "unpause" });
  const resumed = await admission.poll();
  assert.equal(resumed.paused, false);
  assert.deepEqual(resumed.admitted, [keyOf("acme/b", "2")]);
  await admission.settle();
});

test("pause also holds a requested resume until unpause", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : withWorkspace(finished(HELP), WORKSPACE)));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  await operator(stateDir).enqueue({ type: "pause" });
  await operator(stateDir).enqueue({ type: "resume", job: keyOf("acme/app", "1") });
  assert.deepEqual((await admission.poll()).admitted, []);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");

  await operator(stateDir).enqueue({ type: "unpause" });
  assert.deepEqual((await admission.poll()).admitted, [keyOf("acme/app", "1")]);
  await admission.settle();
});

test("the pause survives a restart of the instance", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = await open({ memory, stateDir, runner: new FakeRunner(() => finished(HELP)), repos: ["acme/app"] });
  await operator(stateDir).enqueue({ type: "pause" });
  await first.poll();

  const runner = new FakeRunner(() => finished(HELP));
  const restarted = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  const report = await restarted.poll();
  assert.equal(report.paused, true);
  assert.deepEqual(report.admitted, []);
  assert.deepEqual(runner.calls, []);
});

test("commands are applied in the order they were queued", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const admission = await open({ memory, stateDir, runner: new FakeRunner(() => finished(HELP)), repos: ["acme/app"] });

  await operator(stateDir).enqueue({ type: "pause" });
  await operator(stateDir).enqueue({ type: "unpause" });
  assert.equal((await admission.poll()).paused, false);

  await operator(stateDir).enqueue({ type: "unpause" });
  await operator(stateDir).enqueue({ type: "pause" });
  const report = await admission.poll();
  assert.equal(report.paused, true);
  assert.deepEqual(report.commands.map((outcome) => outcome.type), ["unpause", "pause"]);
});

test("an unreadable command file is reported and does not hide the other commands", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const admission = await open({ memory, stateDir, runner: new FakeRunner(() => finished(HELP)), repos: ["acme/app"] });
  await mkdir(join(stateDir, "commands"), { recursive: true });
  await writeFile(join(stateDir, "commands", "broken.json"), "{");
  await operator(stateDir).enqueue({ type: "pause" });

  const report: PollReport = await admission.poll();
  assert.equal(report.paused, true);
  assert.match(report.errors.map((error) => error.message).join("\n"), /broken\.json/);
});

test("pause does not stop the tracking of a waiting PR: a merge is still confirmed as done", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  // The PR is open when the runner reports it, and merged by the time the pause is polled.
  let merged = false;
  const prs: PrPort = {
    async readPr(ref) {
      const state = merged ? "merged" : "open";
      return {
        status: "found",
        pr: {
          ref, state, baseBranch: "main", headBranch: JOB_HEAD, headSha: "h1", baseSha: "b1", mergeable: { known: true, value: "mergeable" },
          checks: { known: true, value: "passing" }, review: { known: true, value: "approved" },
        },
      };
    },
    readFeedback: async () => ({ comments: [], checks: [] }),
  };
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"], prs });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-pr");

  await operator(stateDir).enqueue({ type: "pause" });
  merged = true;
  const report = await admission.poll();
  assert.equal(report.paused, true);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "done");
  assert.deepEqual((await memory.readIssue(refOf("acme/app", "1"))).statusCategory, { known: true, value: "done" });
});

// ---- R09 / R12 / CA19: release ----------------------------------------------------------------

test("release removes the claim, ends tracking and keeps area, session and PR", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-pr");

  await operator(stateDir).enqueue({ type: "release", job: keyOf("acme/app", "1") });
  const report = await admission.poll();
  assert.deepEqual(report.commands.map((outcome) => outcome.status), ["applied"]);

  const job = admission.job(keyOf("acme/app", "1"));
  assert.equal(job?.state, "released");
  assert.deepEqual(job?.pr, { repository: "acme/app", number: 7 });
  assert.deepEqual(job?.workspace, WORKSPACE);

  const external = await memory.readIssue(refOf("acme/app", "1"));
  assert.deepEqual(external.claimed, { known: true, value: false });
  assert.deepEqual(external.statusCategory, { known: true, value: "in-progress" }, "release never moves the issue to done");

  assert.deepEqual((await admission.poll()).admitted, [], "a released issue is not admitted again");
  assert.equal(runKinds(runner).length, 1);
});

test("release is refused for a job whose agent is running", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const first = gate();
  const admission = await open({ memory, stateDir, runner: new FakeRunner(() => first.promise), repos: ["acme/app"] });
  await admission.poll();

  await operator(stateDir).enqueue({ type: "release", job: keyOf("acme/app", "1") });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "rejected");
  assert.match(report.commands[0]?.reason ?? "", /release não se aplica ao estado running/);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "running");
  assert.deepEqual(await memory.readIssue(refOf("acme/app", "1")).then((snapshot) => snapshot.claimed), { known: true, value: true });
  first.release(finished(HELP));
  await admission.settle();
});

test("a release the tracker does not confirm leaves the job as it was", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => withWorkspace(finished(HELP), WORKSPACE));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  memory.failNext("releaseClaim", "falha-antes", "tracker indisponível");
  await operator(stateDir).enqueue({ type: "release", job: keyOf("acme/app", "1") });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "rejected");
  assert.match(report.commands[0]?.reason ?? "", /não confirmada/);
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "waiting-for-help");
  assert.deepEqual((await memory.readIssue(refOf("acme/app", "1"))).claimed, { known: true, value: true });
});

test("a release whose write landed but whose answer was lost is confirmed by rereading the tracker", async () => {
  const stateDir = await dir();
  const memory = memoryOf([{ repo: "acme/app", id: "1" }]);
  const runner = new FakeRunner(() => withWorkspace(finished(HELP), WORKSPACE));
  const admission = await open({ memory, stateDir, runner, repos: ["acme/app"] });
  await admission.poll();
  await admission.settle();

  memory.failNext("releaseClaim", "resposta-perdida", "resposta perdida");
  await operator(stateDir).enqueue({ type: "release", job: keyOf("acme/app", "1") });
  const report = await admission.poll();
  assert.equal(report.commands[0]?.status, "applied");
  assert.equal(admission.job(keyOf("acme/app", "1"))?.state, "released");
});
