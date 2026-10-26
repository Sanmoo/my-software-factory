import type { WorkIdentity } from "../tracker/identity.js";
import type { Known, PrRepairFacts, RepairReason, RequiredCheckResult } from "../tracker/port.js";
import { repairEvidenceSignature } from "./repair.js";
import { workKeyOf } from "./work-key.js";

/**
 * The confirmed impediments of an open PR — the ONE definition of "this PR
 * needs Repair", and of the evidence signature that makes a round attributable.
 *
 * It has one owner because it had two: the Work state carried a copy of the
 * type and applied the same trigger policy as the derivation did, and the
 * launch pipeline hashed whichever copy reached it into the DURABLE repair
 * evidence. A divergence between the copies would have changed a persisted
 * signature across restarts, silently.
 *
 * The policy below is the whole of it — a conflicting PR, or a required check
 * that concluded with failure or timeout on the current head, and nothing else.
 * The vocabulary it feeds (`RepairReason`, the premise) stays in `pool/repair.ts`
 * and `pool/repair-round.ts`; this file reads the facts and answers them.
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
export function isFailingRequiredCheck(check: RequiredCheckResult): boolean {
  return check.status === "completed" && (check.conclusion === "failure" || check.conclusion === "timed_out");
}

/** The trigger of an open PR, or null when nothing is confirmed. */
export function confirmedRepairTrigger(facts: PrRepairFacts): RepairTrigger | null {
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

/** The premise of a repair round read from the PR's current facts:
 *  a confirmed trigger persists; only a mergeable PR with a known required set
 *  is obsolete (an unknown mergeability, or an undetermined required set,
 *  proves nothing); an unreadable read is unknown, never an invented clean
 *  bill. The vocabulary lives in pool/repair.ts. */
export function readRepairPremise(facts: Known<PrRepairFacts>): RepairPremiseReading {
  if (!facts.known) return { premise: "unknown" };
  const trigger = confirmedRepairTrigger(facts.value);
  if (trigger !== null) return { premise: "persisting", trigger };
  if (facts.value.mergeState !== "mergeable") return { premise: "unknown" };
  if (facts.value.requiredChecks === null) return { premise: "unknown" };
  return { premise: "obsolete" };
}
