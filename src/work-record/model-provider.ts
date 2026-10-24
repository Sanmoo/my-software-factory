import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WorkRecordError } from "./errors.js";

/**
 * The model-provider part of a Work's record (issue 144): the persisted retry
 * allowance of an attempt ended by the model provider's own error, and the last
 * settlement. The DECISIONS (retry or await) stay with the domain module
 * (pool/model-provider.ts); the file and its schema live here, so the shape of
 * what ended the attempt has one owner.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const MODEL_PROVIDER_FILENAME = "provedor.json";

/** One granted model provider retry: its index, wait and the failure it answered. */
export interface ModelProviderRetryEvent {
  /** 0-based index; the wait schedule is indexed by it. */
  index: number;
  /** The backoff this retry is granted; the loop waits it before the relaunch. */
  waitMs: number;
  /** The attempt the retry continues — the same number, never a new one. */
  attempt: number;
  /** When the factory settled the failure — not the failure's own time. */
  at: string;
  /** The model provider's message at settlement. */
  message: string;
}

/**
 * The last model provider failure that ended the attempt, with its settlement.
 * `failureIdentity` is the failure's own identity (the stream's timestamp), so
 * re-reading the same settled failure after a restart is recognised instead of
 * counted twice.
 */
export type ModelProviderSettlement = {
  attempt: number;
  /** The failure's identity (the stream's timestamp, or its line) — never the settlement time. */
  failureIdentity: string;
  message: string;
  at: string;
} & (
  | { granted: true; waitMs: number }
  /** Awaiting: `helpRequested` keeps the help request retryable — a death
   *  after the ledger but before the comment never loses the request. */
  | { granted: false; waitMs: null; helpRequested: boolean }
);

export interface ModelProviderLedger {
  /** The attempt the count belongs to; a different attempt starts from zero. */
  attempt: number;
  /** Retries consumed by THIS attempt. */
  consumed: number;
  events: ModelProviderRetryEvent[];
  /** The last model provider failure that ended the attempt. */
  last: ModelProviderSettlement | null;
}

export function emptyModelProviderLedger(): ModelProviderLedger {
  return { attempt: 1, consumed: 0, events: [], last: null };
}

/**
 * Read the model provider ledger of a work. An absent or corrupt file is the honest
 * initial state: no retry was ever granted, nothing is invented and nothing is
 * deleted. A work that never met a model provider failure reads exactly like one
 * that never launched.
 */
export async function readModelProviderLedger(workDir: string): Promise<ModelProviderLedger> {
  let raw: string;
  try {
    raw = await readFile(join(workDir, MODEL_PROVIDER_FILENAME), "utf8");
  } catch {
    return emptyModelProviderLedger();
  }
  try {
    return parseLedger(JSON.parse(raw));
  } catch {
    return emptyModelProviderLedger();
  }
}

function parseLedger(value: unknown): ModelProviderLedger {
  if (value === null || typeof value !== "object") return emptyModelProviderLedger();
  const record = value as Record<string, unknown>;
  return {
    attempt: positiveInteger(record["attempt"]) ?? 1,
    consumed: nonNegativeInteger(record["consumed"]) ?? 0,
    events: Array.isArray(record["events"]) ? record["events"].filter(isEvent) : [],
    last: isSettlement(record["last"]) ? record["last"] : null,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isEvent(value: unknown): value is ModelProviderRetryEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    nonNegativeInteger(event["index"]) !== null &&
    typeof event["waitMs"] === "number" &&
    positiveInteger(event["attempt"]) !== null &&
    typeof event["at"] === "string" &&
    typeof event["message"] === "string"
  );
}

function isSettlement(value: unknown): value is ModelProviderSettlement {
  if (value === null || typeof value !== "object") return false;
  const settlement = value as Record<string, unknown>;
  if (
    positiveInteger(settlement["attempt"]) === null ||
    typeof settlement["failureIdentity"] !== "string" ||
    typeof settlement["message"] !== "string" ||
    typeof settlement["at"] !== "string"
  ) {
    return false;
  }
  if (settlement["granted"] === true) return typeof settlement["waitMs"] === "number";
  if (settlement["granted"] === false) {
    return settlement["waitMs"] === null && typeof settlement["helpRequested"] === "boolean";
  }
  return false;
}

/** Persist the ledger; every fact names the attempt it settles or continues. */
export async function writeModelProviderLedger(workDir: string, ledger: ModelProviderLedger): Promise<void> {
  assertLedgerNamesItsAttempts(ledger);
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, MODEL_PROVIDER_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function assertLedgerNamesItsAttempts(ledger: ModelProviderLedger): void {
  if (positiveInteger(ledger.attempt) === null) {
    throw new WorkRecordError(`the model provider ledger must name its attempt, got ${String(ledger.attempt)}`);
  }
  if (nonNegativeInteger(ledger.consumed) === null) {
    throw new WorkRecordError(`the model provider ledger's consumed count must be a non-negative integer, got ${String(ledger.consumed)}`);
  }
  for (const event of ledger.events) {
    if (!isEvent(event)) {
      throw new WorkRecordError("a model provider retry must name the attempt it continued");
    }
  }
  if (ledger.last !== null && !isSettlement(ledger.last)) {
    throw new WorkRecordError("a model provider settlement must name the attempt it ended");
  }
}
