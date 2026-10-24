import type { Labels, ModelProviderBudget, RecoveryBudget } from "../config.js";
import type {
  ExpandedPrFeedback,
  OpenTicket,
  PullRequestRecord,
  PullRequestTracker,
  TicketSelection,
  TicketTracker,
  WorkPullRequest,
} from "../tracker/expanded-port.js";
import type {
  IssueComment,
  Known,
  PrRepairFacts,
  RepairReason,
  RequiredCheckResult,
} from "../tracker/port.js";
import { isAgentSpeech, pauseMarkerId } from "../tracker/port.js";
import { renderWorkIdentity, workIdentity, type WorkIdentity } from "../tracker/identity.js";
import { type WorkspaceLayout } from "../layout.js";
import { mapBounded } from "../concurrency.js";
import { pauseWaits, readPause, type PauseRecord } from "../runtime/continuity-artifacts.js";
import {
  readOutcomeRecord,
  blockedCommentBody,
  repairFallComment,
  ownWrittenOutcome,
  selfReportedBlocked,
  type OutcomeRecord,
} from "./outcome.js";
import { readAttemptLedger } from "../pool/registry.js";
import { peekRecovery, readRecoveryLedger, type RecoveryDecision } from "../pool/recovery.js";
import { workKeyOf } from "../pool/work-key.js";
import {
  modelProviderDecision,
  readModelProviderLedger,
  type ModelProviderDecision,
} from "../pool/model-provider.js";
import { readTurnModelProviderError, type ModelProviderFailure } from "../runtime/model-provider-error.js";
import {
  MAX_REPAIR_FALLS,
  MAX_REPAIR_ROUNDS,
  hasRepairCycle,
  hasPendingReconciliation,
  readRepairCycle,
  repairEvidenceSignature,
  type RepairAttempt,
  type RepairCycle,
} from "../pool/repair.js";

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

/** A confirmed impediment of an open PR, read from structured facts alone. */
export interface RepairTrigger {
  reasons: RepairReason[];
  facts: PrRepairFacts;
  /** The required checks that concluded with failure or timeout on this head. */
  failingChecks: RequiredCheckResult[];
}

/** A check only reacts when it concluded, and failed or timed out — never
 *  pending, cancelled, skipped, neutral or an optional one. */
function isFailingRequiredCheck(check: RequiredCheckResult): boolean {
  return check.status === "completed" && (check.conclusion === "failure" || check.conclusion === "timed_out");
}

/** The trigger of an open PR, or null when nothing is confirmed. */
function repairTrigger(facts: PrRepairFacts): RepairTrigger | null {
  const reasons: RepairReason[] = [];
  if (facts.mergeState === "conflicting") reasons.push("conflicts");
  const failingChecks = (facts.requiredChecks ?? []).filter(isFailingRequiredCheck);
  if (failingChecks.length > 0) reasons.push("required-checks");
  if (reasons.length === 0) return null;
  return { reasons, facts, failingChecks };
}

/** The consumed-evidence signature of a trigger — one authority for the
 *  derivation and the launch's durable record. */
export function repairSignature(work: WorkIdentity, trigger: RepairTrigger): string {
  return repairEvidenceSignature({
    workKey: workKeyOf(work),
    headSha: trigger.facts.headSha,
    reasons: trigger.reasons,
    failingChecks: trigger.failingChecks,
  });
}

/** A premise reading: `persisting` always carries the trigger it presents. */
export type RepairPremiseReading =
  | { premise: "persisting"; trigger: RepairTrigger }
  | { premise: "obsolete" }
  | { premise: "unknown" };

/** The premise of a repair round read from the PR's current facts (issue 149):
 *  a confirmed trigger persists; only a mergeable PR with a known required set
 *  is obsolete (an unknown mergeability, or an undetermined required set,
 *  proves nothing); an unreadable read is unknown, never an invented clean
 *  bill. The vocabulary lives in pool/repair.ts. */
export function readRepairPremise(facts: Known<PrRepairFacts>): RepairPremiseReading {
  if (!facts.known) return { premise: "unknown" };
  const trigger = repairTrigger(facts.value);
  if (trigger !== null) return { premise: "persisting", trigger };
  if (facts.value.mergeState !== "mergeable") return { premise: "unknown" };
  if (facts.value.requiredChecks === null) return { premise: "unknown" };
  return { premise: "obsolete" };
}

