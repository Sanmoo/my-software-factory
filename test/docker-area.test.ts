import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  createJobRepo,
  git,
  headOf,
  jobLayout,
} from "../src/runtime/docker-area.js";
import { jobBranch } from "../src/core/job.js";

// A source repository with a target branch, as the operator's checkout would have.
async function sourceRepo(): Promise<{ source: string; base: string }> {
  const source = await mkdtemp(join(tmpdir(), "msf-source-"));
  await git(source, "init", "-q", "-b", "main");
  await git(source, "config", "user.name", "Operator");
  await git(source, "config", "user.email", "operator@invalid");
  await writeFile(join(source, "spec.md"), "Implement slugify.\n");
  await git(source, "add", ".");
  await git(source, "commit", "-q", "-m", "spec");
  return { source, base: (await git(source, "rev-parse", "HEAD")).trim() };
}

test("a job area is a clone of the target branch at base, on its own job branch, with a clean tree", async () => {
  const { source, base } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  const returned = await createJobRepo({ source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1" });
  assert.equal(returned, base);
  assert.equal(await headOf(repoDir), base);
  assert.equal((await git(repoDir, "branch", "--show-current")).trim(), "msf/github/acme/app/1");
  assert.equal((await git(repoDir, "status", "--porcelain")).trim(), "");
});

test("an existing job area is never overwritten by a new invocation", async () => {
  const { source } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  await createJobRepo({ source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1" });
  await assert.rejects(
    () => createJobRepo({ source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1" }),
    /já existe.*não sobrescrita/,
  );
});

test("runner state beside the repository is excluded from the job's work", async () => {
  const { source } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  await createJobRepo({ source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1" });
  await mkdir(join(repoDir, ".sandcastle", "logs"), { recursive: true });
  await writeFile(join(repoDir, ".sandcastle", "logs", "run.log"), "x");
  await mkdir(join(repoDir, ".pi", "subagents"), { recursive: true });
  await writeFile(join(repoDir, ".pi", "subagents", "run.json"), "x");
  assert.equal((await git(repoDir, "status", "--porcelain")).trim(), "");
});

test("the job layout keeps every job's area, sessions and record separate and outside any container", () => {
  const layout = jobLayout("/state", "github:acme/app#6");
  assert.equal(layout.repoDir, "/state/areas/github%3Aacme%2Fapp%236/repo");
  assert.equal(layout.sessionsDir, "/state/sessions/github%3Aacme%2Fapp%236");
  assert.notEqual(jobLayout("/state", "github:acme/app#7").repoDir, layout.repoDir);
});

test("the area is created on the canonical job branch of the job identity", async () => {
  const { source, base } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  const ref = { tracker: "github" as const, project: "acme/app", id: "6" };
  await createJobRepo({ source, repoDir, targetBranch: "main", branch: jobBranch(ref) });
  assert.equal((await git(repoDir, "branch", "--show-current")).trim(), "msf/github/acme/app/6");
  assert.equal(await headOf(repoDir), base);
});

// Runs `git credential fill` in the area, the way git asks for the credentials of a push.
async function credentialFor(repoDir: string, token: string): Promise<string> {
  const child = promisify(execFile)("git", ["credential", "fill"], {
    cwd: repoDir,
    env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  child.child.stdin?.end("protocol=https\nhost=github.com\n\n");
  return (await child).stdout;
}

test("with a remote URL the area pushes to github.com with the GH_TOKEN of the container, never a stored secret", async () => {
  const { source } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  await createJobRepo({
    source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1",
    remoteUrl: "https://github.com/acme/app.git",
  });
  assert.equal((await git(repoDir, "remote", "get-url", "origin")).trim(), "https://github.com/acme/app.git");
  assert.match(await credentialFor(repoDir, "tok-123"), /password=tok-123/);
  assert.doesNotMatch(await git(repoDir, "config", "--local", "--list"), /tok-123/);
});

test("without a remote URL the origin stays the source checkout", async () => {
  const { source } = await sourceRepo();
  const repoDir = join(await mkdtemp(join(tmpdir(), "msf-area-")), "repo");
  await createJobRepo({ source, repoDir, targetBranch: "main", branch: "msf/github/acme/app/1" });
  assert.equal((await git(repoDir, "remote", "get-url", "origin")).trim(), source);
});
