import { existsSync } from "node:fs";
import { join } from "node:path";

import type { LocalWorkFacts } from "../git/port.js";
import {
  MAX_REPAIR_FALLS,
  MAX_REPAIR_ROUNDS,
  hasRepairCycle,
  legacyRepairAttempt,
  type RemoteObservation,
} from "../pool/repair.js";
import { settleRepairRound, type RepairRoundStart, type RepairSettlement } from "../pool/repair-round.js";
import { workKeyOf } from "../pool/work-key.js";
import { workPullRequest } from "../state/derive.js";
import { describeRemoteChange, renderLocalWork, shortSha } from "../state/repair-view.js";
import type { PullRequestTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { readAttemptLedger } from "../work-record/attempts.js";
import { readEffectJournal } from "../work-record/continuity.js";
import { eventLogName } from "../work-record/logs.js";
import { readOutcomeRecord } from "../work-record/outcome.js";
import { readRepairCycle, writeRepairCycle } from "../work-record/repair.js";

/**
 * The settlement of one repair attempt, and the words for it (issue 112,
 * extended by 149/181).
 *
 * The VERDICT is `pool/repair-round.ts`'s; this file supplies its observations,
 * persists the cycle through the Work record and says the verdict in the
 * operator's log. It was the loop's method, moved here so the engine keeps the
 * cycle and this domain keeps its own depth.
 *
 * The settlement is idempotent — a settled attempt is never charged, refunded
 * or counted again — and an unreadable remote leaves the attempt pending: no
 * worker and no budget return until a later sweep gets an answer.
 */

/** A reserved Work as the reconciliation addresses it: the Work and its dir. */
export interface RepairWork {
  work: WorkIdentity;
  dir: string;
}

/** What settling one attempt needs: the ports, the reads, and the two facts the
 *  cycle owns (the operator's stop, the operator's log). */
export interface SettlementDeps {
  /** The PR's facts, re-read now: the premise of the round (issue 149). */
  pullRequests: PullRequestTracker;
  /** Whether the operator's requested stop owns the end of this attempt
   *  (issue #146). The requested-stop boundary stays the engine's; the
   *  settlement only asks it. */
  operatorStopped: (dir: string, attempt: number) => Promise<boolean>;
  /** The work branch on disk; null when git cannot answer. */
  inspectLocalWork: (work: WorkIdentity) => Promise<LocalWorkFacts | null>;
  /** The remote head now; an unreadable remote is uncertainty, never absence. */
  observeRemote: (work: WorkIdentity) => Promise<RemoteObservation>;
  log: (message: string) => void;
}

/**
 * Settle the repair attempt this Work's record holds, if any: nothing is paid
 * for a work that never ran a repair round, and a live worker's attempt is not
 * touched (the caller keeps it out — settling a half-written branch mid-flight
 * would read it as a verdict).
 */
export async function reconcileRepairAttempt(work: RepairWork, deps: SettlementDeps): Promise<void> {
  const key = workKeyOf(work.work);
  const stored = await readRepairCycle(work.dir);
  const recorded = stored.attempt;
  let operatorStopped = false;
  let observeRoundStart: () => Promise<RepairRoundStart>;
  let inspectLocalWork: () => Promise<LocalWorkFacts | null>;
  let cycle = stored;
  if (recorded !== null) {
    operatorStopped = await deps.operatorStopped(work.dir, recorded.attempt);
    observeRoundStart = () => observeRepairRoundStart(work.dir, recorded.attempt);
    inspectLocalWork = () => deps.inspectLocalWork(work.work);
  } else {
    // A work that never ran a repair round has nothing to reconcile — no
    // registry read or git inspection is paid for it on every sweep.
    if (!hasRepairCycle(stored)) return;
    // A legacy cycle with no attempt on disk: only the registry gap can
    // establish the attempt, and its local work is read once, by adoption.
    const adopted = await adoptLegacyCycle(work, stored, deps.inspectLocalWork);
    const adoptedAttempt = adopted?.attempt ?? null;
    if (adopted === null || adoptedAttempt === null) return;
    cycle = adopted;
    // The adoption's registry gap says an attempt ran; the settlement re-reads
    // that from the attempt's own artifacts (issue 181), so a legacy cycle the
    // artifacts do not back never blocks the work.
    observeRoundStart = () => observeRepairRoundStart(work.dir, adoptedAttempt.attempt);
    inspectLocalWork = async () => adoptedAttempt.localWork;
  }

  const decision = await settleRepairRound({
    cycle,
    operatorStopped,
    observeRoundStart,
    readOutcomeRecord: () => readOutcomeRecord(work.dir),
    observeRemote: () => deps.observeRemote(work.work),
    inspectLocalWork,
    // The premise is part of the verdict (issue 149): a remote the attempt did
    // not produce is a concurrent change ONLY while the impediment the round
    // addressed still exists — a human's own resolution is never taken for a
    // reason to ask for help. Read once per settlement.
    readPremise: () => deps.pullRequests.readPullRequestRepairFacts(workPullRequest(work.work)),
  });
  if (decision.kind === "none") return;
  await writeRepairCycle(work.dir, decision.cycle);
  logSettlement(key, decision, deps.log);
}

/** The cycle a legacy reparo.json implies (issue 112): the budget was charged
 *  and the registry shows an attempt after the last recorded outcome — the
 *  attempt whose observed head only the evidence signature names. */
async function adoptLegacyCycle(
  work: RepairWork,
  cycle: Awaited<ReturnType<typeof readRepairCycle>>,
  inspectLocalWork: (work: WorkIdentity) => Promise<LocalWorkFacts | null>,
) {
  const ledger = await readAttemptLedger(work.dir);
  const candidate = legacyRepairAttempt({
    cycle,
    lastAttempt: ledger.lastAttempt,
    recordedAttempt: ledger.recordedAttempt,
  });
  if (candidate === null) return null;
  const localWork = await inspectLocalWork(work.work);
  return { ...cycle, attempt: { ...candidate, localWork } };
}

/** The settlement verdict, said once in the operator's log. */
function logSettlement(
  key: string,
  decision: Exclude<RepairSettlement, { kind: "none" }>,
  log: (message: string) => void,
): void {
  if (decision.kind === "returned-unstarted") {
    log(`repair attempt ${decision.attempt.attempt} of ${key} never reached the runtime — round returned, no fall`);
    return;
  }
  const attempt = decision.cycle.attempt;
  if (attempt === null) return;
  switch (decision.kind) {
    case "pending":
      log(
        `repair attempt ${attempt.attempt} of ${key}: reconciliation pending (${decision.reason}) — ` +
          "no worker and no budget return while publication is uncertain",
      );
      return;
    case "published":
      log(
        `repair attempt ${attempt.attempt} of ${key} confirmed published at ${shortSha(attempt.observedHeadSha)} → ` +
          `${attempt.remoteHeadSha === null ? "the remote" : shortSha(attempt.remoteHeadSha)} — the round stays charged ` +
          `(${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS})`,
      );
      return;
    case "not-published":
      log(
        `repair attempt ${attempt.attempt} of ${key} ended without publishing — the round returns ` +
          `(${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS}), ${decision.cycle.consecutiveFalls}/${MAX_REPAIR_FALLS} consecutive falls; ` +
          `local work preserved: ${renderLocalWork(attempt.localWork)}`,
      );
      return;
    case "premise-obsolete":
      log(
        `repair attempt ${attempt.attempt} of ${key}: the impediment it was launched for no longer exists ` +
          `(the premise is obsolete) — the round returns (${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS}) ` +
          `with no fall counted; local work preserved: ${renderLocalWork(attempt.localWork)}`,
      );
      return;
    case "concurrent-change":
      log(
        `repair attempt ${attempt.attempt} of ${key}: the remote branch ` +
          `${describeRemoteChange(attempt.remoteHeadSha)} — a concurrent change the attempt did not produce; ` +
          `local work preserved (${renderLocalWork(attempt.localWork)}), a human is asked`,
      );
      return;
  }
}

/** Whether a round with a recorded attempt ever reached the runtime: its own
 *  event log is the cheap proof; when it is absent, the guardrail journal is
 *  the remaining direct fact (an unreadable one proves nothing either way). */
async function observeRepairRoundStart(dir: string, attempt: number): Promise<RepairRoundStart> {
  if (existsSync(join(dir, eventLogName(attempt)))) return { reached: true };
  const journal = readEffectJournal(dir);
  return {
    reached: false,
    journalIntact: journal.intact,
    journaledAttempts: journal.sessions.map((session) => session.attempt),
  };
}
