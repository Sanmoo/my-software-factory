import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMsf, type MsfDeps } from "../src/cli/msf.js";
import { newJob, transitionJob } from "../src/core/job.js";
import type { TrackerPort } from "../src/tracker/port.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileJobStore } from "../src/state/file-job-store.js";

// The operator's single entry point: `./msf [--home DIR] <instância> <comando> [trabalho] [opções]`.
// The tests call the entry with a temporary repository root, so no process is spawned.

const MODELS = {
  implementer: "github-copilot/gpt-6-luna",
  "reviewer-standards": "github-copilot/claude-haiku-5.5",
  "reviewer-spec": "github-copilot/claude-haiku-5.5",
  default: "github-copilot/claude-haiku-5.5",
};
const github = (repository: string) => ({
  name: repository, enabled: true, adapter: "github", repository, targetBranch: "main", prIntegration: "github.com",
  runtimeProfile: "docker-default", githubAccount: "acme", models: MODELS,
});
const jira = {
  name: "monolith", enabled: true, adapter: "jira", repository: "acme/mono", targetBranch: "main", prIntegration: "github.com",
  runtimeProfile: "docker-default", githubAccount: "acme", models: MODELS,
  jira: {
    projectKey: "VAN", routingLabel: "mono", operator: "acc-1", doingTransition: "Doing", doneTransition: "Done",
    blockingLinkTypes: ["Blocks"], credential: "JIRA",
  },
};
const mixedJira = { ...jira, name: "mixed-jira", repository: "acme/mixed-mono", jira: { ...jira.jira, projectKey: "MIX", routingLabel: "mix" } };
const instance = (name: string, projects: object[]) => ({
  name, maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 3, modelAuth: "copilot", projects,
});
const CONFIG = {
  runtimeProfiles: { "docker-default": { required: { files: ["settings.json"] } } },
  credentials: { copilot: { kind: "pi-auth", ref: "copilot" }, JIRA: { kind: "env", ref: "JIRA_API_TOKEN" } },
  instances: [
    instance("pessoal", [github("acme/app"), github("acme/other")]),
    instance("trabalho", [jira]),
    instance("misto", [github("acme/mixed"), mixedJira]),
  ],
};

const jobOf = (repository: string, id: string, interrupted = false) => {
  const job = newJob({ ref: { tracker: "github", project: repository, id }, repository });
  return interrupted ? transitionJob(job, "interrupted", { message: "interrompido", reason: "caiu" }) : job;
};
const KEY = (repository: string, id: string) => `github:${repository}#${id}`;

interface Ctx { root: string; deps: MsfDeps; stateDir: (home: string, instance?: string) => string }

async function setup(options: { home?: string; jobs?: Array<[string, string]>; config?: boolean; local?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), "msf-root-"));
  const home = join(root, options.home ?? ".msf");
  await mkdir(home, { recursive: true });
  if (options.config !== false) await writeFile(join(home, "config.json"), JSON.stringify(CONFIG));
  if (options.local !== false) await writeFile(join(home, "local.json"), JSON.stringify({
    profiles: { copilot: join(root, "profile"), "docker-default": join(root, "profile") },
    allowedRoots: { "docker-default": [join(root, "roots")] },
    checkouts: { "acme/app": join(root, "app"), "acme/other": join(root, "other"), "acme/mono": join(root, "mono"), "acme/mixed": join(root, "mixed"), "acme/mixed-mono": join(root, "mixed-mono") },
  }));
  const store = createFileJobStore(join(home, "state", "pessoal"));
  for (const [repository, id] of options.jobs ?? []) await store.save(jobOf(repository, id, true));
  return { root, deps: { root, env: options.env ?? {} }, stateDir: (name, inst = "pessoal") => join(root, name, "state", inst) };
}

const queued = async (stateDir: string) => (await createFileCommandQueue(stateDir).pending()).commands;

test("a command resolved by the short reference reaches the queue with the full key", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"]] });
  const run = await runMsf(["pessoal", "resume", "#13"], ctx.deps);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /enfileirado, ainda não aplicado nem entregue ao agente/);
  const [command] = await queued(ctx.stateDir(".msf"));
  assert.equal(command?.type, "resume");
  assert.equal((command as { job: string }).job, KEY("acme/app", "13"));
});

