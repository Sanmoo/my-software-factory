import { execFile } from "node:child_process";
import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Git area of one job (R06, CA08): a clone of the target branch on the host, outside the
// container, on its own job branch. Recreating the container never touches it.
export interface JobLayout {
  areaDir: string;
  repoDir: string;
  // The runtime profile snapshot of the job's invocations: next to the repository, never inside it.
  snapshotDir: string;
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
    snapshotDir: join(areaDir, "profile"),
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

const GH_TOKEN_HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';

// Clones the target branch into the job's own repository and checks out the job branch.
// Returns the base commit the review will be measured from. An existing area is never reused
// silently: a new invocation must not overwrite the work of an earlier one.
export async function createJobRepo(input: {
  source: string;
  repoDir: string;
  targetBranch: string;
  branch: string;
  // Where the area pushes to. The clone comes from the operator's checkout, but the work must
  // reach github.com for the PR; the container's GH_TOKEN is the credential (R06, R07).
  remoteUrl?: string;
}): Promise<string> {
  if (await exists(input.repoDir)) {
    throw new Error(`área do trabalho já existe: ${input.repoDir}; não sobrescrita`);
  }
  await run("git", ["clone", "--no-hardlinks", "--branch", input.targetBranch, input.source, input.repoDir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (input.remoteUrl !== undefined) {
    await git(input.repoDir, "remote", "set-url", "origin", input.remoteUrl);
    // The helper reads GH_TOKEN when git asks; the token itself is never written to the config.
    await git(input.repoDir, "config", "credential.https://github.com.helper", GH_TOKEN_HELPER);
  }
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
