/**
 * One JSONL line, read the same way by every artifact reader of the
 * continuity modules: the session transcript and the effect
 * journal are both one-JSON-object-per-line files, and both must refuse a
 * broken line out loud instead of dropping it silently.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The parsed value, or null when the line is not one JSON value. */
export function parseJsonLine(line: string): JsonValue | null {
  if (line.trim() === "") return null;
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
}

/** The parsed object, or null when the line is not one JSON object. */
export function parseJsonObject(line: string): Record<string, JsonValue> | null {
  const parsed = parseJsonLine(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, JsonValue>;
}
