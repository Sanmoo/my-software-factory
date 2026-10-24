import type { Known, PrRepairFacts } from "../tracker/port.js";
import { readRepairPremise, type RepairTrigger } from "../state/derive.js";
import type { RemoteObservation, RepairAttempt } from "./repair.js";

/**
 * The opening of a Repair round (issue 189): given the confirmed trigger the
 * derivation produced, the module re-reads the premise ONCE at the opening
 * point and either returns the launch context — the trigger the session is
 * opened with, the head the intervention is pinned to, the PR's current base
 * and the unpublished attempt it takes over — or a verdict of return (the
 * impediment is gone) or hold (the facts cannot confirm it).
 *
 * The premise is the PR's current facts, never the ones that opened the round
 * (issue 149): a resolution pushed between the derivation and the launch must
 * not buy a session, and an unreadable fact is never taken for a confirmed
 * absence. A remote the host cannot read holds as well; a remote that moved
 * skips the round, and a resumption whose branch moved under it settles the
 * attempt as a concurrent change — its local work is preserved for the human,
 * never published over the collaborator's head.
 *
 * The ledger and the round budget stay in pool/repair.ts: this module decides
 * only what the opening spends, never how a settlement is recorded.
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
