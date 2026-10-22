import type { Labels, ModelProviderBudget, RecoveryBudget } from "../config.js";
import type {
  IssueComment,
  IssueRef,
  Known,
  OpenIssue,
  PrFeedback,
  PrRepairFacts,
  PullRequest,
  RepairReason,
  RequiredCheckResult,
  TrackerPort,
} from "../tracker/port.js";
import { isAgentSpeech } from "../tracker/port.js";
import { type WorkspaceLayout } from "../layout.js";
import { mapBounded } from "../concurrency.js";
import { readPause, type PauseRecord } from "../runtime/continuity-artifacts.js";
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
  ref: IssueRef;
  title: string;
  /** ISO 8601 — age-based priority of the pool. */
  createdAt: string;
}

/** The key every seam shares for a work: "<repo>#<n>". */
export const workKey = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

/**
 * A work the tracker marks as claimed (the claim or the blocked label) but
 * whose registry dir does not exist in this workspace: the factory marked it
 * and left no reservation here (issues 93/97). The command is the operator's
 * safe way back to the pool; the caveat warns that ANOTHER factory or
 * workspace may be the one holding the claim.
 */
export interface UnbackedClaim {
  ref: IssueRef;
  /** The copy-paste `gh` invocation that returns the issue to the pool. */
  command: string;
}

/**
 * A reservation on disk whose work carries NO factory mark at all (no claim,
 * no block, no pool label): possibly lost work. Reported as a fact only — the
 * decision is human, and there is no safe command.
 */
export interface UnmarkedReservation {
  ref: IssueRef;
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
  `unbackedClaim:${workKey(claim.ref)}`;
export const unmarkedReservationKey = (reservation: UnmarkedReservation): string =>
  `unmarkedReservation:${workKey(reservation.ref)}`;

/**
 * The single derivation that returns the pool and the reconciliation from ONE
 * open-issues read per target repo (issue 100): the neutral listing is filtered
 * by the pool's own rules and cross-referenced with the workspace's reservations
 * and the in-flight set. Reads only; never acts.
 */
export async function deriveTrackerState(
  port: TrackerPort,
  repos: string[],
  labels: Labels,
  reservations: ReadonlySet<string> = new Set(),
  inFlight: ReadonlySet<string> = new Set(),
): Promise<TrackerState> {
  const listings = await Promise.all(repos.map((repo) => port.listOpenIssues(repo)));
  const byKey = new Map<string, OpenIssue>();
  for (const issues of listings) for (const issue of issues) byKey.set(workKey(issue.ref), issue);

  const unbackedClaims: UnbackedClaim[] = [];
  const candidates: OpenIssue[] = [];
  for (const issues of listings) {
    for (const issue of issues) {
      const key = workKey(issue.ref);
      // A work this process is launching right now is never reported.
      if (inFlight.has(key)) continue;
      if (hasClaimMark(issue, labels)) {
        // A mark without a reservation: the tracker claims it, this workspace
        // never registered it. A mark WITH a reservation is a normal reserved
        // work — the reserved derivation owns it.
        if (!reservations.has(key)) {
          unbackedClaims.push({ ref: issue.ref, command: releaseCommand(issue, labels) });
        }
        continue;
      }
      if (!isEligible(issue, labels)) continue;
      candidates.push(issue);
    }
  }

  // The blocker read is the only per-candidate round-trip the listing could
  // not answer, and it is issued with bounded concurrency (issue 147).
  const verdicts = await mapBounded(candidates, BLOCKER_READS_IN_FLIGHT, async (issue) => ({
    issue,
    unblocked: await hasNoOpenBlocker(port, issue.ref),
  }));
  const pool: PoolEntry[] = [];
  for (const { issue, unblocked } of verdicts) {
    if (!unblocked) continue;
    pool.push({ ref: issue.ref, title: issue.title, createdAt: issue.createdAt });
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
    const issue = byKey.get(key);
    if (issue === undefined) continue;
    if (hasAnyFactoryLabel(issue, labels)) continue;
    unmarkedReservations.push({ ref: issue.ref });
  }

  return {
    pool: pool.sort(comparePoolEntries),
    unbackedClaims: unbackedClaims.sort(compareLeftoverRefs),
    unmarkedReservations: unmarkedReservations.sort(compareLeftoverRefs),
  };
}

/** The report line `msf status` and the sweep log share — the derivation never acts. */
export function renderUnbackedClaim(claim: UnbackedClaim): string {
  return (
    `unbacked claim: ${workKey(claim.ref)} — a factory mark on an open issue with no reservation in this workspace ` +
    `(${UNBACKED_CLAIM_CAVEAT}); return it to the pool with: ${claim.command}`
  );
}

/** The fact-only line: an unmarked reservation has no safe command. */
export function renderUnmarkedReservation(reservation: UnmarkedReservation): string {
  return (
    `unmarked reservation: ${workKey(reservation.ref)} — the work dir exists but the tracker carries no factory mark ` +
    "(no claim, no block, no pool label); the decision is human, nothing was touched"
  );
}

function comparePoolEntries(a: PoolEntry, b: PoolEntry): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.ref.repo.localeCompare(b.ref.repo) ||
    a.ref.number - b.ref.number
  );
}

