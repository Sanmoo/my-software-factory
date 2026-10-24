import type { LocalWorkFacts } from "../git/port.js";
import type { Known, PrRepairFacts, RepairReason, RequiredCheckResult } from "../tracker/port.js";
import { workKeyOf } from "../pool/work-key.js";
import type { WorkIdentity } from "../tracker/identity.js";
import {
  MAX_REPAIR_FALLS,
  MAX_REPAIR_ROUNDS,
  hasPendingReconciliation,
  hasRepairCycle,
  isSettledPublication,
  repairEvidenceSignature,
  type RemoteObservation,
  type RepairAttempt,
  type RepairCycle,
  type RepairPremise,
  type RepairPublication,
} from "../pool/repair.js";

/**
 * One Repair round, from opening to settlement (issue #186; the policy is
 * issue 107/112/149, unchanged). This module owns the round's two gates and its
 * one verdict:
 *
 *  - {@link openRepairRound} — the derivation's decision: a confirmed trigger
 *    opens a round (with the unpublished attempt it resumes, when there is one),
 *    and a consumed evidence, a pending reconciliation or an exhausted budget
 *    returns/holds it. The trigger stays the derivation's INPUT: this module
 *    decides what the round is, never which works exist.
 *  - {@link confirmRepairRound} — the launch's gate, reading the premise a
 *    second time before the round spends work: a confirmed premise pins the head
 *    the round is leased on, an obsolete one returns the round, and an
 *    unconfirmed or moved remote holds it.
 *  - {@link settleRepairRound} — the settlement of an unfinished round from the
 *    observations alone (remote head, local work, premise): published, fell,
 *    pending, concurrent change or obsolete premise.
 *
 * The premise is read through ONE protocol ({@link readRepairPremise}) with one
 * verdict, so the derivation and the settlement can never hold two opinions
 * about the same PR facts (issue #181's home). The ledger and the budget stay in
 * the pool (pool/repair.ts): this module decides, the pool persists.
 */

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
export function repairTriggerOf(facts: PrRepairFacts): RepairTrigger | null {
  const reasons: RepairReason[] = [];
  if (facts.mergeState === "conflicting") reasons.push("conflicts");
  const failingChecks = (facts.requiredChecks ?? []).filter(isFailingRequiredCheck);
  if (failingChecks.length > 0) reasons.push("required-checks");
  if (reasons.length === 0) return null;
  return { reasons, facts, failingChecks };
}

/** A premise reading: `persisting` always carries the trigger it presents. */
export type RepairPremiseReading =
  | { premise: "persisting"; trigger: RepairTrigger }
  | { premise: "obsolete" }
  | { premise: "unknown" };

/**
 * The premise of a repair round read from the PR's current facts (issue 149):
 * a confirmed trigger persists; only a mergeable PR with a known required set is
 * obsolete (an unknown mergeability, or an undetermined required set, proves
 * nothing); an unreadable read is unknown, never an invented clean bill.
 */
export function readRepairPremise(facts: Known<PrRepairFacts>): RepairPremiseReading {
  if (!facts.known) return { premise: "unknown" };
  const trigger = repairTriggerOf(facts.value);
  if (trigger !== null) return { premise: "persisting", trigger };
  if (facts.value.mergeState !== "mergeable") return { premise: "unknown" };
  if (facts.value.requiredChecks === null) return { premise: "unknown" };
  return { premise: "obsolete" };
}

/** Confirmed recovery (story 22): no conflicts and every required check
 *  approved — narrower than an obsolete premise, which also holds for pending,
 *  neutral or skipped checks. The required set must be KNOWN: the empty set a
 *  repository without CI declares is a confirmation (issue 149); null (unknown)
 *  is never one. */
