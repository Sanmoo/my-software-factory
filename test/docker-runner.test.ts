import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialRef, InstanceConfig, ProjectConfig } from "../src/config/types.js";
import { RunnerConfigError } from "../src/runtime/docker-config.js";
import { createDockerRunner, type SandboxBoundary, type SandboxOutcome, type SandboxRun } from "../src/runtime/docker-runner.js";
import { git, headOf, jobLayout } from "../src/runtime/docker-area.js";
import { jobBranch } from "../src/core/job.js";
import type { PiEvent } from "../src/runtime/pi-events.js";
import type { RunnerContext } from "../src/runtime/runner.js";

const GPT = "github-copilot/gpt-6-luna";
const TOKEN = "ghp_fixture_token_value_0123";
const models = { implementer: GPT, "reviewer-standards": GPT, "reviewer-spec": GPT, default: GPT };

const project = (overrides: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
  prIntegration: "github.com", runtimeProfile: "personal", githubAccount: "acme-bot",
  labels: { ready: "ready-for-agent", claimed: "agent-claimed" }, models: { ...models },
  ...overrides,
} as ProjectConfig);

const instance = (projects: ProjectConfig[] = [project()]): InstanceConfig => ({
  name: "personal", maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 5,
  modelAuth: "MODEL_AUTH", projects,
});
const credentials: Record<string, CredentialRef> = { MODEL_AUTH: { kind: "pi-auth", ref: "PI_AUTH" } };
const ref = { tracker: "github" as const, project: "acme/app", id: "6" };
const key = "github:acme/app#6";

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "msf-src-"));
  await git(source, "init", "-q", "-b", "main");
  await git(source, "config", "user.name", "Operator");
  await git(source, "config", "user.email", "operator@invalid");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs", "spec.md"), "Implement slugify.\n");
  await writeFile(join(source, "CODING_STANDARDS.md"), "Strict TypeScript.\n");
  await git(source, "add", ".");
  await git(source, "commit", "-q", "-m", "fixture");
  const stateDir = await mkdtemp(join(tmpdir(), "msf-state-"));
  const agentDir = await mkdtemp(join(tmpdir(), "msf-agent-"));
  return { source, stateDir, agentDir };
}

const reply = (json: unknown): PiEvent[] => [
  { type: "message_end", message: { role: "assistant", content: [{ type: "text",
    text: `<msf-result>${JSON.stringify(json)}</msf-result>\n<promise>MSF-RESULT</promise>` }] } },
  { type: "agent_settled", aborted: false },
];

// The boundary stands for Docker and Sandcastle: it records what the runner asked for and
// may act in the work area the way the agent would (the area is a bind mount).
function fakeBoundary(script: (run: SandboxRun, call: number) => Promise<Omit<SandboxOutcome, "iterations">>, preflightError?: string) {
  const runs: SandboxRun[] = [];
  const boundary: SandboxBoundary = {
    async preflight() {
      if (preflightError) throw new Error(preflightError);
      return { token: TOKEN };
    },
    async run(input) {
      runs.push(input);
      return { iterations: 1, ...(await script(input, runs.length)) };
    },
  };
  return { boundary, runs };
}

const newContext = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ({ jobId: key, ref, repository: "acme/app", kind: "new", iteration: 1, maxIterations: 5, ...over });

function runnerFor(f: { source: string; stateDir: string; agentDir: string }, boundary: SandboxBoundary, projects?: ProjectConfig[]) {
  return createDockerRunner({
    instance: instance(projects),
    credentials,
    profiles: { PI_AUTH: f.agentDir, personal: f.agentDir },
    stateDir: f.stateDir,
    image: "msf-docker-runner:test",
    repositorySource: () => f.source,
    boundary,
  });
}

const interruptedReason = (output: { kind: string; results?: unknown[] }) => {
  const first = (output.results?.[0] ?? {}) as { status?: string; reason?: string };
  return first.status === "interrupted" ? first.reason : undefined;
};

test("the runner refuses to be built when a role model or the model auth is not configured", async () => {
  const f = await fixture();
  const { boundary } = fakeBoundary(async () => ({ completed: true, events: [] }));
  const { "reviewer-spec": _omitted, ...withoutSpec } = models;
  assert.throws(
    () => runnerFor(f, boundary, [project({ models: withoutSpec } as Partial<ProjectConfig>)]),
    (error: unknown) => error instanceof RunnerConfigError && /reviewer-spec/.test(error.message),
  );
  assert.throws(
    () => createDockerRunner({
      instance: instance(), credentials, profiles: {}, stateDir: f.stateDir, image: "x",
      repositorySource: () => f.source, boundary,
    }),
    /PI_AUTH.*sem fallback/,
  );
});