/** Confirmed recovery (story 22): no conflicts and every required check
 *  approved — narrower than an obsolete premise, which also holds for pending,
 *  neutral or skipped checks. The required set must be KNOWN: the empty set a
 *  repository without CI declares is a confirmation (issue 149); null
 *  (unknown) is never one. */
function repairRecovered(facts: PrRepairFacts): boolean {
  if (facts.mergeState !== "mergeable") return false;
  const checks = facts.requiredChecks;
  if (checks === null) return false;
  return checks.every((check) => check.conclusion === "success");
}

/** The Work as the derivation addresses it: the identity on disk plus its dir. */
export interface ReservedWorkInput {
  work: WorkIdentity;
  /** The reservation's registry dir — never reconstructed from current config. */
  dir: string;
}

export type ReservedDerivation = ReservedWorkInput &
  (
    /** The terminal state: issue closed (by linkage or by any human act). */
    | { state: "done" }
    /** PR merged but issue open: the sweep closes the issue with a short
     * comment first — done must always be reflected on the tracker (ticket 04 Q11). */
    | { state: "done-fallback"; pr: PullRequestRecord; comment: string }
    /** PR closed without merge: rejected — blocked + comment pointing at the PR. */
    | { state: "rejected"; pr: PullRequestRecord; comment: string }
    /** New human comment on the PR: a feedback round on the same branch and PR. */
    | { state: "feedback"; pr: PullRequestRecord; createdAt: string }
    /**
     * Confirmed impediments of the open PR (conflicts with the current base or
     * required checks concluded with failure/timeout) reactivate the worker in
     * ONE round (issue 107) — the repair budget permits it. Same branch, same PR.
     * `resuming` is the unpublished attempt this round takes over (issue 112):
     * its local commits, changes and interrupted operation are inspected
     * before continuing — never redone from scratch.
     */
    | {
        state: "repair";
        pr: PullRequestRecord;
        createdAt: string;
        trigger: RepairTrigger;
        resuming: RepairAttempt | null;
      }
    /** The PR is confirmed clean (no conflicts, every required check approved):
     *  the repair budget resets (issue 107 story 22). */
    | { state: "repair-recovered"; pr: PullRequestRecord }
    /** A confirmed trigger after the two automatic rounds: block and ask help. */
    | {
        state: "repair-blocked";
        pr: PullRequestRecord;
        trigger: RepairTrigger;
        usedRounds: number;
        comment: string;
      }
    /**
     * Repair stopped without publishing (issue 112): two consecutive attempts
     * fell before publishing, or the remote moved to a head the attempt did not
     * produce. The block holds even with the PR open — the fall is never hidden
     * by the PR's state.
     */
    | { state: "repair-fall-blocked"; pr: PullRequestRecord; comment: string; attempt: number }
    /** Human answer on the issue after the marker: the retomada continues from
     * the existing branch — the sweep swaps blocked→claimed before the launch.
     * Only replies after the last agent marker become worker context. */
    | {
        state: "resumable";
        pr: PullRequestRecord | null;
        createdAt: string;
        issueReplies: IssueComment[];
      }
    /** Parked, nothing to decide: waiting for the human (PR open, worker last;
     * blocked without answer) — or a released work the pool owns. */
    | { state: "idle" }
    /** A written failure the factory did not rule yet (it died between the
     *  record and the transition): release, or block on the 2nd consecutive
     *  failure — the ruler applies as at collection (ticket 05 Q3). */
    | { state: "fall"; decision: "release"; attempt: number }
    | { state: "fall"; decision: "block"; comment: string; attempt: number }
    /** An INTERRUPTION (issue 123): the claimed work's attempt ended without an
     *  outcome record (a dead factory/worker/container, a hard stop). It is not
     *  a failure: the same attempt is recovered within the persisted budget, or
     *  the exhausted budget pauses the work and asks the operator for help. A
     *  requested stop is persisted as itself and is never read here. */
    | { state: "interrupted"; attempt: number; recovery: RecoveryDecision }
    /** The attempt ended by the operator's REQUESTED stop (issue #146): the same
     *  attempt resumes on the next run, spending no recovery — a requested stop
     *  is a lifecycle condition, never a fall or an interruption. */
    | { state: "stop-resume"; attempt: number }
    /** The requested stop could not be confirmed (issue #146): the previous
     *  worker may still be alive, so the work is held with the reason until a
     *  later probe proves it gone. */
    | { state: "stop-unconfirmed"; attempt: number; because: string }
    /** A MODEL PROVIDER FAILURE (issue 144): the attempt's stream ended in a
     *  model provider error, so it retries on its own budget instead of the
     *  interruption's — or awaits the operator when that budget is exhausted
     *  (never a block). */
    | {
        state: "model-provider-failure";
        attempt: number;
        failure: ModelProviderFailure;
        modelProvider: ModelProviderDecision;
      }
    /** The work waits for the operator because its interrupted attempt cannot be
     *  continued safely (issue 119): its session is missing/unreadable, its
     *  identity does not match, or an external effect stayed ambiguous. The
     *  pause is persisted, so no cycle re-attempts the recovery. */
    | { state: "continuity-paused"; attempt: number; pause: PauseRecord }
    /** Never acted on: the issue is gone, or closed as not-planned (not done). */
    | { state: "unknown"; because: "issue-not-found" | "not-planned" }
  );

