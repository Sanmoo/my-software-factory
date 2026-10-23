import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelProviderBudget } from "../config.js";
import type { ModelProviderFailure } from "../runtime/model-provider-error.js";
import { renderWaits } from "./recovery.js";

/**
 * The model provider failure budget of a work (issue 144; terms in GLOSSARY):
 * an attempt whose stream ended in a model provider error is not an
 * interruption of the agent, so it retries on this dedicated allowance
 * instead of spending the interruption budget of issue 123. The ledger is an
 * artifact of the work (trabalhos/<repo>#<n>/provedor.json), so a restart
 * continues the count instead of renewing it; exhausting it parks the work
 * "awaiting model provider" and asks the operator for help — never a block,
 * and never an infinite retry.
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
  settledAt: string;
  /** The model provider's message at settlement. */
  message: string;
}

/**
 * The last model provider failure that ended the attempt, with its settlement.
 * `failureAt` is the failure's own identity (the stream's timestamp), so
 * re-reading the same settled failure after a restart is recognised instead of
 * counted twice.
 */
export type ModelProviderSettlement = {
  attempt: number;
  /** The failure's identity (the stream's timestamp, or its line) — never the settlement time. */
  failureAt: string;
  message: string;
  settledAt: string;
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
  /** The last provider failure that ended the attempt. */
  last: ModelProviderSettlement | null;
}

export function emptyModelProviderLedger(): ModelProviderLedger {
  return { attempt: 1, consumed: 0, events: [], last: null };
}

export type ModelProviderDecision =
  | { decision: "retry"; waitMs: number; consumed: number }
  | { decision: "await-provider"; consumed: number; reason: string };

/** A settlement and whether THIS call recorded it (the comment fires once). */
export type ModelProviderSettlementResult = ModelProviderDecision & { recorded: boolean };

/**
 * Read the provider ledger of a work. An absent or corrupt file is the honest
 * initial state: no retry was ever granted, nothing is invented and nothing is
 * deleted. A work that never met a provider failure reads exactly like one
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
    typeof event["settledAt"] === "string" &&
    typeof event["message"] === "string"
  );
}

function isSettlement(value: unknown): value is ModelProviderSettlement {
  if (value === null || typeof value !== "object") return false;
  const settlement = value as Record<string, unknown>;
  if (
    positiveInteger(settlement["attempt"]) === null ||
    typeof settlement["failureAt"] !== "string" ||
    typeof settlement["message"] !== "string" ||
    typeof settlement["settledAt"] !== "string"
  ) {
    return false;
  }
  if (settlement["granted"] === true) return typeof settlement["waitMs"] === "number";
  if (settlement["granted"] === false) {
    return settlement["waitMs"] === null && typeof settlement["helpRequested"] === "boolean";
  }
  return false;
}

async function writeLedger(workDir: string, ledger: ModelProviderLedger): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, MODEL_PROVIDER_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/**
 * The decision the current count supports for this failure, WITHOUT writing
 * the ledger. A retry reports the count AFTER its grant (1 is the first retry),
 * with the next wait by index (the last value repeats); an exhausted budget
 * reports awaiting. A failure already settled with a grant keeps its wait and
 * its count; one already awaiting stays awaiting while the budget is exhausted.
 */
export function modelProviderDecision(
  ledger: ModelProviderLedger,
  budget: ModelProviderBudget,
  attempt: number,
  failure: ModelProviderFailure,
): ModelProviderDecision {
  const scoped = ledgerForAttempt(ledger, attempt);
  if (isModelProviderFailureSettled(scoped, attempt, failure) && scoped.last?.granted === true) {
    return { decision: "retry", waitMs: scoped.last.waitMs, consumed: scoped.consumed };
  }
  if (scoped.consumed >= budget.maxRetries) {
    return { decision: "await-provider", consumed: scoped.consumed, reason: exhaustedModelProviderReason(budget) };
  }
  const index = scoped.consumed;
  return {
    decision: "retry",
    waitMs: budget.waitsMs[Math.min(index, budget.waitsMs.length - 1)] ?? 0,
    consumed: index + 1,
  };
}

