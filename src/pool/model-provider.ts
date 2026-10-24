import type { ModelProviderBudget } from "../config.js";
import type { ModelProviderFailure } from "../runtime/model-provider-error.js";
import {
  readModelProviderLedger,
  writeModelProviderLedger,
  type ModelProviderLedger,
  type ModelProviderRetryEvent,
  type ModelProviderSettlement,
} from "../work-record/model-provider.js";
import { renderWaits } from "./recovery.js";

/**
 * The model provider failure budget of a work (issue 144; terms in GLOSSARY):
 * an attempt whose stream ended in a model provider error is not an
 * interruption of the agent, so it retries on this dedicated allowance instead
 * of spending the interruption budget of issue 123. The ledger is an artifact
 * of the work (trabalhos/<repo>#<n>/provedor.json) — owned by the Work record
 * (issue 187), which keeps the file and its schema. This module keeps the
 * DECISIONS: idempotent settlement, the retry/await verdict and its reason.
 */

export {
  MODEL_PROVIDER_FILENAME,
  emptyModelProviderLedger,
  readModelProviderLedger,
  type ModelProviderLedger,
  type ModelProviderRetryEvent,
  type ModelProviderSettlement,
} from "../work-record/model-provider.js";

export type ModelProviderDecision =
  | { decision: "retry"; waitMs: number; consumed: number }
  | { decision: "awaiting-model-provider"; consumed: number; reason: string };

/** A settlement and whether THIS call recorded it (the comment fires once). */
export type SettledModelProviderDecision = ModelProviderDecision & { recorded: boolean };

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
    return { decision: "awaiting-model-provider", consumed: scoped.consumed, reason: exhaustedModelProviderReason(budget) };
  }
  const index = scoped.consumed;
  return {
    decision: "retry",
    waitMs: budget.waitsMs[Math.min(index, budget.waitsMs.length - 1)] ?? 0,
    consumed: index + 1,
  };
}

/**
 * Settle one model provider failure for the attempt and persist it BEFORE the
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
): Promise<SettledModelProviderDecision> {
  const ledger = ledgerForAttempt(await readModelProviderLedger(workDir), attempt);
  const decision = modelProviderDecision(ledger, budget, attempt, failure);
  const settled = isModelProviderFailureSettled(ledger, attempt, failure);

  if (isModelProviderRetryGranted(ledger, attempt, failure)) return { ...decision, recorded: false };
  if (decision.decision === "awaiting-model-provider" && settled) return { ...decision, recorded: false };

  const at = now().toISOString();
  if (decision.decision === "awaiting-model-provider") {
    await writeModelProviderLedger(workDir, {
      ...ledger,
      last: { attempt, failureIdentity: failure.identity, message: failure.message, granted: false, waitMs: null, helpRequested: false, at },
    });
    return { ...decision, recorded: true };
  }

  const event: ModelProviderRetryEvent = {
    index: ledger.consumed,
    waitMs: decision.waitMs,
    attempt,
    at,
    message: failure.message,
  };
  await writeModelProviderLedger(workDir, {
    ...ledger,
    consumed: ledger.consumed + 1,
    events: [...ledger.events, event],
    last: {
      attempt,
      failureIdentity: failure.identity,
      message: failure.message,
      granted: true,
      waitMs: decision.waitMs,
      at,
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
  if (!settlesFailure(last, attempt, failure) || last.granted || last.helpRequested) return;
  await writeModelProviderLedger(workDir, { ...ledger, last: { ...last, helpRequested: true } });
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

/** Whether this failure of this attempt was already settled WITH a retry: the
 *  settlement that must not be granted a second one, whatever the count says. */
export function isModelProviderRetryGranted(
  ledger: ModelProviderLedger,
  attempt: number,
  failure: ModelProviderFailure,
): boolean {
  const last = ledger.last;
  return settlesFailure(last, attempt, failure) && last.granted;
}

/** Whether this settled failure still owes its help request: awaiting, and
 *  the comment was not posted yet (a death between the ledger and the comment). */
export function isModelProviderHelpPending(
  ledger: ModelProviderLedger,
  attempt: number,
  failure: ModelProviderFailure,
): boolean {
  const last = ledger.last;
  return settlesFailure(last, attempt, failure) && !last.granted && !last.helpRequested;
}

/** Whether the last settlement is this exact failure of this attempt. */
export function isModelProviderFailureSettled(
  ledger: ModelProviderLedger,
  attempt: number,
  failure: ModelProviderFailure,
): boolean {
  return settlesFailure(ledger.last, attempt, failure);
}

/** The one test for "the last settlement is this failure of this attempt":
 *  the failure's own identity and the attempt are what make a settlement this
 *  one, never the time it was settled at. */
function settlesFailure(
  last: ModelProviderSettlement | null,
  attempt: number,
  failure: ModelProviderFailure,
): last is ModelProviderSettlement {
  return last !== null && last.attempt === attempt && last.failureIdentity === failure.identity;
}