export async function deriveReserved(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
  reserved: ReservedWorkInput[],
  labels: Labels,
  workerAccount: string,
  workspace: WorkspaceLayout,
  recovery: RecoveryBudget,
  modelProvider: ModelProviderBudget,
  inFlight?: ReadonlySet<string>,
): Promise<ReservedDerivation[]> {
  return Promise.all(
    reserved.map((work) =>
      deriveReservedWork(tickets, pullRequests, work, labels, workerAccount, workspace, recovery, modelProvider, inFlight),
    ),
  );
}

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

async function deriveReservedWork(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
  input: ReservedWorkInput,
  labels: Labels,
  _workerAccount: string,
  workspace: WorkspaceLayout,
  recovery: RecoveryBudget,
  modelProvider: ModelProviderBudget,
  inFlight?: ReadonlySet<string>,
): Promise<ReservedDerivation> {
  const { work, dir } = input;
  const issue = await tickets.readTicket(work.ticket);
  if (!issue.known) return { work, dir, state: "unknown", because: "issue-not-found" };

  // Done is the ticket's state (ticket 04): closed as completed is done —
  // linkage primary (the merge closes it), fallback second (below).
  if (issue.value.state === "closed") {
    if (issue.value.stateReason === "not-planned") {
      return { work, dir, state: "unknown", because: "not-planned" };
    }
    return { work, dir, state: "done" };
  }

  // The blocked state listens ONLY to the ticket (the rescue channel): a human
  // answer after the marker resumes it; anything else stays parked — this
  // short-circuit also keeps a handled rejection from being re-derived forever.
  if (issue.value.labels.includes(labels.blocked)) {
    const comments = await tickets.readTicketComments(work.ticket);
    // The operator's answer is bound to the question it answered (issue 174):
    // with a CURRENT continuity pause the boundary is the pause's own request,
    // never the last thing the factory said. Every other blocked cause (a
    // fall, a repair, a rejection) keeps the generic last-marker rule.
    const pause = await currentPause(dir);
    const issueReplies = comments.known
      ? pause === null
        ? humanCommentsAfterLastMarker(comments.value)
        : humanCommentsForPause(comments.value, pause.pause)
      : [];
    if (issueReplies.length > 0) {
      // A pending reconciliation outranks the human answer (issue 112, story
      // 21): the remote may already carry this attempt's commit, so starting a
      // worker would duplicate it — and the resume renews a budget the
      // reconciliation has not settled yet. The answer survives and applies as
      // soon as the next sweep gets its verdict; until then this hold is what
      // status shows.
      const cycle = await readRepairCycle(dir);
      if (cycle.attempt !== null && hasPendingReconciliation(cycle.attempt)) {
        return { work, dir, state: "idle" };
      }
      return resumableState(pullRequests, work, dir, issue.value.createdAt, issueReplies);
    }
    // A pause nobody answered is not a reason to wait idle (issue 173): the
    // work is in a state the factory keeps evaluating, and the loop re-reads
    // the evidence the pause doubts before any human is asked again.
    if (pause !== null) {
      return { work, dir, state: "continuity-paused", attempt: pause.attempt, pause: pause.pause };
    }
    return { work, dir, state: "idle" };
  }

  // The PR states listen only to the PR (the feedback channel).
  const target = workPullRequest(work);
  const feedback = await pullRequests.readPullRequestFeedback(target);
  const pr = feedback.known ? feedback.value.pr : null;
  if (pr !== null) {
    if (pr.merged) {
      return { work, dir, state: "done-fallback", pr, comment: fallbackDoneComment() };
    }
    if (pr.state === "closed") {
      return { work, dir, state: "rejected", pr, comment: rejectionComment(pr) };
    }

    const stop = (await readRecoveryLedger(dir)).lastStop;
    if (stop !== null && (stop.kind === "stop-requested" || stop.kind === "stop-unconfirmed") &&
        issue.value.labels.includes(labels.claimed) && !inFlight?.has(workKeyOf(work))) {
      const ledger = await readAttemptLedger(dir);
      if (stop.attempt >= Math.max(1, ledger.lastAttempt) && stop.attempt <= ledger.lastAttempt + 1 &&
          ownWrittenOutcome(await readOutcomeRecord(dir), stop.attempt) === null) {
        return stop.kind === "stop-requested"
          ? { work, dir, state: "stop-resume", attempt: stop.attempt }
          : { work, dir, state: "stop-unconfirmed", attempt: stop.attempt, because: stop.because };
      }
    }

    // The repair channel (issue 107): only CONFIRMED facts of the CURRENT head
    // trigger — conflicts with the current base, or required checks concluded
    // with failure/timeout. Unknown mergeability and pending/optional checks
    // never do, and the Block above already won over all of it.
    const repairFacts = await pullRequests.readPullRequestRepairFacts(target);
    const trigger = repairFacts.known ? repairTrigger(repairFacts.value) : null;
    const cycle = await readRepairCycle(dir);
    const attempt = cycle.attempt;

    // The attempt's own state comes before the trigger and the evidence
    // consumption (issue 112): two consecutive falls and an unattributable
    // remote change block the work EVEN with the PR open and even when the
    // tracker's current facts are not confirmed — the open PR never hides a
    // fall. An attempt that fell without publishing is taken over instead of
    // being mistaken for a consumed round.
    if (attempt !== null && cycle.consecutiveFalls >= MAX_REPAIR_FALLS) {
      return repairFallBlocked(work, dir, pr, cycle, workspace, attempt, "consecutive-falls");
    }
    if (attempt?.publication === "concurrent-change") {
      return repairFallBlocked(work, dir, pr, cycle, workspace, attempt, "concurrent-change");
    }
    if (attempt !== null && hasPendingReconciliation(attempt)) {
      // Pending reconciliation: NO worker of any kind (repair, resumption or
      // feedback round) and no budget return until the remote or the host
      // answers — a later sweep repeats the query (the reconciliation owns the
      // transition). Placed before the trigger so an unconfirmed PR fact
      // cannot open a session while the reconciliation is pending.
      return { work, dir, state: "idle" };
    }

    if (trigger !== null) {
      const signature = repairSignature(work, trigger);
      // A resumption takes over the attempt whose evidence is still the one
      // this head presents (issue 112): a fall on OLDER evidence is history,
      // and the current head gets a round of its own, pinned to its own head.
      if (
        attempt !== null &&
        attempt.publication === "not-published" &&
        attempt.evidence === signature
      ) {
        return {
          work,
          dir,
          state: "repair",
          pr,
          createdAt: issue.value.createdAt,
          trigger,
          resuming: attempt,
        };
      }
      // Story 19: re-finding the same failure without new evidence is never a
      // new session; the exhausted cap still blocks.
      if (cycle.lastEvidence === signature) {
        if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) {
          return repairBlocked(work, dir, pr, trigger, cycle.usedRounds);
        }
        return { work, dir, state: "idle" };
      }
      if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) {
        return repairBlocked(work, dir, pr, trigger, cycle.usedRounds);
      }
      return {
        work,
        dir,
        state: "repair",
        pr,
        createdAt: issue.value.createdAt,
        trigger,
        resuming: null,
      };
    }

    // Confirmed recovery (story 22): no conflicts and every required check
    // approved — the only thing besides a human unblock that resets the cap.
    // The gate is "this work has a repair cycle", not "a round is charged":
    // after a fall the charged round was returned, and the fall ledger it left
    // behind is exactly what recovery must clear (issue 112, story 25).
    if (repairFacts.known && hasRepairCycle(cycle) && repairRecovered(repairFacts.value)) {
      return { work, dir, state: "repair-recovered", pr };
    }

    const last = lastPrComment(feedback.known ? feedback.value : null);
    // Speech, not login (v0.1): the worker account may be the operator's.
    // A closing comment carries the marker; a comment without it is the human.
    if (last !== null && !isAgentSpeech(last.body)) {
      return { work, dir, state: "feedback", pr, createdAt: issue.value.createdAt };
    }
    // The worker just opened the PR (or ended the round commenting on it):
    // the ball is with the human — parked, nothing to decide.
    return { work, dir, state: "idle" };
  }

  // No PR, not blocked: a claimed work without a worker in flight ended
  // without the factory settling it (the collection never happened). The
  // registry says whether that end was an interruption or a written failure
  // (issue 123); anything else is parked — in flight or waiting for the
  // human — or a released work, whose state is the pool's business.
  if (issue.value.labels.includes(labels.claimed)) {
    // A pending reconciliation holds the claim even when the PR cannot be
    // read: releasing it would hand the work back to the pool while its
    // publication is still unknown (issue 112).
    const cycle = await readRepairCycle(dir);
    if (cycle.attempt !== null && hasPendingReconciliation(cycle.attempt)) {
      return { work, dir, state: "idle" };
    }
    const unreconciled = await deriveUnreconciledAttempt(work, dir, workspace, recovery, inFlight);
    // Only an interruption can be a model provider failure: the attempt's own
    // stream decides it (issue 144) — a written outcome or a bare reservation
    // never reads the model provider ledger.
    if (unreconciled.state === "interrupted") {
      const providerFailure = await deriveModelProviderFailure(
        tickets,
        pullRequests,
        {
          work,
          dir,
          attempt: unreconciled.attempt,
          createdAt: issue.value.createdAt,
        },
        modelProvider,
      );
      if (providerFailure !== null) return providerFailure;
    }
    return unreconciled;
  }
  return { work, dir, state: "idle" };
}