test("the full key is still accepted", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"]] });
  const run = await runMsf(["pessoal", "release", KEY("acme/app", "13")], ctx.deps);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal((await queued(ctx.stateDir(".msf"))).length, 1);
});

test("a short reference that matches two jobs is refused, lists the full keys and queues nothing", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"], ["acme/other", "13"]] });
  const run = await runMsf(["pessoal", "resume", "#13"], ctx.deps);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, new RegExp(KEY("acme/app", "13")));
  assert.match(run.stderr, new RegExp(KEY("acme/other", "13")));
  assert.deepEqual(await queued(ctx.stateDir(".msf")), []);
  // The full key still disambiguates.
  assert.equal((await runMsf(["pessoal", "resume", KEY("acme/other", "13")], ctx.deps)).exitCode, 0);
});

test("a reference that matches no job says the job was not found", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"]] });
  const run = await runMsf(["pessoal", "logs", "#99"], ctx.deps);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /trabalho #99 não encontrado/);
  assert.deepEqual(await queued(ctx.stateDir(".msf")), []);
});

test("reply carries the message; pause and unpause take no job", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"]] });
  assert.equal((await runMsf(["pessoal", "reply", "#13", "--message", "use o seam v2"], ctx.deps)).exitCode, 0);
  assert.equal((await runMsf(["pessoal", "pause"], ctx.deps)).exitCode, 0);
  assert.equal((await runMsf(["pessoal", "unpause"], ctx.deps)).exitCode, 0);
  const commands = await queued(ctx.stateDir(".msf"));
  assert.deepEqual(commands.map((command) => command.type), ["reply", "pause", "unpause"]);
  assert.equal((commands[0] as { message: string }).message, "use o seam v2");
});

test("logs shows the job found by its short reference", async () => {
  const ctx = await setup({ jobs: [["acme/app", "13"]] });
  const run = await runMsf(["pessoal", "logs", "#13"], ctx.deps);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`trabalho ${KEY("acme/app", "13")}`));
  assert.match(run.stdout, /estado: interrompido/);
});

test("--home, absolute or relative to the root, picks the base directory; the state directory keeps the .pilot layout", async () => {
  const ctx = await setup({ home: ".pilot", jobs: [] });
  const store = createFileJobStore(join(ctx.root, ".pilot", "state", "pessoal"));
  await store.save(jobOf("acme/app", "13", true));
  assert.equal((await runMsf(["--home", ".pilot", "pessoal", "resume", "#13"], ctx.deps)).exitCode, 0);
  assert.equal((await runMsf(["--home", join(ctx.root, ".pilot"), "pessoal", "pause"], ctx.deps)).exitCode, 0);
  const commands = await queued(join(ctx.root, ".pilot", "state", "pessoal"));
  assert.deepEqual(commands.map((command) => command.type), ["resume", "pause"]);
});

test("the default base directory is .msf at the root, whatever the current folder", async () => {
  const ctx = await setup();
  assert.equal((await runMsf(["pessoal", "pause"], ctx.deps)).exitCode, 0);
  assert.equal((await queued(ctx.stateDir(".msf"))).length, 1);
});

test("an unknown instance lists the available ones", async () => {
  const ctx = await setup();
  const run = await runMsf(["inexistente", "pause"], ctx.deps);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /instância 'inexistente' não encontrada; disponíveis: pessoal, trabalho/);
});

