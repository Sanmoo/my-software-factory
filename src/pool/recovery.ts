import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RecoveryBudget } from "../config.js";
import type { OutcomeClass } from "../state/outcome.js";

/**
 * The interruption-recovery budget of a work (issue 123): an attempt that ended
 * with NO outcome record was interrupted by infrastructure — a SIGKILLed
 * worker, a dead factory process, a dead container, a hard stop — and that is
 * not a failure of the attempt. The interruption is absorbed here, by a finite
 * allowance counted per work and scoped to the attempt, never by the attempt
 * number and never by the 1st/2nd-fall ruler.
 *
 * The count is an artifact of the work (trabalhos/<repo>#<n>/recuperacao.json),
 * so it survives the factory's death: a restart continues the same count
 * instead of renewing the allowance. Exhausting it pauses the work and asks the
 * operator for help — it never restarts forever.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const RECOVERY_FILENAME = "recuperacao.json";

/** One consumed recovery: which attempt it continued, its wait and when. */
export interface RecoveryEvent {
  /** 0-based index; the wait schedule is indexed by it. */
  index: number;
  /** The backoff this recovery is granted; the loop waits it before the relaunch. */
  waitMs: number;
  /** The attempt the recovery continues — the same number, never a new one. */
  attempt: number;
  at: string;
}

/**
 * What ended the last attempt, as the factory settled it: an interruption
 * (absorbed by this budget) or a failure (a written failure/abandon outcome,
 * which consumes the attempt and enters the fall ruler).
 */
export type RecoveryStop =
  | { kind: "interruption"; attempt: number; at: string }
  | { kind: "failure"; attempt: number; at: string; outcome: OutcomeClass };

export interface RecoveryLedger {
  /** The attempt the count belongs to; a different attempt starts from zero. */
  attempt: number;
  /** Recoveries consumed by THIS attempt. */
  consumed: number;
  events: RecoveryEvent[];
  /** What ended the last attempt (or the one before, until a new one ends). */
  lastStop: RecoveryStop | null;
  /** The highest attempt that ended in a WRITTEN failure — the fall ruler's
   *  consecutiveness fact at a crash, never overwritten by an interruption. */
  lastFallAttempt: number | null;
}

export function emptyLedger(): RecoveryLedger {
  return { attempt: 1, consumed: 0, events: [], lastStop: null, lastFallAttempt: null };
}

export type RecoveryDecision =
  | { decision: "recover"; waitMs: number; consumed: number }
  | { decision: "pause-help"; consumed: number; reason: string };

/**
 * Read the ledger of a work. An absent or corrupt file is the honest initial
 * state: no recovery was ever consumed, nothing is invented and nothing is
 * deleted. A legacy work dir (written before this budget existed) has no file
 * and reads exactly like a work that was never interrupted.
 */
export async function readRecoveryLedger(workDir: string): Promise<RecoveryLedger> {
  let raw: string;
  try {
    raw = await readFile(join(workDir, RECOVERY_FILENAME), "utf8");
  } catch {
    return emptyLedger();
  }
  try {
    return parseLedger(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

function parseLedger(value: unknown): RecoveryLedger {
  if (value === null || typeof value !== "object") return emptyLedger();
  const record = value as Record<string, unknown>;
  return {
    attempt: positiveInteger(record["attempt"]) ?? 1,
    consumed: nonNegativeInteger(record["consumed"]) ?? 0,
    events: Array.isArray(record["events"]) ? record["events"].filter(isEvent) : [],
    lastStop: isStop(record["lastStop"]) ? record["lastStop"] : null,
    lastFallAttempt: positiveInteger(record["lastFallAttempt"]),
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isEvent(value: unknown): value is RecoveryEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    nonNegativeInteger(event["index"]) !== null &&
    typeof event["waitMs"] === "number" &&
    positiveInteger(event["attempt"]) !== null &&
    typeof event["at"] === "string"
  );
}

function isStop(value: unknown): value is RecoveryStop {
  if (value === null || typeof value !== "object") return false;
  const stop = value as Record<string, unknown>;
  if (positiveInteger(stop["attempt"]) === null || typeof stop["at"] !== "string") return false;
  if (stop["kind"] === "failure") return typeof stop["outcome"] === "string";
  return stop["kind"] === "interruption";
}

async function writeLedger(workDir: string, ledger: RecoveryLedger): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, RECOVERY_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

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
  return recoveryDecision(budgetForAttempt(ledger, attempt), budget);
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
  const ledger = budgetForAttempt(await readRecoveryLedger(workDir), attempt);
  const decision = recoveryDecision(ledger, budget);
  const at = now().toISOString();
  if (decision.decision === "pause-help") {
    await writeLedger(workDir, {
      ...ledger,
      lastStop: { kind: "interruption", attempt, at },
    });
    return decision;
  }

  const event: RecoveryEvent = {
    index: ledger.consumed,
    waitMs: decision.waitMs,
    attempt,
    at,
  };
  await writeLedger(workDir, {
    ...ledger,
    consumed: decision.consumed,
    events: [...ledger.events, event],
    lastStop: { kind: "interruption", attempt, at },
  });
  return decision;
}

/**
 * Record that the attempt wrote a failure/abandon outcome: the attempt is
 * consumed (the registry numbers the next one) and the interruption count of
 * this attempt no longer applies — the next attempt starts with a full budget.
 */
export async function recordFailure(
  workDir: string,
  attempt: number,
  outcome: OutcomeClass,
  now: () => Date = () => new Date(),
): Promise<void> {
  const ledger = await readRecoveryLedger(workDir);
  const current = budgetForAttempt(ledger, attempt);
  await writeLedger(workDir, {
    ...current,
    lastStop: { kind: "failure", attempt, at: now().toISOString(), outcome },
    lastFallAttempt: Math.max(current.lastFallAttempt ?? 0, attempt),
  });
}

/** The same ledger for a different attempt: the allowance is per attempt, the
 *  events stay as the work's history. */
function budgetForAttempt(ledger: RecoveryLedger, attempt: number): RecoveryLedger {
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

/** The waits in the operator's words: 1s/4s/16s — sub-second waits keep their
 *  milliseconds, so a configured 250 ms is never reported as "0s". */
export function renderWaits(waitsMs: readonly number[]): string {
  return waitsMs.map((wait) => (wait % 1000 === 0 ? `${wait / 1000}s` : `${wait}ms`)).join("/");
}