/**
 * The claimed work whose attempt the factory did not settle (ticket 05 Q3,
 * derived in 14; orphans in 18; interruption vs failure in 123). The registry
 * decides which question is being asked:
 *
 *  - the last attempt wrote NO outcome record: an INTERRUPTION. Absence is not
 *    a failure, so the 1st/2nd-fall ruler never applies — the attempt keeps its
 *    number and the recovery budget decides (recover, or pause and ask help);
 *  - the last attempt wrote a failure/abandon record: the factory died between
 *    the record and its transition — the fall ruler applies as at collection;
 *  - a claim with zero attempt evidence: an interruption of attempt 1 (a death
 *    between the claim and the spawn). Inside THIS process's in-flight set the
 *    claim is a legitimate launch between the claim and the worker's first
 *    write — held, never recovered behind its back.
 */
async function deriveUnreconciledAttempt(
  work: WorkIdentity,
  dir: string,
  workspace: WorkspaceLayout,
  recovery: RecoveryBudget,
  inFlight?: ReadonlySet<string>,
): Promise<ReservedDerivation> {
  const ledger = await readAttemptLedger(dir);
  const current = ledger.lastAttempt === 0 ? 1 : ledger.lastAttempt;

  // A confirmed Outcome prevails over the interpretation of the stop (issue
  // #146): the attempt really ended with a verdict, so a stop record left on
  // top of it (the operator stopped the factory while that verdict was being
  // applied) never turns the attempt into a requested-stop resume.
  const record = await readOutcomeRecord(dir);
  if (selfReportedBlocked(record, ledger.lastAttempt)) {
    // The worker reported blocked but the label never landed (an interrupted
    // claim swap): a written outcome that is neither a failure to rule nor an
    // interruption to recover — the work stays reserved, as collection's
    // `record-only` leaves it, and the human sees it in `msf status`.
    return { work, dir, state: "idle" };
  }
  if (ownWrittenOutcome(record, ledger.lastAttempt) !== null) {
    return deriveUnreconciledFailure(work, dir, workspace, ledger.lastAttempt, record);
  }

  // The persisted stop of THIS attempt (issue #146): it says the operator
  // ended the attempt deliberately, so it is neither an interruption to charge
  // nor a failure to rule. An unconfirmed stop holds the work.
  const ledgered = await readRecoveryLedger(dir);
  const stop = ledgered.lastStop;
  if (stop !== null && stop.attempt === current) {
    if (stop.kind === "stop-requested") return { work, dir, state: "stop-resume", attempt: current };
    if (stop.kind === "stop-unconfirmed") {
      return { work, dir, state: "stop-unconfirmed", attempt: current, because: stop.because };
    }
  }

  if (ledger.lastAttempt === 0) {
    if (inFlight?.has(workKeyOf(work))) return { work, dir, state: "idle" };
    const pause = pausedAttempt(dir, 1);
    if (pause !== null) return { work, dir, state: "continuity-paused", attempt: 1, pause };
    return {
      work,
      dir,
      state: "interrupted",
      attempt: 1,
      recovery: await peekRecovery(dir, recovery, 1),
    };
  }

  const pause = pausedAttempt(dir, ledger.lastAttempt);
  if (pause !== null) {
    return { work, dir, state: "continuity-paused", attempt: ledger.lastAttempt, pause };
  }

  return {
    work,
    dir,
    state: "interrupted",
    attempt: ledger.lastAttempt,
    recovery: await peekRecovery(dir, recovery, ledger.lastAttempt),
  };
}

