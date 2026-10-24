import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OutcomeClass } from "./outcome.js";
import { WorkRecordError } from "./errors.js";

/**
 * The interruption-recovery part of a Work's record (issue 123; terms in
 * GLOSSARY): the persisted allowance counted per attempt, the stop facts that
 * ended the last attempt, and the fall fact the ruler reads at a crash. The
 * DECISION the count supports stays with the domain module (pool/recovery.ts);
 * the file, its schema, its honest initial state and the one-writer queue live
 * here, where every stop fact is checked to name its attempt.
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

/**
 * One writer per work's ledger: the requested stop and a collection can reach
 * the same artifact concurrently (issue #146 — the stop bookkeeping and the
 * admission it cancels), and two read-modify-write cycles interleaved would
 * lose one of the updates. Each mutation queues behind the previous one for
 * the same dir; the chain survives a rejected writer.
 */
const writing = new Map<string, Promise<unknown>>();

function serialized<T>(workDir: string, write: () => Promise<T>): Promise<T> {
  const previous = writing.get(workDir) ?? Promise.resolve();
  const next = previous.then(write, write);
  writing.set(
    workDir,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * One serialized read-modify-write of the ledger. The mutation returns the
 * ledger to persist (or null to leave the file untouched) and the result the
 * caller needs; the write itself validates every fact that names an attempt.
 */
export function updateRecoveryLedger<T>(
  workDir: string,
  mutate: (ledger: RecoveryLedger) => { next: RecoveryLedger | null; result: T },
): Promise<T> {
  return serialized(workDir, async () => {
    const { next, result } = mutate(await readRecoveryLedger(workDir));
    if (next !== null) await persist(workDir, next);
    return result;
  });
}

/** Persist a whole ledger through the same one-writer queue. */
export function writeRecoveryLedger(workDir: string, ledger: RecoveryLedger): Promise<void> {
  return updateRecoveryLedger(workDir, () => ({ next: ledger, result: undefined }));
}

async function persist(workDir: string, ledger: RecoveryLedger): Promise<void> {
  assertLedgerNamesItsAttempts(ledger);
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, RECOVERY_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Every fact that ends or continues an attempt names that attempt: the
 *  count's scope, each granted recovery and the last stop are not anonymous. */
function assertLedgerNamesItsAttempts(ledger: RecoveryLedger): void {
  if (positiveInteger(ledger.attempt) === null) {
    throw new WorkRecordError(`the recovery ledger must name its attempt, got ${String(ledger.attempt)}`);
  }
  if (nonNegativeInteger(ledger.consumed) === null) {
    throw new WorkRecordError(`the recovery ledger's consumed count must be a non-negative integer, got ${String(ledger.consumed)}`);
  }
  for (const event of ledger.events) {
    if (!isEvent(event)) {
      throw new WorkRecordError("a recovery event must name the attempt it continued");
    }
  }
  if (ledger.lastStop !== null && !isStop(ledger.lastStop)) {
    throw new WorkRecordError("a stop fact must name the attempt it ended");
  }
  if (ledger.lastFallAttempt !== null && positiveInteger(ledger.lastFallAttempt) === null) {
    throw new WorkRecordError(`the last fall must name its attempt, got ${String(ledger.lastFallAttempt)}`);
  }
}
