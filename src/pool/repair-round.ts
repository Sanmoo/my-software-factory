import type { LocalWorkFacts } from "../git/port.js";
import type { Known, PrRepairFacts } from "../tracker/port.js";
import { readRepairPremise, type RepairTrigger } from "../state/derive.js";
import { ownWrittenOutcome } from "../state/outcome.js";
import type { OutcomeRecord } from "../work-record/outcome.js";
import type { RepairAttempt, RepairCycle } from "../work-record/repair.js";
import {
  isSettledPublication,
  reconcileRepairAttempt,
  type RemoteObservation,
  type RepairReconciliation,
} from "./repair.js";

/**
 * The Repair round (issues 189 and 194): "open a round" re-reads the confirmed
 * premise ONCE at the opening point and returns either the launch context —
 * the trigger the session is opened with, the head the intervention is pinned
 * to, the PR's current base and the unpublished attempt it takes over — or a
 * verdict of return (the impediment is gone) or hold (the facts cannot confirm
 * it); "settle a non-finished round" decides what became of a recorded attempt
 * from direct observations of the record, the remote, the worktree and the
 * premise, and returns the verdict and the cycle to persist.
 *
 * The premise is the PR's current facts, never the ones that opened the round
 * (issue 149): a resolution pushed between the derivation and the launch must
 * not buy a session, and an unreadable fact is never taken for a confirmed
 * absence. A remote the host cannot read holds as well; a remote that moved
 * skips the round, and a resumption whose branch moved under it settles the
 * attempt as a concurrent change — its local work is preserved for the human,
 * never published over the collaborator's head.
 *
 * The settlement is not a sweep: it is handed the observations and does no
 * inspection of its own, so premise-obsolete, concurrent change, a round that
 * never started and the publication verdicts are exercised directly. The
 * publication decision itself is composed from pool/repair.ts; the ledger and
 * the round budget stay there. This module decides only what the opening
 * spends and what the settlement concludes, never how a verdict is recorded.
 */

/** The facts the opening is decided from: the confirmed premise of the
 *  derivation and the attempt this round would take over. */
export interface RepairOpeningInput {
  /** The confirmed impediment the derivation opened the round for. */
  trigger: RepairTrigger;
  /** The unpublished attempt this opening takes over (issue 112), or null. */
  resuming: RepairAttempt | null;
  /** Re-read the PR's facts now — called exactly once, at opening. */
  readPremise: () => Promise<Known<PrRepairFacts>>;
  /** The remote head now; an unreadable remote is uncertainty, never absence. */
  observeRemote: () => Promise<RemoteObservation>;
}

/** What a session is launched with (issue 112): the confirmed trigger, the
 *  head the intervention is pinned to, the PR's current base and the attempt
 *  it resumes. The local work is read by the caller once the round goes out. */
export interface RepairRoundContext {
  trigger: RepairTrigger;
  /** The remote head the intervention observed — the force-with-lease value. */
  pinnedHeadSha: string;
  /** The PR's current base branch, never the repository default. */
  baseBranch: string;
  resuming: RepairAttempt | null;
}

/** The opening's verdict: a context to launch, or why no worker is launched. */
export type RepairOpening =
  | { kind: "opened"; context: RepairRoundContext }
  /** The impediment is gone: the round returns and no fall is counted. */
  | { kind: "returned"; premise: "obsolete" }
  /** The facts cannot confirm anything: nothing is spent, the next sweep
   *  re-derives. */
  | { kind: "held"; because: "premise-unknown" | "remote-unreadable" }
  /** The remote head is not the pinned one: nothing is launched. A resumption
   *  carries the attempt settled as `concurrent-change`, ready to persist. */
  | {
      kind: "skipped";
      observedHeadSha: string | null;
      pinnedHeadSha: string;
      concurrentChange: RepairAttempt | null;
    };

export async function openRepairRound(input: RepairOpeningInput): Promise<RepairOpening> {
  // The derivation's trigger is the input; this is the single opening re-read (issue 149).
  const reading = readRepairPremise(await input.readPremise());
  if (reading.premise === "obsolete") return { kind: "returned", premise: "obsolete" };
  if (reading.premise === "unknown") return { kind: "held", because: "premise-unknown" };

  // A fresh round follows the facts as they read now, so a head that moved
  // while the impediment persists is pinned and charged on its own evidence. A
  // resumption keeps the head its fallen attempt observed: moving it would
  // publish that attempt's local history over a concurrent one.
  const trigger = input.resuming === null ? reading.trigger : input.trigger;
  const pinnedHeadSha =
    input.resuming === null ? reading.trigger.facts.headSha : input.resuming.observedHeadSha;

  const observed = await input.observeRemote();
  if (!observed.known) return { kind: "held", because: "remote-unreadable" };
  if (observed.headSha !== pinnedHeadSha) {
    return {
      kind: "skipped",
      observedHeadSha: observed.headSha,
      pinnedHeadSha,
      concurrentChange:
        input.resuming === null
          ? null
          : { ...input.resuming, publication: "concurrent-change", remoteHeadSha: observed.headSha },
    };
  }

  return {
    kind: "opened",
    context: {
      trigger,
      pinnedHeadSha,
      baseBranch: reading.trigger.facts.baseBranch,
      resuming: input.resuming,
    },
  };
}

