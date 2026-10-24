import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { recordPath, WORK_RECORD_FILES } from "./files.js";

/**
 * The outcome record of a Work (`desfecho.json`) — the artifact contract
 * between the worker's ruler and the factory's (issue #186). The record's
 * SCHEMA, its reader and writer and the one criterion of attribution ("is this
 * record THIS attempt's?") live here, so the collection path, the derivation,
 * the registry and the status cannot diverge about what the file on disk means
 * (issues 103/143).
 *
 * The factory never writes prose here: it validates the schema and reads the
 * structured facts alone.
 */

/** Disk name, owned by the record's file layout. */
export const DESFECHO_FILENAME = WORK_RECORD_FILES.outcome;

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
 * Read the outcome record of a work. Returns null when the record is absent,
 * invalid or corrupt. Absence is the FACT "no-outcome" (issue 123): the
 * recovery budget, never the fall ruler, answers it.
 */
export async function readOutcomeRecord(workDir: string): Promise<OutcomeRecord | null> {
  let raw: string;
  try {
    raw = readFileSync(recordPath(workDir, "outcome"), "utf8");
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

/** Write the outcome record of a work (the fake runtime and the fixtures write
 *  the REAL shape; in production the worker writes it from inside the mount).
 *  Synchronous like the registry's own writes: the launch path must not yield
 *  the event loop between its dir reservation and its claim (issue 98's order). */
export function writeOutcomeRecord(workDir: string, record: OutcomeRecord): void {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(recordPath(workDir, "outcome"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
 * The written failure the ruler counts for CONSECUTIVENESS at launch: a clean
 * end without a PR. A `pr-open` record is a success and resets the count; a
 * self-report is the worker's own stop, not a failure (issue 123).
 */
export function isRecordedFailure(record: OutcomeRecord | null): boolean {
  return record?.class === "clean-without-pr";
}

/**
 * The attempt's own written outcome, unless it is the blocked self-report the
 * `record-only` ruling handles: the record that lets the fall ruler decide
 * (issue 123). One rule, shared by collection and by the derivation that
 * settles an unreconciled attempt.
 */
export function ownWrittenOutcome(
  record: OutcomeRecord | null,
  attempt: number,
): OutcomeRecord | null {
  const own = ownOutcomeRecord(record, attempt);
  return own !== null && own.class !== "blocked-self-report" ? own : null;
}

/** The ACTUAL blocked self-report of one attempt — a record left by another
 *  attempt is never the current attempt's self-report (issue 103). */
export function selfReportedBlocked(record: OutcomeRecord | null, attempt: number): boolean {
  return ownOutcomeRecord(record, attempt)?.class === "blocked-self-report";
}

/**
 * The one rendering of the history fact "the record on disk is another
 * attempt's", so the operator's wording cannot drift apart (issue 143).
 */
export function describeForeignRecord(attempt: number): string {
  return `the record on disk belongs to attempt ${attempt}`;
}
