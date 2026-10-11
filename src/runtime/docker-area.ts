import { execFile } from "node:child_process";
import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DIFF_ARGS, sha256 } from "./review-material.js";

const run = promisify(execFile);

// Git area of one job (R06, CA08): a clone of the target branch on the host, outside the
// container, on its own job branch. Recreating the container never touches it.
export interface JobLayout {
  areaDir: string;
  repoDir: string;
  sessionsDir: string;
  recordPath: string;
  auditPath: string;
}

export function jobLayout(stateDir: string, key: string): JobLayout {
  const name = encodeURIComponent(key);
  const areaDir = join(stateDir, "areas", name);
  return {
    areaDir,
    repoDir: join(areaDir, "repo"),
    sessionsDir: join(stateDir, "sessions", name),
    recordPath: join(stateDir, "runs", `${name}.json`),
    auditPath: join(stateDir, "runs", `${name}.audit.jsonl`),
  };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.pager=cat", ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const exists = (path: string) => access(path).then(() => true, () => false);

// Clones the target branch into the job's own repository and checks out the job branch.
// Returns the base commit the review will be measured from. An existing area is never reused
// silently: a new invocation must not overwrite the work of an earlier one.
export async function createJobRepo(input: {
  source: string;
  repoDir: string;
  targetBranch: string;
  branch: string;
}): Promise<string> {
  if (await exists(input.repoDir)) {
    throw new Error(`área do trabalho já existe: ${input.repoDir}; não sobrescrita`);
  }
  await run("git", ["clone", "--no-hardlinks", "--branch", input.targetBranch, input.source, input.repoDir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  await git(input.repoDir, "checkout", "-b", input.branch);
  await git(input.repoDir, "config", "user.name", "MSF job");
  await git(input.repoDir, "config", "user.email", "msf-job@invalid");
  // Runner state that lives beside the repository must not show up as work.
  await appendFile(join(input.repoDir, ".git", "info", "exclude"), "/.sandcastle/\n/.pi/subagents/\n");
  return headOf(input.repoDir);
}

export async function headOf(repoDir: string): Promise<string> {
  return (await git(repoDir, "rev-parse", "HEAD")).trim();
}

// The exact diff text reviewers receive (see DIFF_ARGS) and its digest.
export async function diffTextOf(repoDir: string, base: string, head: string): Promise<string> {
  return git(repoDir, ...DIFF_ARGS(base, head));
}

export async function diffSha256Of(repoDir: string, base: string, head: string): Promise<string> {
  return sha256(await diffTextOf(repoDir, base, head));
}

// Digest of a file as it is in a given commit, so the spec and standards reviewed are the base's.
export async function fileSha256At(repoDir: string, rev: string, path: string): Promise<string> {
  return sha256(await git(repoDir, "show", `${rev}:${path}`));
}
