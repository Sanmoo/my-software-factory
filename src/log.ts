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

/** A duration in the operator's words: 45s, 3m, 1h5m — one rendering, shared
 *  by the cycle's logs and the desktop notices. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
