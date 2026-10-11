import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CredentialRef, InstanceConfig, ProjectConfig } from "../config/types.js";
import { createDockerRunner } from "../runtime/docker-runner.js";
import { git, jobLayout } from "../runtime/docker-area.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import type { RunnerContext, RunnerOutput } from "../runtime/runner.js";
import { assertNoSecret } from "./secret-scan.js";

// Fixture demonstration of the Docker runner (ticket #6, R06/R07/R08, CA08/CA09/CA18).
// Recorded evidence run, not part of `npm test`. It calls the model: one new invocation that
// must stop at a help request, then one continuation on the same Pi session and area.
// The only model is github-copilot/gpt-6-luna, for every role. There is no override.

const execFileAsync = promisify(execFile);
const MODEL = "github-copilot/gpt-6-luna";
const ACCOUNT = "Sanmoo";
const IMAGE = process.env.MSF_RUNNER_IMAGE ?? "msf-docker-runner:local";
const repoRoot = process.cwd();
const root = resolve(repoRoot, ".smoke", "docker-runner", randomUUID());
const source = join(root, "source");
const stateDir = join(root, "state");
const piAgentDir = join(homedir(), ".pi", "agent");
const ref = { tracker: "github" as const, project: "fixture/docker-runner", id: "1" };
const key = "github:fixture/docker-runner#1";

const models = { implementer: MODEL, "reviewer-standards": MODEL, "reviewer-spec": MODEL, default: MODEL };
const project: ProjectConfig = {
  name: "fixture", enabled: true, adapter: "github", repository: "fixture/docker-runner",
  targetBranch: "main", prIntegration: "github.com", runtimeProfile: "demo-profile", githubAccount: ACCOUNT,
  labels: { ready: "ready-for-agent", claimed: "agent-claimed" }, models,
};
const instance: InstanceConfig = {
  name: "demo", maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 5,
  modelAuth: "DEMO_MODEL_AUTH", projects: [project],
};
const credentials: Record<string, CredentialRef> = { DEMO_MODEL_AUTH: { kind: "pi-auth", ref: "DEMO_PI_AUTH" } };
const profiles = { DEMO_PI_AUTH: piAgentDir, "demo-profile": piAgentDir };

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8" });
  return stdout;
}

async function fixtureRepo(): Promise<void> {
  await mkdir(join(source, "docs"), { recursive: true });
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "docker-runner-fixture", private: true, type: "module",
    scripts: { test: "node --test test/slugify.test.ts" },
  }, null, 2) + "\n");
  await writeFile(join(source, "src", "slugify.ts"),
    'export function slugify(text: string): string { throw new Error("Not implemented"); }\n');
  await writeFile(join(source, "docs", "spec.md"), `# Disposable fixture task
Implement the exported slugify(text: string): string for ASCII input.
Lowercase letters, replace each run of non-alphanumeric ASCII characters with one hyphen,
and remove leading and trailing hyphens. Examples: " Hello, WORLD!! " -> "hello-world";
"" -> ""; "TypeScript & Pi" -> "typescript-pi".
Test seams have NOT been approved by the human yet. Propose the exported function as the
seam and ask for approval before writing tests or implementation, as the installed TDD
skill requires. Stop with needs_help.
This fixture has no tracker, no push and no pull request. When the work is verified and
committed locally, stop with interrupted and the reason "fixture local: sem PR".
`);
  await writeFile(join(source, "CODING_STANDARDS.md"),
    "Use TypeScript strict mode. Test public behavior, without mocks or private seams.\n");
  await git(source, "init", "-q", "-b", "main");
  await git(source, "config", "user.name", "Docker runner fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "add", ".");
  await git(source, "commit", "-q", "-m", "Initialize Docker runner fixture");
}

function runnerFor(boundary = sandcastleBoundary(), image = IMAGE) {
  return createDockerRunner({
    instance, credentials, profiles, stateDir, image,
    repositorySource: () => source, boundary,
  });
}

const context = (over: Partial<RunnerContext>): RunnerContext =>
  ({ jobId: key, ref, repository: project.repository, kind: "new", iteration: 1, maxIterations: instance.maxIterations, ...over });

async function sandcastleContainers(): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", "name=^sandcastle-", "--format", "{{.Names}}"]);
  return stdout.split("\n").filter(Boolean);
}

async function scanForToken(token: string): Promise<void> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(json|jsonl|log|md)$/.test(entry.name)) files.push(path);
    }
  };
  await walk(stateDir);
  for (const file of files) assertNoSecret(await readFile(file, "utf8"), token, file);
}