/**
 * Whether a round with a recorded attempt ever reached the runtime. The
 * attempt's own event log is the direct proof; when it is absent, the
 * guardrail's journaled session is the remaining fact — and an unreadable
 * journal proves nothing either way.
 */
export type RepairRoundStart =
  | { reached: true }
  | { reached: false; journalIntact: boolean; journaledAttempts: readonly number[] };

/**
 * The facts a settlement is decided from: the persisted cycle and the direct
 * observations of the record, the remote, the local worktree and the premise.
 */
export interface RepairSettlementInput {
  /** The cycle read from the record, with the attempt to settle — a legacy
   *  cycle already adopted into one. */
  cycle: RepairCycle;
  /** The operator's requested stop owns the attempt's end: until the attempt
   *  writes its own outcome, the same Repair is stopped, not finished. */
  operatorStopped: boolean;
  /** Whether the round ever reached the runtime. An adopted legacy cycle
   *  reports `reached: true`: the adoption itself is the evidence that an
   *  attempt ran (#181 owns re-deciding it from the artifacts). */
  observeRoundStart: () => Promise<RepairRoundStart>;
  /** The Work's outcome record on disk — another attempt's is not this one's. */
  readOutcomeRecord: () => Promise<OutcomeRecord | null>;
  /** The remote head now; an unreadable remote is uncertainty, never absence. */
  observeRemote: () => Promise<RemoteObservation>;
  /** The work branch on disk; null when git cannot answer. */
  inspectLocalWork: () => Promise<LocalWorkFacts | null>;
  /** The PR's facts re-read now, not the ones the round was launched on. */
  readPremise: () => Promise<Known<PrRepairFacts>>;
}

/**
 * The settlement of one non-finished round: the verdict and the cycle it
 * persists. The publication verdicts are the reconciliation of pool/repair.ts
 * composed with the round-start fact; `returned-unstarted` is this module's own
 * verdict for a round no worker ever saw.
 */
export type RepairSettlement =
  /** Nothing to settle: no attempt, one already settled, or one whose
   *  operator stop has not written its own outcome yet. */
  | { kind: "none" }
  /** The round never reached the runtime: the charge returns and no fall is
   *  counted. The attempt leaves the cycle; `attempt` names it for the log. */
  | { kind: "returned-unstarted"; cycle: RepairCycle; attempt: RepairAttempt }
  /** The publication reconciliation of the attempt (pool/repair.ts). */
  | Exclude<RepairReconciliation, { kind: "none" }>;

/**
 * Decide what became of the round's recorded attempt from the observations;
 * nothing is inspected and nothing is written here — the cycle in the verdict
 * is what the caller persists.
 */
export async function settleRepairRound(input: RepairSettlementInput): Promise<RepairSettlement> {
  const attempt = input.cycle.attempt;
  if (attempt === null) return { kind: "none" };
  if (isSettledPublication(attempt.publication)) return { kind: "none" };

  if (input.operatorStopped) {
    const record = await input.readOutcomeRecord();
    if (ownWrittenOutcome(record, attempt.attempt) === null) return { kind: "none" };
  } else if (attempt.publication === "unknown") {
    // A round with no runtime footprint is not an attempt — the home issue
    // 181's fix lands in. The event log, the guardrail's session and the
    // outcome record are the only facts that can prove it started. A record
    // for another attempt, an intact journal with no session of this one, and
    // no event log mean the charge returns and no fall is counted.
    const start = await input.observeRoundStart();
    if (!start.reached) {
      const record = await input.readOutcomeRecord();
      if (
        start.journalIntact &&
        !start.journaledAttempts.includes(attempt.attempt) &&
        record?.attempt !== attempt.attempt
      ) {
        return {
          kind: "returned-unstarted",
          attempt,
          cycle: {
            ...input.cycle,
            usedRounds: Math.max(0, input.cycle.usedRounds - 1),
            lastEvidence: null,
            attempt: null,
          },
        };
      }
    }
  }

  // The host's inspection is the only source of the produced commit; the
  // premise is the PR's facts re-read now, never the ones the round opened on.
  const localWork = await input.inspectLocalWork();
  const remote = await input.observeRemote();
  const premise = readRepairPremise(await input.readPremise()).premise;
  const decision = reconcileRepairAttempt({ cycle: input.cycle, remote, localWork, premise });
  // The cycle carries an unsettled attempt here, so the reconciliation has a
  // verdict; "none" can only answer an absent or settled attempt, checked above.
  return decision.kind === "none" ? { kind: "none" } : decision;
}
