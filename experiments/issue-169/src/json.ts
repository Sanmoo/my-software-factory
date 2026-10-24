/** The JSON value domain Jira stores in an issue property. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const copy: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
  return copy as T;
}
