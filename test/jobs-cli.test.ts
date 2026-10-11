import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Admission } from "../src/core/admission.js";
import { loadConfigFile } from "../src/config/load.js";
import { FakeRunner, finished } from "../src/runtime/fake-runner.js";
import type { RunnerContext, RunnerOutput } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import { runStatus } from "../src/cli/status.js";
import { runLogs } from "../src/cli/logs.js";

// One instance with three ready GitHub issues: one asks for help, one returns an invalid
// result, one never finishes its iterations. N=3 lets all of them run side by side.
const PROJECT = (repository: string) => ({
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

const CONFIG = {
  credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
  instances: [{
    name: "trabalho",
    maxConcurrent: 3,
    pollIntervalSeconds: 300,
    maxIterations: 3,
    modelAuth: "copilot",
    projects: [PROJECT("acme/help"), PROJECT("acme/invalid"), PROJECT("acme/limit")],
  }],
};

const issue = (repo: string, id: string, title: string) => ({
  project: repo, id, title, labels: ["ready-for-agent"], assignees: [], claimed: false,
  statusCategory: "to-do", priority: null, blockers: [],
});

const TRACKER = {
  issues: [
    issue("acme/help", "1", "Needs a seam"),
    issue("acme/invalid", "2", "Returns garbage"),
    issue("acme/limit", "3", "Never finishes"),
  ],
};

const script = (context: RunnerContext): RunnerOutput => {
  switch (context.ref.project) {
    case "acme/help":
      return finished({ status: "needs_help", question: "Qual o contrato da API?", context: "api v2" });
    case "acme/invalid":
      return finished({ status: "complete", summary: "all green" });
    default:
      return { kind: "continue" };
  }
};

interface Fixtures {
  dir: string;
  configPath: string;
  fixturePath: string;
  stateDir: string;
}

// Writes the config and tracker fixtures, then runs one poll (and settles) through the
// real admission, so the state directory is what the operator would see.
async function prepare(extraJobFile?: { name: string; content: string }): Promise<Fixtures> {
  const dir = await mkdtemp(join(tmpdir(), "msf-cli-"));
  const configPath = join(dir, "config.json");
  const fixturePath = join(dir, "tracker.json");
  const stateDir = join(dir, "state");
  await writeFile(configPath, JSON.stringify(CONFIG));
  await writeFile(fixturePath, JSON.stringify(TRACKER));
  const loaded = await loadConfigFile(configPath);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const tracker = loadMemoryTracker(TRACKER);
  const admission = await Admission.open({
    instance: loaded.config.instances[0]!,
    tracker,
    runner: new FakeRunner(script),
    store: createFileJobStore(stateDir),
    commands: createFileCommandQueue(stateDir),
    control: createFileInstanceControl(stateDir),
    prs: { readPr: async () => ({ status: "not-found" }) },
  });
  await admission.poll();
  assert.deepEqual(await admission.settle(), []);
  if (extraJobFile) await writeFile(join(stateDir, extraJobFile.name), extraJobFile.content);
  return { dir, configPath, fixturePath, stateDir };
}

const statusArgs = (f: Fixtures) => ["--config", f.configPath, "--instance", "trabalho", "--fixture", f.fixturePath, "--state-dir", f.stateDir];
const logsArgs = (f: Fixtures, job: string) => ["--config", f.configPath, "--instance", "trabalho", "--state-dir", f.stateDir, job];

test("status shows a job waiting for help with its question, without blocking the other jobs", async () => {
  const f = await prepare();
  const run = await runStatus(statusArgs(f));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /memory:acme\/help#1 aguardando ajuda — Qual o contrato da API\?/);
  assert.match(run.stdout, /memory:acme\/invalid#2 intervenção necessária — resultado inválido/);
  assert.match(run.stdout, /memory:acme\/limit#3 intervenção necessária — limite de iterações \(3\) atingido/);
});

test("status does not offer a job that is already tracked as a candidate", async () => {
  const f = await prepare();
  const run = await runStatus(statusArgs(f));
  assert.match(run.stdout, /candidatas \(0\):/);
  assert.match(run.stdout, /acme\/help#1 Needs a seam — já acompanhada pelo script/);
});

test("status reports an unreadable job file and still shows the other jobs", async () => {
  const f = await prepare({ name: "broken.json", content: "{" });
  const run = await runStatus(statusArgs(f));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Arquivos ilegíveis \(1\): broken\.json/);
  assert.match(run.stdout, /memory:acme\/help#1 aguardando ajuda/);
});

test("status without --state-dir behaves as before and shows no jobs", async () => {
  const f = await prepare();
  const run = await runStatus(["--config", f.configPath, "--instance", "trabalho", "--fixture", f.fixturePath]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Trabalhos/);
});

test("logs shows the help question with the job's log lines", async () => {
  const f = await prepare();
  const run = await runLogs(logsArgs(f, "memory:acme/help#1"));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /trabalho memory:acme\/help#1/);
  assert.match(run.stdout, /estado: aguardando ajuda/);
  assert.match(run.stdout, /pergunta: Qual o contrato da API\?/);
  assert.match(run.stdout, /contexto: api v2/);
  assert.match(run.stdout, /pedido de ajuda: Qual o contrato da API\?/);
  assert.match(run.stdout, /início confirmado; runner disparado/);
});

test("logs shows the invalid-result reason of a job", async () => {
  const f = await prepare();
  const run = await runLogs(logsArgs(f, "memory:acme/invalid#2"));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /estado: intervenção necessária/);
  assert.match(run.stdout, /motivo: resultado inválido/);
});

test("logs shows the iteration limit reached by a job", async () => {
  const f = await prepare();
  const run = await runLogs(logsArgs(f, "memory:acme/limit#3"));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /motivo: limite de iterações \(3\) atingido sem resultado válido/);
  assert.match(run.stdout, /iteração 2\/3 \(new\) sem resultado final; nova iteração/);
});

test("logs of an unknown job is a visible error", async () => {
  const f = await prepare();
  const run = await runLogs(logsArgs(f, "memory:acme/none#9"));
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /trabalho memory:acme\/none#9 não encontrado/);
});

test("logs without a job reference prints the usage", async () => {
  const f = await prepare();
  const run = await runLogs(["--config", f.configPath, "--instance", "trabalho", "--state-dir", f.stateDir]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /uso: npm run logs/);
});
