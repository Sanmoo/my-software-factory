import { join } from "node:path";
import type { IssueRef } from "../tracker/port.js";

/**
 * The git host side of the factory (ticket 10 / 15 decisions): one clone per
 * target repo shared by all its parallel works, a work branch born from the
 * default branch the clone itself reveals — no API call — and cleanup only
 * on done. This is a host-side module, not a port to the external world: git
 * on the local disk, exercised with local bare fixtures, no network.
 *
 * Branch and worktree decisions baked here:
 *   - clone at `<workspace>/repos/<owner>#<nome>/`, created on the first
 *     work of the repo and never re-cloned (delta `git fetch` instead);
 *   - branch `agent-issue-<n>` created from `origin/<default>` on the first
 *     launch, reused on every relaunch (retomada / feedback) — never
 *     recreated; the base advancing between rounds is never touched (no
 *     rebase, no merge — the human asks on the PR);
 *   - the same branch cannot be checked out in two worktrees — git itself
 *     guarantees uniqueness across parallel works of the same repo;
 *   - done is the only state that cleans: remote branch deleted, local
 *     branch deleted, prune. Non-done states clean nothing.
 */

export function workBranchName(number: number): string {
  return `agent-issue-${number}`;
}

/** Directory of the single clone of a target repo: <reposDir>/<owner>#<name>. */
export function repoCloneDir(reposDir: string, repo: string): string {
  return join(reposDir, `${repo.replaceAll("/", "#")}`);
}

export interface PreparedWork {
  /** The single clone of the target repo: <workspace>/repos/<owner>#<name>. */
  repoDir: string;
  /** The work's branch — created now from origin/<default>, or reused. */
  branch: string;
  /** The default branch as revealed by the clone itself — also the PR base. */
  baseBranch: string;
  /** True when this prepare created the branch; false on reuse (relaunch). */
  branchCreated: boolean;
}

export interface GitWork {
  /**
   * Prepare a launch: clone once (first work of the repo), fetch delta
   * (every launch, never a re-clone), and guarantee the work branch exists,
   * born from origin/<default> the first time and untouched afterwards.
   */
  prepareWork(ref: IssueRef): Promise<PreparedWork>;

  /**
   * Done-only cleanup: delete the remote branch (unless already gone — the
   * human's merge may have auto-deleted it), delete the local branch, prune
   * stale worktree registrations and remote-tracking refs. Idempotent.
   */
  cleanupDoneWork(ref: IssueRef): Promise<void>;

  /**
   * The diff of the work branch's own changes against its base (merge-base,
   * three-dot) — the prompt's diff material (ticket 17). Empty string when
   * the branch has no changes yet; a later base advance never leaks in.
   */
  diffWork(ref: IssueRef): Promise<string>;
}
