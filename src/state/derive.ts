import type { Labels } from "../config.js";
import type { IssueComment, IssueRef, PrFeedback, PullRequest, TrackerPort } from "../tracker/port.js";
import { AGENT_MARKER } from "../tracker/port.js";

/**
 * Derivation: the stateless re-read of the tracker from which the sweep
 * derives the states of all works and the pool of eligibles (ticket 07).
 * Reads only; all writes to the tracker are commanded from here, executed
 * elsewhere. On GitHub the honest rank is null — order falls back to
 * createdAt ("eligible the longest").
 */

export interface PoolEntry {
  ref: IssueRef;
  title: string;
  /** ISO 8601 — age-based priority of the pool. */
  createdAt: string;
}

/**
 * Derive the pool: per target repo, candidates (ready label, open, no PR)
 * whose blockers are all closed — excluding works already claimed. Ordered
 * by createdAt, oldest first.
 */
export async function derivePool(
  port: TrackerPort,
  repos: string[],
  labels: Labels,
): Promise<PoolEntry[]> {
  const perRepo = await Promise.all(repos.map((repo) => deriveRepoPool(port, repo, labels)));
  return perRepo
    .flat()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.ref.repo.localeCompare(b.ref.repo) ||
        a.ref.number - b.ref.number,
    );
}

async function deriveRepoPool(
  port: TrackerPort,
  repo: string,
  labels: Labels,
): Promise<PoolEntry[]> {
  const candidates = await port.listCandidates(repo, labels.ready);
  const entries: PoolEntry[] = [];

  for (const candidate of candidates) {
    if (!(await isEligible(port, candidate.ref, labels))) continue;
    entries.push({ ref: candidate.ref, title: candidate.title, createdAt: candidate.createdAt });
  }
  return entries;
}

async function isEligible(
  port: TrackerPort,
  ref: IssueRef,
  labels: Labels,
): Promise<boolean> {
  // Already claimed: the work is in the factory's possession, not in the pool.
  const issue = await port.readIssue(ref);
  if (!issue.known) return false;
  if (issue.value.labels.includes(labels.claimed)) return false;
  if (issue.value.assignees.length > 0) return false;

  // Native blockers must all be terminal — unknown is never "without impediment".
  const blockers = await port.readBlockers(ref);
  if (!blockers.known) return false;
  return blockers.value.every((blocker) => blocker.state === "closed");
}

// ---- the reserved states — the tick's full derivation (ticket 14) ----

/**
 * The states of ALL reserved works, derived per tick statelessly (ticket 07
 * phase 2): done (issue closed — the terminal state), the merge-without-close
 * fallback, the rejection (PR closed without merge), the feedback round (new
 * human comment on the PR) and the retomada (human comment on the issue
 * AFTER the marker). The registry (trabalhos/) tells WHO is reserved — a
 * work the factory never launched is not derived here; a released work (ready
 * label back) is the pool's business, not the reserved states'.
 */
export type ReservedDerivation =
  /** The terminal state: issue closed (by linkage or by any human act). */
  | { ref: IssueRef; state: "done" }
  /** PR merged but issue open: the sweep closes the issue with a short
   * comment first — done must always be reflected on the tracker (ticket 04 Q11). */
  | { ref: IssueRef; state: "done-fallback"; pr: PullRequest; comment: string }
  /** PR closed without merge: rejected — blocked + comment pointing at the PR. */
  | { ref: IssueRef; state: "rejected"; pr: PullRequest; comment: string }
  /** New human comment on the PR: a feedback round on the same branch and PR. */
  | { ref: IssueRef; state: "feedback"; pr: PullRequest; createdAt: string }
  /** Human answer on the issue after the marker: the retomada continues from
   * the existing branch — the sweep swaps blocked→claimed before the launch. */
  | { ref: IssueRef; state: "resumable"; pr: PullRequest | null; createdAt: string }
  /** Parked, nothing to decide: waiting for the human (PR open, worker last;
   * blocked without answer) — or a released work the pool owns. */
  | { ref: IssueRef; state: "idle" }
  /** Never acted on: the issue is gone, or closed as not-planned (not done). */
  | { ref: IssueRef; state: "unknown"; because: "issue-not-found" | "not-planned" };

