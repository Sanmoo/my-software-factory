import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { WorkRecordError } from "./errors.js";

/**
 * The factory's own records of an attempt (issues 102/112/118/144; Work
 * record, issue 187), named once: the per-attempt event log (the JSONL the
 * loop and the runtime append to) and Sandcastle's stdout log. Both live under
 * the work dir, and both are DERIVED from the agent's output — which is why
 * the verifiable-activity observation excludes them (they would turn any line
 * the factory writes into proof of work).
 */
export const eventLogName = (attempt: number): string => `log-${attempt}.jsonl`;

export const sandcastleLogName = (attempt: number): string => `sandcastle-${attempt}.log`;

/** The event log's name pattern — its number is the attempt it belongs to. */
export const EVENT_LOG_PATTERN = /^log-(\d+)\.jsonl$/;

/** Sandcastle's stdout log, matched by shape (it carries the attempt too). */
export const SANDCASTLE_LOG_PATTERN = /^sandcastle-.*\.log$/;

/**
 * Append one event to an attempt's log (the runtime and the loop share the one
 * writer, so a line's shape never drifts between them). The attempt number
 * always rides the line — the log's own number is presentation, the field is
 * the fact.
 */
export function appendAttemptEvent(
  workDir: string,
  attempt: number,
  event: Record<string, unknown>,
): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new WorkRecordError(`an attempt event must name its attempt, got ${String(attempt)}`);
  }
  appendFileSync(join(workDir, eventLogName(attempt)), `${JSON.stringify({ attempt, ...event })}\n`, "utf8");
}
