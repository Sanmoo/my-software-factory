import type { Known } from "../tracker/port.js";

// P05: lower number = more urgent. A missing priority (null) keeps the candidate at the
// default level. An unknown priority is never read as absent: it ranks after every
// known priority, but still keeps the candidate.
export const DEFAULT_PRIORITY_RANK = 3;
export const UNKNOWN_PRIORITY_RANK = Number.MAX_SAFE_INTEGER;

export function normalizePriority(priority: Known<number | null>): number {
  if (!priority.known) return UNKNOWN_PRIORITY_RANK;
  return priority.value ?? DEFAULT_PRIORITY_RANK;
}