/** A reserved work as the derivation reads it — ref + its registry dir. */
export interface ReservedWorkInput {
  ref: IssueRef;
  dir: string;
}

export async function deriveReserved(
  port: TrackerPort,
  reserved: ReservedWorkInput[],
  labels: Labels,
  workerAccount: string,
): Promise<ReservedDerivation[]> {
  return Promise.all(reserved.map((work) => deriveReservedWork(port, work, labels, workerAccount)));
}

async function deriveReservedWork(
  port: TrackerPort,
  work: ReservedWorkInput,
  labels: Labels,
  workerAccount: string,
): Promise<ReservedDerivation> {
  const { ref } = work;
  const issue = await port.readIssue(ref);
  if (!issue.known) return { ref, state: "unknown", because: "issue-not-found" };

  // Done is the issue's state (ticket 04): closed as completed is done —
  // linkage primary (the merge closes it), fallback second (below).
  if (issue.value.state === "closed") {
    if (issue.value.stateReason === "not-planned") {
      return { ref, state: "unknown", because: "not-planned" };
    }
    return { ref, state: "done" };
  }

  // The blocked state listens ONLY to the issue (the rescue channel): a human
  // answer after the marker resumes it; anything else stays parked — this
  // short-circuit also keeps a handled rejection from being re-derived forever.
  if (issue.value.labels.includes(labels.blocked)) {
    const comments = await port.readComments(ref);
    if (comments.known && hasHumanCommentAfterLastMarker(comments.value, workerAccount)) {
      const feedback = await port.readPrFeedback(ref);
      const pr = feedback.known ? feedback.value.pr : null;
      return { ref, state: "resumable", pr, createdAt: issue.value.createdAt };
    }
    return { ref, state: "idle" };
  }

  // The PR states listen only to the PR (the feedback channel).
  const feedback = await port.readPrFeedback(ref);
  const pr = feedback.known ? feedback.value.pr : null;
  if (pr !== null) {
    if (pr.merged) {
      return { ref, state: "done-fallback", pr, comment: fallbackDoneComment() };
    }
    if (pr.state === "closed") {
      return { ref, state: "rejected", pr, comment: rejectionComment(pr) };
    }
    const last = lastPrComment(feedback.known ? feedback.value : null);
    if (last !== null && last.author !== workerAccount) {
      return { ref, state: "feedback", pr, createdAt: issue.value.createdAt };
    }
  }

  // No PR, not blocked: parked (in flight or waiting for the human) — or a
  // released work, whose state is the pool's business, not this one's.
  return { ref, state: "idle" };
}

/**
 * The last comment of the PR across both channels (conversation + reviews),
 * merged by createdAt — the feedback fact is "the LAST comment is not the
 * worker's", no local markers (ticket 07 Q3).
 */
export function lastPrComment(feedback: PrFeedback | null): IssueComment | null {
  if (feedback === null) return null;
  const all = [...feedback.comments, ...feedback.reviews].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt), // stable — ties keep read order
  );
  return all.at(-1) ?? null;
}

/**
 * The rescue answer: a comment by a non-worker author AFTER the last comment
 * carrying the agent marker (ticket 04 Q6). Comment order is chronological.
 */
export function hasHumanCommentAfterLastMarker(
  comments: IssueComment[],
  workerAccount: string,
): boolean {
  let lastMarkerIndex = -1;
  for (const [index, comment] of comments.entries()) {
    if (comment.body.includes(AGENT_MARKER)) lastMarkerIndex = index;
  }
  return comments.some(
    (comment, index) => index > lastMarkerIndex && comment.author !== workerAccount,
  );
}

/** The fallback-done comment: short, by decision (ticket 04 Q11). */
export function fallbackDoneComment(): string {
  return "the PR was merged without closing this issue — the factory closes it (done)";
}

/** The rejection comment: points at the PR (ticket 04 Q5). */
export function rejectionComment(pr: PullRequest): string {
  return (
    `work rejected: PR #${pr.number} (${pr.headBranch} → ${pr.baseBranch}) was closed without merging. ` +
    "The work is blocked and the branch stays — answer on this issue (after the marker) to resume from the existing branch."
  );
}
