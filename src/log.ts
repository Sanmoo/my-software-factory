/**
 * Operational log records (issue 91): every line the factory emits while it
 * runs carries the date and time in UTC with an explicit `Z`, so events
 * correlate across days and machines. The prefix is presentation only — the
 * `status` output and the workers' JSONL files are separate contracts and
 * never pass through here.
 *
 * The clock is read directly (`new Date()`): the specification approves no
 * clock seam and no logging dependency, and the tests only validate the
 * format and that the instant sits between the observations around the act.
 */
export function utcStamp(message: string): string {
  return `[${utcTimestamp(new Date())}] ${message}`;
}

/**
 * Wrap the existing log observation point with the UTC prefix. A missing
 * callback stays a no-op; the loop and the CLI share this single formatter so
 * every operational record looks the same.
 */
export function operationalLog(log?: (message: string) => void): (message: string) => void {
  return log === undefined ? () => {} : (message) => log(utcStamp(message));
}

/** ISO 8601 in UTC at second precision — `2026-07-17T13:05:00Z`, never an offset. */
function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