function repairRecovered(facts: PrRepairFacts): boolean {
  if (facts.mergeState !== "mergeable") return false;
  const checks = facts.requiredChecks;
  if (checks === null) return false;
  return checks.every((check) => check.conclusion === "success");
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

/** The context a round opens with: the confirmed trigger, the unpublished
 *  attempt it takes over (when resuming) and the head it is pinned to — the
 *  lease value a concurrent change is judged against. */
export interface RepairRoundOpening {
  trigger: RepairTrigger;
  resuming: RepairAttempt | null;
  pinnedHeadSha: string;
  /** The PR's current base — a repair targets it, never the repo default. */
  baseBranch: string;
}

/** What the derivation decided about the repair channel of one work. */
export type RepairRoundVerdict =
  /** A round opens: the worker is reactivated on the same branch and PR. */
  | { kind: "open"; round: RepairRoundOpening }
  /** Nothing to open now: the evidence was already consumed, or the previous
   *  round's publication is still being reconciled. The work stays parked. */
  | { kind: "wait"; because: "evidence-consumed" | "pending-reconciliation" }
  /** The budget is spent: a human decision is needed. */
  | { kind: "block"; trigger: RepairTrigger; usedRounds: number }
  /** The round's own ledger already stopped the work: two falls, or a remote
   *  change the attempt did not produce. */
  | { kind: "fall-blocked"; attempt: RepairAttempt; because: "consecutive-falls" | "concurrent-change" }
  /** The PR is confirmed clean: the repair budget resets. */
  | { kind: "recovered" }
  /** The repair channel does not apply to this work. */
  | { kind: "none" };

/**
 * Decide the repair channel of one work from the derivation's inputs (issue
 * 107/112/149): the trigger of the current head, the persisted cycle and the
 * PR's facts. The order is the policy's: the attempt's own state comes before
 * the trigger and the evidence consumption — an open PR never hides a fall — and
 * a pending reconciliation forbids any worker and any budget return until the
 * remote or the host answers.
 */
export function openRepairRound(input: {
  work: WorkIdentity;
  trigger: RepairTrigger | null;
  facts: Known<PrRepairFacts>;
  cycle: RepairCycle;
}): RepairRoundVerdict {
  const { work, trigger, cycle } = input;
  const attempt = cycle.attempt;

  if (attempt !== null && cycle.consecutiveFalls >= MAX_REPAIR_FALLS) {
    return { kind: "fall-blocked", attempt, because: "consecutive-falls" };
  }
  if (attempt?.publication === "concurrent-change") {
    return { kind: "fall-blocked", attempt, because: "concurrent-change" };
  }
  if (attempt !== null && hasPendingReconciliation(attempt)) {
    return { kind: "wait", because: "pending-reconciliation" };
  }

  if (trigger !== null) {
    const signature = repairSignature(work, trigger);
    // A resumption takes over the attempt whose evidence is still the one this
    // head presents (issue 112): a fall on OLDER evidence is history, and the
    // current head gets a round of its own, pinned to its own head. It comes
    // before the cap because taking over an attempt is not paying a round.
    const resuming =
      attempt !== null && attempt.publication === "not-published" && attempt.evidence === signature
        ? attempt
        : null;
    if (resuming !== null) return { kind: "open", round: repairOpening(trigger, resuming) };
    // The exhausted cap blocks whatever the evidence says: the same failure is
    // never a new session, and a new one cannot be paid for.
    if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) {
      return { kind: "block", trigger, usedRounds: cycle.usedRounds };
    }
    if (cycle.lastEvidence === signature) return { kind: "wait", because: "evidence-consumed" };
    return { kind: "open", round: repairOpening(trigger, null) };
  }

  // Confirmed recovery (story 22): no conflicts and every required check
  // approved — the only thing besides a human unblock that resets the cap. The
  // gate is "this work has a repair cycle", not "a round is charged": after a
  // fall the charged round was returned, and the fall ledger it left behind is
  // exactly what recovery must clear (issue 112, story 25).
  if (input.facts.known && hasRepairCycle(cycle) && repairRecovered(input.facts.value)) {
    return { kind: "recovered" };
  }
  return { kind: "none" };
}

/** The opening a trigger buys: the round's lease value and base, pinned to the
 *  head the evidence was read on (a resumption keeps its fallen attempt's head). */
export function repairOpening(trigger: RepairTrigger, resuming: RepairAttempt | null): RepairRoundOpening {
  return {
    trigger,
    resuming,
    // A resumption keeps the head its fallen attempt was launched on: moving it
    // would publish the fallen attempt's local history over a concurrent one.
    pinnedHeadSha: resuming?.observedHeadSha ?? trigger.facts.headSha,
    baseBranch: trigger.facts.baseBranch,
  };
}

/** What the launch decided about a round the derivation opened. */
export type RepairLaunchVerdict =
  /** The premise is confirmed and the remote is where the round was pinned: go. */
  | { kind: "launch"; round: RepairRoundOpening }
  /** The impediment is gone (or unconfirmed): no round is spent. */
  | { kind: "return"; because: "premise-obsolete" | "premise-unconfirmed" }
  /** The remote could not be read, or it moved: nothing is launched. */
  | { kind: "hold"; because: "remote-unreadable" }
  | {
      kind: "hold";
      because: "remote-moved";
      /** The head the remote holds now — null means it holds no such branch. */
      remoteHeadSha: string | null;
      /** A resumption the moved remote settles as the concurrent change it is. */
      concurrent?: { attempt: RepairAttempt };
    };