/**
 * Settle one provider failure for the attempt and persist it BEFORE the
 * relaunch, so a death during the backoff or the session continues the count
 * instead of renewing it. Idempotent by the failure's identity: settling the
 * same failure again reports the standing decision without spending a second
 * retry. Exhausted, the failure is persisted as awaiting — the status and the
 * help request read it from here.
 */
export async function settleModelProviderFailure(
  workDir: string,
  budget: ModelProviderBudget,
  attempt: number,
  failure: ModelProviderFailure,
  now: () => Date = () => new Date(),
): Promise<ModelProviderSettlementResult> {
  const ledger = ledgerForAttempt(await readModelProviderLedger(workDir), attempt);
  const decision = modelProviderDecision(ledger, budget, attempt, failure);
  const settled = isModelProviderFailureSettled(ledger, attempt, failure);

  if (settled && ledger.last?.granted === true) return { ...decision, recorded: false };
  if (decision.decision === "await-provider" && settled) return { ...decision, recorded: false };

  const at = now().toISOString();
  if (decision.decision === "await-provider") {
    await writeLedger(workDir, {
      ...ledger,
      last: { attempt, failureAt: failure.at, message: failure.message, granted: false, waitMs: null, helpRequested: false, settledAt: at },
    });
    return { ...decision, recorded: true };
  }

  const event: ModelProviderRetryEvent = {
    index: ledger.consumed,
    waitMs: decision.waitMs,
    attempt,
    settledAt: at,
    message: failure.message,
  };
  await writeLedger(workDir, {
    ...ledger,
    consumed: ledger.consumed + 1,
    events: [...ledger.events, event],
    last: {
      attempt,
      failureAt: failure.at,
      message: failure.message,
      granted: true,
      waitMs: decision.waitMs,
      settledAt: at,
    },
  });
  return { ...decision, recorded: true };
}

/**
 * Record that the awaiting help request was posted, so a restart neither
 * repeats it nor loses it: a death after the ledger but before the comment
 * leaves `helpRequested: false`, and the next sweep asks again.
 */
export async function markModelProviderHelpRequested(
  workDir: string,
  attempt: number,
  failure: ModelProviderFailure,
): Promise<void> {
  const ledger = await readModelProviderLedger(workDir);
  const last = ledger.last;
  if (last === null || last.attempt !== attempt || last.failureAt !== failure.at || last.granted) return;
  if (last.helpRequested) return;
  await writeLedger(workDir, { ...ledger, last: { ...last, helpRequested: true } });
}

/**
 * Whether the work is waiting for its model provider: the last settled failure of
 * THIS attempt was not granted a retry and the budget is still exhausted. The
 * budget argument keeps the operator's lever honest — raising it revives the
 * work instead of leaving it awaiting.
 */
export function awaitingModelProvider(
  ledger: ModelProviderLedger,
  attempt: number,
  budget: ModelProviderBudget,
): boolean {
  if (ledger.last === null || ledger.last.attempt !== attempt || ledger.last.granted) return false;
  return ledger.consumed >= budget.maxRetries;
}

/** The awaiting's reason, naming the configured value and backoff. */
export function exhaustedModelProviderReason(budget: ModelProviderBudget): string {
  return (
    `the model provider budget is exhausted: ${budget.maxRetries} automatic retries ` +
    `(waits ${renderWaits(budget.waitsMs)}) were already used for this attempt`
  );
}

/** The ledger scoped to an attempt: its allowance is per attempt, its events
 *  stay as the work's history. */
function ledgerForAttempt(ledger: ModelProviderLedger, attempt: number): ModelProviderLedger {
  if (ledger.attempt === attempt) return ledger;
  return { ...ledger, attempt, consumed: 0 };
}

/** Whether the last settlement is this exact failure of this attempt. */
export function isModelProviderFailureSettled(
  ledger: ModelProviderLedger,
  attempt: number,
  failure: ModelProviderFailure,
): boolean {
  return ledger.last !== null && ledger.last.attempt === attempt && ledger.last.failureAt === failure.at;
}
