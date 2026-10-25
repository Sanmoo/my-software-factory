import { renderWorkIdentity } from "../tracker/identity.js";
import type { WorkIdentity } from "../tracker/identity.js";
import {
  isModelProviderFailureSettled,
  isModelProviderHelpPending,
  isModelProviderRetryGranted,
  markModelProviderHelpRequested,
  modelProviderDecision,
  settleModelProviderFailure,
  type ModelProviderDecision,
} from "../pool/model-provider.js";
import { modelProviderAwaitingCommentBody } from "../state/outcome.js";
import {
  readModelProviderLedger,
  type ModelProviderLedger,
} from "../work-record/model-provider.js";
import type { ModelProviderFailure } from "../work-record/model-provider-error.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import type { NonFailureDeps } from "./non-failures.js";

/**
 * The model provider failure (issue 144; epic #198, ticket #207): an Attempt
 * whose turn ended in the model provider's own error (`stopReason: error` with
 * the provider's `errorMessage` in the session stream) — not in an interruption
 * of the agent (GLOSSARY).
 *
 * It retries on its OWN finite, persisted allowance with its own backoff, and it
 * never spends the interruption's recovery budget (issue 123) nor enters the fall
 * ruler. The ledger is an artifact of the Work record (provedor.json); the tables
 * of the allowance live in `pool/model-provider.ts`. What this module owns is the
 * ENDING: settling the failure exactly once, granting the retry with its wait, or
 * — the allowance exhausted — AWAITING THE MODEL PROVIDER: the Work keeps its
 * claim, is NOT blocked, and asks the operator for help naming the provider's
 * last message. A death between the ledger and the comment never loses the
 * request, and the request itself is never repeated.
 */

/** The part of the module that owns the model provider failure. */
export interface ProviderFailure {
  /**
   * Settle one model provider failure and apply the verdict it asks for: a retry
   * (with the wait the engine honours before relaunching the SAME attempt) or
   * awaiting the model provider (the operator was asked; nothing is launched).
   * Idempotent by the failure's identity: settling the same failure twice
   * records once.
   */
  settleModelProvider(
    work: WorkIdentity,
    dir: string,
    attempt: number,
    failure: ModelProviderFailure,
  ): Promise<ModelProviderDecision>;
}

export function openProviderFailure(deps: NonFailureDeps): ProviderFailure {
  return {
    settleModelProvider: (work, dir, attempt, failure) =>
      settleProvider(deps, work, dir, attempt, failure),
  };
}

async function settleProvider(
  deps: NonFailureDeps,
  work: WorkIdentity,
  dir: string,
  attempt: number,
  failure: ModelProviderFailure,
): Promise<ModelProviderDecision> {
  const budget = deps.config.modelProvider;
  const ledger = await readModelProviderLedger(dir);
  const decision = modelProviderDecision(ledger, budget, attempt, failure);

  await recordEvents(deps, dir, attempt, failure, ledger, decision);

  const settlement = await settleModelProviderFailure(dir, budget, attempt, failure, deps.now);
  if (settlement.decision === "awaiting-model-provider") {
    // The help request is retryable, not tied to the settlement that raised it: a
    // death between the ledger and the comment leaves it unrequested, and the
    // next sweep asks again.
    const helpPending = isModelProviderHelpPending(await readModelProviderLedger(dir), attempt, failure);
    if (helpPending) {
      // Keep the work reserved before asking — re-asserting the (already held)
      // claim is idempotent and is what the operator's answer resumes. Never the
      // blocked label: an exhausted model provider budget is not a Block.
      await deps.cycle.holdAndAsk(
        work,
        await modelProviderAwaitingCommentBody({
          attempt,
          failure,
          budget,
          workDir: dir,
          workspace: deps.workspace,
        }),
      );
      await markModelProviderHelpRequested(dir, attempt, failure);
      deps.log(
        `awaiting model provider for ${renderWorkIdentity(work)}: attempt ${attempt} ended by a model provider failure ` +
          `(${settlement.reason}) — a help request on the issue, never a block; the recovery budget is untouched`,
      );
    }
    return settlement;
  }

  if (settlement.recorded) {
    deps.log(
      `model provider failure on attempt ${attempt} of ${renderWorkIdentity(work)}: ${failure.message} — ` +
        `retry ${settlement.consumed}/${budget.maxRetries} after ${settlement.waitMs}ms ` +
        "(the recovery budget is untouched)",
    );
  }
  return settlement;
}

/**
 * The attempt's own log carries the failure and the retry it granted BEFORE the
 * ledger is written: a death between the two leaves the evidence (at worst a
 * repeated line), never a silent loss of the failure or of the retry it granted.
 */
async function recordEvents(
  deps: NonFailureDeps,
  dir: string,
  attempt: number,
  failure: ModelProviderFailure,
  ledger: ModelProviderLedger,
  decision: ModelProviderDecision,
): Promise<void> {
  if (!isModelProviderFailureSettled(ledger, attempt, failure)) {
    appendAttemptEvent(dir, attempt, {
      event: "model-provider-failure",
      message: failure.message,
      failureIdentity: failure.identity,
    });
  }
  if (decision.decision === "retry" && !isModelProviderRetryGranted(ledger, attempt, failure)) {
    appendAttemptEvent(dir, attempt, {
      event: "model-provider-retry",
      retry: decision.consumed,
      maxRetries: deps.config.modelProvider.maxRetries,
      waitMs: decision.waitMs,
    });
  }
}