/**
 * The second gate of a round (issue 149): the facts are re-read before the round
 * spends work, so only a confirmed premise buys a session. A FRESH round follows
 * the facts as they read now — when the head moved while the impediment
 * persists, the evidence was recalculated and the round opens (and is charged)
 * on the current head. A resumption keeps its observed head.
 */
export function confirmRepairRound(input: {
  round: RepairRoundOpening;
  reading: RepairPremiseReading;
  remote: RemoteObservation;
}): RepairLaunchVerdict {
  const { round, reading, remote } = input;
  if (reading.premise !== "persisting") {
    return {
      kind: "return",
      because: reading.premise === "obsolete" ? "premise-obsolete" : "premise-unconfirmed",
    };
  }
  const confirmed = reading.trigger;
  const pinned: RepairRoundOpening = {
    ...round,
    // The base is always the one the confirmed facts name: a repair targets the
    // PR's current base, never the one a previous read saw.
    baseBranch: confirmed.facts.baseBranch,
    ...(round.resuming === null
      ? { trigger: confirmed, pinnedHeadSha: confirmed.facts.headSha }
      : {}),
  };
  if (!remote.known) return { kind: "hold", because: "remote-unreadable" };
  if (remote.headSha !== pinned.pinnedHeadSha) {
    return {
      kind: "hold",
      because: "remote-moved",
      remoteHeadSha: remote.headSha,
      ...(round.resuming === null ? {} : { concurrent: { attempt: round.resuming } }),
    };
  }
  return { kind: "launch", round: pinned };
}

/** The reconciliation of one attempt: what the settlement concluded and the
 *  cycle it persists. */
export type RepairSettlement =
  /** Nothing to reconcile: no attempt, or one already settled. */
  | { kind: "none" }
  | { kind: "pending"; reason: string; cycle: RepairCycle }
  | { kind: "published"; cycle: RepairCycle; attempt: RepairAttempt }
  | { kind: "not-published"; cycle: RepairCycle; attempt: RepairAttempt }
  /** The impediment the round was launched for no longer exists (issue 149):
   *  the round returns, and no fall is counted — there is nothing left to fix,
   *  so the remote is still never overwritten. */
  | { kind: "premise-obsolete"; cycle: RepairCycle; attempt: RepairAttempt }
  | { kind: "concurrent-change"; cycle: RepairCycle; attempt: RepairAttempt };

/** The observations a settlement decides on — read by the caller (git, the
 *  tracker, the record), fed to the verdict directly so the distinction between
 *  an obsolete premise and a concurrent change is deterministic. */
export interface RepairObservations {
  remote: RemoteObservation;
  localWork: LocalWorkFacts | null;
  premise: RepairPremise;
}

/**
 * Decide the publication of the cycle's attempt from the observations alone
 * (issue 112/149): the produced commit (the work branch on disk) against the
 * remote head, with the head observed before the intervention as the anchor. An
 * unreadable remote, local state or premise is "pending" — never "not
 * published", never "published", and it neither returns budget nor allows a new
 * worker. A published round is charged exactly once (it was charged at launch,
 * so the settlement only records the verdict); an attempt that fell without
 * publishing returns its round and counts as one more consecutive fall — unless
 * the premise itself is gone (issue 149): then the round returns with no fall,
 * and the work is never blamed for a fault that no longer exists.
 */
