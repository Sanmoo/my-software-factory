import type { Labels } from "../config.js";
import type {
  ExpandedPrFeedback,
  OpenTicket,
  PullRequestRecord,
  TicketSelection,
  TicketTracker,
  WorkPullRequest,
} from "../tracker/expanded-port.js";
import type { IssueComment } from "../tracker/port.js";
import { isAgentSpeech, pauseMarkerId } from "../tracker/port.js";
import { renderWorkIdentity, workIdentity, type WorkIdentity } from "../tracker/identity.js";
import { mapBounded } from "../concurrency.js";
import { workKeyOf } from "../pool/work-key.js";
import type { PauseRecord } from "../work-record/continuity.js";

/**
 * Derivation: the stateless re-read of the tracker from which the sweep
 * derives the states of all works and the pool of eligibles (ticket 07).
 * Reads only; all writes to the tracker are commanded from here, executed
 * elsewhere. On GitHub the honest rank is null — order falls back to
 * createdAt ("eligible the longest").
 */

export interface PoolEntry {
  work: WorkIdentity;
  title: string;
  /** ISO 8601 — age-based priority of the pool. */
  createdAt: string;
}

/**
 * A work the tracker marks as claimed (the claim or the blocked label) but
 * whose registry dir does not exist in this workspace: the factory marked it
 * and left no reservation here (issues 93/97). The command is the operator's
 * safe way back to the pool; the caveat warns that ANOTHER factory or
 * workspace may be the one holding the claim.
 */
export interface UnbackedClaim {
  work: WorkIdentity;
  /** The copy-paste `gh` invocation that returns the issue to the pool; null
   *  when the ticket is not a GitHub issue (no GitHub command is invented). */
  command: string | null;
}

/**
 * A reservation on disk whose work carries NO factory mark at all (no claim,
 * no block, no pool label): possibly lost work. Reported as a fact only — the
 * decision is human, and there is no safe command.
 */
export interface UnmarkedReservation {
  work: WorkIdentity;
}

/** The two leftover kinds of the tracker↔workspace reconciliation. */
export interface Reconciliation {
  unbackedClaims: UnbackedClaim[];
  unmarkedReservations: UnmarkedReservation[];
}

/** The whole derivation of one tick: the pool AND the reconciliation, one read per repo. */
export interface TrackerState extends Reconciliation {
  pool: PoolEntry[];
}

/** How many blocker reads may be in flight at once (issue 147): independent
 *  round-trips, bounded so the tracker's rate budget still holds. */
export const BLOCKER_READS_IN_FLIGHT = 8;

export const UNBACKED_CLAIM_CAVEAT =
  "another factory or workspace may hold this claim — confirm before releasing";

/** Stable identity of one leftover for the once-per-appearance report. */
export const unbackedClaimKey = (claim: UnbackedClaim): string =>
  `unbackedClaim:${workKeyOf(claim.work)}`;
export const unmarkedReservationKey = (reservation: UnmarkedReservation): string =>
  `unmarkedReservation:${workKeyOf(reservation.work)}`;

/**
 * The single derivation that returns the pool and the reconciliation from ONE
 * open-tickets read per selection (issue 100): the neutral listing is filtered
 * by the pool's own rules and cross-referenced with the workspace's reservations
 * and the in-flight set. Reads only; never acts. Ticket facts come from the
 * ticket port; a Work is the listed ticket plus the selection's explicit
 * destination (issue 126).
 */
