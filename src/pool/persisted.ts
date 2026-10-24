/// <reference types="node" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describeError } from "../format.js";

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

/** The file a work dir persists one kind of record in. */
export interface PersistedFile<T> {
  filename: string;
  /** What the reader calls the record in its diagnosis (e.g. "a reservation record"). */
  what: string;
  isRecord: (value: unknown) => value is T;
}

/**
 * Read one record synchronously: the launch path must not yield the event
 * loop between its dir reservation and the claim, and the
 * files are tiny.
 */
export function readPersistedRecord<T>(dir: string, file: PersistedFile<T>): PersistedFacts<T> {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file.filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `cannot read ${file.filename}: ${describeError(error)}` };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!file.isRecord(parsed)) return { state: "unreadable", reason: `${file.filename} is not ${file.what}` };
    return { state: "persisted", record: parsed };
  } catch (error) {
    return { state: "unreadable", reason: `${file.filename} is not valid JSON: ${describeError(error)}` };
  }
}

/**
 * Write a record atomically: a temp file in the same dir, then a rename. A
 * death mid-write leaves the previous record intact instead of a truncated
 * one — the difference between "older facts" and "unreadable".
 */
export function writePersistedRecord(dir: string, filename: string, record: unknown): void {
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${filename}.${process.pid}.${writeCounter++}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temp, join(dir, filename));
}

let writeCounter = 0;
