import type { Config } from "../config.js";
import type { GitWork, LocalWorkFacts } from "../git/port.js";
import type { WorkspaceLayout } from "../layout.js";
import type { ModelProviderDecision } from "../pool/model-provider.js";
import type { RemoteObservation } from "../pool/repair.js";
import type { RecoveryDecision } from "../pool/recovery.js";
import type { StopLaunch } from "../pool/stop.js";
import type { CallRecovery } from "../runtime/call-recovery.js";
import type { SessionResult, WorkerRuntime } from "../runtime/port.js";
import type { RepairTrigger } from "../pool/repair-trigger.js";
import type { PullRequestTracker, PullRequestRecord, TicketTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { IssueComment } from "../tracker/port.js";
import type { PauseRecord } from "../work-record/continuity.js";
import type { ModelProviderFailure } from "../work-record/model-provider-error.js";
import type { RepairAttempt } from "../work-record/repair.js";
import type { OperationalClass } from "../work-state/state.js";

/**
 * The launch (epic #198, ticket #205): the pipeline that turns one decided
 * launch into an attempt that ran — claim (or resume), prepare, the runtime
 * launch, the budget waits and the collection of every end it starts.
 *
 * It is the island under the engine's cycle. The engine reads the Work state,
 * turns it into the launch it wants, owns capacity and admittance, holds the
 * slot and applies the verdict of each end; everything between "this Work is
 * going out" and "this attempt ended" is here, in ONE path. Recovery, the model
 * provider retry, the resume after a requested stop and the feedback round all
 * come through {@link Launch.attempt}, so the ordering and the logs of every
 * kind of launch live in one file.
 *
 * The deps are given once: the ticket/PR ports, git, the runtime, the layout,
 * the config (with its budgets), the backoff timer and the engine's own side of
 * an admission ({@link LaunchCycle}). The caller never assembles the facts of a
 * launch: it hands a {@link Launchable}, which is the decision the Work state
 * already made, and receives the attempt the same admission continues — or
 * null when the work needs nothing more from it.
 */

/** What a launch starts as: a new claim, a parked feedback round, a retomada, a
 *  repair — or the continuation of an attempt that ended without its own
 *  outcome: the recovery of an interruption (issue 123) or the retry of a
 *  model provider failure (issue 144). */
export type LaunchKind = "claim" | "feedback" | "resume" | "repair" | "recover" | "model-provider-retry";

/**
 * One launch as the engine decided it, from the state and the reservation —
 * never a re-derivation of the Work from the current config.
 */
export interface Launchable {
  /** The Work as the reservation remembers it. */
  work: WorkIdentity;
  /** The Work's registry dir (its identity anchor). */
  dir: string;
  kind: LaunchKind;
  /** The ticket's title when the pool supplied it — presentation of the reservation. */
  title?: string;
  /** ISO 8601 — age-based priority inside each group; null for a recovery or a
   *  model provider retry, which wait for nothing human. */
  createdAt: string | null;
  /** The work's linked PR when the derivation saw one (the retomada reopens a closed one). */
  pr: PullRequestRecord | null;
  /** Human issue replies after the last agent marker, only for a retomada. */
  issueReplies?: IssueComment[];
  /** The confirmed impediments, only for a repair round. */
  repair?: RepairTrigger;
  /** The unpublished attempt this repair takes over (issue 112), when resuming. */
  resuming?: RepairAttempt | null;
  /** The attempt a recovery or a model provider retry continues — the SAME
   *  number (issues 123, 144). */
  attempt?: number;
  /** The attempt was ended by the operator's requested stop (issue #146): it
   *  resumes now, spending no recovery. */
  requestedStop?: boolean;
  callRecovery?: CallRecovery;
}

/**
 * The engine's side of an admission: every moment the pipeline asks the engine
 * to act. Each one is a duty of the cycle that stayed there — the verdict the
 * state's second reading asks for, the operational log's bookkeeping, the stop
 * protocol, the report and the slot. The pipeline decides WHEN; the engine owns
 * WHAT each one writes, so no write moved and no rule is decided twice.
 */
export interface LaunchCycle {
  /** This process is winding down on an operator's requested stop. */
  stopping(): boolean;
  /** Resolves the moment the requested stop begins: a pending admission's
   *  backoff ends with the admission, never after it. */
  readonly stopped: Promise<void>;
  /** Record the operational class an action or event lands the work in. */
  announce(work: WorkIdentity, resulting: OperationalClass | null): void;
  /** The requested stop cancels an admission that has not launched a worker:
   *  the grant it may hold is returned and the stop stays on record. */
  cancelAdmission(entry: StopLaunch, attempt: number): Promise<boolean>;
  /** The worker reached the runtime: the sweep reports it (even when the
   *  collection that follows fails). */
  launched(result: SessionResult): void;
  /** Collect one attempt's end: the Work state's second reading, and the
   *  verdict it asks for (the engine applies it). Resolves with the attempt
   *  the SAME admission continues, or null. */
  collect(launchable: Launchable, result: SessionResult, attempt: number): Promise<Launchable | null>;
  /** The recovered attempt's budget is exhausted: block and ask the operator. */
  pauseInterrupted(
    work: WorkIdentity,
    dir: string,
    attempt: number,
    decision: Extract<RecoveryDecision, { decision: "pause-help" }>,
  ): Promise<void>;
  /** Continuity cannot safely reopen the attempt: persist the pause and ask. */
  pauseForContinuity(work: WorkIdentity, dir: string, pause: PauseRecord, attempt: number): Promise<void>;
  /** Settle a model provider failure and apply the decision it asks for. */
  settleModelProviderFailure(
    work: WorkIdentity,
    dir: string,
    attempt: number,
    failure: ModelProviderFailure,
  ): Promise<ModelProviderDecision>;
  /** The local work on disk, or null when git cannot answer — never "nothing there". */
  inspectLocalWork(work: WorkIdentity): Promise<LocalWorkFacts | null>;
  /** The remote head now, or the honest uncertainty. */
  observeRemote(work: WorkIdentity): Promise<RemoteObservation>;
}

/** What the launch is given once: the ports, the budgets, the clock and the
 *  engine's side of an admission. */
export interface LaunchDeps {
  config: Config;
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
  runtime: WorkerRuntime;
  git: GitWork;
  workspace: WorkspaceLayout;
  log: (message: string) => void;
  /** The backoff before a relaunch; production waits on a real timer, a test
   *  injects one to observe the configured schedule. */
  wait?: (ms: number) => Promise<void>;
  cycle: LaunchCycle;
}

/** The launch module as a caller receives it. */
export interface Launch {
  /**
   * Claim (or resume), prepare, launch and collect one attempt; the reservation
   * lands BEFORE any launch. Resolves with the attempt the SAME admission
   * continues — an interruption inside the session (issue 123) or a model
   * provider retry (issue 144) returns the same attempt for the same held slot
   * — or null when the work needs nothing more from this admission. A failure
   * of any step propagates: the caller owns the slot and the failure path.
   */
  attempt(launchable: Launchable): Promise<Launchable | null>;
  /** The admissions that may still be carrying a worker (the stop's view). */
  admissions(): readonly StopLaunch[];
  /** Whether an admission of this launch carries the work right now. */
  carries(key: string): boolean;
}