function compareLeftoverRefs(a: { ref: IssueRef }, b: { ref: IssueRef }): number {
  return a.ref.repo.localeCompare(b.ref.repo) || a.ref.number - b.ref.number;
}

const hasAnyLabel = (issue: OpenIssue, candidates: readonly string[]): boolean =>
  candidates.some((label) => issue.labels.includes(label));

/** The claim mark that makes a tracker entry a reservation: claim or block. */
function hasClaimMark(issue: OpenIssue, labels: Labels): boolean {
  return hasAnyLabel(issue, [labels.claimed, labels.blocked]);
}

/** Any of the three factory labels — the pool label alone still marks a work. */
function hasAnyFactoryLabel(issue: OpenIssue, labels: Labels): boolean {
  return hasAnyLabel(issue, [labels.ready, labels.claimed, labels.blocked]);
}

/** The copy-paste command that returns an unbacked claim to the pool: add the
 *  pool label when missing, drop the factory mark(s) present, release the
 *  assignee(s) — an assigned work is never eligible. */
function releaseCommand(issue: OpenIssue, labels: Labels): string {
  const parts = [`gh issue edit ${issue.ref.number}`, `--repo ${issue.ref.repo}`];
  if (!issue.labels.includes(labels.ready)) parts.push(`--add-label ${labels.ready}`);
  if (issue.labels.includes(labels.claimed)) parts.push(`--remove-label ${labels.claimed}`);
  if (issue.labels.includes(labels.blocked)) parts.push(`--remove-label ${labels.blocked}`);
  for (const assignee of issue.assignees) parts.push(`--remove-assignee ${assignee}`);
  return parts.join(" ");
}

/** The pool's label rules, over the neutral read — never in the adapter. An
 *  assigned issue is claimed by decoration; a linked PR is already in the PR
 *  channel (ticket 12). */
function isEligible(issue: OpenIssue, labels: Labels): boolean {
  if (!issue.labels.includes(labels.ready)) return false;
  if (issue.labels.includes(labels.claimed)) return false;
  // Blocked works listen to the issue channel, never to the pool (ticket 14).
  if (issue.labels.includes(labels.blocked)) return false;
  if (issue.assignees.length > 0) return false;
  if (issue.hasOpenPr) return false;
  return true;
}

