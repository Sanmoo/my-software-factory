import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { IssueRef } from "../tracker/port.js";
import { repoCloneDir, workBranchName, type GitWork, type PreparedWork } from "./port.js";

const execFile = promisify(execFileCallback);

/**
 * The git host side over the real git CLI, exercised with local bare
 * fixtures in tests — no GitHub, no network (ticket 15). The single clone
 * of a target repo lives at `<reposDir>/<owner>#<name>` and is created on
 * the first work of that repo; every launch is a delta `git fetch`, never a
 * re-clone. The default branch is revealed by the clone itself
 * (`origin/HEAD`), no API call. The credential helper of the `gh` keyring
 * for real remotes is a wiring concern of the GitHub adapter (ticket 16).
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export interface LocalGitWorkOptions {
  /** <workspace>/repos — where the single clone per target repo lives. */
  reposDir: string;
  /** The clone URL of a repo; defaults to the GitHub https URL. */
  remoteUrl?: (repo: string) => string;
}

const defaultRemoteUrl = (repo: string): string => `https://github.com/${repo}.git`;

/** A GitWork backed by the git CLI on the local disk. */
export function localGitWork(options: LocalGitWorkOptions): GitWork {
  const remoteUrl = options.remoteUrl ?? defaultRemoteUrl;

  async function git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFile("git", args, { cwd });
      return stdout;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n").slice(1).join(" ") : error;
      throw new GitError(`git ${args.join(" ")} failed in ${cwd}: ${reason}`);
    }
  }

  /** Exit 1 means "missing"; any other failure is a real error. */
  async function localBranchExists(repoDir: string, branch: string): Promise<boolean> {
    try {
      await execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoDir });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  /** The default branch, revealed by the clone itself — never an API call. */
  async function detectDefaultBranch(repoDir: string): Promise<string> {
    try {
      const out = await git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      return out.trim().replace(/^origin\//, "");
    } catch {
      // Fallback: ask the remote directly (still git, still no API).
      const out = await git(repoDir, ["ls-remote", "--symref", "origin", "HEAD"]);
      const match = /^ref:\s+refs\/heads\/(\S+)/m.exec(out);
      if (match?.[1]) return match[1];
      throw new GitError(`cannot reveal the default branch of origin in ${repoDir}`);
    }
  }

  return {
    async prepareWork(ref: IssueRef): Promise<PreparedWork> {
      const repoDir = repoCloneDir(options.reposDir, ref.repo);

      // One clone per target repo: created on the first work, never re-cloned.
      if (existsSync(join(repoDir, ".git"))) {
        await git(repoDir, ["fetch", "origin"]); // delta fetch — every launch, cheap
      } else {
        await git(options.reposDir, ["clone", remoteUrl(ref.repo), repoDir]);
      }

      // The default branch, revealed by the clone itself — no API call.
      const baseBranch = await detectDefaultBranch(repoDir);

      const branch = workBranchName(ref.number);
      let branchCreated = false;
      if (!(await localBranchExists(repoDir, branch))) {
        // Born from the default; relaunches reuse it untouched.
        await git(repoDir, ["branch", branch, `refs/remotes/origin/${baseBranch}`]);
        branchCreated = true;
      }

      return { repoDir, branch, baseBranch, branchCreated };
    },

    async cleanupDoneWork(ref: IssueRef): Promise<void> {
      const repoDir = repoCloneDir(options.reposDir, ref.repo);

      // No clone ever created: there is nothing to clean.
      if (!existsSync(join(repoDir, ".git"))) return;

      const branch = workBranchName(ref.number);

      // Remote branch — the human's merge may have auto-deleted it already.
      const remoteHeads = await git(repoDir, ["ls-remote", "origin", `refs/heads/${branch}`]);
      if (remoteHeads.trim()) {
        await git(repoDir, ["push", "origin", "--delete", branch]);
      }

      // Local branch.
      if (await localBranchExists(repoDir, branch)) {
        await git(repoDir, ["branch", "-D", branch]);
      }

      // Prune: stale worktree registrations and remote-tracking refs.
      await git(repoDir, ["worktree", "prune"]);
      await git(repoDir, ["remote", "prune", "origin"]);
    },
  };
}
