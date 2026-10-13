import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { Admission } from "../src/core/admission.js";
import type { PrRef } from "../src/core/result.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";
import { createGithubPrPort, type GhCall } from "../src/pr/github.js";
import type { PrFeedback, PrLookup, PrPort, PrSnapshot } from "../src/pr/port.js";
import { FakeRunner, finished } from "../src/runtime/fake-runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import type { DoneOutcome, TrackerPort } from "../src/tracker/port.js";
import { jobBranch } from "../src/core/job.js";

// Job branch of issue 1 (see jobBranch) and target branch of the project.
const HEAD = jobBranch({ tracker: "memory", project: "acme/app", id: "1" });
const TARGET = "main";
const READY = { status: "pr_ready", pr: { repository: "acme/app", number: 9 } };
const dir = () => mkdtemp(join(tmpdir(), "msf-pr-"));
const keyOf = "memory:acme/app#1";

const project = {
  name: "acme/app",
  enabled: true,
  adapter: "github",
  repository: "acme/app",
  targetBranch: TARGET,
  prIntegration: "github.com",
  runtimeProfile: "docker-default",
  githubAccount: "acme-bot",
  models: {
    implementer: "github-copilot/gpt-6-luna",
    "reviewer-standards": "github-copilot/claude-haiku-5.5",
    "reviewer-spec": "github-copilot/claude-haiku-5.5",
    default: "github-copilot/claude-haiku-5.5",
  },
};

function instance(): InstanceConfig {
  const parsed = parseConfig({
    credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
    instances: [{
      name: "trabalho",
      maxConcurrent: 1,
      pollIntervalSeconds: 300,
      maxIterations: 5,
      modelAuth: "copilot",
      projects: [project],
    }],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config.instances[0]!;
}

const memoryOf = () => loadMemoryTracker({
  issues: [{
    project: "acme/app", id: "1", title: "Issue 1", labels: ["ready-for-agent"], assignees: [],
    claimed: false, statusCategory: "to-do", priority: null, blockers: [],
  }],
});

// The PR port as the factory sees it: it can only read, and the test decides the PR state.
class FakePrs implements PrPort {
  readonly reads: PrRef[] = [];
  unreadable = false;
  private readonly prs = new Map<string, PrSnapshot>();

  put(pr: PrSnapshot): void {
    this.prs.set(`${pr.ref.repository}#${pr.ref.number}`, pr);
  }

  async readPr(ref: PrRef): Promise<PrLookup> {
    this.reads.push({ ...ref });
    if (this.unreadable) throw new Error("github.com indisponível");
    const pr = this.prs.get(`${ref.repository}#${ref.number}`);
    return pr ? { status: "found", pr } : { status: "not-found" };
  }

  // No human feedback and no checks unless a test says otherwise.
  async readFeedback(): Promise<PrFeedback> {
    return { comments: [], checks: [] };
  }
}

const prOf = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  ref: { repository: "acme/app", number: 9 },
  state: "open",
  baseBranch: TARGET,
  headBranch: HEAD,
  headSha: "h1",
  baseSha: "b1",
  mergeable: { known: true, value: "mergeable" },
  checks: { known: true, value: "pending" },
  review: { known: true, value: "none" },
  ...overrides,
});

interface Setup {
  memory: MemoryTracker;
  prs: FakePrs;
  runner: FakeRunner;
  stateDir: string;
}

function admissionOver(setup: Setup, tracker: TrackerPort = setup.memory, prs: PrPort = setup.prs) {
  return Admission.open({
    instance: instance(),
  eligibility: (project) => projectEligibility(instance(), project),
    tracker,
    runner: setup.runner,
    store: createFileJobStore(setup.stateDir),
    commands: createFileCommandQueue(setup.stateDir),
    control: createFileInstanceControl(setup.stateDir),
    prs,
  });
}

async function setup(runner: FakeRunner = new FakeRunner(() => finished(READY))): Promise<Setup> {
  return { memory: memoryOf(), prs: new FakePrs(), runner, stateDir: await dir() };
}

// Admits issue 1, whose runner reports PR 9 as ready; the PR is put in the port first.
async function admittedWithPr(pr: PrSnapshot = prOf()) {
  const s = await setup();
  s.prs.put(pr);
  const admission = await admissionOver(s);
  await admission.poll();
  await admission.settle();
  return { ...s, admission };
}

// ---- a "PR pronto" result is accepted only after the PR is confirmed ---------