/** The persisted continuity pause of THIS attempt, if any (issue 119). A pause
 *  from an older attempt is history: the current attempt's facts decide — but a
 *  record whose own attempt is unreadable waits for whichever attempt is
 *  current, because guessing one is how a pause disappears. */
function pausedAttempt(dir: string, attempt: number): PauseRecord | null {
  const pause = readPause(dir);
  return pause !== null && pauseWaits(pause, attempt) ? pause : null;
}

/** The pause the factory keeps re-evaluating, if any: it is history only once
 *  the ledger advanced PAST it, and a claim that wrote no attempt yet cannot
 *  have advanced past one (`pauseWaits` holds for every record against 0). The
 *  attempt reported is the one the pause waits for — its own, or the claim's
 *  first when the record cannot name one. Read only when a record exists — a
 *  blocked work without one never touches the ledger for this. */
async function currentPause(dir: string): Promise<{ pause: PauseRecord; attempt: number } | null> {
  const pause = readPause(dir);
  if (pause === null) return null;
  const { lastAttempt } = await readAttemptLedger(dir);
  if (!pauseWaits(pause, lastAttempt)) return null;
  return { pause, attempt: pause.attempt >= 1 ? pause.attempt : Math.max(lastAttempt, 1) };
}

/**
 * The model provider failure derivation of an INTERRUPTED attempt (issue 144),
 * or null when the attempt's stream carries no model provider error. One
 * retries on its own budget; exhausted, it awaits the operator — a help
 * request a human answer resumes.
 */
