import { type LocalWorkFacts } from "../git/port.js";
import type { RepairReason, RequiredCheckResult } from "../tracker/port.js";
import type { RepairAttempt, RepairCycle, RepairPublication } from "../work-record/repair.js";

/**
 * The durable repair cycle of a work: how many
 * automatic repair rounds were DELIVERED since the last confirmed recovery,
 * which evidence was already consumed, how many repair attempts ended without
 * publishing, and the structured facts of the attempt currently on disk. The
 * FILE and its schema are owned by the Work record
 * (trabalhos/<repo>#<n>/reparo.json); this module keeps the POLICY — the round
 * and fall caps, the evidence signature and the reconciliation of a round.
 *
 * The two ledgers are independent: the ROUND budget counts
 * published rounds (a fall before publishing is refunded, never a free retry
 * forever) and the FALL ledger counts consecutive unpublished attempts (two
 * block the work even with the PR open). The attempt facts are what make
 * publication attributable: the remote head observed before the intervention,
 * the evidence it addressed, and the commit the attempt produced on disk.
 */

/** The joint cap: conflicts and CI failures share the same two rounds. */
export const MAX_REPAIR_ROUNDS = 2;

/** Separate from the round budget on purpose: returning an undelivered round
 *  must never authorize an unbounded number of retries. */
export const MAX_REPAIR_FALLS = 2;

/**
 * The renewed reading of the premise that opened a repair round,
 * re-derived from the PR's current facts before the round spends work and
 * before the factory asks for help. `obsolete` means no confirmed impediment
 * remains — the PR is mergeable and the required set is KNOWN (the empty set
 * of a repository without CI is known); `persisting` means a confirmed
 * impediment is still there; `unknown` is an unreadable fact, and it is never
 * a licence to conclude either way.
 */
export type RepairPremise = "obsolete" | "persisting" | "unknown";

/** True when the attempt's publication is a terminal verdict — a settlement
 *  that must never be repeated (no double charge, refund or fall count). */
export function isSettledPublication(publication: RepairPublication): boolean {
  return (
    publication === "published" ||
    publication === "not-published" ||
    publication === "concurrent-change"
  );
}

/** True while the attempt's publication is unknown or pending: no worker of
 *  any kind may start and no budget may return until a sweep settles it. */
export function hasPendingReconciliation(attempt: RepairAttempt): boolean {
  return !isSettledPublication(attempt.publication);
}

/** The evidence that makes a trigger new: the Work it belongs to, the head it
 *  concerns and the exact failing checks. A different head, or a different
 *  failing check on the same head, is new evidence; the same failure is
 *  consumed. The first component is the registry Work key, so two Works of one
 *  repository never share a consumed signature. */
export function repairEvidenceSignature(input: {
  /** The registry key of the Work ("<repo>#<n>" for GitHub, the encoded Work key otherwise). */
  workKey: string;
  headSha: string;
  reasons: readonly RepairReason[];
  failingChecks: readonly RequiredCheckResult[];
}): string {
  const checks = input.failingChecks
    .map((check) => `${check.name}:${check.conclusion ?? "unknown"}`)
    .sort()
    .join(",");
  return [
    input.workKey,
    input.headSha,
    input.reasons.includes("conflicts") ? "conflicts" : "no-conflicts",
    checks,
  ].join("|");
}

/**
 * The observed head a signature was built on: component 2 of the signature
 * (Work key | headSha | reasons | checks). Legacy reparo.json files carry only
 * the signature, so this is how a state written in the older shape is
 * reconciled without metadata that did not exist when it was written. Null for
 * a signature of an unknown shape — never a guessed SHA.
 */
export function observedHeadShaOfSignature(signature: string): string | null {
  const parts = signature.split("|");
  if (parts.length < 2) return null;
  const headSha = parts[1] ?? "";
  return headSha === "" ? null : headSha;
}

/** What the remote says right now: a SHA, "no such branch" (null), or that it
 *  could not be asked — the third case is uncertainty, never absence. */
export type RemoteObservation = { known: true; headSha: string | null } | { known: false };

/**
 * The attempt a legacy cycle implies: a budget that was charged
 * and a registry attempt AFTER the last recorded outcome means a repair round
 * ran and fell before writing its own record. Its observed head comes from the
 * signature; its local work from the host. Nothing is charged or refunded
 * here — the reconciliation decides with the remote in hand.
 */
export function legacyRepairAttempt(input: {
  cycle: RepairCycle;
  lastAttempt: number;
  recordedAttempt: number | null;
}): RepairAttempt | null {
  const { cycle } = input;
  if (cycle.attempt !== null) return null;
  if (cycle.usedRounds === 0 || cycle.lastEvidence === null) return null;
  const headSha = observedHeadShaOfSignature(cycle.lastEvidence);
  if (headSha === null) return null;
  if (input.lastAttempt <= (input.recordedAttempt ?? 0)) return null;
  return {
    evidence: cycle.lastEvidence,
    attempt: input.lastAttempt,
    observedHeadSha: headSha,
    remoteHeadSha: null,
    publication: "unknown",
    localWork: null,
  };
}

