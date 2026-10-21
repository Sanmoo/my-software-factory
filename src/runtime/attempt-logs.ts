/**
 * The factory's own records of an attempt (issues 102/112/118), named once:
 * the per-attempt event log (the JSONL the loop appends to) and Sandcastle's
 * stdout log. Both live under the work dir, and both are DERIVED from the
 * agent's output — which is why the verifiable-activity observation excludes
 * them (they would turn any line the factory writes into proof of work).
 */
export const eventLogName = (attempt: number): string => `log-${attempt}.jsonl`;

export const sandcastleLogName = (attempt: number): string => `sandcastle-${attempt}.log`;

/** The event log's name pattern — its number is the attempt it belongs to. */
export const EVENT_LOG_PATTERN = /^log-(\d+)\.jsonl$/;

/** Sandcastle's stdout log, matched by shape (it carries the attempt too). */
export const SANDCASTLE_LOG_PATTERN = /^sandcastle-.*\.log$/;
