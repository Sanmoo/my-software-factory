import type { Labels } from "../config.js";
import type { IssueRef, TrackerPort } from "../tracker/port.js";

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