/** Native blockers must all be terminal — unknown is never "without impediment". */
async function hasNoOpenBlocker(port: TrackerPort, ref: IssueRef): Promise<boolean> {
  const blockers = await port.readBlockers(ref);
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
export function repairSignature(ref: IssueRef, trigger: RepairTrigger): string {
  return repairEvidenceSignature({
    ref,
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
  /**
   * Confirmed impediments of the open PR (conflicts with the current base or
   * required checks concluded with failure/timeout) reactivate the worker in
   * ONE round (issue 107) — the repair budget permits it. Same branch, same PR.
   * `resuming` is the unpublished attempt this round takes over (issue 112):
   * its local commits, changes and interrupted operation are inspected
   * before continuing — never redone from scratch.
   */
  | {
      ref: IssueRef;
      state: "repair";
      pr: PullRequest;
      createdAt: string;
      trigger: RepairTrigger;
      resuming: RepairAttempt | null;
    }
  /** The PR is confirmed clean (no conflicts, every required check approved):
   *  the repair budget resets (issue 107 story 22). */
  | { ref: IssueRef; state: "repair-recovered"; pr: PullRequest }
  /** A confirmed trigger after the two automatic rounds: block and ask help. */
  | {
      ref: IssueRef;
      state: "repair-blocked";
      pr: PullRequest;
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
  | { ref: IssueRef; state: "repair-fall-blocked"; pr: PullRequest; comment: string; attempt: number }
  /** Human answer on the issue after the marker: the retomada continues from
   * the existing branch — the sweep swaps blocked→claimed before the launch.
   * Only replies after the last agent marker become worker context. */
  | {
      ref: IssueRef;
      state: "resumable";
      pr: PullRequest | null;
      createdAt: string;
      issueReplies: IssueComment[];
    }
  /** Parked, nothing to decide: waiting for the human (PR open, worker last;
   * blocked without answer) — or a released work the pool owns. */
  | { ref: IssueRef; state: "idle" }
  /** A written failure the factory did not rule yet (it died between the
   *  record and the transition): release, or block on the 2nd consecutive
   *  failure — the ruler applies as at collection (ticket 05 Q3). */
  | { ref: IssueRef; state: "fall"; decision: "release"; attempt: number }
  | { ref: IssueRef; state: "fall"; decision: "block"; comment: string; attempt: number }
  /** An INTERRUPTION (issue 123): the claimed work's attempt ended without an
   *  outcome record (a dead factory, worker or container). It is not a
   *  failure: the same attempt is recovered within the persisted budget, or
   *  the exhausted budget pauses the work and asks the operator for help. A
   *  requested stop is persisted as itself and is never read here. */
  | { ref: IssueRef; state: "interrupted"; attempt: number; recovery: RecoveryDecision }
  /** A MODEL PROVIDER FAILURE (issue 144): the attempt's stream ended in a
   *  model provider error, so it retries on its own budget instead of the
   *  interruption's — or awaits the operator when that budget is exhausted
   *  (never a block). */
  | {
      ref: IssueRef;
      state: "model-provider-failure";
      attempt: number;
      failure: ModelProviderFailure;
      modelProvider: ModelProviderDecision;
    }
  /** The attempt ended by the operator's REQUESTED stop (issue #146): the same
   *  attempt resumes on the next run, spending no recovery — a requested stop
   *  is a lifecycle condition, never a fall or an interruption. */
  | { ref: IssueRef; state: "stop-resume"; attempt: number }
  /** The requested stop could not be confirmed (issue #146): the previous
   *  worker may still be alive, so the work is held with the reason until a
   *  later probe proves it gone. */
  | { ref: IssueRef; state: "stop-unconfirmed"; attempt: number; because: string }
  /** The work waits for the operator because its interrupted attempt cannot be
   *  continued safely (issue 119): its session is missing/unreadable, its
   *  identity does not match, or an external effect stayed ambiguous. The
   *  pause is persisted, so no cycle re-attempts the recovery. */
  | { ref: IssueRef; state: "continuity-paused"; attempt: number; pause: PauseRecord }
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
  workspace: WorkspaceLayout,
  recovery: RecoveryBudget,
  modelProvider: ModelProviderBudget,
  inFlight?: ReadonlySet<string>,
): Promise<ReservedDerivation[]> {
  return Promise.all(
    reserved.map((work) =>
      deriveReservedWork(port, work, labels, workerAccount, workspace, recovery, modelProvider, inFlight),
    ),
  );
}

async function deriveReservedWork(
  port: TrackerPort,
  work: ReservedWorkInput,
  labels: Labels,
  _workerAccount: string,
  workspace: WorkspaceLayout,
  recovery: RecoveryBudget,
  modelProvider: ModelProviderBudget,
  inFlight?: ReadonlySet<string>,
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
    const issueReplies = comments.known ? humanCommentsAfterLastMarker(comments.value) : [];
    if (issueReplies.length > 0) {
      // A pending reconciliation outranks the human answer (issue 112, story
      // 21): the remote may already carry this attempt's commit, so starting a
      // worker would duplicate it — and the resume renews a budget the
      // reconciliation has not settled yet. The answer survives and applies as
      // soon as the next sweep gets its verdict; until then this hold is what
      // status shows.
      const cycle = await readRepairCycle(work.dir);
      if (cycle.attempt !== null && hasPendingReconciliation(cycle.attempt)) {
        return { ref, state: "idle" };
      }
      return resumableState(port, ref, issue.value.createdAt, issueReplies);
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

    // The repair channel (issue 107): only CONFIRMED facts of the CURRENT head
    // trigger — conflicts with the current base, or required checks concluded
    // with failure/timeout. Unknown mergeability and pending/optional checks
    // never do, and the Block above already won over all of it.
    const repairFacts = await port.readPrRepairFacts(ref);
    const trigger = repairFacts.known ? repairTrigger(repairFacts.value) : null;
    const cycle = await readRepairCycle(work.dir);
    const attempt = cycle.attempt;

    // The attempt's own state comes before the trigger and the evidence
    // consumption (issue 112): two consecutive falls and an unattributable
    // remote change block the work EVEN with the PR open and even when the
    // tracker's current facts are not confirmed — the open PR never hides a
    // fall. An attempt that fell without publishing is taken over instead of
    // being mistaken for a consumed round.
    if (attempt !== null && cycle.consecutiveFalls >= MAX_REPAIR_FALLS) {
      return repairFallBlocked(ref, pr, cycle, work.dir, workspace, attempt, "consecutive-falls");
    }
    if (attempt?.publication === "concurrent-change") {
      return repairFallBlocked(ref, pr, cycle, work.dir, workspace, attempt, "concurrent-change");
    }
    if (attempt !== null && hasPendingReconciliation(attempt)) {
      // Pending reconciliation: NO worker of any kind (repair, resumption or
      // feedback round) and no budget return until the remote or the host
      // answers — a later sweep repeats the query (the reconciliation owns the
      // transition). Placed before the trigger so an unconfirmed PR fact
      // cannot open a session while the reconciliation is pending.
      return { ref, state: "idle" };
    }

    if (trigger !== null) {
      const signature = repairSignature(ref, trigger);
      // A resumption takes over the attempt whose evidence is still the one
      // this head presents (issue 112): a fall on OLDER evidence is history,
      // and the current head gets a round of its own, pinned to its own head.
      if (
        attempt !== null &&
        attempt.publication === "not-published" &&
        attempt.evidence === signature
      ) {
        return {
          ref,
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
          return repairBlocked(ref, pr, trigger, cycle.usedRounds);
        }
        return { ref, state: "idle" };
      }
      if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) {
        return repairBlocked(ref, pr, trigger, cycle.usedRounds);
      }
      return {
        ref,
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
      return { ref, state: "repair-recovered", pr };
    }

    const last = lastPrComment(feedback.known ? feedback.value : null);
    // Speech, not login (v0.1): the worker account may be the operator's.
    // A closing comment carries the marker; a comment without it is the human.
    if (last !== null && !isAgentSpeech(last.body)) {
      return { ref, state: "feedback", pr, createdAt: issue.value.createdAt };
    }
    // The worker just opened the PR (or ended the round commenting on it):
    // the ball is with the human — parked, nothing to decide.
    return { ref, state: "idle" };
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
    const cycle = await readRepairCycle(work.dir);
    if (cycle.attempt !== null && hasPendingReconciliation(cycle.attempt)) {
      return { ref, state: "idle" };
    }
    const unreconciled = await deriveUnreconciledAttempt(ref, work.dir, workspace, recovery, inFlight);
    // Only an interruption can be a model provider failure: the attempt's own
    // stream decides it (issue 144) — a written outcome or a bare reservation
    // never reads the model provider ledger.
    if (unreconciled.state === "interrupted") {
      const providerFailure = await deriveModelProviderFailure(
        port,
        {
          ref,
          dir: work.dir,
          attempt: unreconciled.attempt,
          createdAt: issue.value.createdAt,
        },
        modelProvider,
      );
      if (providerFailure !== null) return providerFailure;
    }
    return unreconciled;
  }
  return { ref, state: "idle" };
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
  ref: IssueRef,
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
    return { ref, state: "idle" };
  }
  if (ownWrittenOutcome(record, ledger.lastAttempt) !== null) {
    return deriveUnreconciledFailure(ref, dir, workspace, ledger.lastAttempt, record);
  }

  // The persisted stop of THIS attempt (issue #146): it says the operator
  // ended the attempt deliberately, so it is neither an interruption to charge
  // nor a failure to rule. An unconfirmed stop holds the work.
  const ledgered = await readRecoveryLedger(dir);
  const stop = ledgered.lastStop;
  if (stop !== null && stop.attempt === current) {
    if (stop.kind === "stop-requested") return { ref, state: "stop-resume", attempt: current };
    if (stop.kind === "stop-unconfirmed") {
      return { ref, state: "stop-unconfirmed", attempt: current, because: stop.because };
    }
  }

  if (ledger.lastAttempt === 0) {
    if (inFlight?.has(workKey(ref))) return { ref, state: "idle" };
    const pause = pausedAttempt(dir, 1);
    if (pause !== null) return { ref, state: "continuity-paused", attempt: 1, pause };
    return {
      ref,
      state: "interrupted",
      attempt: 1,
      recovery: await peekRecovery(dir, recovery, 1),
    };
  }

  const pause = pausedAttempt(dir, ledger.lastAttempt);
  if (pause !== null) return { ref, state: "continuity-paused", attempt: ledger.lastAttempt, pause };

  return {
    ref,
    state: "interrupted",
    attempt: ledger.lastAttempt,
    recovery: await peekRecovery(dir, recovery, ledger.lastAttempt),
  };
}

/** The persisted continuity pause of THIS attempt, if any (issue 119). A pause
 *  from an older attempt is history: the current attempt's facts decide. */
function pausedAttempt(dir: string, attempt: number): PauseRecord | null {
  const pause = readPause(dir);
  return pause !== null && pause.attempt === attempt ? pause : null;
}

/**
 * The model provider failure derivation of an INTERRUPTED attempt (issue 144),
 * or null when the attempt's stream carries no model provider error. One
 * retries on its own budget; exhausted, it awaits the operator — a help
 * request a human answer resumes.
 */
async function deriveModelProviderFailure(
  port: TrackerPort,
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
    const comments = await port.readComments(work.ref);
    const issueReplies = comments.known ? humanCommentsAfterLastMarker(comments.value) : [];
    if (issueReplies.length > 0) return resumableState(port, work.ref, work.createdAt, issueReplies);
  }
  return { ref: work.ref, state: "model-provider-failure", attempt: work.attempt, failure, modelProvider: decision };
}

/** The interrupted attempt the model provider decision reads: its work, dir, number
 *  and the issue's creation time (the retomada's priority fact). */
interface InterruptedAttempt {
  ref: IssueRef;
  dir: string;
  attempt: number;
  createdAt: string;
}

/** The retomada: a human answer after the marker resumes the work on its
 *  existing branch and PR — shared by the blocked channel and the awaiting
 *  model provider (issue 144), so their shape cannot drift apart. */
async function resumableState(
  port: TrackerPort,
  ref: IssueRef,
  createdAt: string,
  issueReplies: IssueComment[],
): Promise<ReservedDerivation> {
  const feedback = await port.readPrFeedback(ref);
  const pr = feedback.known ? feedback.value.pr : null;
  return { ref, state: "resumable", pr, createdAt, issueReplies };
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
  ref: IssueRef,
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
  if (!previousWasFall) return { ref, state: "fall", decision: "release", attempt };
  return {
    ref,
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
export function lastPrComment(feedback: PrFeedback | null): IssueComment | null {
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

/** The fallback-done comment: short, by decision (ticket 04 Q11). */
export function fallbackDoneComment(): string {
  return "the PR was merged without closing this issue — the factory closes it (done)";
}

/** The block after the two automatic repair rounds, naming what persists. */
function repairBlocked(
  ref: IssueRef,
  pr: PullRequest,
  trigger: RepairTrigger,
  usedRounds: number,
): ReservedDerivation {
  const comment =
    `automatic repair stopped after ${usedRounds} rounds without recovering PR #${pr.number}: ` +
    `${repairReasonsPhrase(trigger)} persist on the current HEAD. A human decision, authorization or fix is needed.`;
  return { ref, state: "repair-blocked", pr, trigger, usedRounds, comment };
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
  ref: IssueRef,
  pr: PullRequest,
  cycle: RepairCycle,
  dir: string,
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
  return { ref, state: "repair-fall-blocked", pr, comment, attempt: attempt.attempt };
}

/** The rejection comment: points at the PR (ticket 04 Q5). */
export function rejectionComment(pr: PullRequest): string {
  return (
    `work rejected: PR #${pr.number} (${pr.headBranch} → ${pr.baseBranch}) was closed without merging. ` +
    "The work is blocked and the branch stays — answer on this issue (after the marker) to resume from the existing branch."
  );
}
