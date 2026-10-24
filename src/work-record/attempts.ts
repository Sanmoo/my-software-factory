import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

import { readOutcomeRecord, type OutcomeRecord } from "./outcome.js";
import { EVENT_LOG_PATTERN } from "./logs.js";

/**
 * The attempt numbering of a Work's record (issues 102/112; Work record, issue
 * 187): the attempts the per-attempt event logs and the outcome record number,
 * read from disk. This is the one place that answers "which attempt is this?"
 * — the launch facts, the status view and the repair reconciliation all ask it
 * instead of guessing from another artifact.
 */

/**
 * The attempt ledger of one work (issue 112): the highest attempt the registry
 * numbers, and the attempt the outcome record on disk belongs to (null when no
 * record exists). The gap between the two is an attempt that wrote no record
 * of its own — the fall a repair reconciliation must settle.
 */
export interface AttemptLedger {
  lastAttempt: number;
  recordedAttempt: number | null;
}

export async function readAttemptLedger(dir: string): Promise<AttemptLedger> {
  const { logs, record } = await attemptsAndRecord(dir);
  return { lastAttempt: lastAttemptOf(logs, record), recordedAttempt: record?.attempt ?? null };
}

/**
 * The attempt a work is on right now (issue 102): the highest per-attempt log,
 * or the record's own number when the record is the latest evidence — read
 * from the registry that numbers attempts, never guessed from elsewhere. Null
 * when nothing on disk numbers an attempt (a work dir that is gone): the
 * registry invents no number.
 */
export async function readLastAttempt(workDir: string): Promise<number | null> {
  const { logs, record } = await attemptsAndRecord(workDir);
  const attempt = lastAttemptOf(logs, record);
  return attempt === 0 ? null : attempt;
}

/** The attempt numbers present in the work dir, ascending. */
export async function attemptNumbers(workDir: string): Promise<number[]> {
  if (!existsSync(workDir)) return [];
  const entries = await readdir(workDir);
  const numbers: number[] = [];
  for (const entry of entries) {
    const match = EVENT_LOG_PATTERN.exec(entry);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers.sort((a, b) => a - b);
}

function lastAttemptOf(logs: readonly number[], record: OutcomeRecord | null): number {
  return Math.max(logs.at(-1) ?? 0, record?.attempt ?? 0);
}

async function attemptsAndRecord(workDir: string): Promise<{
  logs: number[];
  record: OutcomeRecord | null;
}> {
  const [logs, record] = await Promise.all([attemptNumbers(workDir), readOutcomeRecord(workDir)]);
  return { logs, record };
}
