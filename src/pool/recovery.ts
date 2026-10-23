import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RecoveryBudget } from "../config.js";
import type { OutcomeClass } from "../state/outcome.js";

/**
 * The interruption-recovery budget of a work (issue 123; terms in GLOSSARY):
 * an attempt that ended with no outcome record is interrupted, not failed, so
 * the factory absorbs it with a finite allowance scoped to the attempt instead
 * of consuming it. The ledger is an artifact of the work
 * (trabalhos/<repo>#<n>/recuperacao.json), so a restart continues the count
 * instead of renewing it; exhausting it pauses the work and asks for help.
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
 * (absorbed by this budget), a failure (a written failure/abandon outcome,
 * which consumes the attempt and enters the fall ruler), or the operator's
 * requested stop (issue #146) — a lifecycle condition that spends nothing and
 * resumes the same attempt. `stop-unconfirmed` means the requested stop could
 * not be confirmed: the next invocation must not relaunch the work until the
 * previous worker is known to be gone.
 */
export type RecoveryStop =
  | { kind: "interruption"; attempt: number; at: string }
  | { kind: "failure"; attempt: number; at: string; outcome: OutcomeClass }
  | { kind: "stop-requested"; attempt: number; at: string }
  | { kind: "stop-unconfirmed"; attempt: number; at: string; because: string };

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
  if (stop["kind"] === "stop-unconfirmed") return typeof stop["because"] === "string";
  return stop["kind"] === "interruption" || stop["kind"] === "stop-requested";
}

async function writeLedger(workDir: string, ledger: RecoveryLedger): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, RECOVERY_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/**
 * One writer per work's ledger: the engine's shutdown and a collection can
 * reach the same artifact concurrently (issue #146 — the stop bookkeeping and
 * the admission it cancels), and two read-modify-write cycles interleaved
 * would lose one of the updates. Each mutation below queues behind the
 * previous one for the same dir; the chain survives a rejected writer.
 */
const writing = new Map<string, Promise<unknown>>();

function serialized<T>(workDir: string, mutate: () => Promise<T>): Promise<T> {
  const previous = writing.get(workDir) ?? Promise.resolve();
  const next = previous.then(mutate, mutate);
  writing.set(
    workDir,
    next.catch(() => undefined),
  );
  return next;
}

/** One serialized read-modify-write of the ledger's `lastStop` (and of the
 *  count it scopes to). The mutation returns the ledger to write, or null to
 *  leave the file untouched — every stop record differs only in that value. */
async function updateLastStop(
  workDir: string,
  mutate: (ledger: RecoveryLedger) => RecoveryLedger | null,
): Promise<void> {
  await serialized(workDir, async () => {
    const next = mutate(await readRecoveryLedger(workDir));
    if (next !== null) await writeLedger(workDir, next);
  });
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
  return serialized(workDir, async () => {
    const ledger = ledgerForAttempt(await readRecoveryLedger(workDir), attempt);
    const decision = recoveryDecision(ledger, budget);
    const at = now().toISOString();
    if (decision.decision === "pause-help") return decision;

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
  });
}

/**
 * Persist that the attempt ended by the operator's requested stop (issue
 * #146): the evidence the next invocation reads to resume the SAME attempt
 * instead of charging a recovery. Written BEFORE the worker is asked to stop,
 * so a factory that dies inside the shutdown still leaves the attribution.
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
 * Return a recovery whose relaunch the requested stop cancelled (issue #146):
 * the grant was persisted before the backoff, but no worker ever started with
 * it, so spending it would penalize a requested restart. Only the grant named
 * by its ledger event index is returned — earlier, legitimate consumption and
 * a second return of the same grant are impossible.
 */
export async function refundRecovery(workDir: string, attempt: number, index: number): Promise<boolean> {
  return serialized(workDir, async () => {
    const ledger = await readRecoveryLedger(workDir);
    if (ledger.attempt !== attempt) return false;
    const granted = ledger.events.findIndex((event) => event.index === index && event.attempt === attempt);
    if (granted < 0) return false;
    await writeLedger(workDir, {
      ...ledger,
      consumed: Math.max(0, ledger.consumed - 1),
      events: ledger.events.filter((_event, position) => position !== granted),
    });
    return true;
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
  await serialized(workDir, async () => {
    const ledger = await readRecoveryLedger(workDir);
    const current = ledgerForAttempt(ledger, attempt);
    await writeLedger(workDir, {
      ...current,
      lastStop: { kind: "failure", attempt, at: now().toISOString(), outcome },
      lastFallAttempt: Math.max(current.lastFallAttempt ?? 0, attempt),
    });
  });
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

/** The waits in the operator's words: 1s/4s/16s — sub-second waits keep their
 *  milliseconds, so a configured 250 ms is never reported as "0s". */
export function renderWaits(waitsMs: readonly number[]): string {
  return waitsMs.map((wait) => (wait % 1000 === 0 ? `${wait / 1000}s` : `${wait}ms`)).join("/");
}