test("a base directory without config.json or local.json names the path it looked for", async () => {
  const noConfig = await setup({ config: false });
  const run = await runMsf(["pessoal", "pause"], noConfig.deps);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, new RegExp(`config\\.json não encontrado em ${join(noConfig.root, ".msf", "config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const noLocal = await setup({ local: false });
  const check = await runMsf(["pessoal", "run", "--check"], noLocal.deps);
  assert.equal(check.exitCode, 1);
  assert.match(check.stderr, new RegExp(`local\\.json não encontrado em ${join(noLocal.root, ".msf", "local.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("help: global, by command, with and without the instance; always the ./msf form", async () => {
  const ctx = await setup();
  const global = await runMsf(["--help"], ctx.deps);
  assert.equal(global.exitCode, 0);
  for (const command of ["run", "logs", "reply", "resume", "release", "pause", "unpause", "status"]) assert.match(global.stdout, new RegExp(`\\b${command}\\b`));
  const withInstance = await runMsf(["pessoal", "reply", "--help"], ctx.deps);
  const withoutInstance = await runMsf(["reply", "--help"], ctx.deps);
  assert.equal(withInstance.exitCode, 0);
  assert.equal(withInstance.stdout, withoutInstance.stdout);
  assert.match(withInstance.stdout, /uso: \.\/msf \[--home DIR\] <instância> reply <trabalho> --message TEXTO/);
  assert.doesNotMatch(global.stdout + withInstance.stdout, /npm run/);
  assert.match((await runMsf(["pessoal", "run", "--help"], ctx.deps)).stdout, /--check[\s\S]*--once/);
});

test("a syntax error prints the usage of the command next to the error", async () => {
  const ctx = await setup();
  for (const [argv, error] of [
    [["pessoal", "reply", "#13"], /reply exige --message/],
    [["pessoal", "resume"], /informe um trabalho/],
    [["pessoal", "pause", "#13"], /pause não recebe trabalho/],
    [["pessoal", "resume", "#13", "--nope"], /argumento desconhecido: --nope/],
    [["pessoal", "frobnicate"], /comando desconhecido: frobnicate/],
    [["resume", "#13"], /informe a instância antes do comando/],
  ] as const) {
    const run = await runMsf(argv, ctx.deps);
    assert.equal(run.exitCode, 2, argv.join(" "));
    assert.match(run.stderr, error);
    assert.match(run.stderr, /uso: \.\/msf/);
    assert.doesNotMatch(run.stderr, /npm run/);
  }
  assert.deepEqual(await queued(ctx.stateDir(".msf")), []);
});

test("supervision commands need no Jira credentials, even for an instance that uses Jira", async () => {
  const ctx = await setup({ env: {} });
  const run = await runMsf(["trabalho", "pause"], ctx.deps);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal((await queued(ctx.stateDir(".msf", "trabalho"))).length, 1);
});

test("starting a Jira instance without the variables says the instance, the Jira projects and the three variables", async () => {
  const ctx = await setup({ env: {} });
  const run = await runMsf(["trabalho", "run", "--check"], ctx.deps);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /trabalho/);
  assert.match(run.stderr, /monolith \(VAN\)/);
  for (const name of ["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"]) assert.match(run.stderr, new RegExp(name));
  assert.match(run.stderr, /exporte/);
});

test("an instance without Jira is checked without the Jira variables", async () => {
  const ctx = await setup({ env: {} });
  const sandbox: SandboxBoundary = { preflight: async () => ({ token: "t" }), imageHas: async () => true, run: async () => { throw new Error("unused"); } };
  const github = { accountToken: async () => "t", api: async () => ({ status: 200, body: [] }) };
  const run = await runMsf(["pessoal", "run", "--check"], { ...ctx.deps, sandbox, github });
  // The checkouts are not real, so lines fail; what matters is that the check ran and never asked for Jira.
  assert.match(run.stdout, /tracker \(descoberta somente leitura\)/);
  assert.doesNotMatch(run.stderr + run.stdout, /JIRA/);
});

// ── status (issue #23) ─────────────────────────────────────────────────────────────────────────

const emptyTracker = (over: Partial<TrackerPort> = {}): TrackerPort => ({
  claimMarkOf: () => ({ labels: [], assignees: [] }),
  discoverCandidates: async () => [],
  readIssue: async () => { throw new Error("unused"); },
  claim: async () => { throw new Error("write"); },
  releaseClaim: async () => { throw new Error("write"); },
  updateLabels: async () => { throw new Error("write"); },
  readComments: async () => [],
  postComment: async () => { throw new Error("write"); },
  markDone: async () => { throw new Error("write"); },
  ...over,
}) as TrackerPort;
const githubEmpty = { accountToken: async () => "t", api: async () => ({ status: 200, body: [] }) };

test("status needs no --config, --state-dir or --fixture, and not even local.json", async () => {
  const ctx = await setup({ local: false, jobs: [["acme/app", "13"]] });
  const run = await runMsf(["pessoal", "status"], { ...ctx.deps, tracker: emptyTracker() });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /^Instância pessoal \(N=1, polling 300s, máx\. iterações 3\)\nVagas: 0\/1\n/);
  assert.match(run.stdout, /#13 interrompido — caiu/);
  assert.match(run.stdout, /\[acme\/app\] github acme\/app\n {2}elegíveis \(0\):/);
});

test("status --help shows the ./msf usage and takes no job", async () => {
  const ctx = await setup();
  const help = await runMsf(["pessoal", "status", "--help"], ctx.deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /uso: \.\/msf \[--home DIR\] <instância> status\n/);
  assert.doesNotMatch(help.stdout, /--fixture|--config|--state-dir/);
  const withJob = await runMsf(["pessoal", "status", "#13"], ctx.deps);
  assert.equal(withJob.exitCode, 2);
  assert.match(withJob.stderr, /status não recebe trabalho/);
  assert.equal((await runMsf(["pessoal", "status", "--fixture", "x.json"], ctx.deps)).exitCode, 2);
});

test("printed commands carry --home when the base is not the default", async () => {
  const ctx = await setup({ home: ".pilot" });
  const store = createFileJobStore(join(ctx.root, ".pilot", "state", "pessoal"));
  await store.save(transitionJob(jobOf("acme/app", "13"), "waiting-for-help", { message: "ajuda", question: "Qual?" }));
  const custom = await runMsf(["--home", ".pilot", "pessoal", "status"], { ...ctx.deps, tracker: emptyTracker() });
  assert.match(custom.stdout, new RegExp(`\\./msf --home \\S*\\.pilot pessoal logs '#13'`));
  const plain = await setup({ jobs: [] });
  await createFileJobStore(plain.stateDir(".msf")).save(transitionJob(jobOf("acme/app", "13"), "waiting-for-help", { message: "ajuda", question: "Qual?" }));
  const standard = await runMsf(["pessoal", "status"], { ...plain.deps, tracker: emptyTracker() });
  assert.match(standard.stdout, /\.\/msf pessoal logs '#13'/);
  assert.doesNotMatch(standard.stdout, /--home/);
});

test("without the Jira variables the local state and the GitHub projects stay, the Jira project says tracker indisponível, and the exit is 1", async () => {
  const ctx = await setup({ env: {} });
  await createFileJobStore(ctx.stateDir(".msf", "misto")).save(jobOf("acme/mixed", "7", true));
  const run = await runMsf(["misto", "status"], { ...ctx.deps, github: githubEmpty });
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /#7 interrompido/);
  assert.match(run.stdout, /\[acme\/mixed\] github acme\/mixed\n {2}elegíveis \(0\):/);
  const message = /\[mixed-jira\] jira MIX \/ mix\n {2}tracker indisponível: (.*)\n/.exec(run.stdout)?.[1];
  assert.ok(message, run.stdout);
  for (const name of ["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"]) assert.match(message, new RegExp(name));
  // The same message the run gives in this situation.
  const check = await runMsf(["misto", "run", "--check"], { ...ctx.deps, github: githubEmpty });
  assert.ok(check.stderr.includes(message), check.stderr);
});

test("a GitHub failure in one project does not hide the others and does not write anything", async () => {
  const ctx = await setup({ env: {} });
  const tracker = emptyTracker({
    discoverCandidates: async (scope) => { if (scope.project === "acme/app") throw new Error("API 503"); return []; },
  });
  const run = await runMsf(["pessoal", "status"], { ...ctx.deps, tracker });
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /\[acme\/app\] github acme\/app\n {2}tracker indisponível: API 503/);
  assert.match(run.stdout, /\[acme\/other\] github acme\/other\n {2}elegíveis \(0\):/);
});