/** The reconciliation of one attempt: what the sweep concluded and the cycle it persists. */
export type RepairReconciliation =
  /** Nothing to reconcile: no attempt, or one already settled. */
  | { kind: "none" }
  | { kind: "pending"; reason: string; cycle: RepairCycle }
  | { kind: "published"; cycle: RepairCycle; attempt: RepairAttempt }
  | { kind: "not-published"; cycle: RepairCycle; attempt: RepairAttempt }
  /** The impediment the round was launched for no longer exists:
   *  the round returns, and no fall is counted — there is nothing left to
   *  fix, so the remote is still never overwritten. */
  | { kind: "premise-obsolete"; cycle: RepairCycle; attempt: RepairAttempt }
  | { kind: "concurrent-change"; cycle: RepairCycle; attempt: RepairAttempt };

/**
 * Decide the publication of the cycle's attempt from structured facts alone:
 * the produced commit (the work branch on disk) against the
 * remote head, with the head observed before the intervention as the anchor.
 * An unreadable remote, local state or premise is "pending" — never "not
 * published", never "published", and it neither returns budget nor allows a
 * new worker. A published round is charged exactly once (it was charged at
 * launch, so the reconciliation only records the verdict); an attempt that fell
 * without publishing returns its round and counts as one more consecutive fall
 * — unless the premise itself is gone: then the round returns with
 * no fall, and the work is never blamed for a fault that no longer exists.
 */
export function reconcileRepairAttempt(input: {
  cycle: RepairCycle;
  remote: RemoteObservation;
  localWork: LocalWorkFacts | null;
  /** The PR's facts re-read now, not the ones the round was launched on. */
  premise: RepairPremise;
}): RepairReconciliation {
  const attempt = input.cycle.attempt;
  if (attempt === null) return { kind: "none" };
  if (isSettledPublication(attempt.publication)) return { kind: "none" };

  // The host's inspection is the only source: falling back to the facts
  // recorded at launch would read a pre-session branch as the attempt's result
  // and turn an unreadable host into a concurrent-change verdict.
  if (!input.remote.known) {
    return {
      kind: "pending",
      reason: "the remote head could not be read",
      cycle: settleAttempt(input.cycle, attempt, "pending", input.localWork).cycle,
    };
  }
  const remoteHeadSha = input.remote.headSha;
  const localWork = input.localWork;
  if (localWork === null) {
    return {
      kind: "pending",
      reason: "the local work could not be read",
      cycle: settleAttempt(input.cycle, attempt, "pending", null, remoteHeadSha).cycle,
    };
  }

  const produced = localWork.headSha;
  // One settlement of the current attempt; the ledgers are the caller's.
  const settled = (
    publication: RepairPublication,
    cycle: RepairCycle,
  ): { cycle: RepairCycle; attempt: RepairAttempt } =>
    settleAttempt(cycle, attempt, publication, localWork, remoteHeadSha);
  /** The round returns: the charge is refunded and the attempt settles as
   *  "nothing of it reached the remote". Counting a fall is the caller's
   * business — an attempt that fell counts one, an obsolete premise does not.
   * */
  const settledUnpublished = (cycle: RepairCycle): { cycle: RepairCycle; attempt: RepairAttempt } =>
    settled("not-published", { ...cycle, usedRounds: Math.max(0, cycle.usedRounds - 1) });

  // The remote carries exactly the commit this attempt produced: published,
  // and attributable — a different head proves nothing about this attempt.
  if (produced !== null && remoteHeadSha === produced && produced !== attempt.observedHeadSha) {
    return { kind: "published", ...settled("published", { ...input.cycle, consecutiveFalls: 0 }) };
  }

  // The premise vanished while the round ran: the obstacle it was
  // reopened for is gone, so the round returns without counting a fall — the
  // remote (whoever moved it) is still never overwritten. Only a confirmed
  // absence reaches here; an unknown one keeps the verdicts below.
  if (input.premise === "obsolete") {
    return { kind: "premise-obsolete", ...settledUnpublished(input.cycle) };
  }

  // The remote is still where it was, or holds no such branch: nothing of this
  // attempt was published. The charged round returns and the fall is counted.
  if (remoteHeadSha === null || remoteHeadSha === attempt.observedHeadSha) {
    return {
      kind: "not-published",
      ...settledUnpublished({ ...input.cycle, consecutiveFalls: input.cycle.consecutiveFalls + 1 }),
    };
  }

  // Somebody else moved the remote. The verdict needs the premise: a confirmed
  // impediment keeps the concurrent change a human question, while an
  // unreadable one is HELD — uncertainty is never turned into a help request
  // for work that may already be delivered.
  if (input.premise === "unknown") {
    return {
      kind: "pending",
      reason: "the impediment the round addressed could not be re-read",
      cycle: settled("pending", input.cycle).cycle,
    };
  }

  // Somebody else moved the remote: preserve the local work, ask a human.
  return { kind: "concurrent-change", ...settled("concurrent-change", input.cycle) };
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

/** True when the cycle carries an attempt on disk — the status and the
 *  reconciliation agree on what "this work ran a repair round" means. */
export function hasRepairCycle(cycle: RepairCycle): boolean {
  return cycle.attempt !== null || cycle.usedRounds > 0 || cycle.consecutiveFalls > 0;
}
