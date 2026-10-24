import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { WorkRecordError } from "./errors.js";
import { writeAtomic } from "./fs.js";

/**
 * The outcome part of a Work's record: desfecho.json, the artifact contract
 * between the worker's ruler and the factory's ruler (state/outcome.ts). The
 * factory reads it and never interprets text; the worker/fixtures write the
 * same shape through this module, so one schema serves both sides.
 */

/** Disk name is a taken decision (tickets 05/10) and stays in PT-BR. */
export const DESFECHO_FILENAME = "desfecho.json";

/** The class field of the outcome record — vocabulary of ticket 05. */
export type OutcomeClass =
  /** The work ended with an open PR: stays reserved, waiting for the human. */
  | "pr-open"
  /** The worker self-reported blocked (marker + label) and exited. */
  | "blocked-self-report"
  /** Clean end without an open PR — still a fall, per the single ruler. */
  | "clean-without-pr";

/**
 * Schema of desfecho.json — the artifact contract between the two rulers.
 * The factory validates this schema; it never interprets text.
 */
export interface OutcomeRecord {
  class: OutcomeClass;
  /** Attempt number of this session (1st, 2nd... on the same branch). */
  attempt: number;
  /** Present when class is "pr-open". */
  pr?: {
    repo: string;
    number: number;
    branch: string;
  };
  /** Paths of artifacts of this attempt, when the session recorded them. */
  paths?: Record<string, string>;
}

/**
 * The record OF THIS ATTEMPT, or null: the ONE place the criterion "is this
 * record this attempt's?" lives — the collection path, the ruler and the
 * status call it, so they cannot diverge (issue 143). A record without an
 * `attempt` (legacy) never parses, so it is absence too.
 */
export function ownOutcomeRecord(
  record: OutcomeRecord | null,
  attempt: number,
): OutcomeRecord | null {
  return record !== null && record.attempt === attempt ? record : null;
}

/**
 * Read the outcome record of a work. Returns null when the record is absent,
 * invalid or corrupt. Absence is the FACT "no-outcome" (issue 123): the
 * recovery budget, never the fall ruler, answers it.
 */
export async function readOutcomeRecord(workDir: string): Promise<OutcomeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(workDir, DESFECHO_FILENAME), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isOutcomeRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the outcome of one attempt — the host side of the same contract
 * (fixtures and tests write real shapes through it). It names its attempt: a
 * record no attempt can claim is not a verdict anyone may read.
 */
export function writeOutcomeRecord(workDir: string, record: OutcomeRecord): void {
  if (!isOutcomeRecord(record)) {
    throw new WorkRecordError(`invalid outcome record: not the ${DESFECHO_FILENAME} schema`);
  }
  if (!Number.isInteger(record.attempt) || record.attempt < 1) {
    throw new WorkRecordError(`an outcome record must name its attempt, got ${String(record.attempt)}`);
  }
  writeAtomic(join(workDir, DESFECHO_FILENAME), record);
}

function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record["class"] !== "string") return false;
  if (!["pr-open", "blocked-self-report", "clean-without-pr"].includes(record["class"])) {
    return false;
  }
  if (typeof record["attempt"] !== "number") return false;
  return true;
}