async function deriveModelProviderFailure(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
  work: InterruptedAttempt,
  modelProvider: ModelProviderBudget,
): Promise<ReservedDerivation | null> {
  const failure = await readTurnModelProviderError(work.dir, work.attempt);
  if (failure === null) return null;

  const modelProviderLedger = await readModelProviderLedger(work.dir);
  const decision = modelProviderDecision(modelProviderLedger, modelProvider, work.attempt, failure);
  if (decision.decision === "awaiting-model-provider") {
    // The model provider budget is exhausted: the work waits for the operator
    // — a help request, never a block. A human answer after the marker resumes it,
    // the same channel a blocked work listens to.
    const comments = await tickets.readTicketComments(work.work.ticket);
    const issueReplies = comments.known ? humanCommentsAfterLastMarker(comments.value) : [];
    if (issueReplies.length > 0) {
      return resumableState(pullRequests, work.work, work.dir, work.createdAt, issueReplies);
    }
  }
  return {
    work: work.work,
    dir: work.dir,
    state: "model-provider-failure",
    attempt: work.attempt,
    failure,
    modelProvider: decision,
  };
}

/** The interrupted attempt the model provider decision reads: its Work, dir,
 *  attempt number and the ticket's creation time (the retomada's priority fact). */
interface InterruptedAttempt {
  work: WorkIdentity;
  dir: string;
  attempt: number;
  createdAt: string;
}

/** The retomada: a human answer after the marker resumes the work on its
 *  existing branch and PR — shared by the blocked channel and the awaiting
 *  model provider (issue 144), so their shape cannot drift apart. */
