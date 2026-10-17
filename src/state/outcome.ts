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
 * The umbrella classification of a collection, no matter how the record got
 * there: `abrupt-fall` is written by no one — its fact IS the absence, so it
 * never appears in the artifact vocabulary, only in the ruler's reasoning.
 */
export type ObservedClass = OutcomeClass | "abrupt-fall";

/** The ruled transition of a collection, decided in state/, executed by the loop. */
export type OutcomeRuling =
  /** Classes 1 and 5: PR open (by record or by pre-existence) — stays
   * reserved awaiting the human; a fall is never recorded, the claim is held. */
  | { decision: "reserve"; because: "pr-open" }
  /** Class 6: blocked self-report — the worker already posted mounted marker + label; the factory only records it. */
  | { decision: "record-only"; because: "blocked-self-report" }
  /** Class 2: fall without PR, 1st consecutive — release (claimed→ready; the branch stays). */
  | { decision: "release"; because: "fall-first" }
  /** Class 3/4: fall without PR, 2nd consecutive — blocked + comment carrying the exact outcome. */
  | { decision: "block"; because: "fall-second"; comment: string };

/** The structured facts the ruler reads — nothing else, zero prose (ticket 05 Q5: mounting the artifact). */
export interface OutcomeFacts {
  /** desfecho.json of the collected attempt; null = absent = abrupt fall. */
  record: OutcomeRecord | null;
  /** The port's fact: an open PR linked to the issue (recorded now or pre-existing). */
  prOpen: boolean;
  /** The port's fact: the blocked label is on the issue (the worker's self-report). */
  blockedLabelOnIssue: boolean;
  /** The registry's fact from launch time: the previous attempt on this branch also fell. */
  consecutiveFall: boolean;
}

/**
 * The factory's ruler (ticket 13), applied at collection (loop) on structured
 * facts alone. Priority is the vocabulary of the six classes:
 *   1/5. PR open → reserve, no fall recorded (pre-existing PR included);
 *   6. blocked self-report → only recorded (the worker posted marker + label);
 *   then any end without PR is the one fall (ticket 05 Q1): absent record =
 *   abrupt fall — 1st consecutive → release, 2nd consecutive → blocked + comment.
 */
export function classifyOutcome(facts: OutcomeFacts): OutcomeRuling {
  if (facts.prOpen) return { decision: "reserve", because: "pr-open" };
  if (isBlockedSelfReport(facts)) return { decision: "record-only", because: "blocked-self-report" };

  // Fall without PR — clean or abrupt, the ruler is a single one.
  if (facts.consecutiveFall) {
    return {
      decision: "block",
      because: "fall-second",
      comment: blockedCommentBody(facts.record, facts.record?.attempt),
    };
  }
  return { decision: "release", because: "fall-first" };
}

/** A self-report is the record class or the label — both are structured facts. */
function isBlockedSelfReport(facts: OutcomeFacts): boolean {
  return facts.blockedLabelOnIssue || facts.record?.class === "blocked-self-report";
}

/**
 * The blocked comment: the exact outcome carried on the issue (ticket 05 Q7:
 * the human must SEE why it fell before deciding to resume). For a recorded
 * fall the record's JSON is embedded verbatim; for an abrupt one the absence
 * itself is the statement. The port mounts the agent marker on top.
 */
export function blockedCommentBody(record: OutcomeRecord | null, attempt?: number): string {
  if (record === null) {
    return (
      `worker blocked after 2 consecutive falls (attempt ${attempt ?? "unknown"}) — ` +
      "abrupt fall: no outcome record was written"
    );
  }
  return (
    `worker blocked after 2 consecutive falls (attempt ${record.attempt}) — the exact outcome record:\n\n` +
    JSON.stringify(record, null, 2)
  );
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
