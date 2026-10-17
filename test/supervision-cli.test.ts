import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { Admission } from "../src/core/admission.js";
import { loadConfigFile } from "../src/config/load.js";
import { stringifyYaml } from "../src/config/yaml.js";
import { runLogs } from "../src/cli/logs.js";
import { loadInstance } from "../src/cli/instance.js";
import { runStatus } from "../src/cli/status.js";
import { runSupervision } from "../src/cli/supervision.js";
import type { PrPort } from "../src/pr/port.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { RunnerContext, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import { jobBranch } from "../src/core/job.js";
import { createObserver, type Observer } from "../src/core/observability.js";
import { createFileFailureStore, createFileHistory } from "../src/state/history.js";
const JOB_HEAD = jobBranch({ tracker: "memory", project: "acme/app", id: "1" });

// The operator's CLI for one instance. The CLI writes commands to the instance's local
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

interface Fixtures {
  configPath: string;
  fixturePath: string;
  stateDir: string;
  // One tracker for every admission of the scenario, as a real tracker keeps the claim.
  tracker: MemoryTracker;
}

async function fixturesIn(dir: string): Promise<Fixtures> {
  const fixtures = {
    configPath: join(dir, "config.yaml"),
    fixturePath: join(dir, "tracker.json"),
    stateDir: join(dir, "state"),
    tracker: loadMemoryTracker(TRACKER),
  };
  await writeFile(fixtures.configPath, stringifyYaml(CONFIG));
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
async function openAdmission(fixtures: Fixtures, runner: FakeRunner | { run: (context: RunnerContext) => Promise<RunnerOutput> }, observer?: Observer) {
  const loaded = await loadConfigFile(fixtures.configPath);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return Admission.open({
    instance: loaded.config.instances[0]!,
  eligibility: (project) => projectEligibility(loaded.config.instances[0]!, project),
    tracker: fixtures.tracker,
    runner,
    store: createFileJobStore(fixtures.stateDir),
    commands: createFileCommandQueue(fixtures.stateDir),
    control: createFileInstanceControl(fixtures.stateDir),
    prs: openPrs,
    ...(observer ? { observer } : {}),
  });
}

const common = (f: Fixtures) => ["--config", f.configPath, "--instance", "trabalho", "--state-dir", f.stateDir];
const statusOf = async (f: Fixtures) => {
  const loaded = await loadInstance(f.configPath, "trabalho");
  assert.ok(loaded.ok);
  return runStatus({ instance: loaded.instance, stateDir: f.stateDir, env: {}, tracker: f.tracker });
};
const logsArgs = (f: Fixtures) => [...common(f), JOB];

test("reply records a directed answer without changing the job until the instance applies it", async () => {
  const f = await prepare();
  const run = await runSupervision(["reply", ...common(f), "--message", "Use the v2 seam", JOB]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /resposta registrada \(memory:acme\/app#1\) na fila da instância trabalho/);
  // Queued is not applied and not delivered, and the command has an id to follow it by.
  assert.match(run.stdout, /comando=\S+; enfileirado, ainda não aplicado nem entregue ao agente/);

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
  const resumed = runner.calls[0]?.continuation;
  assert.equal(resumed?.plan.step, "continue");
  assert.deepEqual(
    resumed?.plan.step === "continue" ? resumed.plan.items.map((item) => (item.kind === "directed-reply" ? item.message : item.kind)) : undefined,
    ["Use the v2 seam"],
  );
  assert.equal(runner.calls[0]?.kind, "resume");
  assert.equal(runner.calls.length, 1, "one reply starts one continuation");
  await admission.poll();
  await admission.settle();
  assert.equal(runner.calls.length, 1, "consumed reply is not dispatched again");

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
  assert.deepEqual(runner.calls[0]?.continuation, { workspace: WORKSPACE, plan: { step: "continue", items: [] } });
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

  const paused = await statusOf(f);
  assert.match(paused.stdout, /Admissões: pausadas/);
  assert.match(paused.stdout, /Comandos pendentes: 1/);

  await openAdmission(f, new FakeRunner(() => finished(HELP))).then((admission) => admission.poll());
  const afterPoll = await statusOf(f);
  assert.match(afterPoll.stdout, /Admissões: pausadas/);
  assert.match(afterPoll.stdout, /Comandos pendentes: 0/);

  assert.equal((await runSupervision(["unpause", ...common(f)])).exitCode, 0);
  await openAdmission(f, new FakeRunner(() => finished(HELP))).then((admission) => admission.poll());
  assert.match((await statusOf(f)).stdout, /Admissões: ativas/);
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
  const status = await statusOf(f);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /Pedidos de ajuda \(1\):\n {2}#1 — /);
});

test("logs shows the timeline of a reply from the queue to the outcome, with ids and without promising delivery", async () => {
  const f = await prepare();
  const lines: string[] = [];
  const observer = createObserver({ instance: "trabalho", console: (line) => lines.push(line), history: createFileHistory(f.stateDir) });
  // The first help request happened before this process: its history comes from the same files.
  const run = await runSupervision(["reply", ...common(f), "--message", "Use the v2 seam", JOB]);
  const id = /comando=(\S+);/.exec(run.stdout)![1]!;

  const runner = new FakeRunner((context) => (context.kind === "resume" ? finished(PR_READY) : finished(HELP)));
  const admission = await openAdmission(f, runner, observer);
  await admission.poll();
  await admission.settle();
  await observer.flush();

  const logs = (await runLogs(logsArgs(f))).stdout;
  const timeline = logs.slice(logs.indexOf("linha do tempo:"));
  const order = ["reply enfileirado", "reply aplicado", "invocação retomada", "resposta incluída na retomada", "PR aceito para acompanhamento"]
    .map((text) => timeline.indexOf(text));
  assert.ok(order.every((index) => index >= 0), `every step is on the timeline: ${order.join(",")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
  assert.equal(timeline.split(`comando=${id}`).length - 1, 4, "the command id correlates enqueue, application, resume and inclusion");
  assert.doesNotMatch(timeline, /entregue/, "no delivery is promised without runtime evidence");
  assert.match(timeline, /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/, "timestamped");
});

test("status shows a failing observability, and a history that cannot be written does not lose the queued command", async () => {
  const f = await prepare();
  await createFileFailureStore(f.stateDir).record({ at: "2026-10-11T12:00:00.000Z", sink: "log detalhado", message: "EACCES" });
  const status = await statusOf(f);
  assert.match(status.stdout, /Observabilidade: falha em log detalhado desde 2026-10-11T12:00:00.000Z: EACCES/);

  const blocked = await fixturesIn(await mkdtemp(join(tmpdir(), "msf-supervision-cli-")));
  await mkdir(blocked.stateDir, { recursive: true });
  await writeFile(join(blocked.stateDir, "history"), "blocks the directory");
  await writeFile(join(blocked.stateDir, "memory%3Aacme%2Fapp%231.json"), JSON.stringify({
    key: JOB, ref: { tracker: "memory", project: "acme/app", id: "1" }, repository: "acme/app", state: "waiting-for-help", log: [],
  }));
  const run = await runSupervision(["resume", ...common(blocked), JOB]);
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /aviso: o histórico local não pôde ser gravado/);
  assert.equal((await createFileCommandQueue(blocked.stateDir).pending()).commands.length, 1, "the command is still queued");
});

// ── Comandos que endereçam uma sessão assistida (ticket #56) ─────────────────────────────────

test("um comando de operador serve também a uma sessão assistida registrada; alvo desconhecido segue recusado", async () => {
  const f = await prepare();
  // Sem registro nenhum: a recusa diz os dois lugares consultados.
  const missing = await runSupervision(["resume", ...common(f), "memory:acme/app#9"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /trabalho memory:acme\/app#9 não encontrado \(nem como atendimento assistido\)/);

  const store = createFileAssistSessionStore(join(f.stateDir, "assist-sessions"));
  await store.save({
    key: "memory:acme/app#9", ref: { tracker: "memory", project: "acme/app", id: "9" },
    repository: "acme/app", state: "pending", promptKind: "needs-triage", model: "p/m",
    image: "img", cloneDir: "/c", startedAt: "2026-10-14T12:00:00.000Z",
    reason: "execução encerrada (exit 0) sem resultado de atendimento reconhecido",
    continuity: { question: "autoriza uma retomada futura desta mesma sessão?", askedAt: "2026-10-14T12:05:00.000Z" },
    log: [],
  } as never);

  for (const [command, expected] of [["resume", /resume registrado \(memory:acme\/app#9\)/], ["release", /liberação registrada \(memory:acme\/app#9\)/]] as const) {
    const run = await runSupervision([command, ...common(f), "memory:acme/app#9"]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, expected);
    assert.match(run.stdout, /enfileirado, ainda não aplicado/);
  }
  const reply = await runSupervision(["reply", ...common(f), "--message", "não autorizo retomada automática", "memory:acme/app#9"]);
  assert.equal(reply.exitCode, 0, reply.stderr);
  assert.match(reply.stdout, /resposta registrada \(memory:acme\/app#9\)/);
});
// The approval of a proposed assisted result (ticket #55): the CLI validates the key against
// the assist session store (not the implementation jobs'), queues the command and the assisted
// flow applies it on the next poll.
const ASSIST_SESSION = {
  key: "memory:acme/app#1",
  ref: { tracker: "memory" as const, project: "acme/app", id: "1" },
  repository: "acme/app",
  state: "proposed" as const,
  promptKind: "needs-triage" as const,
  model: "github-copilot/claude-haiku-5.5",
  image: "msf-docker-runner:local",
  cloneDir: "/tmp/clone",
  startedAt: "2026-10-14T12:00:00.000Z",
  log: [],
};

test("approve queues an approval for the assisted attendance found in the session store", async () => {
  const f = await fixturesIn(await mkdtemp(join(tmpdir(), "msf-supervision-cli-")));
  const store = createFileAssistSessionStore(join(f.stateDir, "assist-sessions"));
  await store.save({ ...ASSIST_SESSION });
  const run = await runSupervision(["approve", ...common(f), "memory:acme/app#1"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /aprovação registrada \(memory:acme\/app#1\)/);
  const queued = (await createFileCommandQueue(f.stateDir).pending()).commands;
  assert.deepEqual(queued.map((c) => c.type), ["approve"]);
  assert.equal((queued[0] as { job?: string }).job, "memory:acme/app#1");
});

test("approve refuses a key that is not a tracked assisted attendance", async () => {
  const f = await fixturesIn(await mkdtemp(join(tmpdir(), "msf-supervision-cli-")));
  const run = await runSupervision(["approve", ...common(f), "memory:acme/app#9"]);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /atendimento assistido memory:acme\/app#9 não encontrado/);
  assert.equal((await createFileCommandQueue(f.stateDir).pending()).commands.length, 0, "nada fica na fila");
});