async function resumableState(
  pullRequests: PullRequestTracker,
  work: WorkIdentity,
  dir: string,
  createdAt: string,
  issueReplies: IssueComment[],
): Promise<ReservedDerivation> {
  const feedback = await pullRequests.readPullRequestFeedback(workPullRequest(work));
  const pr = feedback.known ? feedback.value.pr : null;
  return { work, dir, state: "resumable", pr, createdAt, issueReplies };
}

/**
 * The ruler for a written outcome the factory never applied: the on-disk
 * record is the attempt's own (a written failure when the class is one), so the
 * attempt is consumed and the ruler applies as at collection — the 2nd
 * consecutive fall blocks, otherwise the 1st releases. The last interval — a
 * death right after the factory settled the failure but before its transition —
 * is read from the recovery ledger, which records the stop before the tracker
 * write.
 */
async function deriveUnreconciledFailure(
  work: WorkIdentity,
  dir: string,
  workspace: WorkspaceLayout,
  attempt: number,
  record: OutcomeRecord | null,
): Promise<ReservedDerivation> {
  const ledger = await readRecoveryLedger(dir);
  // The consecutiveness fact is the attempt NUMBER of the last fall, never the
  // last stop: an interruption of the current attempt must not erase the fall
  // of the one before it. Only ledger-era history carries it — a fall recorded
  // before the ledger existed is not counted here.
  const previousWasFall = ledger.lastFallAttempt === attempt - 1;
  if (!previousWasFall) return { work, dir, state: "fall", decision: "release", attempt };
  return {
    work,
    dir,
    state: "fall",
    decision: "block",
    attempt,
    comment: await blockedCommentBody({ attempt, record, workDir: dir, workspace }),
  };
}

/**
 * The last comment of the PR across both channels (conversation + reviews),
 * merged by createdAt. Feedback is "the LAST comment does not carry the
 * agent marker" (ticket 07 Q3, amended in 18) — login cannot separate the
 * sides when they are the same account.
 */
export function lastPrComment(feedback: ExpandedPrFeedback | null): IssueComment | null {
  if (feedback === null) return null;
  const all = [...feedback.comments, ...feedback.reviews].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt), // stable — ties keep read order
  );
  return all.at(-1) ?? null;
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

/** The fallback-done comment: short, by decision (ticket 04 Q11). */
export function fallbackDoneComment(): string {
  return "the PR was merged without closing this issue — the factory closes it (done)";
}

/** The block after the two automatic repair rounds, naming what persists. */
function repairBlocked(
  work: WorkIdentity,
  dir: string,
  pr: PullRequestRecord,
  trigger: RepairTrigger,
  usedRounds: number,
): ReservedDerivation {
  const comment =
    `automatic repair stopped after ${usedRounds} rounds without recovering PR #${pr.number}: ` +
    `${repairReasonsPhrase(trigger)} persist on the current HEAD. A human decision, authorization or fix is needed.`;
  return { work, dir, state: "repair-blocked", pr, trigger, usedRounds, comment };
}

/** The persisting impediments, in the operator's words. */
function repairReasonsPhrase(trigger: RepairTrigger): string {
  return trigger.reasons
    .map((reason) =>
      reason === "conflicts" ? "the conflict with the base" : "the failing required checks",
    )
    .join(" and ");
}

/**
 * The block of a Repair that stopped without publishing (issue 112): the
 * attempt that fell, its abrupt end, the divergent record on disk and the
 * evidence paths are named by the comment; the local work is never touched.
 */
async function repairFallBlocked(
  work: WorkIdentity,
  dir: string,
  pr: PullRequestRecord,
  cycle: RepairCycle,
  workspace: WorkspaceLayout,
  attempt: RepairAttempt,
  cause: "consecutive-falls" | "concurrent-change",
): Promise<ReservedDerivation> {
  const record = await readOutcomeRecord(dir);
  const comment = await repairFallComment({
    cause,
    prNumber: pr.number,
    consecutiveFalls: cycle.consecutiveFalls,
    attempt,
    record,
    workDir: dir,
    workspace,
  });
  return { work, dir, state: "repair-fall-blocked", pr, comment, attempt: attempt.attempt };
}

/** The rejection comment: points at the PR (ticket 04 Q5). */
export function rejectionComment(pr: PullRequestRecord): string {
  return (
    `work rejected: PR #${pr.number} (${pr.headBranch} → ${pr.baseBranch}) was closed without merging. ` +
    "The work is blocked and the branch stays — answer on this issue (after the marker) to resume from the existing branch."
  );
}
