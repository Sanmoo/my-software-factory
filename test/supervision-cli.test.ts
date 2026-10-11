import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Admission } from "../src/core/admission.js";
import { loadConfigFile } from "../src/config/load.js";
import { runLogs } from "../src/cli/logs.js";
import { runStatus } from "../src/cli/status.js";
import { runSupervision } from "../src/cli/supervision.js";
import type { PrPort } from "../src/pr/port.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { RunnerContext, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";

// The operator's CLI for one instance (R09). The CLI writes commands to the instance's local
// queue; the instance applies them on its next poll. The memory tracker and the fake runner
// keep the scenario deterministic.

const PROJECT = {
  name: "acme/app",
  enabled: true,
  adapter: "github",
  repository: "acme/app",
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

const CONFIG = {
  credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
  instances: [{
    name: "trabalho",
    maxConcurrent: 1,
    pollIntervalSeconds: 300,
    maxIterations: 3,
    modelAuth: "copilot",
    projects: [PROJECT],
  }],
};

const TRACKER = {
  issues: [{
    project: "acme/app", id: "1", title: "Needs a seam", labels: ["ready-for-agent"], assignees: [],
    claimed: false, statusCategory: "to-do", priority: null, blockers: [],
  }],
};

const JOB = "memory:acme/app#1";
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };
const HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
const PR_READY = { status: "pr_ready", pr: { repository: "acme/app", number: 7 } };

// The github.com boundary: every PR the runner reports is open, based on the target branch
// and headed by the job branch (msf/<issue id>), so a ready result is accepted.
const openPrs: PrPort = {
  async readPr(ref) {
    return {
      status: "found",
      pr: {
        ref,
        state: "open",
        baseBranch: "main",
        headBranch: "msf/1",
        checks: { known: true, value: "pending" },
        review: { known: true, value: "none" },
      },
    };
  },
  readFeedback: async () => ({ comments: [], checks: [] }),
};

interface Fixtures {
  configPath: string;
  fixturePath: string;
  stateDir: string;
  // One tracker for every admission of the scenario, as a real tracker keeps the claim.
  tracker: MemoryTracker;
}

async function fixturesIn(dir: string): Promise<Fixtures> {
  const fixtures = {
    configPath: join(dir, "config.json"),
    fixturePath: join(dir, "tracker.json"),
    stateDir: join(dir, "state"),
    tracker: loadMemoryTracker(TRACKER),
  };
  await writeFile(fixtures.configPath, JSON.stringify(CONFIG));
  await writeFile(fixtures.fixturePath, JSON.stringify(TRACKER));
  return fixtures;
}

// The instance has asked for help on job 1 inside a known session, as a real run would.
async function prepare(): Promise<Fixtures> {
  const fixtures = await fixturesIn(await mkdtemp(join(tmpdir(), "msf-supervision-cli-")));
  const admission = await openAdmission(fixtures, new FakeRunner(() => withWorkspace(finished(HELP), WORKSPACE)));
  await admission.poll();
  assert.deepEqual(await admission.settle(), []);
  assert.equal(admission.job(JOB)?.state, "waiting-for-help");
  return fixtures;
}

// The instance itself: the same admission the operator's commands are applied to.
async function openAdmission(fixtures: Fixtures, runner: FakeRunner | { run: (context: RunnerContext) => Promise<RunnerOutput> }) {
  const loaded = await loadConfigFile(fixtures.configPath);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return Admission.open({
    instance: loaded.config.instances[0]!,
    tracker: fixtures.tracker,
    runner,
    store: createFileJobStore(fixtures.stateDir),
    commands: createFileCommandQueue(fixtures.stateDir),
    control: createFileInstanceControl(fixtures.stateDir),
    prs: openPrs,
  });
}

const common = (f: Fixtures) => ["--config", f.configPath, "--instance", "trabalho", "--state-dir", f.stateDir];
const statusArgs = (f: Fixtures) => [...common(f).slice(0, 4), "--fixture", f.fixturePath, "--state-dir", f.stateDir];
const logsArgs = (f: Fixtures) => [...common(f), JOB];

test("reply records a directed answer without changing the job until the instance applies it", async () => {
  const f = await prepare();
  const run = await runSupervision(["reply", ...common(f), "--message", "Use the v2 seam", JOB]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /resposta registrada \(memory:acme\/app#1\) na fila da instância trabalho/);

  const before = await runLogs(logsArgs(f));
  assert.match(before.stdout, /estado: aguardando ajuda/);
  assert.doesNotMatch(before.stdout, /Use the v2 seam/);
});

test("the instance applies a queued reply: the job resumes its session with the answer", async () => {
  const f = await prepare();
  await runSupervision(["reply", ...common(f), "--message", "Use the v2 seam", JOB]);

  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : finished(HELP)));
  const admission = await openAdmission(f, runner);
  const report = await admission.poll();
  assert.deepEqual(report.admitted, [JOB]);
  assert.deepEqual(report.commands.map((outcome) => outcome.status), ["applied"]);
  await admission.settle();
  assert.deepEqual(runner.calls[0]?.continuation, { workspace: WORKSPACE, replies: ["Use the v2 seam"] });

  const logs = await runLogs(logsArgs(f));
  assert.match(logs.stdout, /estado: aguardando PR/);
  assert.match(logs.stdout, /resposta recebida; reativação quando houver vaga: Use the v2 seam/);
});