test("a ready PR that is open, based on the target branch and headed by the job branch is accepted", async () => {
  const s = await setup();
  s.prs.put(prOf());
  const admission = await admissionOver(s);

  await admission.poll();
  await admission.settle();

  const job = admission.job(keyOf);
  assert.equal(job?.state, "waiting-for-pr");
  assert.deepEqual(job?.pr, { repository: "acme/app", number: 9 }, "the link is the one the factory recorded");
  assert.deepEqual(job?.prStatus, { checks: { known: true, value: "pending" }, review: { known: true, value: "none" }, mergeable: { known: true, value: "mergeable" } });
  assert.deepEqual(s.prs.reads, [{ repository: "acme/app", number: 9 }]);
});

test("a ready result that the PR port does not confirm becomes a help request, and the job is not run again", async () => {
  const cases: Array<[string, PrSnapshot | undefined, RegExp]> = [
    ["PR absent", undefined, /não encontrado/],
    ["PR closed without merge", prOf({ state: "closed" }), /não está aberto/],
    ["PR already merged", prOf({ state: "merged" }), /não está aberto/],
    ["base is another branch", prOf({ baseBranch: "develop" }), /base develop, esperada main/],
    ["head is another branch", prOf({ headBranch: "feature/x" }), /head feature\/x, esperado msf\/memory\/acme\/app\/1/],
  ];
  for (const [label, pr, reason] of cases) {
    const s = await setup();
    if (pr) s.prs.put(pr);
    const admission = await admissionOver(s);

    await admission.poll();
    await admission.settle();

    const job = admission.job(keyOf);
    assert.equal(job?.state, "waiting-for-help", label);
    assert.match(job?.question ?? "", reason, label);
    assert.equal(s.runner.calls.length, 1, `${label}: no new implementation`);
    const issue = await s.memory.readIssue({ tracker: "memory", project: "acme/app", id: "1" });
    assert.deepEqual(issue.statusCategory, { known: true, value: "in-progress" }, `${label}: issue not done`);
  }
});

test("a ready PR of another repository is refused without reading it", async () => {
  const s = await setup(new FakeRunner(() => finished({ status: "pr_ready", pr: { repository: "acme/other", number: 9 } })));
  s.prs.put(prOf({ ref: { repository: "acme/other", number: 9 } }));
  const admission = await admissionOver(s);

  await admission.poll();
  await admission.settle();

  assert.equal(admission.job(keyOf)?.state, "waiting-for-help");
  assert.match(admission.job(keyOf)?.question ?? "", /outro repositório \(acme\/other\)/);
  assert.deepEqual(s.prs.reads, []);
});

test("a ready PR that cannot be read is not accepted and needs the operator, not a silent success", async () => {
  const s = await setup();
  s.prs.put(prOf());
  s.prs.unreadable = true;
  const admission = await admissionOver(s);

  await admission.poll();
  await admission.settle();

  const job = admission.job(keyOf);
  assert.equal(job?.state, "intervention-required");
  assert.match(job?.reason ?? "", /não pôde ser confirmado/);
});

// ---- polling tracks CI, review and merge; merge leads to done ------------

test("an open PR keeps the job waiting, records CI and review, and writes nothing to the tracker", async () => {
  const { prs, memory, admission } = await admittedWithPr();
  prs.put(prOf({ checks: { known: true, value: "passing" } }));
  const before = await memory.readIssue({ tracker: "memory", project: "acme/app", id: "1" });

  const report = await admission.poll();
  await admission.settle();

  const job = admission.job(keyOf);
  assert.equal(job?.state, "waiting-for-pr");
  assert.equal(job?.prStatus?.checks.known && job.prStatus.checks.value, "passing");
  assert.ok(job?.log.some((line) => /CI: passing/.test(line)), "the change in CI is logged");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await memory.readIssue({ tracker: "memory", project: "acme/app", id: "1" }), before);
});

test("a PR merged into the target branch leads to done, confirmed by reread of the tracker", async () => {
  const { prs, memory, admission } = await admittedWithPr();
  prs.put(prOf({ state: "merged" }));

  await admission.poll();
  await admission.settle();

  assert.equal(admission.job(keyOf)?.state, "done");
  const issue = await memory.readIssue({ tracker: "memory", project: "acme/app", id: "1" });
  assert.deepEqual(issue.statusCategory, { known: true, value: "done" });
});