export async function deriveTrackerState(
  tickets: TicketTracker,
  selections: readonly TicketSelection[],
  labels: Labels,
  reservations: ReadonlySet<string> = new Set(),
  inFlight: ReadonlySet<string> = new Set(),
): Promise<TrackerState> {
  const listings = await Promise.all(
    selections.map(async (selection) => {
      const open = await tickets.listOpenTickets(selection);
      return open.map((ticket) => ({ ticket, work: workIdentity(ticket.ticket, selection.destination) }));
    }),
  );
  const byKey = new Map<string, { ticket: OpenTicket; work: WorkIdentity }>();
  for (const listed of listings) for (const entry of listed) byKey.set(workKeyOf(entry.work), entry);

  const unbackedClaims: UnbackedClaim[] = [];
  const candidates: Array<{ ticket: OpenTicket; work: WorkIdentity }> = [];
  for (const listed of listings) {
    for (const entry of listed) {
      const key = workKeyOf(entry.work);
      // A work this process is launching right now is never reported.
      if (inFlight.has(key)) continue;
      if (hasClaimMark(entry.ticket, labels)) {
        // A mark without a reservation: the tracker claims it, this workspace
        // never registered it. A mark WITH a reservation is a normal reserved
        // work — the reserved derivation owns it.
        if (!reservations.has(key)) {
          unbackedClaims.push({ work: entry.work, command: releaseCommand(entry.ticket, labels) });
        }
        continue;
      }
      if (!isEligible(entry.ticket, labels)) continue;
      candidates.push(entry);
    }
  }

  // The blocker read is the only per-candidate round-trip the listing could
  // not answer, and it is issued with bounded concurrency (issue 147).
  const verdicts = await mapBounded(candidates, BLOCKER_READS_IN_FLIGHT, async (entry) => ({
    entry,
    unblocked: await hasNoOpenBlocker(tickets, entry.ticket.ticket),
  }));
  const pool: PoolEntry[] = [];
  for (const { entry, unblocked } of verdicts) {
    if (!unblocked) continue;
    pool.push({ work: entry.work, title: entry.ticket.title, createdAt: entry.ticket.createdAt });
  }

  // A reservation whose open work carries no factory mark (not even the pool
  // label): the dir exists, the tracker says nothing about it. The listing is
  // the only read, so a reservation missing from `byKey` stays out: a
  // closed/unknown issue is the done derivation's business, and a reservation
  // whose repo is not a target has no listing at all (its dir still shows in
  // the registry section of `msf status`).
  const unmarkedReservations: UnmarkedReservation[] = [];
  for (const key of reservations) {
    if (inFlight.has(key)) continue;
    const listed = byKey.get(key);
    if (listed === undefined) continue;
    if (hasAnyFactoryLabel(listed.ticket, labels)) continue;
    unmarkedReservations.push({ work: listed.work });
  }

  return {
    pool: pool.sort(comparePoolEntries),
    unbackedClaims: unbackedClaims.sort(compareLeftoverWorks),
    unmarkedReservations: unmarkedReservations.sort(compareLeftoverWorks),
  };
}

/** The report line `msf status` and the sweep log share — the derivation never acts. */
export function renderUnbackedClaim(claim: UnbackedClaim): string {
  const release =
    claim.command === null
      ? "this ticket is not a GitHub issue, so no gh command is offered"
      : `return it to the pool with: ${claim.command}`;
  return (
    `unbacked claim: ${renderWorkIdentity(claim.work)} — a factory mark on an open issue with no reservation in this workspace ` +
    `(${UNBACKED_CLAIM_CAVEAT}); ${release}`
  );
}

/** The fact-only line: an unmarked reservation has no safe command. */
export function renderUnmarkedReservation(reservation: UnmarkedReservation): string {
  return (
    `unmarked reservation: ${renderWorkIdentity(reservation.work)} — the work dir exists but the tracker carries no factory mark ` +
    "(no claim, no block, no pool label); the decision is human, nothing was touched"
  );
}

function comparePoolEntries(a: PoolEntry, b: PoolEntry): number {
  return a.createdAt.localeCompare(b.createdAt) || compareWorks(a.work, b.work);
}

function compareLeftoverWorks(a: { work: WorkIdentity }, b: { work: WorkIdentity }): number {
  return compareWorks(a.work, b.work);
}

/** A stable presentation order that keeps GitHub's historical repo-then-number
 *  comparison (#2 before #10) and falls back to the Work key for other sources. */
function compareWorks(a: WorkIdentity, b: WorkIdentity): number {
  if (a.ticket.provider === "github" && b.ticket.provider === "github") {
    return (
      a.ticket.repo.localeCompare(b.ticket.repo) ||
      a.ticket.number - b.ticket.number ||
      workKeyOf(a).localeCompare(workKeyOf(b))
    );
  }
  return workKeyOf(a).localeCompare(workKeyOf(b));
}

const hasAnyLabel = (issue: OpenTicket, candidates: readonly string[]): boolean =>
  candidates.some((label) => issue.labels.includes(label));

/** The claim mark that makes a tracker entry a reservation: claim or block. */
function hasClaimMark(issue: OpenTicket, labels: Labels): boolean {
  return hasAnyLabel(issue, [labels.claimed, labels.blocked]);
}

