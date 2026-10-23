/**
 * The operator-facing renderings shared across the factory's surfaces — the
 * cycle's log, `msf status` and the desktop notices. Pure formatting only, so
 * `log.ts` (the operational record) and the view stay free of each other.
 */

/** An error's message on one line: for a log line or a refusal, never a stack. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A duration in the operator's words: 45s, 3m, 1h5m. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
