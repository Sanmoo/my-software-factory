import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reading a persisted JSON record of a work dir. `absent` is the honest empty
 * state (a dir older than the record); `unreadable` is an unknown that is never
 * treated as absent and never silently replaced. Both record files of the
 * registry (reservations, PR associations) answer in exactly this shape.
 */
export type PersistedFacts<T> =
  | { state: "persisted"; record: T }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

export async function readPersistedRecord<T>(
  dir: string,
  filename: string,
  /** What the reader calls the record in its diagnosis (e.g. "a reservation record"). */
  what: string,
  isRecord: (value: unknown) => value is T,
): Promise<PersistedFacts<T>> {
  let raw: string;
  try {
    raw = await readFile(join(dir, filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `cannot read ${filename}: ${describeError(error)}` };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { state: "unreadable", reason: `${filename} is not ${what}` };
    return { state: "persisted", record: parsed };
  } catch (error) {
    return { state: "unreadable", reason: `${filename} is not valid JSON: ${describeError(error)}` };
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
