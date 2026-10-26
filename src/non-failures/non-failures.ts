import type { Config } from "../config.js";
import type { Launchable } from "../launch/launch.js";
import type { WorkspaceLayout } from "../layout.js";
import type { RecheckResult } from "../runtime/continuity.js";
import type { PullRequestTracker, TicketTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { PauseRecord } from "../work-record/continuity.js";
import { openContinuityPause, type ContinuityPause } from "./continuity-pause.js";
import { openProviderFailure, type ProviderFailure } from "./provider-failure.js";

/**
 * The two endings that are not a failure: the
 * **Continuity pause** and the **model provider failure** (terms in GLOSSARY).
 *
 * An Attempt ends without an Outcome record and without being a Fall in more
 * than one way, and the factory's conduct differs for each:
 *
 * - **Continuity pause** — the Attempt cannot safely continue (its session or an
 *   external effect remains unresolved), so the factory persists a hold, marks
 *   the ticket blocked and asks the operator ONCE. It spends no Attempt and no
 *   recovery, and it clears by itself when RELIABLE EVIDENCE resolves the cause,
 *   without requiring another human answer. An unreadable pause record is never
 *   read as its absence: the doubt IS the record, so the factory keeps waiting
 *   (and asks) instead of falling back to a recovery.
 * - **Model provider failure** — the Attempt's turn ended in the model
 *   provider's own error, not in an interruption of the agent. It retries on its
 *   own finite, persisted allowance with its own backoff; exhausting it means
 *   awaiting the model provider — the Work keeps its claim, is NOT blocked and
 *   asks the operator for help. It never spends the recovery budget of an
 *   interruption, and the recovery budget never spends its own.
 *
 * The module owns the DECISIONS of both endings — whether a pause is resolved or
 * still waits, the asking-once rule, the failure's own budget and backoff, and
 * what the end means (a continuation of the SAME Attempt, a hold, a comment, a
 * notice). The engine only EXECUTES what a verdict asks for and keeps the cycle:
 * it parks the continuation the module returns, blocks/holds the ticket and
 * delivers the notice through {@link NonFailureCycle}. Launching, capacity,
 * admission, the requested stop and the interruption's own recovery (ADR 0008,
 * stay exactly where they were.
 */

/**
 * What re-reading a persisted pause decided: the pause is settled and a
 * continuation is ready to be parked, or the operator is still waited for.
 */
export type PauseVerdict =
  | {
      /** Reliable evidence resolved the pause: the record is closed and the
       *  CORRECT continuation is ready. It is not launched from here, so every
       *  existing gate (liveness, continuity, the recovery ruler, the operator's
       *  stop) applies again. */
      kind: "continue";
      launch: Launchable;
    }
  /** The pause stands: the ticket stays blocked and the operator was asked
   *  (once) or the question is still the same one. Nothing is launched. */
  | { kind: "waiting" };

/**
 * The engine's side of these endings: the duties that STAY in the cycle because
 * they write to the tracker or own the operator's channel, plus the one fact
 * only the engine holds.
 */
export interface NonFailureCycle {
  /** Block the ticket and ask the operator: the blocked label, the comment on
   *  the issue and the notice. The module says WHEN and WITH WHAT words. */
  blockAndAsk(work: WorkIdentity, comment: string): Promise<void>;
  /** The same pause was announced already: re-assert the blocked label WITHOUT
   *  repeating the request (a failed retomada swapped it off). */
  reassertBlock(work: WorkIdentity): Promise<void>;
  /** Hold the claim and ask the operator: the claim, the comment and the notice
   *  — never the blocked label (an exhausted model provider budget is not a
   *  Block). */
  holdAndAsk(work: WorkIdentity, comment: string): Promise<void>;
  /** The block leaves with the pause: a resolved pause that continues the SAME
   *  attempt needs the claim back before its record is cleared. */
  unblock(work: WorkIdentity): Promise<void>;
  /** A worker of this Work may still be alive (an admission of this process or
   *  a survivor): the journal of that Work is never written and no substitute is
   *  launched over it. Only the engine knows; this module never reads liveness. */
  workerMayBeAlive(work: WorkIdentity): boolean;
}

/** What the module is opened with, once. */
export interface NonFailureDeps {
  config: Config;
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
  workspace: WorkspaceLayout;
  log: (message: string) => void;
  /**
   * The moment a settlement is written with. Injected so a test reaches the
   * persisted facts without waiting; production takes the real clock.
   */
  now?: () => Date;
  /**
   * Re-read the doubt a pause names — the attempt's own session, its effect
   * journal and the real state (`runtime/continuity.ts`). Injected: the read
   * stays behind this seam and the module decides what the evidence MEANS. A
   * test steers it; production reads the attempt's own artifacts, never an
   * mtime.
   */
  recheckEvidence: (
    work: WorkIdentity,
    dir: string,
    attempt: number,
    pause: PauseRecord,
  ) => Promise<RecheckResult>;
  cycle: NonFailureCycle;
}

/** The two endings as a caller receives them. */
export interface NonFailures extends ContinuityPause, ProviderFailure {}

export function openNonFailures(deps: NonFailureDeps): NonFailures {
  const continuity = openContinuityPause(deps);
  return { ...continuity, ...openProviderFailure(deps) };
}
