import { join } from "node:path";
import { GITHUB_SITE, type RepositoryIdentity, type WorkIdentity } from "../tracker/identity.js";

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
 *     launch, reused on every relaunch (retomada / feedback / repair) — never
 *     recreated; a mere base advance is never touched (the human asks on the
 *     PR), and the branch is rebased onto the PR's current base only when a
 *     confirmed conflict reactivates the worker (issue 107);
 *   - the same branch cannot be checked out in two worktrees — git itself
 *     guarantees uniqueness across parallel works of the same repo;
 *   - done is the only state that cleans: remote branch deleted, local
 *     branch deleted, prune. Non-done states clean nothing.
 */

export function workBranchName(number: number): string {
  return `agent-issue-${number}`;
}

/**
 * The work branch of an explicit Work identity (issue 125).
 *
 * A GitHub ticket on github.com keeps the legacy `agent-issue-<n>` — the remote
 * branches of existing works stay theirs. Any other source derives the name
 * from provider + site + stable ticket id, base64url-encoded: injective (the
 * readable Jira key never enters, and a mutable key cannot rename a branch) and
 * safe as a git ref. Two sites, or two providers, aimed at the same repository
 * can never share a branch, so no slug or sanitization merges their rounds.
 */
export function branchOfWork(work: WorkIdentity): string {
  const { ticket } = work;
  if (ticket.provider === "github" && ticket.site === GITHUB_SITE) {
    return workBranchName(ticket.number);
  }
  return (
    `agent-${ticket.provider}.` +
    `${encodeBranchComponent(ticket.site)}.${encodeBranchComponent(ticket.stableId)}`
  );
}

/** base64url: [A-Za-z0-9_-], no dot, no separator a sanitizer could collapse. */
function encodeBranchComponent(value: string): string {
  if (value === "") throw new Error("a branch component cannot be empty");
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * The path Sandcastle manages for one of our work branches inside the shared
 * clone: a pure and injective function of the branch (`/` and `%` are
 * percent-encoded, so no two branches share a path). Every branch this factory
 * names is slash- and `%`-free, so this is exactly the path Sandcastle derives
 * for it (`branch.replaceAll("/", "-")` coincides there); for a branch
 * outside the convention the caller falls back to whichever worktree holds it.
 * Two Works of one repository never land on the same worktree — git also
 * refuses a branch checked out twice.
 */
export function workerWorktreePath(repoDir: string, branch: string): string {
  return join(repoDir, ".sandcastle", "worktrees", encodeURIComponent(branch));
}

/** Directory of the single clone of a target repo: <reposDir>/<owner>#<name>. */
export function repoCloneDir(reposDir: string, repo: string): string {
  return join(reposDir, `${repo.replaceAll("/", "#")}`);
}

/**
 * Directory of the single clone of a destination (issue 125): github.com keeps
 * the legacy path above, so no existing clone is relocated; a destination on
 * another code-host site carries the site in the name. The remote is a
 * different host, and two Works of the same repo name on different sites must
 * never share a clone, a remote or a branch.
 */
export function repoCloneDirFor(reposDir: string, destination: RepositoryIdentity): string {
  return destination.site === GITHUB_SITE
    ? repoCloneDir(reposDir, destination.repo)
    : `${repoCloneDir(reposDir, destination.repo)}@${encodeURIComponent(destination.site)}`;
}

export interface PreparedWork {
  /** The single clone of the destination: <workspace>/repos/<owner>#<name>. */
  repoDir: string;
  /** The work's branch — created now from origin/<default>, or reused. */
  branch: string;
  /** The default branch as revealed by the clone itself — also the PR base. */
  baseBranch: string;
  /** True when this prepare created the branch; false on reuse (relaunch). */
  branchCreated: boolean;
  /** True when `refs/heads/<branch>` exists on origin — asked of the remote
   *  itself, so a branch deleted remotely reads as absent. The work branch is
   *  pushed only when the worker publishes (push + PR): a relaunch of a work
   *  that fell before publishing has nothing on the remote to fast-forward. */
  branchOnOrigin: boolean;
}

/** The git operations a session can leave unfinished in its worktree. */
export type WorkOperation = "rebase" | "merge" | "cherry-pick";

/** Every {@link WorkOperation}, so a persisted one can be validated on read. */
export const WORK_OPERATIONS: readonly WorkOperation[] = ["rebase", "merge", "cherry-pick"];

/**
 * What the work branch holds on disk right now (issue 112): the commits a
 * resumed round must reuse instead of redoing, the changes it must inspect
 * instead of discarding, and the operation it must finish or abort instead of
 * blindly restarting. Read host-side, from the real repository — never from
 * the worker's prose.
 */
export interface LocalWorkFacts {
  /** Tip of the work branch, or null when the branch is not on disk. */
  headSha: string | null;
  /** Commits the work branch carries beyond origin/<base> (0 when the branch is absent). */
  commits: number;
  /** The worktree holds tracked changes that were never committed. */
  uncommitted: boolean;
  /** An operation the worktree left unfinished — inspected, never restarted blind. */
  operationInProgress: WorkOperation | null;
}

export interface GitWork {
  /**
   * Prepare a launch: clone once (first work of the repo), fetch delta
   * (every launch, never a re-clone), and guarantee the work branch exists,
   * born from origin/<default> the first time and untouched afterwards.
   */
  prepareWorkFor(work: WorkIdentity): Promise<PreparedWork>;

  /**
   * Done-only cleanup: delete the remote branch (unless already gone — the
   * human's merge may have auto-deleted it), delete the local branch, prune
   * stale worktree registrations and remote-tracking refs. Idempotent.
   */
  cleanupDoneWorkFor(work: WorkIdentity): Promise<void>;

  /**
   * The SHA of the work branch on the remote, or null when the branch is not
   * there — the value observed BEFORE an intervention, pinned into the
   * worker's force-with-lease so a concurrent push can never be overwritten.
   * A later fetch does not silently renew it.
   */
  observeRemoteHeadFor(work: WorkIdentity): Promise<string | null>;

  /**
   * The diff of the work branch's own changes against its base (merge-base,
   * three-dot) — the prompt's diff material (ticket 17). Empty string when
   * the branch has no changes yet; a later base advance never leaks in.
   */
  diffWorkFor(work: WorkIdentity): Promise<string>;

  /**
   * The fact sheet of the work branch as it exists on disk (issue 112): its
   * tip, how many commits it carries beyond the base, whether the worktree is
   * dirty and whether an operation was left in progress. Throws when git
   * cannot answer — an unverifiable local state is never "nothing there".
   */
  inspectLocalWorkFor(work: WorkIdentity): Promise<LocalWorkFacts>;
}
