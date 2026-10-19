/**
 * Operational records: every line the factory emits while it runs carries a
 * UTC timestamp with an explicit `Z`, so events correlate across days and
 * machines. Presentation only — `status` and the workers' JSONL files never
 * pass through here.
 */
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
