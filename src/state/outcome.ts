import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The factory's ruler (state/outcome.ts) — classification of outcomes and
 * tracker transitions (tickets 04/05; fleshed out by tickets 12-14).
 *
 * The two-rulers contract: the worker's ruler (its obligations) lives in the
 * prompt; the factory's ruler (this module) NEVER reads what the agent wrote
 * in natural language. It reads only structured, verifiable facts:
 *   - does desfecho.json exist? what is its `class` field?
 *   - is there an open PR on the issue? (port)
 *   - labels? author of the last comment? (port)
 * The contract between the two sides is the artifact schema below. Zero
 * natural-language parsing in the critical path.
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
 * Read the outcome record of a work. Returns null when the record is absent,
 * invalid or corrupt — absence is itself the class "abrupt fall"
 * (dead process, restart, garbage), and the ruler applies from there.
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
