import type { RecoveryBudget } from "../config.js";
import type { OutcomeClass } from "../work-record/outcome.js";
import {
  readRecoveryLedger,
  updateRecoveryLedger,
  type RecoveryEvent,
  type RecoveryLedger,
  type RecoveryStop,
} from "../work-record/recovery.js";
import { renderWaits } from "./waits.js";

/**
 * The interruption-recovery budget of a work (terms in GLOSSARY):
 * an attempt that ended with no outcome record is interrupted, not failed, so
 * the factory absorbs it with a finite allowance scoped to the attempt instead
 * of consuming it. The ledger is an artifact of the work
 * (trabalhos/<repo>#<n>/recuperacao.json) — owned by the Work record (issue
 * 187), which keeps the file, its schema, its one-writer queue and the rule
 * that every stop fact names its attempt. This module keeps the DECISION: the
 * configured allowance, the wait schedule and what each settlement means.
 */

export type RecoveryDecision =
  | { decision: "recover"; waitMs: number; consumed: number }
  | { decision: "pause-help"; consumed: number; reason: string };

/**
 * The decision the current count supports, without consuming it: the next wait
 * by index (the last value repeats for longer schedules) or the pause that asks
 * the operator for help.
 */
export function recoveryDecision(ledger: RecoveryLedger, budget: RecoveryBudget): RecoveryDecision {
  if (ledger.consumed >= budget.maxRecoveries) {
    return {
      decision: "pause-help",
      consumed: ledger.consumed,
      reason: exhaustedReason(budget),
    };
  }
  const index = ledger.consumed;
  return {
    decision: "recover",
    waitMs: budget.waitsMs[Math.min(index, budget.waitsMs.length - 1)] ?? 0,
    consumed: index + 1,
  };
}

/** What the next recovery would cost — the derivation's read-only view. */
export async function peekRecovery(
  workDir: string,
  budget: RecoveryBudget,
  attempt: number,
): Promise<RecoveryDecision> {
  const ledger = await readRecoveryLedger(workDir);
  return recoveryDecision(ledgerForAttempt(ledger, attempt), budget);
}

/**
 * Consume one recovery for the attempt and persist it BEFORE the relaunch, so
 * a death during the backoff or the session continues the count instead of
 * renewing it. An exhausted budget is persisted as the interruption's last
 * stop and is never consumed further.
 */
export async function consumeRecovery(
  workDir: string,
  budget: RecoveryBudget,
  attempt: number,
  now: () => Date = () => new Date(),
): Promise<RecoveryDecision> {
  return updateRecoveryLedger<RecoveryDecision>(workDir, (stored) => {
    const ledger = ledgerForAttempt(stored, attempt);
    const decision = recoveryDecision(ledger, budget);
    const at = now().toISOString();
    if (decision.decision === "pause-help") return { next: null, result: decision };

    const event: RecoveryEvent = {
      index: ledger.consumed,
      waitMs: decision.waitMs,
      attempt,
      at,
    };
    return {
      next: {
        ...ledger,
        consumed: decision.consumed,
        events: [...ledger.events, event],
        lastStop: { kind: "interruption", attempt, at },
      },
      result: decision,
    };
  });
}

/** One serialized read-modify-write of the ledger's `lastStop` (and of the
 *  count it scopes to). A null mutation leaves the file untouched — every stop
 *  record differs only in that value. */
async function updateLastStop(
  workDir: string,
  mutate: (ledger: RecoveryLedger) => RecoveryLedger | null,
): Promise<void> {
  await updateRecoveryLedger(workDir, (ledger) => ({ next: mutate(ledger), result: undefined }));
}

/**
 * Persist that the attempt ended by the operator's requested stop: the
 * evidence the next invocation reads to resume the SAME attempt
 * instead of charging a recovery. Written BEFORE the worker is asked to stop,
 * so a factory that dies inside the requested stop still leaves the attribution.
 */
export async function recordStopRequest(
  workDir: string,
  attempt: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLastStop(workDir, (ledger) => ({
    ...ledgerForAttempt(ledger, attempt),
    lastStop: { kind: "stop-requested", attempt, at: now().toISOString() },
  }));
}

/**
 * Persist that the requested stop could NOT be confirmed: the worker may still
 * be alive. The next invocation holds the work until the worker is known to be
 * gone — never a duplicate worker on the same work.
 */
export async function recordUnconfirmedStop(
  workDir: string,
  attempt: number,
  because: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLastStop(workDir, (ledger) => ({
    ...ledgerForAttempt(ledger, attempt),
    lastStop: { kind: "stop-unconfirmed", attempt, at: now().toISOString(), because },
  }));
}