test("Docker unavailable is an interruption with its reason: the agent never runs and no host work starts", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({ completed: true, events: [] }),
    "Docker is unavailable (docker info failed).");
  const output = await runnerFor(f, boundary).run(newContext());
  assert.match(interruptedReason(output) ?? "", /Docker is unavailable/);
  assert.equal(runs.length, 0, "no agent may run without the sandbox");
  await assert.rejects(() => access(jobLayout(f.stateDir, key).areaDir), "no host job area was created");
});

test("a missing model auth file is a visible interruption before any work starts", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({ completed: true, events: [] }),
    `Operator Pi profile is incomplete at ${f.agentDir}: auth.json missing.`);
  const output = await runnerFor(f, boundary).run(newContext());
  assert.match(interruptedReason(output) ?? "", /auth\.json missing/);
  assert.equal(runs.length, 0);
});

test("a new invocation runs in its own area at base, with the configured limit, the role models and no resumed session", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true,
    events: reply({ status: "needs_help", question: "Which seam?", context: "slugify" }),
  }));
  const output = await runnerFor(f, boundary).run(newContext());

  const layout = jobLayout(f.stateDir, key);
  assert.deepEqual(output, {
    kind: "finished",
    results: [{ status: "needs_help", question: "Which seam?", context: "slugify" }],
    workspace: { session: "session-1", area: layout.repoDir },
  });
  const [run] = runs;
  assert.ok(run, "the agent ran once");
  assert.equal(run.cwd, layout.repoDir);
  assert.equal(run.request.maxIterations, 5);
  assert.equal(run.request.resumeSession, undefined);
  assert.equal(run.model, GPT);
  assert.equal(run.sessionsDir, layout.sessionsDir);
  assert.match(run.request.prompt, /\/skill:implement/);
  assert.match(run.request.prompt, /Authorized repository: acme\/app\./);
  assert.ok(run.request.prompt.includes(await headOf(layout.repoDir)), "the prompt names the base");
});

test("the implementation prompt the sandbox receives carries the issue title and body", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true,
    events: reply({ status: "needs_help", question: "Which seam?", context: "slugify" }),
  }));
  await runnerFor(f, boundary).run(newContext({
    issue: { title: "Slugify", body: { known: true, value: "Implementar slugify.\nVer docs/spec.md" } },
  }));

  assert.match(runs[0]!.request.prompt, /Issue title: Slugify/);
  assert.ok(runs[0]!.request.prompt.includes("Implementar slugify.\nVer docs/spec.md"), "the body reaches the agent");
});

test("the job area is on the canonical job branch that the PR check expects, and the prompt names it", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true,
    events: reply({ status: "needs_help", question: "Which seam?", context: "slugify" }),
  }));
  await runnerFor(f, boundary).run(newContext());

  const layout = jobLayout(f.stateDir, key);
  const branch = jobBranch(ref);
  assert.equal((await git(layout.repoDir, "branch", "--show-current")).trim(), branch);
  assert.ok(runs[0]!.request.prompt.includes(branch), "the prompt names the branch");
});

test("the git area and the Pi session survive the container: a continuation resumes the same session on the same commits", async () => {
  const f = await fixture();
  const layout = jobLayout(f.stateDir, key);
  const { boundary, runs } = fakeBoundary(async (run, call) => {
    if (call === 1) {
      // The agent commits its work in the area, then its container goes away.
      await writeFile(join(run.cwd, "slugify.txt"), "hello\n");
      await git(run.cwd, "add", "slugify.txt");
      await git(run.cwd, "commit", "-q", "-m", "partial work");
      return { sessionId: "session-1", completed: false, events: reply({ status: "needs_help", question: "q" }) };
    }
    return { sessionId: "session-1", completed: true, events: reply({ status: "interrupted", reason: "done locally" }) };
  });
  const runner = runnerFor(f, boundary);
  await runner.run(newContext());
  const partial = await headOf(layout.repoDir);

  const output = await runner.run(newContext({
    kind: "resume", maxIterations: 5,
    continuation: { workspace: { session: "session-1", area: layout.repoDir }, replies: ["Approved."] },
  }));

  assert.deepEqual(output, {
    kind: "finished",
    results: [{ status: "interrupted", reason: "done locally" }],
    workspace: { session: "session-1", area: layout.repoDir },
  });
  const second = runs[1]!;
  assert.equal(second.request.resumeSession, "session-1", "same Pi session");
  assert.equal(second.request.maxIterations, 1, "continuations are one iteration");
  assert.equal(second.cwd, layout.repoDir, "same area");
  assert.match(second.request.prompt, /Operator input: Approved\./);
  assert.equal(await git(layout.repoDir, "rev-parse", "HEAD").then((s) => s.trim()), partial, "partial commit kept");
});