export function settleRepairRound(cycle: RepairCycle, observations: RepairObservations): RepairSettlement {
  const attempt = cycle.attempt;
  if (attempt === null) return { kind: "none" };
  if (isSettledPublication(attempt.publication)) return { kind: "none" };

  // The host's inspection is the only source: falling back to the facts recorded
  // at launch would read a pre-session branch as the attempt's result and turn an
  // unreadable host into a concurrent-change verdict.
  if (!observations.remote.known) {
    return {
      kind: "pending",
      reason: "the remote head could not be read",
      cycle: settleAttempt(cycle, attempt, "pending", observations.localWork).cycle,
    };
  }
  const remoteHeadSha = observations.remote.headSha;
  const localWork = observations.localWork;
  if (localWork === null) {
    return {
      kind: "pending",
      reason: "the local work could not be read",
      cycle: settleAttempt(cycle, attempt, "pending", null, remoteHeadSha).cycle,
    };
  }

  const produced = localWork.headSha;
  // One settlement of the current attempt; the ledgers are the caller's.
  const settled = (
    publication: RepairPublication,
    next: RepairCycle,
  ): { cycle: RepairCycle; attempt: RepairAttempt } =>
    settleAttempt(next, attempt, publication, localWork, remoteHeadSha);
  /** The round returns: the charge is refunded and the attempt settles as
   *  "nothing of it reached the remote". Counting a fall is the caller's
   *  business — an attempt that fell counts one, an obsolete premise does not
   *  (issue 149). */
  const settledUnpublished = (next: RepairCycle): { cycle: RepairCycle; attempt: RepairAttempt } =>
    settled("not-published", { ...next, usedRounds: Math.max(0, next.usedRounds - 1) });

  // The remote carries exactly the commit this attempt produced: published, and
  // attributable — a different head proves nothing about this attempt.
  if (produced !== null && remoteHeadSha === produced && produced !== attempt.observedHeadSha) {
    return { kind: "published", ...settled("published", { ...cycle, consecutiveFalls: 0 }) };
  }

  // The premise vanished while the round ran (issue 149): the obstacle it was
  // reopened for is gone, so the round returns without counting a fall — the
  // remote (whoever moved it) is still never overwritten. Only a confirmed
  // absence reaches here; an unknown one keeps the verdicts below.
  if (observations.premise === "obsolete") {
    return { kind: "premise-obsolete", ...settledUnpublished(cycle) };
  }

  // The remote is still where it was, or holds no such branch: nothing of this
  // attempt was published. The charged round returns and the fall is counted.
  if (remoteHeadSha === null || remoteHeadSha === attempt.observedHeadSha) {
    return {
      kind: "not-published",
      ...settledUnpublished({ ...cycle, consecutiveFalls: cycle.consecutiveFalls + 1 }),
    };
  }

  // Somebody else moved the remote. The verdict needs the premise: a confirmed
  // impediment keeps the concurrent change a human question, while an unreadable
  // one is HELD — uncertainty is never turned into a help request for work that
  // may already be delivered (issue 149).
  if (observations.premise === "unknown") {
    return {
      kind: "pending",
      reason: "the impediment the round addressed could not be re-read",
      cycle: settleAttempt(cycle, attempt, "pending", localWork).cycle,
    };
  }

  // Somebody else moved the remote: preserve the local work, ask a human.
  return { kind: "concurrent-change", ...settled("concurrent-change", cycle) };
}

/** Persist one verdict on the attempt, keeping the round/fall ledgers as given.
 *  An unobserved remote head (a failed query) keeps the last known one. */
function settleAttempt(
  cycle: RepairCycle,
  attempt: RepairAttempt,
  publication: RepairPublication,
  localWork: LocalWorkFacts | null,
  remoteHeadSha: string | null = attempt.remoteHeadSha,
): { cycle: RepairCycle; attempt: RepairAttempt } {
  const settled: RepairAttempt = { ...attempt, publication, localWork, remoteHeadSha };
  return { cycle: { ...cycle, attempt: settled }, attempt: settled };
}

/**
 * The facts that say a repair round never reached the runtime: no event log of
 * the attempt, an intact journal with no session for it, and no outcome record of
 * its own. A round that never started is not a fall (issue 181's home): it is
 * returned with no count.
 */
export interface UnstartedRoundEvidence {
  /** The attempt's own event log exists (the runtime was reached). */
  hasEventLog: boolean;
  /** The effect journal is readable (an unreadable one proves nothing). */
  journalIntact: boolean;
  /** The journal carries a session start for the attempt. */
  journalHasSession: boolean;
  /** The attempt wrote its own outcome record. */
  hasOwnOutcome: boolean;
}

/** A round that never reached the runtime: its charge returns and nothing is
 *  counted. Returns null when the round may have started. */
export function returnUnstartedRound(cycle: RepairCycle, evidence: UnstartedRoundEvidence): RepairCycle | null {
  if (evidence.hasEventLog) return null;
  if (!evidence.journalIntact) return null;
  if (evidence.journalHasSession) return null;
  if (evidence.hasOwnOutcome) return null;
  return { ...cycle, usedRounds: Math.max(0, cycle.usedRounds - 1), lastEvidence: null, attempt: null };
}

/**
 * The remote moved to a head the attempt did not produce, after the round fell:
 * the attempt settles as the concurrent change it is, so the derivation asks the
 * human to reconcile both sides and nothing is published over it.
 */
export function settleConcurrentChange(
  cycle: RepairCycle,
  attempt: RepairAttempt,
  remoteHeadSha: string | null,
): RepairCycle {
  return { ...cycle, attempt: { ...attempt, publication: "concurrent-change", remoteHeadSha } };
}