/**
 * The worker of an unconfirmed stop is confirmed gone: the stop becomes the
 * requested-stop one it was meant to be, and the attempt may resume free of charge.
 * A record of another kind (or another attempt) is left untouched.
 */
export async function confirmStopRequest(
  workDir: string,
  attempt: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLastStop(workDir, (ledger) =>
    isStopOfAttempt(ledger.lastStop, "stop-unconfirmed", attempt)
      ? {
          ...ledgerForAttempt(ledger, attempt),
          lastStop: { kind: "stop-requested", attempt, at: now().toISOString() },
        }
      : null,
  );
}

/**
 * The requested-stop resume is launching: the record did its job. Cleared
 * BEFORE the worker starts so a later, unexpected interruption of this
 * attempt is charged like any other — the requested stop only excuses itself.
 */
export async function consumeStopRequest(workDir: string, attempt: number): Promise<void> {
  await updateLastStop(workDir, (ledger) =>
    isStopOfAttempt(ledger.lastStop, "stop-requested", attempt) ? { ...ledger, lastStop: null } : null,
  );
}

/**
 * Return one Recovery grant to the attempt's budget: the launch it paid for
 * provably carried no worker — the requested stop cancelled the admission, or
 * the environment refused the launch. Only the grant named by its ledger event
 * index is returned — earlier, legitimate consumption and a second return of
 * the same grant are impossible.
 */
export async function refundRecovery(workDir: string, attempt: number, index: number): Promise<boolean> {
  return updateRecoveryLedger(workDir, (ledger) => {
    if (ledger.attempt !== attempt) return { next: null, result: false };
    const granted = ledger.events.findIndex((event) => event.index === index && event.attempt === attempt);
    if (granted < 0) return { next: null, result: false };
    return {
      next: {
        ...ledger,
        consumed: Math.max(0, ledger.consumed - 1),
        events: ledger.events.filter((_event, position) => position !== granted),
      },
      result: true,
    };
  });
}

/** The stop record OF THIS attempt and kind, if that is what ended it. */
function isStopOfAttempt(
  stop: RecoveryStop | null,
  kind: "stop-requested" | "stop-unconfirmed",
  attempt: number,
): boolean {
  return stop !== null && stop.kind === kind && stop.attempt === attempt;
}
export async function recordInterruptionStop(
  workDir: string,
  attempt: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLastStop(workDir, (ledger) => ({
    ...ledgerForAttempt(ledger, attempt),
    lastStop: { kind: "interruption", attempt, at: now().toISOString() },
  }));
}

/**
 * Record that the attempt wrote a failure outcome: the attempt is consumed
 * (the registry numbers the next one) and the interruption count of this
 * attempt no longer applies — the next attempt starts with a full budget.
 */
export async function recordFailure(
  workDir: string,
  attempt: number,
  outcome: OutcomeClass,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateRecoveryLedger(workDir, (ledger) => {
    const current = ledgerForAttempt(ledger, attempt);
    return {
      next: {
        ...current,
        lastStop: { kind: "failure", attempt, at: now().toISOString(), outcome },
        lastFallAttempt: Math.max(current.lastFallAttempt ?? 0, attempt),
      },
      result: undefined,
    };
  });
}

/**
 * Restart the fall count: the human answered the block the 2nd
 * consecutive fall asked for, so the next failure starts a FRESH count — the
 * 1st fall releases again. The count is the ledger's fact (`lastFallAttempt`),
 * so the restart is written there: kept only in a launch's memory it would be
 * lost by the next sweep or a restart, and the 2nd-fall block would come back
 * over an answer already given.
 */
export async function resetFallCount(workDir: string): Promise<void> {
  await updateRecoveryLedger(workDir, (ledger) =>
    ledger.lastFallAttempt === null
      ? { next: null, result: undefined }
      : { next: { ...ledger, lastFallAttempt: null }, result: undefined },
  );
}

/** The ledger scoped to an attempt: its allowance is per attempt, its events
 *  stay as the work's history. */
function ledgerForAttempt(ledger: RecoveryLedger, attempt: number): RecoveryLedger {
  if (ledger.attempt === attempt) return ledger;
  return { ...ledger, attempt, consumed: 0 };
}

/** The pause's reason, naming the configured value and backoff. */
export function exhaustedReason(budget: RecoveryBudget): string {
  return (
    `the recovery budget is exhausted: ${budget.maxRecoveries} automatic recoveries ` +
    `(waits ${renderWaits(budget.waitsMs)}) were already used for this attempt`
  );
}
