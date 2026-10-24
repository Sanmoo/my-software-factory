import type { LocalWorkFacts } from "../git/port.js";
import type { RepairPublication } from "../pool/repair.js";

/**
 * The operator's words for a repair cycle (issue 112): what a publication
 * verdict, the preserved local work and a commit mean in the issue comment,
 * the status line and the worker prompt. Presentation only — the cycle and the
 * reconciliation live in pool/repair.ts.
 */

/** A branch tip the human reads at a glance: the first 12 characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** What happened to the remote branch, in one phrase: a moved head, or a
 *  branch that is gone (a deleted branch is not "a commit"). */
export function describeRemoteChange(remoteHeadSha: string | null): string {
  if (remoteHeadSha === null) return "no longer exists";
  return `moved to \`${shortSha(remoteHeadSha)}\``;
}

/**
 * The local work of an attempt in one phrase, for the block comment and the
 * status: what exists on disk and would be lost by a blind restart.
 */
export function renderLocalWork(facts: LocalWorkFacts | null): string {
  if (facts === null) return "the local work could not be read";
  const parts: string[] = [];
  if (facts.headSha === null) {
    parts.push("no work branch on disk");
  } else {
    parts.push(
      facts.commits === 1 ? "1 commit on the branch" : `${facts.commits} commits on the branch`,
    );
    parts.push(`HEAD ${shortSha(facts.headSha)}`);
  }
  if (facts.uncommitted) parts.push("uncommitted changes");
  if (facts.operationInProgress !== null) parts.push(`a ${facts.operationInProgress} in progress`);
  return parts.join(", ");
}

/** The publication verdict in the operator's vocabulary — one phrase, no jargon. */
export function describePublication(publication: RepairPublication): string {
  switch (publication) {
    case "published":
      return "published (the remote carries the commit the attempt produced)";
    case "not-published":
      // True for the unchanged head AND for a branch that is gone: the remote
      // never received this attempt's commit.
      return "not published (the remote does not carry the attempt's commit)";
    case "concurrent-change":
      return "a concurrent change the attempt did not produce";
    case "pending":
      return "publication not verified yet (reconciliation pending)";
    case "unknown":
      return "publication not verified yet";
  }
}
