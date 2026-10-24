import { appendFileSync } from "node:fs";

import { eventLogPath } from "../work-record/files.js";

/**
 * The factory's own records of an attempt (issues 102/112/118/144), named once:
 * the per-attempt event log (the JSONL the loop and the runtime append to) and
 * Sandcastle's stdout log. Both live under the work dir, and both are DERIVED
 * from the agent's output — which is why the verifiable-activity observation
 * excludes them (they would turn any line the factory writes into proof of
 * work).
 */
export {
  EVENT_LOG_PATTERN,
  SANDCASTLE_LOG_PATTERN,
  eventLogName,
  sandcastleLogName,
} from "../work-record/files.js";

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
  appendFileSync(eventLogPath(workDir, attempt), `${JSON.stringify({ attempt, ...event })}\n`, "utf8");
}
