import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { IssueRef } from "../tracker/port.js";
import { workOfIssueRef, type WorkIdentity } from "../tracker/identity.js";
import {
  branchOfWork,
  repoCloneDir,
  workerWorktreePath,
  type ExpandedGitWork,
  type LocalWorkFacts,
  type PreparedWork,
  type WorkOperation,
} from "./port.js";

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

/** The expanded git host side over the real git CLI on the local disk. */
export function localGitWork(options: LocalGitWorkOptions): ExpandedGitWork {
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

  /** The paths of every worktree that currently holds `branch` checked out,
   *  read from `git worktree list --porcelain` (the main clone never counts:
   *  the work branch is only ever born, never checked out, there). */
  async function worktreesHolding(repoDir: string, branch: string): Promise<string[]> {
    const out = await git(repoDir, ["worktree", "list", "--porcelain"]);
    const holding: string[] = [];
    let path: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}` && path) {
        holding.push(path);
      } else if (line === "") path = null;
    }
    return holding;
  }

  /** The worktree Sandcastle runs the worker in for `branch`: the managed
   *  path it derives, else whichever worktree holds the branch. */
  async function workerWorktreeOf(repoDir: string, branch: string): Promise<string | undefined> {
    const managed = workerWorktreePath(repoDir, branch);
    if (existsSync(managed)) return managed;
    const [holding] = await worktreesHolding(repoDir, branch);
    return holding;
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

  async function prepareWorkFor(work: WorkIdentity): Promise<PreparedWork> {
    const repoDir = repoCloneDir(options.reposDir, work.destination.repo);

    // One clone per target repo: created on the first work, never re-cloned.
    if (existsSync(join(repoDir, ".git"))) {
      await git(repoDir, ["fetch", "origin"]); // delta fetch — every launch, cheap
    } else {
      await git(options.reposDir, ["clone", remoteUrl(work.destination.repo), repoDir]);
    }

    // The default branch, revealed by the clone itself — no API call.
    const baseBranch = await detectDefaultBranch(repoDir);

    const branch = branchOfWork(work);
    let branchCreated = false;
    if (!(await localBranchExists(repoDir, branch))) {
      // Born from the default; relaunches reuse it untouched.
      await git(repoDir, ["branch", branch, `refs/remotes/origin/${baseBranch}`]);
      branchCreated = true;
    }

    // Asked of the remote, never of the local remote-tracking ref: a branch
    // deleted on the remote (the human's merge, a hand cleanup) must read as
    // absent, and only the remote knows it (issue 96).
    const remoteHead = await git(repoDir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);

    return { repoDir, branch, baseBranch, branchCreated, branchOnOrigin: remoteHead.trim() !== "" };
  }

  async function cleanupDoneWorkFor(work: WorkIdentity): Promise<void> {
    const repoDir = repoCloneDir(options.reposDir, work.destination.repo);

    // No clone ever created: there is nothing to clean.
    if (!existsSync(join(repoDir, ".git"))) return;

    const branch = branchOfWork(work);

    // Remote branch — the human's merge may have auto-deleted it already.
    const remoteHeads = await git(repoDir, ["ls-remote", "origin", `refs/heads/${branch}`]);
    if (remoteHeads.trim()) {
      await git(repoDir, ["push", "origin", "--delete", branch]);
    }

    // Local branch. The worker ran in Sandcastle's own worktree on this
    // branch (.sandcastle/worktrees/<branch>); a dirty round makes
    // Sandcastle PRESERVE it, so the branch is still checked out here and
    // a plain `git branch -D` refuses. The worktree goes first — the done
    // duty already archived its artifacts, and `remove --force` also
    // clears a registration whose directory a hand deleted.
    if (await localBranchExists(repoDir, branch)) {
      for (const worktreePath of await worktreesHolding(repoDir, branch)) {
        await git(repoDir, ["worktree", "remove", "--force", worktreePath]);
      }
      await git(repoDir, ["branch", "-D", branch]);
    }

    // Prune: stale worktree registrations and remote-tracking refs.
    await git(repoDir, ["worktree", "prune"]);
    await git(repoDir, ["remote", "prune", "origin"]);
  }

  async function diffWorkFor(work: WorkIdentity): Promise<string> {
    const repoDir = repoCloneDir(options.reposDir, work.destination.repo);
    const branch = branchOfWork(work);
    const baseBranch = await detectDefaultBranch(repoDir);
    // Three-dot: from the merge-base — only the work's own changes, never
    // the base's later advances.
    return git(repoDir, ["diff", `refs/remotes/origin/${baseBranch}...${branch}`]);
  }

  async function observeRemoteHeadFor(work: WorkIdentity): Promise<string | null> {
    const repoDir = repoCloneDir(options.reposDir, work.destination.repo);
    if (!existsSync(join(repoDir, ".git"))) return null;
    const branch = branchOfWork(work);
    // Asked of the remote, never of a stale remote-tracking ref (issue 96).
    const out = await git(repoDir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    const line = out.trim();
    return line === "" ? null : (line.split(/\s+/)[0] ?? null);
  }

  async function inspectLocalWorkFor(work: WorkIdentity): Promise<LocalWorkFacts> {
    const repoDir = repoCloneDir(options.reposDir, work.destination.repo);
    const branch = branchOfWork(work);
    if (!existsSync(join(repoDir, ".git")) || !(await localBranchExists(repoDir, branch))) {
      // No clone or no branch yet: nothing of this attempt reached the disk.
      return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
    }

    const headSha = (await git(repoDir, ["rev-parse", `refs/heads/${branch}`])).trim();
    const baseBranch = await detectDefaultBranch(repoDir);
    // The branch's own commits against the base it was born from — never the
    // base's later advances (three-dot semantics, as diffWork reads it).
    const ahead = await git(repoDir, [
      "rev-list",
      "--count",
      `refs/remotes/origin/${baseBranch}..refs/heads/${branch}`,
    ]);

    // The worker ran in Sandcastle's own worktree: that is where uncommitted
    // changes and an interrupted operation live — the main clone never holds
    // the branch checked out. Its path is derived first because an
    // interrupted rebase detaches the worktree's HEAD, which makes the
    // branch-based lookup miss it.
    const worktreePath = await workerWorktreeOf(repoDir, branch);
    if (worktreePath === undefined) {
      return { headSha, commits: Number(ahead.trim()), uncommitted: false, operationInProgress: null };
    }

    const status = await git(worktreePath, ["status", "--porcelain"]);
    const gitDir = (await git(worktreePath, ["rev-parse", "--git-dir"])).trim();
    return {
      headSha,
      commits: Number(ahead.trim()),
      uncommitted: status.trim() !== "",
      // `git rev-parse --git-dir` answers absolute here; resolve keeps a
      // relative answer relative to the worktree.
      operationInProgress: operationInProgressOf(resolve(worktreePath, gitDir)),
    };
  }

  // The legacy IssueRef methods are the transitional bridge over the same
  // functions: one implementation, never a second git path.
  return {
    prepareWork: (ref) => prepareWorkFor(workOfIssueRef(ref)),
    prepareWorkFor,
    cleanupDoneWork: (ref) => cleanupDoneWorkFor(workOfIssueRef(ref)),
    cleanupDoneWorkFor,
    diffWork: (ref) => diffWorkFor(workOfIssueRef(ref)),
    diffWorkFor,
    observeRemoteHead: (ref) => observeRemoteHeadFor(workOfIssueRef(ref)),
    observeRemoteHeadFor,
    inspectLocalWork: (ref) => inspectLocalWorkFor(workOfIssueRef(ref)),
    inspectLocalWorkFor,
  };
}

/** The operation markers git leaves inside the worktree's git dir, in the
 *  order they win: an unfinished rebase is never mistaken for a clean tree. */
function operationInProgressOf(gitDir: string): WorkOperation | null {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  return null;
}