test("a continuation naming another session or area than the runner's record is refused", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true, events: reply({ status: "needs_help", question: "q" }),
  }));
  const runner = runnerFor(f, boundary);
  await runner.run(newContext());
  const layout = jobLayout(f.stateDir, key);
  const otherSession = await runner.run(newContext({
    kind: "resume", continuation: { workspace: { session: "session-9", area: layout.repoDir }, replies: [] },
  }));
  assert.match(interruptedReason(otherSession) ?? "", /sessão registrada no trabalho difere/);
  const otherArea = await runner.run(newContext({
    kind: "resume", continuation: { workspace: { session: "session-1", area: "/elsewhere" }, replies: [] },
  }));
  assert.match(interruptedReason(otherArea) ?? "", /área registrada no trabalho/);
  assert.equal(runs.length, 1, "neither mismatch reached the agent");
});

test("a continuation without a recorded session is an interruption, never a new conversation", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({ completed: true, events: [] }));
  const runner = runnerFor(f, boundary);
  const noRecord = await runner.run(newContext({ kind: "resume" }));
  assert.match(interruptedReason(noRecord) ?? "", /sem registro/);
  assert.equal(runs.length, 0);
});

test("a continuation whose area was removed is an interruption that names the missing area", async () => {
  const f = await fixture();
  const { boundary, runs } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true, events: reply({ status: "needs_help", question: "q" }),
  }));
  const runner = runnerFor(f, boundary);
  await runner.run(newContext());
  await rm(jobLayout(f.stateDir, key).areaDir, { recursive: true, force: true });
  const output = await runner.run(newContext({ kind: "resume" }));
  assert.match(interruptedReason(output) ?? "", /área do trabalho ausente/);
  assert.equal(runs.length, 1, "the continuation did not reach the agent");
});

test("an error from the sandbox is an interruption with the reason, and the token never appears in it", async () => {
  const f = await fixture();
  const { boundary } = fakeBoundary(async () => {
    throw new Error(`container failed while using ${TOKEN}`);
  });
  const output = await runnerFor(f, boundary).run(newContext());
  const reason = interruptedReason(output) ?? "";
  assert.match(reason, /container failed/);
  assert.ok(!reason.includes(TOKEN), "token must not be persisted or shown");
});

test("the effective limit and every use of the default model are written to the run's audit log, with no secret", async () => {
  const f = await fixture();
  const { boundary } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true,
    events: [
      { type: "tool_execution_start", toolName: "subagent", toolCallId: "c1",
        args: { agent: "researcher", async: false, model: GPT } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "subagent" },
      ...reply({ status: "needs_help", question: "q" }),
    ],
  }));
  await runnerFor(f, boundary).run(newContext());
  const audit = await readFile(jobLayout(f.stateDir, key).auditPath, "utf8");
  assert.match(audit, /limite efetivo=5/);
  assert.match(audit, /default usado por researcher/);
  assert.match(audit, /iterações do Sandcastle=1 de 5/);
  assert.ok(!audit.includes(TOKEN));
  const record = await readFile(jobLayout(f.stateDir, key).recordPath, "utf8");
  assert.ok(!record.includes(TOKEN), "run record holds no secret");
});

test("a pr_ready result without approved reviews on both axes never reaches the admission as success", async () => {
  const f = await fixture();
  const { boundary } = fakeBoundary(async () => ({
    sessionId: "session-1", completed: true,
    events: reply({ status: "pr_ready", pr: { repository: "acme/app", number: 7 }, reviews: [] }),
  }));
  const output = await runnerFor(f, boundary).run(newContext());
  assert.match(interruptedReason(output) ?? "", /sem revisão aprovada/);
});