test("a merge the tracker does not confirm stays waiting, and the next poll confirms it", async () => {
  const s = await setup();
  s.prs.put(prOf());
  const memory = s.memory;
  let refusals = 1;
  const flaky: TrackerPort = {
    ...memory,
    claimMarkOf: (ref) => memory.claimMarkOf(ref),
    discoverCandidates: (scope) => memory.discoverCandidates(scope),
    readIssue: (ref) => memory.readIssue(ref),
    claim: (ref) => memory.claim(ref),
    releaseClaim: (ref) => memory.releaseClaim(ref),
    readComments: (ref) => memory.readComments(ref),
    postComment: (ref, body) => memory.postComment(ref, body),
    markDone: async (ref): Promise<DoneOutcome> => {
      if (refusals > 0) {
        refusals -= 1;
        return { status: "not-confirmed", reason: "tracker ainda mostra in-progress" };
      }
      return memory.markDone(ref);
    },
  };
  const admission = await admissionOver(s, flaky);
  await admission.poll();
  await admission.settle();
  s.prs.put(prOf({ state: "merged" }));

  const first = await admission.poll();
  assert.equal(admission.job(keyOf)?.state, "waiting-for-pr", "done is not claimed without confirmation");
  assert.equal(first.errors.length, 1);

  await admission.poll();
  assert.equal(admission.job(keyOf)?.state, "done");
});

test("a PR closed without merge interrupts the job, keeps the issue out of done, and starts nothing new", async () => {
  const { prs, memory, admission, runner } = await admittedWithPr();
  prs.put(prOf({ state: "closed" }));

  await admission.poll();
  await admission.poll();
  await admission.settle();

  const job = admission.job(keyOf);
  assert.equal(job?.state, "interrupted");
  assert.match(job?.reason ?? "", /PR fechado sem merge: acme\/app#9/);
  assert.equal(runner.calls.length, 1, "no new implementation was started");
  const issue = await memory.readIssue({ tracker: "memory", project: "acme/app", id: "1" });
  assert.deepEqual(issue.statusCategory, { known: true, value: "in-progress" }, "issue not done");
  assert.deepEqual(issue.claimed, { known: true, value: true }, "claim kept for the operator");
});

test("a PR merged into another branch is not done: it becomes an intervention", async () => {
  const { prs, admission } = await admittedWithPr();
  prs.put(prOf({ state: "merged", baseBranch: "develop" }));

  await admission.poll();
  await admission.settle();

  assert.equal(admission.job(keyOf)?.state, "intervention-required");
  assert.match(admission.job(keyOf)?.reason ?? "", /base develop, esperada main/);
});

test("an unreadable PR during tracking changes nothing and is read again on the next poll", async () => {
  const { prs, admission } = await admittedWithPr();
  prs.unreadable = true;

  const failed = await admission.poll();
  assert.equal(admission.job(keyOf)?.state, "waiting-for-pr");
  assert.equal(failed.errors.length, 1);

  prs.unreadable = false;
  prs.put(prOf({ state: "merged" }));
  await admission.poll();
  assert.equal(admission.job(keyOf)?.state, "done");
});

test("the merge is seen after a restart: no Pi session is kept alive to wait for it", async () => {
  const s = await setup();
  s.prs.put(prOf());
  const first = await admissionOver(s);
  await first.poll();
  await first.settle();

  const restarted = await admissionOver(s);
  assert.equal(restarted.job(keyOf)?.state, "waiting-for-pr");
  s.prs.put(prOf({ state: "merged" }));
  await restarted.poll();

  assert.equal(restarted.job(keyOf)?.state, "done");
  assert.equal(s.runner.calls.length, 1, "the implementation ran once");
});

test("the full lifecycle through the github.com adapter builds no merge call", async () => {
  let pr: { state: string; base: string; head: string; rollup: string } = { state: "OPEN", base: TARGET, head: HEAD, rollup: "PENDING" };
  const argvs: string[][] = [];
  const run: GhCall = async (args) => {
    argvs.push([...args]);
    if (args[0] === "auth") return { exitCode: 0, stdout: "gho_test_not_real\n", stderr: "" };
    const pullRequest = {
      state: pr.state, baseRefName: pr.base, headRefName: pr.head, headRefOid: "h1", baseRefOid: "b1", mergeable: "MERGEABLE", reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: pr.rollup } } }] },
    };
    return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest } } }), stderr: "" };
  };
  const s = await setup();
  const admission = await admissionOver(s, s.memory, createGithubPrPort({ accountOf: () => "acme-bot", run }));

  await admission.poll();
  await admission.settle();
  assert.equal(admission.job(keyOf)?.state, "waiting-for-pr");
  pr = { ...pr, rollup: "SUCCESS" };
  await admission.poll();
  pr = { ...pr, state: "MERGED" };
  await admission.poll();

  assert.equal(admission.job(keyOf)?.state, "done");
  assert.ok(argvs.length > 0);
  assert.ok(argvs.every((argv) => !argv.includes("merge")), "no gh call merges a PR");
  assert.ok(argvs.every((argv) => !argv.some((arg) => /mergePullRequest|enablePullRequestAutoMerge|pr merge/i.test(arg))), "reading mergeability is not a merge");
});