test("resume queues a continuation of the same session for the instance to apply", async () => {
  const f = await prepare();
  const run = await runSupervision(["resume", ...common(f), JOB]);
  assert.equal(run.exitCode, 0, run.stderr);

  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : finished(HELP)));
  const admission = await openAdmission(f, runner);
  assert.deepEqual((await admission.poll()).admitted, [JOB]);
  await admission.settle();
  assert.equal(runner.calls[0]?.kind, "resume");
  assert.deepEqual(runner.calls[0]?.continuation, { workspace: WORKSPACE, replies: [] });
});

test("release removes the claim through the instance and shows the job as released", async () => {
  const f = await prepare();
  const run = await runSupervision(["release", ...common(f), JOB]);
  assert.equal(run.exitCode, 0, run.stderr);

  const admission = await openAdmission(f, new FakeRunner(() => finished(HELP)));
  await admission.poll();
  assert.equal(admission.job(JOB)?.state, "released");

  const logs = await runLogs(logsArgs(f));
  assert.match(logs.stdout, /estado: liberado \(sem acompanhamento\)/);
  assert.match(logs.stdout, /claim removido pelo operador/);
  assert.match(logs.stdout, /área, sessão e PR preservados/);
});

test("pause and unpause are instance-wide, and status shows the admission state and queued commands", async () => {
  const f = await prepare();
  assert.equal((await runSupervision(["pause", ...common(f)])).exitCode, 0);

  const paused = await runStatus(statusArgs(f));
  assert.match(paused.stdout, /Admissões: pausadas/);
  assert.match(paused.stdout, /Comandos pendentes: 1/);

  await openAdmission(f, new FakeRunner(() => finished(HELP))).then((admission) => admission.poll());
  const afterPoll = await runStatus(statusArgs(f));
  assert.match(afterPoll.stdout, /Admissões: pausadas/);
  assert.match(afterPoll.stdout, /Comandos pendentes: 0/);

  assert.equal((await runSupervision(["unpause", ...common(f)])).exitCode, 0);
  await openAdmission(f, new FakeRunner(() => finished(HELP))).then((admission) => admission.poll());
  assert.match((await runStatus(statusArgs(f))).stdout, /Admissões: ativas/);
});

test("a job that does not exist is refused and nothing is queued", async () => {
  const f = await prepare();
  const run = await runSupervision(["reply", ...common(f), "--message", "hello", "memory:acme/app#99"]);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /trabalho memory:acme\/app#99 não encontrado/);

  const admission = await openAdmission(f, new FakeRunner(() => finished(HELP)));
  assert.deepEqual((await admission.poll()).commands, []);
});

test("usage errors are reported before anything is queued", async () => {
  const f = await prepare();
  const cases: Array<[string[], number, RegExp]> = [
    [["reply", ...common(f), JOB], 2, /--message/],
    [["reply", ...common(f), "--message", "  ", JOB], 2, /resposta vazia|--message/],
    [["pause", ...common(f), JOB], 2, /uso:/],
    [["resume", ...common(f)], 2, /uso:/],
    [["explode", ...common(f), JOB], 2, /comando desconhecido: explode/],
    [["pause", "--config", f.configPath, "--instance", "pessoal", "--state-dir", f.stateDir], 2, /instância 'pessoal' não encontrada/],
  ];
  for (const [argv, exitCode, message] of cases) {
    const run = await runSupervision(argv);
    assert.equal(run.exitCode, exitCode, JSON.stringify(argv));
    assert.match(run.stderr, message, JSON.stringify(argv));
  }
  const admission = await openAdmission(f, new FakeRunner(() => finished(HELP)));
  assert.deepEqual((await admission.poll()).commands, []);
});

test("with no state directory the command cannot be queued, so the CLI says so", async () => {
  const f = await prepare();
  const run = await runSupervision(["pause", "--config", f.configPath, "--instance", "trabalho"]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /--state-dir/);
});

test("a reply to a job waiting for help that has no session is answered with a visible help request", async () => {
  const f = await fixturesIn(await mkdtemp(join(tmpdir(), "msf-supervision-cli-")));
  const first = await openAdmission(f, new FakeRunner(() => finished(HELP)));
  await first.poll();
  await first.settle();

  await runSupervision(["reply", ...common(f), "--message", "Use the v2 seam", JOB]);
  const runner = new FakeRunner(() => finished(PR_READY));
  const admission = await openAdmission(f, runner);
  assert.deepEqual((await admission.poll()).admitted, []);
  await admission.settle();
  assert.deepEqual(runner.calls, []);
  assert.match(admission.job(JOB)?.question ?? "", /sessão/);
});

test("a command file written by an operator cannot hide the status of the other jobs", async () => {
  const f = await prepare();
  assert.equal((await runSupervision(["pause", ...common(f)])).exitCode, 0);
  await writeFile(join(f.stateDir, "commands", "broken.json"), "{").catch(() => undefined);
  const status = await runStatus(statusArgs(f));
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /memory:acme\/app#1 aguardando ajuda/);
});
