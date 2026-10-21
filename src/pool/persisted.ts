import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
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
  what: string,
  isRecord: (value: unknown) => value is T,
): Promise<PersistedFacts<T>> {
  let raw: string;
  try {
    raw = await readFile(join(dir, filename), "utf8");
  } catch (error) {
    return factsOfReadError<T>(filename, error);
  }
  return parsePersistedRecord(raw, filename, what, isRecord);
}

/** The same read, synchronous: the launch path must not yield the event loop
 *  between its dir reservation and the claim (issue 98's order). */
export function readPersistedRecordSync<T>(
  dir: string,
  filename: string,
  what: string,
  isRecord: (value: unknown) => value is T,
): PersistedFacts<T> {
  let raw: string;
  try {
    raw = readFileSync(join(dir, filename), "utf8");
  } catch (error) {
    return factsOfReadError<T>(filename, error);
  }
  return parsePersistedRecord(raw, filename, what, isRecord);
}

function parsePersistedRecord<T>(
  raw: string,
  filename: string,
  what: string,
  isRecord: (value: unknown) => value is T,
): PersistedFacts<T> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { state: "unreadable", reason: `${filename} is not ${what}` };
    return { state: "persisted", record: parsed };
  } catch (error) {
    return { state: "unreadable", reason: `${filename} is not valid JSON: ${describeError(error)}` };
  }
}

function factsOfReadError<T>(filename: string, error: unknown): PersistedFacts<T> {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
  return { state: "unreadable", reason: `cannot read ${filename}: ${describeError(error)}` };
}

/**
 * Write a record atomically: a temp file in the same dir, then a rename. A
 * death mid-write leaves the previous record intact instead of a truncated
 * one — the difference between "older facts" and "unreadable".
 */
export async function writePersistedRecord(dir: string, filename: string, record: unknown): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const temp = tempPath(dir, filename);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, join(dir, filename));
}

export function writePersistedRecordSync(dir: string, filename: string, record: unknown): void {
  mkdirSync(dir, { recursive: true });
  const temp = tempPath(dir, filename);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temp, join(dir, filename));
}

let writeCounter = 0;

function tempPath(dir: string, filename: string): string {
  return join(dir, `.${filename}.${process.pid}.${writeCounter++}.tmp`);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