/** Any of the three factory labels — the pool label alone still marks a work. */
function hasAnyFactoryLabel(issue: OpenTicket, labels: Labels): boolean {
  return hasAnyLabel(issue, [labels.ready, labels.claimed, labels.blocked]);
}

/** The copy-paste command that returns an unbacked claim to the pool: add the
 *  pool label when missing, drop the factory mark(s) present, release the
 *  assignee(s) — an assigned work is never eligible. A non-GitHub ticket has
 *  no `gh` command; null is offered instead of a fabricated one. */
function releaseCommand(issue: OpenTicket, labels: Labels): string | null {
  const ticket = issue.ticket;
  if (ticket.provider !== "github") return null;
  const parts = [`gh issue edit ${ticket.number}`, `--repo ${ticket.repo}`];
  if (!issue.labels.includes(labels.ready)) parts.push(`--add-label ${labels.ready}`);
  if (issue.labels.includes(labels.claimed)) parts.push(`--remove-label ${labels.claimed}`);
  if (issue.labels.includes(labels.blocked)) parts.push(`--remove-label ${labels.blocked}`);
  for (const assignee of issue.assignees) parts.push(`--remove-assignee ${assignee}`);
  return parts.join(" ");
}

/** The pool's label rules, over the neutral read — never in the adapter. An
 *  assigned issue is claimed by decoration; a linked PR is already in the PR
 *  channel (ticket 12). */
function isEligible(issue: OpenTicket, labels: Labels): boolean {
  if (!issue.labels.includes(labels.ready)) return false;
  if (issue.labels.includes(labels.claimed)) return false;
  // Blocked works listen to the issue channel, never to the pool (ticket 14).
  if (issue.labels.includes(labels.blocked)) return false;
  if (issue.assignees.length > 0) return false;
  // Unknown linkage (null) is never "without an open PR".
  if (issue.hasOpenPr !== false) return false;
  return true;
}

/** Native blockers must all be terminal — unknown is never "without impediment". */
async function hasNoOpenBlocker(tickets: TicketTracker, ticket: OpenTicket["ticket"]): Promise<boolean> {
  const blockers = await tickets.readTicketBlockers(ticket);
  if (!blockers.known) return false;
  return blockers.value.every((blocker) => blocker.state === "closed");
}

// ---- the reserved states — the tick's full derivation (ticket 14) ----
// The repair trigger and the premise it reads have one owner (pool/repair-trigger.ts):
// the Work state, the derivation and the launch's durable signature all ask it.

/** The PR read target of a Work: the PR the caller already saw, else null —
 *  which lets the code host answer from its own linkage. The persisted
 *  association is never preferred over the host's linkage: a stale or
 *  unreadable record would silently retarget a feedback or repair read. */
export function workPullRequest(
  work: WorkIdentity,
  seen: PullRequestRecord | null = null,
): WorkPullRequest {
  return { work, pullRequest: seen?.identity ?? null };
}

/**
 * The human replies that resume blocked work: all non-agent comments AFTER
 * the last comment carrying the marker (ticket 04 Q6, amended in 18). The
 * author may be the worker account. Comment order is chronological.
 */
export function humanCommentsAfterLastMarker(comments: IssueComment[]): IssueComment[] {
  let lastMarkerIndex = -1;
  for (const [index, comment] of comments.entries()) {
    if (isAgentSpeech(comment.body)) lastMarkerIndex = index;
  }
  return comments.slice(lastMarkerIndex + 1).filter((comment) => !isAgentSpeech(comment.body));
}

export function hasHumanCommentAfterLastMarker(comments: IssueComment[]): boolean {
  return humanCommentsAfterLastMarker(comments).length > 0;
}

/**
 * The human replies that answer ONE continuity pause (issue 174): every
 * non-agent comment after the FIRST factory comment carrying that pause's
 * marker. A later factory comment about the same pause — a re-assertion or a
 * diagnostic for a changed cause — never displaces an answer already given.
 *
 * Before the request lands there is nothing to answer, and an answer given to
 * an earlier question is never consumed. A record written before the identity
 * existed keeps the generic rule, so old pauses still resume.
 */
export function humanCommentsForPause(comments: IssueComment[], pause: PauseRecord): IssueComment[] {
  if (pause.id === undefined) return humanCommentsAfterLastMarker(comments);
  const request = comments.findIndex((comment) => pauseMarkerId(comment.body) === pause.id);
  if (request < 0) return [];
  return comments.slice(request + 1).filter((comment) => !isAgentSpeech(comment.body));
}