process.stdout.write(`Area: ${root}\n`);
await fixtureRepo();
const accountBefore = await gh("auth", "status");
const token = (await gh("auth", "token", "--user", ACCOUNT)).trim();

// 1. Negative: a missing image is refused before any area or agent exists.
const negative = await runnerFor(sandcastleBoundary(), "msf-docker-runner:does-not-exist")
  .run(context({ jobId: "github:fixture/docker-runner#negative", ref: { ...ref, id: "negative" } }));
const negativeReason = (negative as { results: Array<{ reason: string }> }).results[0]?.reason ?? "";
assert.match(negativeReason, /missing|not found|Build it/i, "missing image must be a visible interruption");
assert.ok(!existsSync(jobLayout(stateDir, "github:fixture/docker-runner#negative").areaDir), "no area for a refused job");
process.stdout.write(`Negative (missing image): ${negativeReason.split("\n")[0]}\n`);

// 2. New invocation: must stop at a help request within the effective limit.
const first: RunnerOutput = await runnerFor().run(context({}));
process.stdout.write(`New invocation output: ${JSON.stringify(first)}\n`);
assert.equal(first.kind, "finished");
assert.equal((first.results[0] as { status?: string }).status, "needs_help");
const layout = jobLayout(stateDir, key);
const recordAfterFirst = JSON.parse(await readFile(layout.recordPath, "utf8")) as { sessionId?: string; baseSha: string };
assert.ok(recordAfterFirst.sessionId, "Pi session recorded outside the container");

// 3. Continuation: same session, one iteration, same area; the operator approves the seam.
const note = "Approved seam: export function slugify(text: string): string in src/slugify.ts. "
  + "Proceed with TDD through the export (red then green), run npm test, make one local commit.";
const firstSession = recordAfterFirst.sessionId;
assert.ok(firstSession, "continuation needs the session recorded by the first invocation");
const second: RunnerOutput = await runnerFor().run(context({
  kind: "resume",
  continuation: { workspace: { session: firstSession, area: layout.repoDir }, replies: [note] },
}));
process.stdout.write(`Continuation output: ${JSON.stringify(second)}\n`);
assert.equal(second.kind, "finished");

// 4. Evidence: git area, audit, containers, host test, secrets, active gh account.
const recordAfterSecond = JSON.parse(await readFile(layout.recordPath, "utf8")) as { sessionId?: string };
const sameSession = recordAfterSecond.sessionId === recordAfterFirst.sessionId;
assert.ok(sameSession, "the continuation must use the same Pi session");
// Each Sandcastle iteration of the new invocation is a fresh Pi session file; the continuation
// must append to the one the runner recorded (the last iteration of the new invocation).
const sessionFiles = (await execFileAsync("find", [layout.sessionsDir, "-name", "*.jsonl"])).stdout
  .split("\n").filter(Boolean);
const continuationFile = sessionFiles.find((path) => path.endsWith(`_${firstSession}.jsonl`));
assert.ok(continuationFile, "the recorded session file exists");
assert.match(await readFile(continuationFile, "utf8"), /Continue the resume of work item/, "continuation appended to the recorded session");
const commits = Number((await git(layout.repoDir, "rev-list", "--count", `${recordAfterFirst.baseSha}..HEAD`)).trim());
const status = (await git(layout.repoDir, "status", "--porcelain")).trim();
const { stdout: hostTest } = await execFileAsync("node", ["--test", "test/slugify.test.ts"], { cwd: layout.repoDir }).catch(
  (error: { stdout?: string; stderr?: string }) => ({ stdout: `FAILED: ${error.stderr ?? ""}` }),
);
const report = {
  model: MODEL,
  image: IMAGE,
  effectiveLimit: { new: instance.maxIterations, continuation: 1 },
  negative: negativeReason.split("\n")[0],
  first,
  second,
  sameSession,
  sessionFiles: sessionFiles.length,
  fixtureCommitsSinceBase: commits,
  areaClean: status === "",
  hostTestOutput: hostTest.split("\n").filter((line) => /^# (pass|fail)/.test(line)),
  sandcastleContainersLeft: (await sandcastleContainers()).length,
  activeGhUnchanged: (await gh("auth", "status")) === accountBefore,
  audit: (await readFile(layout.auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line).line),
};
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
await scanForToken(token);
assert.equal(report.sandcastleContainersLeft, 0, "containers removed after each invocation");
assert.ok(report.activeGhUnchanged, "the active gh account is unchanged");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
