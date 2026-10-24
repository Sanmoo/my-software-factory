/**
 * Operational records: every line the factory emits while it runs carries a
 * UTC timestamp with an explicit `Z`, so events correlate across days and
 * machines. Presentation only — `status` and the workers' JSONL files never
 * pass through here.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { describeError } from "./format.js";

/**
 * The durable operational log (issue 141): the CLI mirrors the stamped lines
 * into the workspace, so a retrospective round can read the factory's own
 * history (mounted read-only) instead of trusting the summary alone.
 */
export const OPERATIONAL_LOG_FILENAME = "operacional.log";

/** The workspace file the operational record lives in. */
export function operationalLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, OPERATIONAL_LOG_FILENAME);
}

/** Append one line to the workspace's operational log — the file a
 *  retrospective round reads, mounted read-only. A workspace it cannot write
 *  never takes the factory down: the console is the primary log. */
export function appendOperationalLog(workspaceRoot: string, line: string): void {
  try {
    appendFileSync(operationalLogPath(workspaceRoot), `${line}\n`, "utf8");
  } catch (error) {
    console.error(utcStamp(`operational log not written: ${describeError(error)}`));
  }
}

export function utcStamp(message: string): string {
  return `[${isoUtc(new Date())}] ${message}`;
}

/** The loop's log observation point, stamped; a missing callback stays a no-op. */
export function operationalLog(log?: (message: string) => void): (message: string) => void {
  return log === undefined ? () => {} : (message) => log(utcStamp(message));
}

/** ISO 8601 UTC at second precision — `2026-07-17T13:05:00Z`, never an offset. */
function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
