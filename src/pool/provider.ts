import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderBudget } from "../config.js";
import type { ProviderFailure } from "../runtime/provider-error.js";
import { renderWaits } from "./recovery.js";

/**
 * The provider-failure budget of a work (issue 144; terms in GLOSSARY): an
 * attempt whose stream ended in a provider error is not an interruption of the
 * agent, so it retries on this dedicated allowance instead of spending the
 * interruption budget of issue 123. The ledger is an artifact of the work
 * (trabalhos/<repo>#<n>/provedor.json), so a restart continues the count
 * instead of renewing it; exhausting it parks the work "awaiting provider" and
 * asks the operator for help — never a block, and never an infinite retry.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const PROVIDER_FILENAME = "provedor.json";

/** One granted provider retry: its index, wait and the failure it answered. */
export interface ProviderRetryEvent {
  /** 0-based index; the wait schedule is indexed by it. */
  index: number;
  /** The backoff this retry is granted; the loop waits it before the relaunch. */
  waitMs: number;
  /** The attempt the retry continues — the same number, never a new one. */
  attempt: number;
  /** When the factory settled the failure. */
  at: string;
  /** The provider's message at settlement. */
  message: string;
}

/**
 * The last provider failure that ended the attempt, with its settlement. Its
 * `at` is the failure's own identity (the stream's timestamp), so re-reading
 * the same settled failure after a restart is recognised instead of counted
 * twice.
 */
export interface ProviderSettlement {
  attempt: number;
  /** The failure's identity — never the settlement time. */
  at: string;
  message: string;
  /** A retry was consumed for this failure. */
  granted: boolean;
  /** The granted wait; null while awaiting provider. */
  waitMs: number | null;
  settledAt: string;
}

export interface ProviderLedger {
  /** The attempt the count belongs to; a different attempt starts from zero. */
  attempt: number;
  /** Retries consumed by THIS attempt. */
  consumed: number;
  events: ProviderRetryEvent[];
  /** The last provider failure that ended the attempt. */
  last: ProviderSettlement | null;
}

export function emptyProviderLedger(): ProviderLedger {
  return { attempt: 1, consumed: 0, events: [], last: null };
}

export type ProviderDecision =
  | { decision: "retry"; waitMs: number; consumed: number }
  | { decision: "await-provider"; consumed: number; reason: string };

/** A settlement and whether THIS call recorded it (the comment fires once). */
export type ProviderSettlementResult = ProviderDecision & { recorded: boolean };

/**
 * Read the provider ledger of a work. An absent or corrupt file is the honest
 * initial state: no retry was ever granted, nothing is invented and nothing is
 * deleted. A work that never met a provider failure reads exactly like one
 * that never launched.
 */
export async function readProviderLedger(workDir: string): Promise<ProviderLedger> {
  let raw: string;
  try {
    raw = await readFile(join(workDir, PROVIDER_FILENAME), "utf8");
  } catch {
    return emptyProviderLedger();
  }
  try {
    return parseLedger(JSON.parse(raw));
  } catch {
    return emptyProviderLedger();
  }
}

function parseLedger(value: unknown): ProviderLedger {
  if (value === null || typeof value !== "object") return emptyProviderLedger();
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

function isEvent(value: unknown): value is ProviderRetryEvent {
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

function isSettlement(value: unknown): value is ProviderSettlement {
  if (value === null || typeof value !== "object") return false;
  const settlement = value as Record<string, unknown>;
  return (
    positiveInteger(settlement["attempt"]) !== null &&
    typeof settlement["at"] === "string" &&
    typeof settlement["message"] === "string" &&
    typeof settlement["granted"] === "boolean" &&
    (settlement["waitMs"] === null || typeof settlement["waitMs"] === "number") &&
    typeof settlement["settledAt"] === "string"
  );
}

async function writeLedger(workDir: string, ledger: ProviderLedger): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, PROVIDER_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/**
 * The decision the current count supports for this failure, WITHOUT consuming
 * it: the next wait by index (the last value repeats), or the awaiting that
 * asks the operator for help. A failure already settled with a grant keeps its
 * wait; one already awaiting stays awaiting while the budget is exhausted.
 */
export function providerDecision(
  ledger: ProviderLedger,
  budget: ProviderBudget,
  attempt: number,
  failure: ProviderFailure,
): ProviderDecision {
  const scoped = ledgerForAttempt(ledger, attempt);
  if (isSettled(scoped, attempt, failure) && scoped.last?.granted === true) {
    return { decision: "retry", waitMs: scoped.last.waitMs ?? 0, consumed: scoped.consumed };
  }
  if (scoped.consumed >= budget.maxRetries) {
    return { decision: "await-provider", consumed: scoped.consumed, reason: exhaustedProviderReason(budget) };
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
export async function settleProviderFailure(
  workDir: string,
  budget: ProviderBudget,
  attempt: number,
  failure: ProviderFailure,
  now: () => Date = () => new Date(),
): Promise<ProviderSettlementResult> {
  const ledger = ledgerForAttempt(await readProviderLedger(workDir), attempt);
  const decision = providerDecision(ledger, budget, attempt, failure);
  const settled = isSettled(ledger, attempt, failure);

  if (settled && ledger.last?.granted === true) return { ...decision, recorded: false };
  if (decision.decision === "await-provider" && settled) return { ...decision, recorded: false };

  const at = now().toISOString();
  if (decision.decision === "await-provider") {
    await writeLedger(workDir, {
      ...ledger,
      last: { attempt, at: failure.at, message: failure.message, granted: false, waitMs: null, settledAt: at },
    });
    return { ...decision, recorded: true };
  }

  const event: ProviderRetryEvent = {
    index: ledger.consumed,
    waitMs: decision.waitMs,
    attempt,
    at,
    message: failure.message,
  };
  await writeLedger(workDir, {
    ...ledger,
    consumed: ledger.consumed + 1,
    events: [...ledger.events, event],
    last: {
      attempt,
      at: failure.at,
      message: failure.message,
      granted: true,
      waitMs: decision.waitMs,
      settledAt: at,
    },
  });
  return { ...decision, recorded: true };
}

/**
 * Whether the work is waiting for its provider: the last settled failure of
 * THIS attempt was not granted a retry and the budget is still exhausted. The
 * budget argument keeps the operator's lever honest — raising it revives the
 * work instead of leaving it awaiting.
 */
export function awaitingProvider(
  ledger: ProviderLedger,
  attempt: number,
  budget: ProviderBudget,
): boolean {
  if (ledger.last === null || ledger.last.attempt !== attempt || ledger.last.granted) return false;
  return ledger.consumed >= budget.maxRetries;
}

/** The awaiting's reason, naming the configured value and backoff. */
export function exhaustedProviderReason(budget: ProviderBudget): string {
  return (
    `the provider budget is exhausted: ${budget.maxRetries} automatic retries ` +
    `(waits ${renderWaits(budget.waitsMs)}) were already used for this attempt`
  );
}

/** The ledger scoped to an attempt: its allowance is per attempt, its events
 *  stay as the work's history. */
function ledgerForAttempt(ledger: ProviderLedger, attempt: number): ProviderLedger {
  if (ledger.attempt === attempt) return ledger;
  return { ...ledger, attempt, consumed: 0 };
}

/** Whether the last settlement is this exact failure of this attempt. */
function isSettled(
  ledger: ProviderLedger,
  attempt: number,
  failure: ProviderFailure,
): boolean {
  return ledger.last !== null && ledger.last.attempt === attempt && ledger.last.at === failure.at;
}
