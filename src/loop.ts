import { randomUUID } from "node:crypto";

import type { Config } from "./config.js";
import type { IssueComment } from "./tracker/port.js";
import type { PullRequestRecord, PullRequestTracker, TicketTracker } from "./tracker/expanded-port.js";
import type { SessionResult, WorkerMaterial, WorkerRuntime } from "./runtime/port.js";
import type { GitWork, LocalWorkFacts } from "./git/port.js";
import {
  helpNotice,
  reviewNotice,
  factoryUnavailableNotice,
  interventionNotice,
  describeNotification,
  type Notification,
  type Notifier,
} from "./notify/port.js";
import { SESSIONS_SUBDIR, workDirOfKey, type WorkspaceLayout } from "./layout.js";
import {
  composedTicketSources,
  githubSelections,
  renderWorkIdentity,
  sourceKey,
  ticketUrl,
  type WorkIdentity,
} from "./tracker/identity.js";
import {
  reservationRecordOf,
  reserveWork,
  scanReservations,
  type IdentifiedReservation,
} from "./pool/reservation.js";
import { recordPrAssociation } from "./pool/pr-association.js";
import {
  deriveTrackerState,
  deriveReserved,
  fallbackDoneComment,
  humanCommentsForPause,
  readRepairPremise,
  repairSignature,
  workPullRequest,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  unbackedClaimKey,
  unmarkedReservationKey,
  type Reconciliation,
  type PoolEntry,
  type RepairTrigger,
  type ReservedDerivation,
  type ReservedWorkInput,
} from "./state/derive.js";
import {
  readOutcomeRecord,
  classifyOutcome,
  selfReportedBlocked,
  isRecordedFailure,
  ownWrittenOutcome,
  interruptionPausedCommentBody,
  modelProviderAwaitingCommentBody,
  continuityPausedCommentBody,
  type OutcomeRecord,
  type OutcomeRuling,
} from "./state/outcome.js";
import {
  readLaunchFacts,
  archiveDoneWorkFor,
  readAttemptLedger,
  readLastAttempt,
} from "./pool/registry.js";
import {
  EMPTY_REPAIR_CYCLE,
  MAX_REPAIR_FALLS,
  MAX_REPAIR_ROUNDS,
  hasRepairCycle,
  isSettledPublication,
  legacyRepairAttempt,
  readRepairCycle,
  reconcileRepairAttempt,
  writeRepairCycle,
  type RemoteObservation,
  type RepairAttempt,
  type RepairCycle,
  type RepairReconciliation,
} from "./pool/repair.js";
import { describeRemoteChange, renderLocalWork, shortSha } from "./state/repair-view.js";
import {
  confirmStopRequest,
  consumeRecovery,
  consumeStopRequest,
  readRecoveryLedger,
  recordFailure,
  recordInterruptionStop,
  recordStopRequest,
  recordUnconfirmedStop,
  refundRecovery,
  type RecoveryDecision,
} from "./pool/recovery.js";
import { workKeyOf, workOfKey } from "./pool/work-key.js";
import {
  isModelProviderFailureSettled,
  isModelProviderHelpPending,
  isModelProviderRetryGranted,
  markModelProviderHelpRequested,
  modelProviderDecision,
  readModelProviderLedger,
  settleModelProviderFailure,
  type ModelProviderDecision,
} from "./pool/model-provider.js";
import { COOPERATIVE_STOP_MS } from "./stop-signals.js";
import { deferred } from "./runtime/deferred.js";
import { planContinuity, recheckPausedEffects, type ContinuityDeps } from "./runtime/continuity.js";
import { pendingCallRecovery, type CallRecovery } from "./runtime/call-recovery.js";
import { ContinuityDiagnostics } from "./continuity-diagnostics.js";
import {
  clearPause,
  readEffectJournal,
  knownAttempt,
  readPause,
  recheckablePause,
  writePause,
  type PauseRecord,
} from "./runtime/continuity-artifacts.js";
import { Slots } from "./pool/slots.js";
import {
  freshDuplicates,
  idleWarningDue,
  observeSurvivorActivity,
  survivorWorkKeys,
  unavailableWarningDue,
  type SurvivorRecord,
  type UnavailableEpisode,
} from "./pool/survivors.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  capacityExcess,
  carriedWorkKeys,
  duplicateWorkers,
  occupiedSlots,
  probeLiveness,
  type LivenessObservation,
  type LivenessProbe,
} from "./state/liveness.js";
import { DEFAULT_IDLE_LIMIT_MS } from "./runtime/activity.js";
import { appendAttemptEvent, eventLogName } from "./runtime/attempt-logs.js";
import { processRecoveryRequests } from "./recover.js";
import { readTurnModelProviderError, type ModelProviderFailure } from "./runtime/model-provider-error.js";
import { operationalLog } from "./log.js";
import { collectFinishedWorks } from "./retro/window.js";
import { RetroBusyError, emptyWindowNotice, planAutomaticRound, runRetroRound } from "./retro/round.js";
import { describeError, formatDuration } from "./format.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The loop is the general workflow and is thin: the only module that knows
 * the process is a loop — owner of time (the fixed 60 s tick), of the --once
 * boundary and of waking by event (end of worker vs tick). It interlaces the
 * four phases deciding nothing of the domain: the states live in state/, the
 * liveness policy and the survivor ledger in state/ + pool/, and IO in
 * tracker/ + pool/ + git/ + runtime/ — the loop only reads the
 * facts and applies what they decide.
 *
 * The derivation of the tick covers the states of ALL reserved works (done ·
 * done-fallback · rejected · feedback · resumable — state/ decides, the loop
 * executes the tracker and disk writes), the launches
 * prioritize the parked reserved works before new claims by age, and the
 * continuous run wakes by event (end of worker), not only by the clock.
 */

export const TICK_MS = 60_000;

/** The production backoff timer; tests inject {@link LoopDeps.wait}. */
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoopDeps {
  config: Config;
  /** Ticket facts and mutations: claims, labels, comments, blockers, closure. */
  tickets: TicketTracker;
  /** PR/code-host facts: linkage, feedback, checks, the branch. */
  pullRequests: PullRequestTracker;
  runtime: WorkerRuntime;
  /** The git host side: one clone per target repo, work branch per work. */
  git: GitWork;
  workspace: WorkspaceLayout;
  /** Where the loop reports progress (the cli wires stdout here). */
  log?: (message: string) => void;
  /** Host-side notice delivery; absent = silent. */
  notifier?: Notifier;
  /** The liveness probe the operational cycle reads before deciding anything
   *  that could replace a worker. The composition (wireRunDeps) supplies the
   *  real read-only Docker probe; absent means this process sees only its own
   *  launches. Never a CLI flag — tests inject a fake probe. */
  probe?: LivenessProbe;
  /** The bound of one probe query; a hung Docker call is unknown, never a stall. */
  probeTimeoutMs?: number;
  /** The cycle's clock; tests inject one to exercise deadlines without waiting. */
  now?: () => number;
  /** The backoff seam before a recovery relaunch: production waits
   *  on a real timer; a test injects one to observe the configured schedule. */
  wait?: (ms: number) => Promise<void>;
}

/** The ruler's decided transition, as the sweep reports it. */
export interface AppliedRuling {
  decision: OutcomeRuling["decision"];
  because: string;
}

export interface CollectedWork {
  work: WorkIdentity;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The ruler's decided transition, applied at the act. */
  ruling: AppliedRuling;
}

/** The facts that settle one attempt's end: its own dir, its
 *  number, its consecutiveness and who ended it. */
interface AttemptEnd {
  dir: string;
  attempt: number;
  consecutiveFall: boolean;
  /** A worker this process launched, or a survivor whose exit Docker confirmed. */
  origin: "collected" | "survivor";
}

/** What applying the ruler produced: the next launch it asks for (if any), the
 *  PR fact the sweep reports, and the ruling itself. */
interface RulingApplied {
  next: Launchable | null;
  prConfirmed: boolean;
  ruling: AppliedRuling;
}

export interface SweepResult {
  pool: PoolEntry[];
  /** The states derived for every reserved work this sweep. */
  reserved: ReservedDerivation[];
  /** The tracker↔workspace reconciliation reported this sweep. */
  reconciliation: Reconciliation;
  launched: SessionResult[];
  collected: CollectedWork[];
  /** What the operator's stop left behind; null when none was requested. */
  stop: StopReport | null;
}

/**
 * The operator's stop as the run receives it: the first signal and
 * the second (the escalation), plus the cooperative window — a seam the tests
 * shorten to observe the deadline deterministically.
 */
export interface StopOptions {
  /** The first Ctrl-C/SIGTERM: close admissions and request the cooperative stop. */
  signal?: AbortSignal;
  /** The second Ctrl-C/SIGTERM: force the remaining workers now. */
  escalate?: AbortSignal;
  /** How long the cooperative phase lasts; defaults to ten seconds. */
  cooperativeMs?: number;
}

/**
 * The facts of one requested stop, for the operator and for the exit status:
 * the works the deadline/second signal forced, and the works whose worker the
 * factory could NOT confirm gone (those are held on the next run).
 */
export interface StopReport {
  forced: string[];
  unconfirmed: Array<{ key: string; because: string }>;
  /** Why the liveness probe could not answer: the factory cannot say that no
   *  worker survives, and never calls a stop safe on a guess. */
  unreadBecause: string | null;
}

/** The one verdict of a stop: safe only when every worker's end was confirmed
 *  and the factory could see the workspace while it concluded. */
export function stopConfirmed(report: StopReport): boolean {
  return report.unconfirmed.length === 0 && report.unreadBecause === null;
}

/** What the engine tracks of one launch while it may still be carrying a worker. */
interface InFlightLaunch {
  /** The Work as the reservation names it — its source is never re-derived. */
  work: WorkIdentity;
  /** The work's registry dir — where the stop evidence is persisted. */
  dir: string;
  /** The attempt the launch is on, known as soon as the registry answers. */
  attempt: number | null;
  /** The attempt a recovery continues, known before the registry is read. */
  attemptHint?: number;
  /** The worker session really started (the runtime was called). */
  launched: boolean;
  /** The ledger event of a recovery granted to this admission, so a return
   *  removes exactly it: non-null while the grant may still be unused. */
  recoveryIndex: number | null;
}

type OperationalClass = "eligible" | "reserved" | "feedback" | "resumable";

/**
 * The states consent never reopens: the work already reached a terminal
 * verdict, or a worker may still carry it. A blacklist, not a whitelist — a
 * newer state must not silently strand an authorization again (issue #128 hit
 * exactly that with `repair-fall-blocked`): consent answers the pause, so it
 * outranks the round the factory planned meanwhile.
 */
const TERMINAL_FOR_CONSENT: ReadonlySet<ReservedDerivation["state"]> = new Set([
  "done",
  "done-fallback",
  "rejected",
  "stop-unconfirmed",
]);

export function consentAppliesTo(state: ReservedDerivation["state"]): boolean {
  return !TERMINAL_FOR_CONSENT.has(state);
}

/**
 * The class each reserved derivation state contributes to the observed state;
 * `null` means the work leaves it (a done work is archived by the same tick).
 * An action's announced class can differ from this derivation class — a
 * released fall lands eligible.
 */
const RESERVED_OPERATIONAL_CLASS = {
  done: null,
  "done-fallback": null,
  rejected: "reserved",
  idle: "reserved",
  fall: "reserved",
  interrupted: "reserved",
  "model-provider-failure": "reserved",
  "stop-resume": "reserved",
  "stop-unconfirmed": "reserved",
  "continuity-paused": "reserved",
  unknown: "reserved",
  feedback: "feedback",
  resumable: "resumable",
  repair: "reserved",
  "repair-recovered": "reserved",
  "repair-blocked": "reserved",
  "repair-fall-blocked": "reserved",
} satisfies Record<ReservedDerivation["state"], OperationalClass | null>;

/**
 * The derivations that presume a worker has stopped: while Docker
 * cannot answer, archiving an attempt whose worker may be alive, spending an
 * attempt or recovery on a silence, or publishing a block over a worker that
 * may still be writing are exactly the presumptions to avoid.
 */
const HOLDS_WHILE_LIVENESS_UNKNOWN: ReadonlySet<ReservedDerivation["state"]> = new Set([
  "done",
  "done-fallback",
  "fall",
  "interrupted",
  "model-provider-failure",
  "continuity-paused",
  "rejected",
  "repair-fall-blocked",
  "repair-blocked",
]);

/** In-flight counts as reserved. Titles and order never enter — the schedule order stays untouched. */
function operationalState(
  pool: readonly PoolEntry[],
  reserved: readonly ReservedDerivation[],
  inFlight: ReadonlySet<string>,
): Map<string, OperationalClass> {
  const state = new Map<string, OperationalClass>();
  for (const entry of pool) state.set(workKeyOf(entry.work), "eligible");
  for (const decision of reserved) {
    const key = workKeyOf(decision.work);
    const operationalClass = RESERVED_OPERATIONAL_CLASS[decision.state];
    if (operationalClass !== null && !state.has(key)) state.set(key, operationalClass);
  }
  for (const key of inFlight) if (!state.has(key)) state.set(key, "reserved");
  return state;
}

function changedWorkKeys(
  previous: ReadonlyMap<string, OperationalClass>,
  next: ReadonlyMap<string, OperationalClass>,
): string[] {
  const changed: string[] = [];
  for (const [key, operationalClass] of next) {
    if (previous.get(key) !== operationalClass) changed.push(key);
  }
  for (const key of previous.keys()) if (!next.has(key)) changed.push(key);
  return changed;
}

/** The rulings that end in an occurrence the operator must see (a block and
 *  the done already notify; an interruption is absorbed by its budget). */
function needsOccurrenceNotice(ruling: OutcomeRuling): boolean {
  return (
    ruling.decision === "reserve" ||
    ruling.decision === "record-only" ||
    ruling.decision === "release"
  );
}

/** A recovery (no human age) goes first; the rest by creation age, then key. */
function byParkedPriority(a: Launchable, b: Launchable): number {
  if (a.createdAt === null || b.createdAt === null) {
    if (a.createdAt === b.createdAt) return workKeyOf(a.work).localeCompare(workKeyOf(b.work));
    return a.createdAt === null ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt) || workKeyOf(a.work).localeCompare(workKeyOf(b.work));
}

/**
 * The pause as it is PERSISTED and announced, now that the factory knows which
 * work and attempt it is pausing, and with its occurrence identity (issue 174).
 * An unreadable record carries no work and no attempt (0); writing those into
 * the file and the operator's comment would fabricate facts the record never
 * held. Every other reason keeps its own.
 */
function pauseOccurrence(
  pending: PauseRecord,
  work: WorkIdentity,
  attempt: number,
  previous: PauseRecord | null,
): PauseRecord & { id: string } {
  const pause = persistedPause(pending, work, attempt);
  const id = pause.id ?? previous?.id ?? randomUUID();
  // A record of the SAME occurrence keeps the moment it started; a new one
  // starts now (the pause itself carries the time it was created). A previous
  // record with no identity is that same occurrence still waiting — written
  // before identities existed — so the request the operator already answered
  // keeps its own start time instead of being dated by this sweep. A record
  // with no time at all (unreadable) has none to keep.
  const sameOccurrence = previous !== null && (previous.id === undefined || previous.id === id);
  const at = sameOccurrence && previous.at !== "" ? previous.at : pause.at;
  return { ...pause, id, at };
}

/**
 * The work and attempt a pause is persisted with. An unreadable record carries
 * neither; every other reason keeps its own, so the attempt the launch planned
 * is not rewritten into one the disk evidences.
 */
function persistedPause(pause: PauseRecord, work: WorkIdentity, attempt: number): PauseRecord {
  if (pause.reason !== "record-unreadable") return pause;
  // `readPause` fabricates no attempt for an unreadable record, so the caller's
  // is the only one there is.
  return { ...pause, work, attempt };
}

/**
 * The record of a pause whose request already landed (the block and the
 * comment are being re-asserted, never repeated). A legacy occurrence — one
 * announced before identities existed — stays WITHOUT one: the identity
 * generated for it now has no comment carrying it, and a record with no
 * identity is the one case where the factory still binds the answers by the
 * generic last-comment rule, so stamping it would orphan the answer already
 * given (issue 174). The occurrence gains its identity with the first factory
 * comment that can carry one: a diagnostic for a changed cause.
 */
function reassertedPause(pause: PauseRecord & { id: string }, previous: PauseRecord): PauseRecord {
  if (previous.id !== undefined) return { ...pause, announced: true };
  const { id: _generated, ...occurrence } = pause;
  return { ...occurrence, announced: true };
}

/** The stable rendering order of a key set — presentation only, never the schedule. */
const byKey = (keys: Iterable<string>): string[] => [...keys].sort((a, b) => a.localeCompare(b));

/** Remove a settled waiter from the array it parked in: the arrays live as
 *  long as the run, and a stop may be waited out many times. */
function dropWaiter(waiters: Array<() => void>, waiter: () => void): void {
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
}

/**
 * The first observation renders the whole composition; later ones only what
 * changed. A swap with equal counts still names both works involved.
 */
function renderPoolSummary(
  state: ReadonlyMap<string, OperationalClass>,
  previous: ReadonlyMap<string, OperationalClass> | null,
  changed: readonly string[],
): string {
  let eligible = 0;
  for (const operationalClass of state.values()) if (operationalClass === "eligible") eligible += 1;
  const reserved = state.size - eligible;
  const head = `derived pool: ${eligible} eligible work(s), ${reserved} reserved work(s)`;

  const detail =
    previous === null
      ? byKey(state.keys())
          .map((key) => `${key} (${state.get(key)})`)
          .join(", ")
      : byKey(changed)
          .map((key) => {
            const now = state.get(key);
            const before = previous.get(key);
            if (now !== undefined && before === undefined) return `+ ${key} (${now})`;
            if (now === undefined) return `- ${key} (was ${before})`;
            return `~ ${key} (${before}→${now})`;
          })
          .join(", ");
  return detail === "" ? head : `${head} — ${detail}`;
}

/** What a launch starts as: a new claim, a parked feedback round, a retomada, a
 *  repair — or the continuation of an attempt that ended without its own
 *  outcome: the recovery of an interruption or the retry of a model provider
 *  failure. */
type LaunchKind = "claim" | "feedback" | "resume" | "repair" | "recover" | "model-provider-retry";

interface Launchable {
  /** The Work as the reservation remembers it — never re-derived from config. */
  work: WorkIdentity;
  /** The Work's registry dir (its identity anchor). */
  dir: string;
  kind: LaunchKind;
  /** The ticket's title when the pool supplied it — presentation of the reservation. */
  title?: string;
  /** ISO 8601 — age-based priority inside each group; null for a recovery or a
   *  model provider retry, which wait for nothing human and are launched before
   *  the parked rounds. */
  createdAt: string | null;
  /** The work's linked PR when the derivation saw one (the retomada reopens a closed one). */
  pr: PullRequestRecord | null;
  /** Human issue replies after the last agent marker, only for a retomada. */
  issueReplies?: IssueComment[];
  /** The confirmed impediments, only for a repair round. */
  repair?: RepairTrigger;
  /** The unpublished attempt this repair takes over, when resuming. */
  resuming?: RepairAttempt | null;
  /** The attempt a recovery or a model provider retry continues — the SAME
   *  number. */
  attempt?: number;
  /** The attempt was ended by the operator's requested stop: it
   *  resumes now, spending no recovery. */
  requestedStop?: boolean;
  callRecovery?: CallRecovery;
}

/**
 * One sweep engine, four phases: derivation (+ the reserved
 * actions decided by state/), launches into free slots (parked reserved
 * first, then new claims by age), collection at the act of each worker's
 * end (régua applied, slot replenished in the same cycle), and the wait for
 * the next event. The --once boundary awaits everything launched; the
 * continuous run keeps sweeping on the tick and wakes by event.
 */
export class SweepEngine {
  private readonly slots: Slots;
  private readonly continuityDiagnostics = new ContinuityDiagnostics();
  /** The full pool of the latest derivation — what `runOnce` reports. */
  lastPool: PoolEntry[] = [];
  /** The working copy the launches drain (parked reserved first). */
  private cache: PoolEntry[] = [];
  private parkedQueue: Launchable[] = [];
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;
  /** The requested stop in progress; null before any request. */
  private requestedStopRun: Promise<StopReport> | null = null;
  /** Resolves the moment a requested stop begins — the boundary's wake. */
  private readonly requestedStopBegan = deferred();
  /** The launches that may still be carrying a worker, by work key. */
  private readonly inFlight = new Map<string, InFlightLaunch>();
  /** Waiters of the backoff wait — the requested stop ends the wait at once. */
  private readonly stopWaiters: Array<() => void> = [];
  /** Waiters of the cooperative phase — the escalation ends it at once. */
  private readonly escalationWaiters: Array<() => void> = [];
  /** The second signal arrived: force what the cooperative window left. */
  private escalated = false;
  private readonly cooperativeMs: number;
  /** The works held by an unconfirmed stop, with the reason last logged. */
  private readonly reportedStopHolds = new Map<string, string>();
  private readonly endedWaiters: Array<{ fire: (event: WakeEvent) => void }> = [];
  /** The previous observation only — process-local, never persisted. */
  private lastState: Map<string, OperationalClass> | null = null;
  /** The leftovers reported on the previous sweep — report once per appearance. */
  private reportedReconciliation = new Set<string>();
  /** The reconciliation derived by the latest tick — what `runOnce` reports. */
  lastReconciliation: Reconciliation = { unbackedClaims: [], unmarkedReservations: [] };
  /** The class each action/event announced this interval (`null` = left); cleared after each observation. */
  private readonly announced = new Map<string, OperationalClass | null>();
  readonly launched: SessionResult[] = [];
  readonly collected: CollectedWork[] = [];
  /** The retrospective round in flight — its own lane, never a slot. */
  private retroRun: Promise<void> | null = null;

  // ---- liveness and the surviving workers ----
  /** The latest probe answer — read before every decision that could replace
   *  a worker; `unknown` suspends launches instead of guessing. */
  private liveness: LivenessObservation = { state: "known", workers: [] };
  /** The workers a reliable probe showed and this process did not launch. */
  private readonly survivors = new Map<string, SurvivorRecord>();
  /** The recoveries the ended survivors' reconciliation asks for, flushed by
   *  the next derivation (a recovery is never spent while liveness is unknown). */
  private survivorRecoveries: Launchable[] = [];
  /** The current Docker-unavailability episode: when it began and whether its
   *  one warning was already raised. */
  private livenessEpisode: UnavailableEpisode | null = null;
  /** The works whose duplicate containers were already reported. */
  private announcedDuplicates: ReadonlySet<string> = new Set();
  /** Live containers whose reservation names no Work this composition can
   *  address: said once, and once more when the worker is gone — never a line
   *  per tick. */
  private readonly heldSurvivors = new Set<string>();
  /** The reason each held reservation was last reported: said once per
   * appearance, re-said only when the reason changes. */
  private reportedReservationHolds = new Map<string, string>();
  /** The last reported capacity verdict, so the change is said once. */
  private overCapacity = false;

  // Prepare (clone/fetch/branch) touches the shared clone of a repo — two
  // first-launches of the same repo must not race inside it. The serialization
  // stays local to prepares; the launches themselves run concurrently.
  private readonly preparing = new Map<string, Promise<void>>();

  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: LoopDeps,
    stop: StopOptions = {},
  ) {
    this.slots = new Slots(deps.config.concurrency);
    this.log = operationalLog(deps.log);
    this.cooperativeMs = stop.cooperativeMs ?? COOPERATIVE_STOP_MS;
    // The signals are listened to from the START of the run: a
    // stop requested during the derivation, before the first admission, is
    // honoured exactly like one during a worker.
    if (stop.signal?.aborted === true) {
      // A stop requested before the engine existed (a signal during the
      // startup) never fires the listener: it closes admission right here.
      void this.beginRequestedStop();
    } else {
      stop.signal?.addEventListener("abort", () => void this.beginRequestedStop(), { once: true });
    }
    if (stop.escalate?.aborted === true) this.escalate();
    else stop.escalate?.addEventListener("abort", () => this.escalate(), { once: true });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Phase 2 (derivation) + the reserved actions it decides: WHO is reserved
   * comes from the registry's dirs on disk (what survives a restart); the
   * states come from the port. Done works are archived and cleaned, the
   * fallback closes their issue first, rejections go blocked with the PR
   * pointed out. The parked queue (feedback, retomada — by age) and the
   * cached pool (by age) are what the launches draw from.
   */
  async deriveAndAct(): Promise<ReservedDerivation[]> {
    const { config, workspace } = this.deps;

    // The liveness facts come FIRST: a decision that could
    // substitute a worker or end its resources reads them, and the survivor
    // ledger keeps the executions that outlived a previous factory process.
    await this.observeLiveness();
    // WHO is reserved is what the reservation on disk says — a work's source is
    // never reconstructed from the current selection configuration.
    const reservations = await scanReservations(workspace);
    // The guard is about the SOURCES the composed adapter serves, never about
    // the configured repos: a repo leaving the selection never strands a
    // reserved Work — done, archive and recovery still apply to it. A Work from
    // a source the composition does not serve is held where
    // it is: no adapter is substituted, no tracker migration happens.
    const served = new Set(composedTicketSources().map(sourceKey));
    const serveable: IdentifiedReservation[] = [];
    const held: Array<{ key: string; reason: string }> = [];
    for (const entry of reservations) {
      if (entry.work === null) {
        held.push({
          key: entry.key,
          reason:
            `has no trustworthy identity (` +
            `${entry.reservation.state === "unreadable" ? entry.reservation.reason : "no reservation record"}) — ` +
            "held; nothing is invented from the current configuration",
        });
        continue;
      }
      if (!served.has(sourceKey(entry.work.ticket))) {
        const source = entry.work.ticket;
        held.push({
          key: entry.key,
          reason:
            `comes from ${source.provider} on ${source.site}, which the composed ticket adapter does not serve — ` +
            "held; no adapter is substituted and no tracker migration happens",
        });
        continue;
      }
      serveable.push({ ...entry, work: entry.work });
    }
    this.reportReservationHolds(held);
    // The same list feeds the survivor reconciliation and the derivation: a
    // held Work is held on EVERY path, never launched just because a container
    // still carries it.
    const reservationByKey = new Map(serveable.map((entry) => [entry.key, entry]));
    const settled = await this.observeSurvivors(reservationByKey);
    this.observeCapacity();
    const suspended = this.liveness.state === "unknown";
    const surviving = [...this.carriedKeys];

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight). The
    // in-flight set also goes INTO the derivation: a zero-
    // footprint claim inside it is a legit launch between the claim and the
    // worker's first write — held; outside it, an interruption to recover.
    // Surviving workers and the works just settled join it: a
    // live worker keeps its work reserved, and a settled exit is not decided
    // twice in the same sweep.
    const inFlight = new Set([...this.slots.workKeys, ...surviving, ...settled]);
    // The pool is read from the configured selections — the same repos the
    // operator names, never a second source of truth.
    const selections = githubSelections(config.repos);
    const allReserved: ReservedWorkInput[] = serveable.map((entry) => ({
      work: entry.work,
      dir: entry.dir,
    }));
    const reservedWorks = allReserved.filter((work) => !inFlight.has(workKeyOf(work.work)));

    // The repair reconciliation runs BEFORE the derivation: a
    // repair attempt that fell is settled against the remote first, so the
    // derivation reads the verdict (resume, block, or uncertainty) instead of
    // a charged round that never published. Unknown liveness holds it too:
    // a worker may still be writing the branch its verdict reads.
    if (!suspended && !this.stopping) {
      await processRecoveryRequests(config, {
        probe: this.deps.probe ?? (async () => []), inFlight,
        log: (line) => this.log(line),
      });
    }
    if (!suspended) await this.reconcileRepairAttempts(allReserved, inFlight);

    // A stop whose confirmation failed on the previous invocation is settled
    // BEFORE the derivation: the work only resumes once the
    // previous worker is known to be gone.
    await this.reconcileUnconfirmedStops(allReserved, inFlight);

    const derived = await deriveReserved(
      this.deps.tickets,
      this.deps.pullRequests,
      reservedWorks,
      config.labels,
      config.workerGhAccount,
      workspace,
      config.recovery,
      config.modelProvider,
      inFlight,
    );

    // The actions state/ decided — executed here, in the loop's IO duty.
    const parked: Launchable[] = [];
    const heldWhileUnknown: string[] = [];
    for (const decision of derived) {
      // Liveness unknown means no worker can be ruled out: a
      // decision that would archive/clean, spend the attempt or its recovery
      // budget must wait for a reliable answer — never presume a stop.
      if (suspended && HOLDS_WHILE_LIVENESS_UNKNOWN.has(decision.state)) {
        heldWhileUnknown.push(workKeyOf(decision.work));
        continue;
      }
      const key = workKeyOf(decision.work);
      if (await this.parkAuthorizedCallRetry(decision, parked)) continue;
      switch (decision.state) {
        case "done": {
          this.log(`derived ${key}: issue closed — done; archiving artifacts, cleaning branches`);
          await this.finishWork(decision.work);
          this.announce(decision.work, null);
          break;
        }
        case "done-fallback": {
          this.log(
            `derived ${key}: PR merged without closing the issue — ` +
              "the factory closes it (fallback of the linkage), then archives",
          );
          await this.completeMergedWork(decision.work, decision.comment);
          this.announce(decision.work, null);
          break;
        }
        case "rejected": {
          this.log(
            `derived ${key}: PR closed without merge — rejected, ` +
              "blocked with a comment pointing at the PR",
          );
          await this.applyBlockWithComment(decision.work, decision.comment);
          this.announce(decision.work, "reserved");
          break;
        }
        case "fall": {
          // A WRITTEN failure the factory died before ruling: it consumes the
          // attempt and the ruler applies as at collection.
          const dir = decision.dir;
          await this.settleFailure(dir, decision.attempt, await readOutcomeRecord(dir));
          if (decision.decision === "release") {
            this.log(
              `derived ${key}: unreconciled failure (the factory died before ruling it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await this.applyRelease(decision.work);
            this.announce(decision.work, "eligible");
          } else {
            this.log(
              `derived ${key}: 2nd consecutive fall, unreconciled — ` +
                "blocked with the attempt's diagnosis on the issue",
            );
            await this.applyBlockWithComment(decision.work, decision.comment);
            this.announce(decision.work, "reserved");
          }
          break;
        }
        case "interrupted": {
          // The same attempt continues within its budget; an exhausted budget
          // pauses it and asks the operator for help.
          if (decision.recovery.decision === "pause-help") {
            await this.pauseInterrupted(decision.work, decision.dir, decision.attempt, decision.recovery);
          } else {
            this.log(
              `derived ${key}: attempt ${decision.attempt} was interrupted (no outcome record) — ` +
                `recovery ${decision.recovery.consumed}/${config.recovery.maxRecoveries} will continue it after ` +
                `${decision.recovery.waitMs}ms`,
            );
            parked.push({
              work: decision.work,
              dir: decision.dir,
              kind: "recover",
              // A recovery waits for nothing human: it sorts before the parked
              // feedback rounds, which carry their own creation time.
              createdAt: null,
              pr: null,
              attempt: decision.attempt,
            });
          }
          break;
        }
        case "model-provider-failure": {
          // A model provider outage is not an interruption of the agent:
          // it retries on its own budget, or awaits the operator when that
          // budget is exhausted — never the recovery budget, never a block.
          if (decision.modelProvider.decision === "awaiting-model-provider") {
            await this.applyModelProviderFailure(
              decision.work,
              decision.dir,
              decision.attempt,
              decision.failure,
            );
          } else {
            parked.push({
              work: decision.work,
              dir: decision.dir,
              kind: "model-provider-retry",
              // A retry waits for nothing human: like a recovery, it sorts
              // before the parked feedback rounds.
              createdAt: null,
              pr: null,
              attempt: decision.attempt,
            });
          }
          break;
        }
        case "stop-resume": {
          // The operator's requested stop: the same attempt
          // resumes on this invocation, without spending the budget.
          this.log(
            `derived ${key}: attempt ${decision.attempt} ended by the operator's ` +
              "requested stop — resuming it now (no recovery is spent)",
          );
          parked.push({
            work: decision.work,
            dir: decision.dir,
            kind: "recover",
            createdAt: null,
            pr: null,
            attempt: decision.attempt,
            requestedStop: true,
          });
          break;
        }
        case "stop-unconfirmed": {
          // Nothing is launched: a previous worker may still carry the work.
          // The diagnostic was said by the reconciliation above.
          this.announce(decision.work, "reserved");
          break;
        }
        case "continuity-paused": {
          // Continuity could not safely reopen the attempt's session (issue
          // 119). The pause is persisted and asks for help once; every sweep
          // re-reads the doubt this pause names — a terminal result in the
          // attempt's own session, or the real state — and clears it on its own
          // once that evidence settles it (issue 173). Other works keep going.
          const pause = decision.pause;
          const attempt = knownAttempt(pause.attempt) ?? decision.attempt;
          this.announce(decision.work, "reserved");
          // A worker of this work may still be alive — one this process
          // launched, or one a reliable probe carried. Its journal is never
          // written and no substitute is launched over it (issue 173).
          if (this.slots.workKeys.includes(key) || this.carriedKeys.has(key)) {
            this.log(
              `continuity of ${renderWorkIdentity(decision.work)} is not re-evaluated: a worker of this work ` +
                "may still be alive — nothing is written and nothing is relaunched",
            );
            break;
          }
          // A pause the factory can settle by itself returns to the normal
          // cycle: the evidence it doubts is read again from the attempt's own
          // session, the journal and the real state, WITHOUT another human
          // answer (issue 173). The one cause never re-read is a record it
          // cannot read — that doubt IS the record.
          const verdict = recheckablePause(pause.reason)
            ? await recheckPausedEffects(this.continuityDeps(decision.work, decision.dir, attempt), pause)
            : null;
          if (verdict !== null && verdict.resolved) {
            await this.resolvedPause(decision.work, decision.dir, pause, attempt, parked);
            break;
          }
          const current = verdict?.pause ?? pause;
          // A real change of cause is a new fact the operator must see, told
          // once by the same occurrence (issue 174); a pause whose request
          // never landed is announced now. A steady cause is said once — `msf
          // status` keeps it visible — so a persistent doubt never becomes a
          // line per cycle.
          if (pause.announced !== true || current.reason !== pause.reason) {
            await this.pauseForContinuity(decision.work, decision.dir, current, attempt);
          } else if (verdict !== null) {
            // The cause did not change, but the evidence behind it may have:
            // the fresher diagnosis is kept on the SAME occurrence (its id, its
            // moment and its announcement) and said in the diagnostic line. No
            // comment and no notice — the operator was asked once, and the
            // request has not changed.
            const fresher = current.detail !== pause.detail;
            if (fresher) writePause(decision.dir, { ...pause, detail: current.detail });
            this.reportContinuityPause(decision.work, decision.dir, { ...pause, detail: current.detail });
          } else {
            this.reportContinuityPause(decision.work, decision.dir, pause);
          }
          break;
        }
        case "feedback":
        case "resumable": {
          const launchable: Launchable = {
            work: decision.work,
            dir: decision.dir,
            kind: decision.state === "feedback" ? "feedback" : "resume",
            createdAt: decision.createdAt,
            pr: decision.pr,
          };
          if (decision.state === "resumable") launchable.issueReplies = decision.issueReplies;
          parked.push(launchable);
          break;
        }
        case "repair": {
          parked.push({
            work: decision.work,
            dir: decision.dir,
            kind: "repair",
            createdAt: decision.createdAt,
            pr: decision.pr,
            repair: decision.trigger,
            resuming: decision.resuming,
          });
          break;
        }
        case "repair-fall-blocked": {
          this.log(
            `derived ${key}: repair attempt ${decision.attempt} fell without publishing — ` +
              "blocked with the attempt's diagnosis on the issue (the open PR does not hide the fall)",
          );
          await this.applyBlockWithComment(decision.work, decision.comment);
          this.announce(decision.work, "reserved");
          break;
        }
        case "repair-recovered": {
          this.log(
            `derived ${key}: PR recovered — no conflicts and all required checks approved; repair budget reset`,
          );
          await writeRepairCycle(decision.dir, EMPTY_REPAIR_CYCLE);
          break;
        }
        case "repair-blocked": {
          this.log(
            `derived ${key}: ${decision.usedRounds} automatic repair rounds without recovery — ` +
              "blocked with the reason on the issue",
          );
          await this.applyBlockWithComment(decision.work, decision.comment);
          this.announce(decision.work, "reserved");
          break;
        }
        default:
          break; // idle / unknown: nothing to decide
      }
    }
    if (heldWhileUnknown.length > 0) {
      this.log(
        `liveness unknown — held ${heldWhileUnknown.length} decision(s) that presume a worker stopped: ` +
          `${byKey(heldWhileUnknown).join(", ")}; nothing was consumed, archived or cleaned`,
      );
    }
    parked.sort(byParkedPriority);
    // A recovery for a survivor's ended attempt joins the queue;
    // while liveness is unknown the pending recoveries are preserved untouched
    // — the launch gate keeps them from starting.
    this.parkedQueue = suspended
      ? parked
      : [...this.survivorRecoveries.splice(0), ...parked].sort(byParkedPriority);

    // The pool AND the reconciliation from ONE open-issues read per repo:
    // the cached pool of the latest derivation (replenishment
    // draws from it; a cache drained empty waits for the next tick) and the
    // leftovers the reconciliation reports. No action: the report touches
    // nothing, and the sweep continues normally.
    const reservationKeys = new Set(reservations.map((entry) => entry.key));
    const state = await deriveTrackerState(
      this.deps.tickets,
      selections,
      config.labels,
      reservationKeys,
      inFlight,
    );
    this.lastPool = state.pool;
    this.cache = [...this.lastPool];
    this.lastReconciliation = {
      unbackedClaims: state.unbackedClaims,
      unmarkedReservations: state.unmarkedReservations,
    };
    this.reportReconciliation(this.lastReconciliation);
    this.observeOperationalState(this.lastPool, derived, inFlight);
    // The retrospective trigger is checked at each sweep: the
    // archived works are the pulse and the report is the marker — no separate
    // scheduler exists. The round runs on its own lane: it takes no slot and
    // the sweep never waits for it.
    this.maybeStartRetro();
    return derived;
  }

  /**
   * Start a retrospective round when the trigger asks for one.
   * The round is fire-and-forget for the sweep — it never consumes a slot and
   * never delays a launch — but a failure is logged, never silent, and the
   * `--once` boundary waits for it (settle). One round at a time: this engine
   * holds at most one (the promise below) and the workspace lock keeps every
   * other factory process out; the report's marker keeps the windows apart.
   */
  private maybeStartRetro(): void {
    if (!this.deps.config.retro.enabled || this.retroRun !== null || this.stopping) return;
    this.retroRun = this.startRetroRound()
      .catch((error: unknown) => {
        const line =
          error instanceof RetroBusyError
            ? `retro: ${error.message}`
            : `retro round failed: ${describeError(error)}`;
        this.log(line);
      })
      .finally(() => {
        this.retroRun = null;
      });
  }

  private async startRetroRound(): Promise<void> {
    const { config, runtime, workspace, notifier, now } = this.deps;
    // The window's premise is that no live worker carries these works. An
    // unknown liveness cannot confirm it, so the round waits for a sweep that
    // can — the trigger stays armed, nothing is consumed.
    if (this.liveness.state !== "known") {
      this.log("retro: liveness is unknown — no round is launched; the window is analyzed once Docker answers");
      return;
    }
    const finished = await collectFinishedWorks(workspace, this.carriedKeys);
    const plan = await planAutomaticRound(config, workspace, finished, now);
    if (plan === null) return;
    if ("empty" in plan) {
      this.log(emptyWindowNotice(plan.empty));
      return;
    }
    await runRetroRound(
      {
        config,
        runtime,
        workspace,
        log: this.log,
        ...(notifier === undefined ? {} : { notifier }),
        ...(now === undefined ? {} : { now }),
      },
      plan,
    );
  }

  /**
   * Report each leftover ONCE per appearance: a leftover that persists on the
   * next tick stays silent; one that disappears and reappears is reported
   * again. Pure logging — the report deletes, moves and archives nothing.
   */
  private reportReconciliation(reconciliation: Reconciliation): void {
    const current = new Set<string>();
    for (const claim of reconciliation.unbackedClaims) {
      const key = unbackedClaimKey(claim);
      current.add(key);
      if (!this.reportedReconciliation.has(key)) this.log(renderUnbackedClaim(claim));
    }
    for (const reservation of reconciliation.unmarkedReservations) {
      const key = unmarkedReservationKey(reservation);
      current.add(key);
      if (!this.reportedReconciliation.has(key)) this.log(renderUnmarkedReservation(reservation));
    }
    this.reportedReconciliation = current;
  }

  /**
   * Log the first observation (even empty), then only changes no action/event
   * already announced. Memory is the previous observation only, so a state
   * that reappears after another is logged again.
   */
  private observeOperationalState(
    pool: readonly PoolEntry[],
    reserved: readonly ReservedDerivation[],
    inFlight: ReadonlySet<string>,
  ): void {
    const next = operationalState(pool, reserved, inFlight);
    if (this.lastState === null) {
      this.log(renderPoolSummary(next, null, []));
    } else {
      const changed = changedWorkKeys(this.lastState, next);
      const unexplained = changed.filter(
        (key) => this.announced.get(key) !== (next.get(key) ?? null),
      );
      if (unexplained.length > 0) {
        this.log(renderPoolSummary(next, this.lastState, unexplained));
      }
    }
    this.lastState = next;
    this.announced.clear();
  }

  /** The works a live container carries, read from the latest answer: the
   *  launch and capacity decisions never ask Docker a second question. */
  private get carriedKeys(): ReadonlySet<string> {
    return carriedWorkKeys(this.liveness);
  }

  /** Record the class an action/event lands a work in (`null` = it leaves). */
  private announce(work: WorkIdentity, resulting: OperationalClass | null): void {
    this.announced.set(workKeyOf(work), resulting);
  }

  // ---- liveness and the surviving workers ----

  /**
   * Ask the probe (bounded) and keep the episode bookkeeping. One observation
   * per derived sweep: the decisions below read THAT answer, and the next tick
   * asks again — coherence, not atomicity between probe and launch.
   */
  private async observeLiveness(): Promise<void> {
    const observation = await probeLiveness(
      this.deps.probe ?? (() => Promise.resolve([])),
      this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    this.liveness = observation;
    if (observation.state === "unknown") this.enterUnavailableEpisode(observation.reason);
    else this.closeUnavailableEpisode();
  }

  /**
   * The first failure diagnoses the cause; the notice fires ONCE, when the
   * configured continuous unavailability is reached, and never repeats in the
   * same episode. Nothing here asks the human for anything: a reliable answer
   * resumes the factory by itself.
   */
  private async enterUnavailableEpisode(reason: string): Promise<void> {
    const now = this.now();
    if (this.livenessEpisode === null) {
      this.livenessEpisode = { unknownSince: now, warned: false };
      this.log(
        `liveness unknown (${reason}) — new launches suspended; workers, reservations and evidence preserved, ` +
          "no attempt or recovery spent",
      );
    }
    const episode = this.livenessEpisode;
    const unavailableForMs = unavailableWarningDue(
      episode,
      now,
      this.deps.config.liveness.unavailableWarnMs,
    );
    if (unavailableForMs === null) return;
    episode.warned = true;
    this.log(
      `WARNING: Docker has not answered for ${formatDuration(unavailableForMs)} — the factory keeps launching nothing ` +
        "and preserves every worker and reservation; it resumes automatically when the probe answers",
    );
    await this.deliverNotice(factoryUnavailableNotice(unavailableForMs));
  }

  /** A reliable answer closes the episode; launches resume without any human act. */
  private closeUnavailableEpisode(): void {
    if (this.livenessEpisode === null) return;
    const lasted = this.now() - this.livenessEpisode.unknownSince;
    this.livenessEpisode = null;
    this.log(
      `liveness reliable again after ${formatDuration(lasted)} — new launches resume automatically (nothing was lost)`,
    );
  }

  /**
   * Recognise the workers a reliable probe shows but this process did not
   * launch, and settle the ones it no longer shows. Returns the works settled
   * this sweep: the derivation must not decide them a second time. Nothing
   * here launches, attaches, kills or numbers an attempt — recognition is
   * observation.
   */
  private async observeSurvivors(
    reservations: ReadonlyMap<string, IdentifiedReservation>,
  ): Promise<Set<string>> {
    const settled = new Set<string>();
    if (this.liveness.state !== "known") return settled;
    const workers = this.liveness.workers;
    const local = new Set(this.slots.workKeys);

    // Exit: a survivor a reliable probe no longer lists has ended.
    for (const [key, record] of [...this.survivors.entries()]) {
      if (this.carriedKeys.has(key)) continue;
      this.survivors.delete(key);
      settled.add(key);
      await this.reconcileSurvivorExit(key, record);
    }

    const live = new Set(survivorWorkKeys(workers, local));

    // A held container whose worker is gone: the reservation still names no
    // Work this composition serves, so the end is said once — the slot it
    // occupied is free, the decision stays human.
    for (const key of [...this.heldSurvivors]) {
      if (live.has(key)) continue;
      this.heldSurvivors.delete(key);
      this.log(
        `the held worker of ${key} is gone; its reservation still names no Work this composition can serve — ` +
          "a human must settle it",
      );
    }

    // Recognition: a work carried by a container this process did not launch.
    for (const key of live) {
      if (this.survivors.has(key)) continue;
      const reserved = reservations.get(key);
      if (reserved === undefined) {
        if (this.heldSurvivors.has(key)) continue;
        this.heldSurvivors.add(key);
        this.log(
          `a live container carries ${key}, but this workspace has no reservation that names a Work this ` +
            "composition serves — it occupies a slot and no substitute is launched; the reservation needs a human",
        );
        continue;
      }
      this.heldSurvivors.delete(key);
      const { work, dir } = reserved;
      const attempt = await readLastAttempt(dir);
      this.survivors.set(key, {
        key,
        work,
        dir,
        activityStamp: null,
        lastActivityAt: this.now(),
        idleWarned: false,
      });
      this.log(
        `recognizing surviving worker ${key}: a live container carries it` +
          `${attempt === null ? "" : ` (attempt ${attempt})`} — its work stays reserved, it occupies a slot, ` +
          "no substitute is launched and no recovery is consumed",
      );
    }

    for (const key of [...this.survivors.keys()]) await this.watchSurvivorActivity(key);

    await this.announceDuplicates(reservations);
    return settled;
  }

  /**
   * Verifiable activity keeps a survivor accounted for; silence past the
   * runtime's idle limit only WARNS — never a kill, a substitute
   * or a freed slot, and never the same warning twice.
   */
  private async watchSurvivorActivity(key: string): Promise<void> {
    const record = this.survivors.get(key);
    if (record === undefined) return;
    const observed = await observeSurvivorActivity(record, this.now());
    this.survivors.set(key, observed);
    const idleMs = idleWarningDue(observed, this.now(), DEFAULT_IDLE_LIMIT_MS);
    if (idleMs === null) return;
    this.survivors.set(key, { ...observed, idleWarned: true });
    this.log(
      `WARNING: surviving worker ${key} shows no verifiable activity for ${formatDuration(idleMs)} — ` +
        "the factory keeps its slot and launches no substitute; it does not end a worker it did not launch " +
        "(a human decision is needed)",
    );
    await this.deliverNotice(interventionNotice(record.work));
  }

  /**
   * The duplicate anomaly, said once per appearance: several containers of one
   * work are several occupied slots, no new launch for that work and no owner
   * chosen or ended — the evidence stays for the human.
   */
  private async announceDuplicates(
    reservations: ReadonlyMap<string, IdentifiedReservation>,
  ): Promise<void> {
    if (this.liveness.state !== "known") return;
    const { fresh, next } = freshDuplicates(
      this.announcedDuplicates,
      duplicateWorkers(this.liveness.workers),
    );
    this.announcedDuplicates = next;
    for (const duplicate of fresh) {
      this.log(
        `duplicate workers for ${duplicate.key}: ${duplicate.containers} containers carry the same work — ` +
          "no new launch for it, no owner chosen and nothing ended; a human decision is needed",
      );
      const work = reservations.get(duplicate.key)?.work ?? workOfKey(duplicate.key);
      if (work === null) {
        this.log(
          `no intervention notice for duplicate ${duplicate.key}: this workspace has no readable reservation ` +
            "or key that names its Work (the facts above are preserved for the human)",
        );
        continue;
      }
      await this.deliverNotice(interventionNotice(work));
    }
  }

  /**
   * A survivor's exit, confirmed by a reliable probe: the ordinary ruler on
   * the attempt's own artifacts and the current tracker — never the in-memory
   * launch this process never had, and never an older attempt's outcome.
   */
  private async reconcileSurvivorExit(key: string, record: SurvivorRecord): Promise<void> {
    const { work, dir } = record;
    const attempt = await readLastAttempt(dir);
    if (attempt === null) {
      this.log(
        `survivor ${key} ended with no attempt evidence on disk — the derivation settles the bare reservation`,
      );
      return;
    }
    // The consecutiveness is the persisted ledger's fact (a written failure),
    // never an older record on disk or a previous launch's memory.
    const ledger = await readRecoveryLedger(dir);
    const consecutiveFall = ledger.lastFallAttempt === attempt - 1;
    const cycle = await readRepairCycle(dir);
    const repairing = cycle.attempt !== null && cycle.attempt.attempt === attempt;
    const ended: Launchable = {
      work,
      dir,
      kind: repairing ? "repair" : "claim",
      createdAt: null,
      pr: null,
    };
    this.log(
      `survivor ${key} ended: attempt ${attempt} confirmed finished by a reliable probe — ` +
        `reconciling by its artifacts and the tracker${repairing ? " (the attempt was a repair round)" : ""}`,
    );
    const outcome = await this.applyEnd(ended, {
      dir,
      attempt,
      consecutiveFall,
      origin: "survivor",
    });
    if (outcome.next !== null) this.survivorRecoveries.push(outcome.next);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The capacity verdict: survivors above the configured
   * concurrency suspend launches and END NOBODY; when the live workforce drops
   * back below the limit, capacity returns without any human act.
   */
  private observeCapacity(): void {
    if (this.liveness.state !== "known") return; // the unknown episode has its own line
    const excess = capacityExcess(
      this.liveness.workers,
      new Set(this.slots.workKeys),
      this.deps.config.concurrency,
    );
    const over = excess > 0;
    if (over === this.overCapacity) return;
    this.overCapacity = over;
    this.log(
      over
        ? `capacity exceeded: ${excess} more worker(s) alive than the concurrency ` +
            `${this.deps.config.concurrency} allows — no new launch and nobody ended; ` +
            "capacity returns by itself when they finish"
        : `capacity available again within ${this.deps.config.concurrency} worker(s) — launches resume automatically`,
    );
  }

  /**
   * Phase 3 (launches): fill every free slot — first the parked reserved
   * works (feedback rounds, retomadas: they already hold the claim), then
   * new claims by createdAt. Returns the raw launch promises (the --once
   * boundary awaits them transitively; the continuous run only guards them).
   */
  fillSlots(): Promise<void>[] {
    const started: Promise<void>[] = [];
    // Unknown liveness suspends EVERY launch — including the replenishment a
    // collection triggers: without a reliable answer the factory
    // could put a substitute over a live worker.
    if (this.stopping || this.liveness.state !== "known") return started;
    while (!this.slots.full && this.hasCapacity()) {
      if (this.stopping) break;
      const launchable = this.takeNextLaunchable();
      if (launchable === undefined) break;
      if (!this.slots.tryAcquire(workKeyOf(launchable.work))) continue; // already in flight
      const run = this.launchAndCollect(launchable);
      this.pending.add(run);
      // Bookkeeping only: the rejection belongs to the caller (runOnce awaits
      // it, runForever logs it). A `.finally` derivative would be a second,
      // unowned rejection — which kills the process on the very failure the
      // next tick must retry.
      void run.then(
        () => this.pending.delete(run),
        () => this.pending.delete(run),
      );
      started.push(run);
    }
    return started;
  }

  /** The parked reserved works first, then the cached pool — each by age. A
   * work a live container carries is never relaunched: a survivor
   *  keeps its work reserved whatever the tracker's label says. */
  private takeNextLaunchable(): Launchable | undefined {
    for (;;) {
      const parked = this.parkedQueue.shift();
      if (parked !== undefined) {
        if (this.carriedKeys.has(workKeyOf(parked.work))) continue;
        return parked;
      }
      const entry = this.cache.shift();
      if (entry === undefined) return undefined;
      const key = workKeyOf(entry.work);
      if (this.carriedKeys.has(key)) continue;
      return {
        work: entry.work,
        dir: workDirOfKey(this.deps.workspace, key),
        kind: "claim",
        createdAt: entry.createdAt,
        pr: null,
        title: entry.title,
      };
    }
  }

  /**
   * Free capacity for one more launch: every live container counts
   * once — a local launch Docker already shows is not counted twice — and a
   * survivor set above the configured concurrency suspends launches without
   * ending anybody.
   */
  private hasCapacity(): boolean {
    if (this.liveness.state !== "known") return false;
    return (
      occupiedSlots(this.liveness.workers, new Set(this.slots.workKeys)) <
      this.deps.config.concurrency
    );
  }

  /**
   * The cooperative window ends here: a second signal forces the
   * remaining workers NOW, without skipping the confirmation of their end.
   */
  private escalate(): void {
    this.escalated = true;
    for (const fire of this.escalationWaiters.splice(0)) fire();
  }

  /**
   * The operator's requested stop: admissions close, the evidence of the stop
   * is persisted, the workers are asked to end, and the factory waits the
   * cooperative window (or the escalation) before forcing what remains. The
   * returned report says what was forced and what could not be confirmed.
   */
  beginRequestedStop(): Promise<StopReport> {
    if (this.requestedStopRun !== null) return this.requestedStopRun;
    this.stopping = true;
    // A backoff waiting to relaunch is a pending admission: it ends with the
    // admission, never after it.
    for (const fire of this.stopWaiters.splice(0)) fire();
    this.requestedStopBegan.resolve();
    this.requestedStopRun = this.runRequestedStop();
    return this.requestedStopRun;
  }

  private async runRequestedStop(): Promise<StopReport> {
    const entries = [...this.inFlight.values()];
    this.log(
      `stop requested: no new worker is admitted; asking ${entries.length} in-flight launch(es) to stop ` +
        `(cooperative window ${formatDuration(this.cooperativeMs)})`,
    );
    // The workers a previous factory process left are the
    // operator's workers too: this process has no session to ask, so they get
    // the same window to end on their own and are forced with the rest.
    if (this.survivors.size > 0) {
      this.log(
        `the stop also covers ${this.survivors.size} surviving worker(s) of a previous run (${byKey(this.survivors.keys()).join(", ")}) — ` +
          "they are not this process's sessions, so they are never asked, only waited for and then forced",
      );
    }

    // The evidence of the requested stop is persisted BEFORE any worker is
    // asked to end: a factory that dies inside the requested stop still lets the
    // next invocation resume the attempt without charging it. A recovery
    // granted but never launched is returned — the stop cancelled it.
    for (const entry of entries) {
      const attempt = entry.attempt ?? (await this.plannedAttempt(entry));
      if (attempt === null) continue;
      entry.attempt = attempt;
      if (await this.settleStoppedAdmission(entry, attempt)) {
        this.log(
          `the recovery granted to ${renderWorkIdentity(entry.work)} is returned: the requested stop cancelled its relaunch`,
        );
      }
    }

    // The runtime's stop request speaks the Work identity — a ticket from any
    // source and the destination are addressable without a GitHub issue number.
    for (const entry of entries) {
      this.deps.runtime.requestStop(entry.work);
    }

    // Whatever still carries a work is forced now. The evidence of the stop
    // lands on a survivor's attempt BEFORE it is ended, exactly as for the
    // launches below: the next invocation resumes it instead of charging it.
    await this.awaitCooperativeWindow();
    const doomed = await this.stopCandidates(entries);
    const own = new Set(entries.map((entry) => workKeyOf(entry.work)));
    for (const key of doomed) if (!own.has(key)) await this.recordStopOf(key);

    const forced: string[] = [];
    if (doomed.length > 0) {
      this.log(
        `the cooperative phase is over: forcing the stop of ${doomed.length} worker(s) now — ` +
          "the end of each one is still confirmed before the factory calls the stop safe",
      );
    }
    await Promise.all(
      doomed.map(async (key) => {
        const work = workOfKey(key);
        if (work === null) return undefined;
        try {
          await this.deps.runtime.forceStop(work);
          forced.push(key);
          this.log(`forced stop of ${key}: its worker is gone`);
        } catch (error) {
          this.log(`forcing ${key} failed: ${describeError(error)}`);
        }
        return undefined;
      }),
    );

    const { unconfirmed, observation } = await this.confirmStop(entries);
    const unreadBecause = observation.state === "unknown" ? observation.reason : null;
    if (unreadBecause !== null) {
      this.log(
        `stop NOT confirmed: the worker liveness could not be read (${unreadBecause}) — the factory cannot ` +
          "say that no worker survives; the next run asks the same question again",
      );
    }
    return { forced, unconfirmed, unreadBecause };
  }

  /**
   * Every worker this stop is answerable for, with the attempt
   * already known when the caller has it: the launches this run carried, the
   * survivors it recognised — which it knows were alive even when
   * the probe stops answering — and whatever a live container names right now.
   * An unreadable probe cannot LOSE a known worker, it only fails to add one.
   */
  private async stopWorkers(
    entries: readonly InFlightLaunch[],
  ): Promise<{ workers: Map<string, number | null>; observation: LivenessObservation }> {
    const workers = new Map<string, number | null>();
    for (const entry of entries) {
      if (entry.launched) workers.set(workKeyOf(entry.work), entry.attempt);
    }
    for (const key of this.survivors.keys()) if (!workers.has(key)) workers.set(key, null);
    await this.observeLiveness();
    const observation = this.liveness;
    if (observation.state === "known") {
      for (const worker of observation.workers) if (!workers.has(worker.key)) workers.set(worker.key, null);
    }
    return { workers, observation };
  }

  /**
   * The works the stop has to end: every worker the stop knows about — the
   * survivors of a previous process included, which it can only end, never
   * ask — minus the launches that really ended. A launch whose end the window
   * saw is gone, and forcing it again would only race a container that is
   * already going away; one whose container the probe still names is forced.
   */
  private async stopCandidates(entries: readonly InFlightLaunch[]): Promise<string[]> {
    const { workers, observation } = await this.stopWorkers(entries);
    const live = carriedWorkKeys(observation);
    for (const entry of entries) {
      const key = workKeyOf(entry.work);
      if (this.inFlight.has(key) || live.has(key)) continue;
      workers.delete(key);
    }
    return byKey(workers.keys());
  }

  /** Persist the operator's stop on a work the stop ends: the next
   *  invocation resumes that attempt rather than charging it a recovery. A work
   *  with no registry dir has nothing to resume. */
  private async recordStopOf(key: string): Promise<void> {
    const attempt = await this.lastAttemptOf(key);
    if (attempt === null) return;
    await recordStopRequest(workDirOfKey(this.deps.workspace, key), attempt);
  }

  /**
   * The attempt a work is on right now, or null when the registry has no dir
   * for it. A bare reservation (a claim whose worker never wrote anything) is
   * on attempt 1 — the number its first launch would carry — so the stop is
   * recorded for it and its resume is free.
   */
  private async lastAttemptOf(key: string): Promise<number | null> {
    const dir = workDirOfKey(this.deps.workspace, key);
    if (!existsSync(dir)) return null;
    return (await readLastAttempt(dir)) ?? 1;
  }

  /**
   * Wait out the cooperative phase: until every launch of this engine settled,
   * the window ran out, or the second signal escalated it — whichever is first.
   * Callers only need the wait to be over; why it ended is the deadline's or the
   * escalation's own fact, not a value to branch on.
   */
  private async awaitCooperativeWindow(): Promise<void> {
    const escalation = deferred();
    if (this.escalated) escalation.resolve();
    else this.escalationWaiters.push(escalation.resolve);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.cooperativeMs);
    });
    try {
      await Promise.race([this.waitPending(), deadline, escalation.promise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      dropWaiter(this.escalationWaiters, escalation.resolve);
    }
  }

  /** Wait until no launch of this engine is pending, failures included. */
  private async waitPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * The confirmation the factory never skips: no worker of this
   * workspace may survive — neither the launches this process started nor the
   * ones it found alive. The liveness probe answers, freshly,
   * because the workers just ended or were forced; an unreadable answer is
   * uncertainty, never an empty factory. An unconfirmed work is persisted so
   * the next invocation holds it.
   */
  private async confirmStop(
    entries: readonly InFlightLaunch[],
  ): Promise<{ unconfirmed: Array<{ key: string; because: string }>; observation: LivenessObservation }> {
    const { workers: answerable, observation } = await this.stopWorkers(entries);

    const unconfirmed: Array<{ key: string; because: string }> = [];
    for (const [key, knownAttempt] of answerable) {
      const because = this.stopHoldReason(observation, key);
      if (because === null) continue;
      unconfirmed.push({ key, because });
      const attempt = knownAttempt ?? (await this.lastAttemptOf(key));
      if (attempt !== null) {
        await recordUnconfirmedStop(workDirOfKey(this.deps.workspace, key), attempt, because);
      }
      this.log(
        `cannot confirm the stop of ${key}: ${because} — the work will not relaunch until a worker is known to be gone`,
      );
    }

    if (unconfirmed.length > 0) {
      this.log(
        `stop NOT confirmed for ${unconfirmed.length} work(s) — the next run holds them until the worker is known gone`,
      );
    } else if (observation.state === "known" && answerable.size === 0) {
      this.log("stop confirmed: no worker had started and none survives");
    } else if (observation.state === "known") {
      this.log(`stop confirmed: every worker ended and none survives (${answerable.size} checked)`);
    }
    return { unconfirmed, observation };
  }

  /**
   * A stop cancelled this admission before any worker existed: the granted
   * recovery is returned and the requested stop is (re)recorded, so the next
   * invocation resumes the attempt for free. The grant's own event index makes
   * it idempotent — the requested stop and the admission may both reach it,
   * and neither can return an earlier, legitimate recovery. Returns whether a
   * grant was actually returned.
   */
  private async settleStoppedAdmission(entry: InFlightLaunch, attempt: number): Promise<boolean> {
    const grant = entry.recoveryIndex !== null && !entry.launched ? entry.recoveryIndex : null;
    entry.recoveryIndex = null;
    const refunded = grant === null ? false : await refundRecovery(entry.dir, attempt, grant);
    await recordStopRequest(entry.dir, attempt);
    return refunded;
  }

  /** The attempt the pending launch would use, read from the registry. A work
   *  with no registry dir left no reservation behind: nothing to reconcile, so
   *  no stop evidence is recorded for it. */
  private async plannedAttempt(entry: InFlightLaunch): Promise<number | null> {
    if (!existsSync(entry.dir)) return null;
    try {
      const facts = await readLaunchFacts(entry.dir, entry.attemptHint);
      return facts.attempt;
    } catch {
      return null;
    }
  }

  /** The boundary of `run --once`: the launch settling, or the requested stop
   *  and its confirmation. */
  async settle(): Promise<StopReport | null> {
    if (this.requestedStopRun !== null) return this.requestedStopRun;
    // The boundary waits for the launches — OR for the requested stop, which
    // may legitimately finish without every launch promise settling (an
    // unconfirmed end; the report carries the uncertainty).
    await Promise.race([this.awaitAllLaunched(), this.requestedStopBegan.promise]);
    // The retrospective lane is outside the slots, so the boundary waits for
    // it explicitly. A requested stop does not wait: the stop is
    // the operator's act and the round advances no marker without its report.
    if (this.requestedStopRun === null && this.retroRun !== null) await this.retroRun;
    return this.requestedStopRun === null ? null : this.requestedStopRun;
  }

  /** The --once boundary: wait for every launched worker,
   * transitively — each collection replenishes the slot within the same
   * cycle. Once the requested stop began, no replenishment takes the freed
   * slot. */
  async awaitAllLaunched(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** Resolves when any worker's collection completed (the event wake). */
  waitForWake(tickMs: number, signal?: AbortSignal): Promise<WakeEvent> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve("abort");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => waiter.fire("abort");
      const waiter = { fire: (event: WakeEvent) => {
        const index = this.endedWaiters.indexOf(waiter);
        if (index >= 0) this.endedWaiters.splice(index, 1);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(event);
      } };
      timer = setTimeout(() => waiter.fire("tick"), tickMs);
      this.endedWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notifyWorkerEnded(): void {
    for (const waiter of this.endedWaiters.splice(0)) waiter.fire("worker-end");
  }

  /** One launch start to finish, releasing the slot even on failure — a leaked
   * slot would never retry the work. The rejection belongs to the
   *  caller (runOnce awaits it, runForever logs it as a failed launch). */
  private async launchAndCollect(launchable: Launchable): Promise<void> {
    const key = workKeyOf(launchable.work);
    try {
      // An interruption inside the session returns the SAME attempt as a
      // recovery to launch next, in the same held slot.
      let next: Launchable | null = launchable;
      while (next !== null) next = await this.launchOnce(next);
    } finally {
      // The work stays reconcilable by the next derivation even when the
      // collection's transition fails: its claim is already on the tracker.
      this.slots.release(key);
      this.discardFromCacheAndParked(key);
      this.fillSlots();
      this.notifyWorkerEnded();
    }
  }

  /** Claim (or resume), prepare, launch and collect one work; replenish in
   * the same cycle. The reservation lands BEFORE any launch. */
  private async launchOnce(launchable: Launchable): Promise<Launchable | null> {
    const key = workKeyOf(launchable.work);
    const entry: InFlightLaunch = {
      work: launchable.work,
      dir: launchable.dir,
      // A recovery continues a known attempt even before the registry answers.
      attempt: launchable.kind === "recover" ? (launchable.attempt ?? null) : null,
      ...(launchable.kind === "recover" && launchable.attempt !== undefined
        ? { attemptHint: launchable.attempt }
        : {}),
      launched: false,
      recoveryIndex: null,
    };
    this.inFlight.set(key, entry);
    try {
      return await this.launchInner(launchable, entry);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async launchInner(launchable: Launchable, entry: InFlightLaunch): Promise<Launchable | null> {
    const { config, tickets, pullRequests, runtime, git, workspace } = this.deps;
    const { work, kind, dir } = launchable;
    const key = workKeyOf(work);

    // The requested stop closes admissions the instant it arrives: a launch
    // that has not written to the tracker yet leaves nothing
    // behind, and one that already reserved the work merely stops here — the
    // reservation stays for the next run's reconciliation.
    if (this.stopping) {
      this.log(`the launch of ${key} stopped before the claim — nothing was reserved`);
      return null;
    }

    if (kind === "claim") {
      logClaim(this.log, key);
      // The dir is the safety footprint and lands before the claim; the record
      // is the Work's own facts. An unknown or unwritable record is reported and
      // never blocks the claim — nor is it
      // overwritten.
      mkdirSync(dir, { recursive: true });
      const url = ticketUrl(work.ticket);
      const presentation = {
        ...(launchable.title === undefined ? {} : { title: launchable.title }),
        ...(url === undefined ? {} : { url }),
      };
      try {
        const reservation = reserveWork(workspace, reservationRecordOf(work, presentation));
        if (reservation.reservation.state === "unreadable") {
          this.log(
            `reservation of ${key} is unreadable (${reservation.reservation.reason}) — ` +
              "keeping it and launching on the dir key",
          );
        }
      } catch (error) {
        this.log(`reservation of ${key} could not be persisted (${describeError(error)}) — launching on the dir key`);
      }
      await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
    } else if (kind === "resume") {
      this.log(`resuming ${key}: a human answered after the marker — blocked→claimed on the tracker`);
      await tickets.resumeTicketClaim(work.ticket, config.labels);
      // The rejection's retomada: the SAME PR is reopened, never a new one.
      if (launchable.pr !== null && launchable.pr.state === "closed") {
        await pullRequests.reopenPullRequest({ work, pullRequest: launchable.pr.identity });
      }
    } else if (kind === "recover" || kind === "model-provider-retry") {
      this.log(
        kind === "model-provider-retry"
          ? `model provider retry for ${key}: attempt ${launchable.attempt} ended by a model provider failure — ` +
              "the same attempt continues (no new attempt, branch preserved)"
          : launchable.requestedStop === true
            ? `resuming ${key}: the operator's requested stop ended attempt ${launchable.attempt} — ` +
                "the same attempt resumes (no new attempt, no recovery spent, branch preserved)"
            : `recovering ${key}: attempt ${launchable.attempt} was interrupted — ` +
                "the same attempt continues (no new attempt, branch preserved)",
      );
      // The claim swap itself may have been interrupted — or a model provider
      // outage killed it: re-asserting the idempotent claim heals it without
      // releasing the work to the pool.
      if (launchable.callRecovery !== undefined) await tickets.resumeTicketClaim(work.ticket, config.labels);
      await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
    } else if (kind === "feedback") {
      this.log(`feedback round for ${key}: the claim is already held — same branch, same PR`);
    }
    // Every launch kind holds the claim, so the work is reserved from here.
    this.announce(work, "reserved");

    // Git host: clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await this.serializePrepare(work.destination.repo, () => git.prepareWorkFor(work));

    // A repair targets the PR's CURRENT base — never the repo default — and is
    // pinned to the head the facts were read on. If the remote moved
    // since, the evidence is stale: skip the round (the next tick re-derives).
    const derivedTrigger = launchable.repair;
    const resuming = launchable.resuming ?? null;
    // The launch context of a repair round, created once here and
    // filled with the local work below: the confirmed trigger, the unpublished
    // attempt it takes over (when resuming) and the lease value — the head
    // observed before the intervention (for a resumption, the head its fallen
    // attempt was launched on: equal to the trigger's by construction, since
    // only the attempt whose evidence still matches the current head is
    // resumed), never a fresh read, so a collaborator's push to the branch
    // after the fall is never overwritten by local history.
    const repair: RepairLaunchContext | undefined =
      derivedTrigger === undefined
        ? undefined
        : {
            trigger: derivedTrigger,
            resuming,
            localWork: null,
            pinnedHeadSha: resuming?.observedHeadSha ?? derivedTrigger.facts.headSha,
          };
    let baseBranch = prepared.baseBranch;
    if (repair !== undefined) {
      // The facts are re-read before the round spends work: the
      // impediment that opened it may have been resolved meanwhile — by a
      // human pushing the resolution, by a base advance. Only a confirmed
      // premise buys a session; an obsolete one returns the round unspent,
      // and an unconfirmed one waits for the next derivation instead of
      // paying for stale evidence. The round is announced below, after this
      // decision: a returned round is never also "reactivated".
      const reading = readRepairPremise(
        await pullRequests.readPullRequestRepairFacts(
          workPullRequest(work, launchable.pr),
        ),
      );
      if (reading.premise !== "persisting") {
        this.log(
          reading.premise === "obsolete"
            ? `repair round for ${key} not opened: the impediment that opened it no longer exists ` +
                "(the premise is obsolete) — no round is spent"
            : `repair round for ${key} not opened: the PR's facts could not confirm the impediment — ` +
                "nothing is spent and the next sweep re-derives",
        );
        return null;
      }
      const confirmed = reading.trigger;
      // A FRESH round follows the facts as they read now: when the head moved
      // while the impediment persists, the evidence was recalculated, so the
      // round opens on the current head and is charged on the new evidence.
      // A resumption keeps its observed head — moving it would
      // publish the fallen attempt's local history over a concurrent one.
      if (resuming === null) {
        if (confirmed.facts.headSha !== repair.pinnedHeadSha) {
          this.log(
            `repair round for ${key}: the evidence was recalculated on the current head ` +
              `${shortSha(confirmed.facts.headSha)} — the round opens there`,
          );
        }
        repair.trigger = confirmed;
        repair.pinnedHeadSha = confirmed.facts.headSha;
      }
      baseBranch = confirmed.facts.baseBranch;
      const observed = await this.observeRemote(work);
      if (!observed.known) {
        this.log(
          `repair round for ${key} skipped: the remote head could not be read — ` +
            "its reconciliation stays pending and nothing is launched (the next sweep retries)",
        );
        return null;
      }
      if (observed.headSha !== repair.pinnedHeadSha) {
        this.log(
          `repair round for ${key} skipped: the remote head ${observed.headSha ?? "(absent)"} no longer matches the ` +
            `observed ${repair.pinnedHeadSha} — nothing is launched`,
        );
        if (resuming !== null) {
          // Somebody moved the branch after the fall: the local work must not
          // be published over it. The attempt is settled as a concurrent
          // change, and the next derivation asks the human for a reconciliation.
          await this.markConcurrentChange(work, resuming, observed.headSha);
        }
        return null;
      }
      this.log(
        `repair round for ${key}: ${repair.trigger.reasons.join(" + ")} reactivated the worker — ` +
          "same branch, same PR, no human comment needed",
      );
    }

    this.log(
      `launching worker for ${key} (branch ${prepared.branch}, ` +
        `${prepared.branchCreated ? "created" : "reused"} from base ${baseBranch})`,
    );
    // A work branch reaches the remote only when the worker publishes it
    // (push + PR): a relaunch of a work that fell before publishing reuses a
    // branch the remote never saw, so the reuse has nothing to fast-forward.
    // Said once per launch, next to the launch it explains — the
    // runtime's reuse fetch then reads as expected instead of a broken remote.
    if (!prepared.branchCreated && !prepared.branchOnOrigin) {
      this.log(
        `branch ${prepared.branch} is not on origin yet (the worker pushes it when it opens the PR) — ` +
          `the relaunch has nothing to fast-forward`,
      );
    }

    // The registry numbers the attempt and remembers the previous WRITTEN
    // failure — both are disk facts of this work, not process state; an
    // interruption never counts as a fall.
    const continuesAttempt = kind === "recover" || kind === "model-provider-retry";
    const facts = await readLaunchFacts(dir, continuesAttempt ? launchable.attempt : undefined);
    entry.attempt = facts.attempt;
    if (kind === "resume" && facts.previousFall) {
      // The human's answer resets the consecutive failure count — the blocked
      // valve already did its job and was addressed; a new failure starts a
      // fresh count (1st → release again).
      facts.previousFall = false;
    }
    if (kind === "resume") {
      // A human answer that unblocks the work also renews the automatic
      // repair budget; new commits never do.
      await writeRepairCycle(dir, EMPTY_REPAIR_CYCLE);
    }
    // The local work the round takes over, read from real git only once the
    // round is really going out: existing commits are reused, changes are
    // inspected, an unfinished operation is continued — the resumption never
    // restarts the work blind.
    if (repair !== undefined) {
      repair.localWork = await this.inspectLocalWork(work);
    }
    // The launch material: the issue, the open PR with its
    // conversation (a feedback round), the diff of the branch — every
    // session starts from the whole context through the port + git host.
    const material = await launchMaterial(tickets, pullRequests, git, launchable, repair);
    // Ctrl-C perceived after the reservation but before the worker started:
    // do not start a new worker after this point. The reservation (the claim
    // and the registry dir) stays for the next run's reconciliation; the
    // caller releases the slot.
    if (this.stopping) {
      this.log(`the launch of ${key} stopped before the worker started — the reservation stays for reconciliation`);
      return null;
    }

    // Continuity: which Pi session this launch opens, and whether
    // it may open it at all. A human's answer to a paused work is orientation,
    // not proof about the world: the facts are read again before acting, and
    // an effect that is still ambiguous keeps the work paused.
    const continuityDeps = {
      workDir: dir,
      sessionsDir: join(dir, SESSIONS_SUBDIR),
      work,
      attempt: facts.attempt,
      git,
      tickets,
      pullRequests,
    };
    if (kind === "resume") {
      const pause = readPause(dir);
      if (pause !== null) {
        const recheck = await recheckPausedEffects(
          {
            ...continuityDeps,
            attempt: knownAttempt(pause.attempt) ?? facts.attempt,
          },
          pause,
        );
        if (!recheck.resolved && recheck.pause !== null) {
          // No new information and no changed cause: the answer does not
          // authorize a replay and the same question is not asked again. The
          // pause keeps its identity and its binding to the answer (issue 174);
          // a real cause change posts exactly one diagnostic.
          await this.pauseForContinuity(work, dir, recheck.pause, facts.attempt);
          return null;
        }
        // The fresh read settled it: the answer becomes the updated context
        // of a NEW round (the material above already carries it).
        clearPause(dir);
        this.log(`the continuity pause of ${key} is resolved by a fresh read of the real state — starting a new round`);
      }
    }
    if (launchable.callRecovery !== undefined) {
      material.callRetry = {
        id: launchable.callRecovery.id, command: launchable.callRecovery.command,
        cwd: launchable.callRecovery.cwd, reason: launchable.callRecovery.reason,
        ...(launchable.callRecovery.tool === undefined ? {} : { tool: launchable.callRecovery.tool, input: launchable.callRecovery.input! }),
        ...(launchable.callRecovery.executorSessionId === undefined ? {} : { sourceSessionId: launchable.callRecovery.sessionId }),
      };
    }
    // Every relaunch of the same attempt continues ITS session (ADR 0005):
    // a recovery, a model provider retry and the resume after the operator's
    // requested stop. A claim, a feedback or orientation round and a repair
    // round are new executions.
    const continuity = await planContinuity(continuityDeps, continuesAttempt ? "resume" : "new");
    if (continuity.decision === "pause") {
      this.log(
        `continuity of ${key} halted the relaunch (${continuity.pause.reason}) — ` +
          "the work pauses for help; no recovery is spent and no new attempt starts",
      );
      await this.pauseForContinuity(work, dir, continuity.pause, facts.attempt);
      return null;
    }

    // The recovery is GRANTED and persisted before the wait and the relaunch:
    // a death during the backoff or the session continues the
    // count instead of renewing the allowance. An exhausted budget pauses the
    // work and asks the operator for help — never another blind relaunch.
    //
    // The resume after the operator's requested stop spends
    // nothing and waits nothing: it continues the SAME attempt.
    if (kind === "recover" && launchable.requestedStop !== true) {
      const decision = await consumeRecovery(dir, config.recovery, facts.attempt);
      if (decision.decision === "recover") entry.recoveryIndex = decision.consumed - 1;
      if (decision.decision === "pause-help") {
        this.log(`recovery of ${key} paused: ${decision.reason} — the work is blocked and asks for help`);
        await this.pauseInterrupted(work, dir, facts.attempt, decision);
        return null;
      }
      this.log(
        `recovery ${decision.consumed}/${config.recovery.maxRecoveries} for ${key} — ` +
          `attempt ${facts.attempt} keeps its number, ` +
          (continuity.mode === "resume"
            ? `session ${continuity.sessionId} is reopened with ${continuity.intactEntries} confirmed entries of its history`
            : `session ${continuity.sessionId} starts fresh (no session had been created yet)`) +
          `; waiting ${decision.waitMs}ms before the relaunch`,
      );
      await this.wait(decision.waitMs);
      if (this.stopping) {
        await this.settleStoppedAdmission(entry, facts.attempt);
        this.log(
          `the recovery of ${key} stopped during the backoff — nothing is launched and the grant is returned ` +
            "with the requested-stop evidence",
        );
        return null;
      }
    }
    // The model provider retry is settled and persisted before the wait:
    // a death during the backoff continues the model provider count instead of
    // renewing it, and the interruption recovery budget is never touched.
    if (kind === "model-provider-retry") {
      const failure = await readTurnModelProviderError(dir, facts.attempt);
      if (failure === null) {
        this.log(
          `model provider retry for ${key} skipped: the attempt's stream no longer shows a provider error — nothing is launched`,
        );
        return null;
      }
      const decision = await this.applyModelProviderFailure(work, dir, facts.attempt, failure);
      if (decision.decision === "awaiting-model-provider") return null;
      await this.wait(decision.waitMs);
      if (this.stopping) {
        this.log(`the model provider retry of ${key} stopped during the backoff — the grant stays consumed, nothing is launched`);
        return null;
      }
    }

    // The stop may have landed while this admission persisted its own
    // bookkeeping (the grant, or the consumption of the requested stop): what
    // it wrote is undone and the requested stop is what the work keeps.
    if (this.stopping) {
      await this.settleStoppedAdmission(entry, facts.attempt);
      this.log(`the launch of ${key} stopped before the worker started — the requested stop stays on record`);
      return null;
    }

    // A launch means this attempt is being carried NOW: a stop record left on
    // it by a previous requested stop has done its job (or the record is stale on a
    // fresh claim of the same number), so it never excuses a later, unexpected
    // interruption of this attempt.
    const stopBeforeLaunch = (await readRecoveryLedger(dir)).lastStop;
    await consumeStopRequest(dir, facts.attempt);

    if (launchable.callRecovery !== undefined) clearPause(dir);
    // Charge only after continuity allowed the launch. A pause before a worker
    // exists is not an unpublished Repair and cannot consume a round or fall.
    if (repair !== undefined) {
      await this.recordRepairRound(dir, work, repair.trigger, facts.attempt, repair.localWork);
    }
    if (this.stopping) {
      await this.settleStoppedAdmission(entry, facts.attempt);
      return null;
    }
    entry.launched = true;
    let result: SessionResult;
    try {
      result = await runtime.launch({
        work,
        workDir: dir,
        branch: prepared.branch,
        repoDir: prepared.repoDir,
        baseBranch,
        attempt: facts.attempt,
        session: { mode: continuity.mode, sessionId: continuity.sessionId },
        material,
      });
    } catch (error) {
      if (stopBeforeLaunch?.kind === "stop-requested" && stopBeforeLaunch.attempt === facts.attempt &&
          ownWrittenOutcome(await readOutcomeRecord(dir), facts.attempt) === null &&
          (await readRecoveryLedger(dir)).lastStop === null) {
        await recordStopRequest(dir, facts.attempt);
      }
      throw error;
    }
    this.launched.push(result);

    return this.collect(launchable, result, facts.attempt, facts.previousFall);
  }

  /** The backoff before a recovery relaunch (the injected seam or a real timer).
   *  The requested stop ends the wait at once: a pending admission never delays
   *  the requested stop. */
  private async wait(ms: number): Promise<void> {
    if (ms <= 0 || this.stopping) return;
    const stopped = deferred();
    this.stopWaiters.push(stopped.resolve);
    try {
      await Promise.race([(this.deps.wait ?? sleepMs)(ms), stopped.promise]);
    } finally {
      dropWaiter(this.stopWaiters, stopped.resolve);
    }
  }

  /** Why a work's end cannot be confirmed, or null when it is: an unreadable
   *  probe is uncertainty, never an empty factory. */
  private stopHoldReason(observation: LivenessObservation, key: string): string | null {
    if (observation.state === "unknown") {
      return `the worker liveness could not be read (${observation.reason})`;
    }
    return observation.workers.some((worker) => worker.key === key)
      ? "a worker of this work is still alive"
      : null;
  }

  /**
   * Whether the operator's own requested stop owns the end of this attempt:
   * the persisted stop-requested, or a stop-unconfirmed one whose
   * worker this invocation just confirmed gone (promoted, so the launch
   * consumes it like any other requested stop). A stop of another attempt, or
   * a failure, never answers yes.
   */
  private async operatorStoppedAttempt(dir: string, attempt: number): Promise<boolean> {
    const { lastStop } = await readRecoveryLedger(dir);
    if (lastStop === null || lastStop.attempt !== attempt) return false;
    if (lastStop.kind === "stop-unconfirmed") {
      await confirmStopRequest(dir, attempt);
      return true;
    }
    return lastStop.kind === "stop-requested";
  }

  /** The facts a continuity decision reads for one paused work: its artifacts,
   *  its sessions, the Work and the attempt being continued. */
  private continuityDeps(work: WorkIdentity, dir: string, attempt: number): ContinuityDeps {
    const { git, tickets, pullRequests } = this.deps;
    return { workDir: dir, sessionsDir: join(dir, SESSIONS_SUBDIR), work, attempt, git, tickets, pullRequests };
  }

  /**
   * A pause whose doubt the attempt's session and the real state now settle
   * (issue 173): the record is closed and the CORRECT continuation is parked —
   * never launched from here, so every existing gate (liveness, continuity, the
   * recovery ruler, the operator's stop) applies again. A human answer bound to
   * the pause orients a NEW round; without one the SAME attempt continues.
   * Resolving a pause spends neither an attempt nor a recovery.
   */
  private async resolvedPause(
    work: WorkIdentity,
    dir: string,
    pause: PauseRecord,
    attempt: number,
    parked: Launchable[],
  ): Promise<void> {
    const { tickets, pullRequests, config } = this.deps;
    this.continuityDiagnostics.resolved(workKeyOf(work));
    const comments = await tickets.readTicketComments(work.ticket);
    const answers = comments.known ? humanCommentsForPause(comments.value, pause) : [];
    const feedback = await pullRequests.readPullRequestFeedback(workPullRequest(work));
    const pr = feedback.known ? feedback.value.pr : null;
    if (answers.length > 0) {
      // The clear lands first because the answer self-heals a death on either
      // side of it: with the record still there the answer is read again, and
      // with it cleared the resume launch swaps the block off.
      clearPause(dir);
      this.log(
        `continuity of ${renderWorkIdentity(work)} is resolved by its own evidence — ` +
          "the human answer orients a NEW round (no recovery is spent)",
      );
      // The resume launch swaps blocked→claimed itself.
      parked.push({ work, dir, kind: "resume", createdAt: pause.at, pr, issueReplies: answers });
      return;
    }
    // The block leaves with the pause: the recover launch continues the SAME
    // attempt and the existing recovery ruler decides whether it may relaunch.
    // The unblock lands BEFORE the record is cleared, and both are idempotent —
    // a death in between leaves the pause for the next recheck to resolve again,
    // while a death after the clear leaves an unblocked interrupted attempt,
    // which derives to a recovery on its own.
    await tickets.resumeTicketClaim(work.ticket, config.labels);
    clearPause(dir);
    this.log(
      `continuity of ${renderWorkIdentity(work)} is resolved by its own evidence — ` +
        `attempt ${attempt} continues (the recovery ruler applies)`,
    );
    parked.push({ work, dir, kind: "recover", createdAt: null, pr, attempt });
  }

  /**
   * A continuity pause: the interrupted attempt cannot be reopened
   * safely, so the work stops and asks for help instead of pretending a fresh
   * session is a continuation. The record is written FIRST and survives a
   * restart; the issue comment, the blocked label and the notice happen only
   * once per occurrence — a recheck that learned nothing new, a later sweep and
   * a restart never re-ask (issue 174), and neither does the first sweep after
   * an upgrade for a pause that was announced before occurrences had identities.
   * Only a changed REASON is a new fact worth a diagnostic, and it keeps the
   * occurrence's identity, so the answers already on the issue stay bound to it.
   */
  private async pauseForContinuity(
    work: WorkIdentity,
    dir: string,
    pending: PauseRecord,
    attempt: number,
  ): Promise<void> {
    const { tickets, config, workspace } = this.deps;
    const previous = readPause(dir);
    // By now the factory knows which work and attempt it is pausing, whatever
    // the record could say: an unreadable record's unknown work/attempt is
    // replaced here, so the persisted pause and the operator's comment name the
    // real attempt instead of a fabricated zero. The occurrence keeps its id
    // and its start time for as long as the record lives; only a resolved
    // pause (its record cleared) makes the next one a different occurrence.
    const pause = pauseOccurrence(pending, work, attempt, previous);
    this.announce(work, "reserved");
    // A record with no identity was announced before occurrences had one: the
    // question is already on the issue, so this is the same occurrence and the
    // identity it lacks must not ask it again. A record whose reason changed
    // since is a NEW fact and is told.
    const alreadyAnnounced =
      previous !== null &&
      previous.reason === pause.reason &&
      previous.announced === true &&
      (previous.id === undefined || previous.id === pause.id);
    if (alreadyAnnounced) {
      // The same pause was already announced: re-assert the blocked label
      // without repeating the request (a failed retomada swapped it), so the
      // work stays out of every launch and the human sees one request. Only the
      // detail may carry fresher evidence. The record is not marked
      // unannounced on the way: the request DID land.
      await tickets.blockTicketClaim(work.ticket, config.labels);
      writePause(dir, reassertedPause(pause, previous));
      this.reportContinuityPause(work, dir, pause);
      return;
    }
    // The record lands FIRST (a restart must know the work waits), marked
    // unannounced until the block and the request really landed: a death in
    // between leaves the fact that the operator was never told.
    writePause(dir, { ...pause, announced: false });
    this.reportContinuityPause(work, dir, pause);
    await this.applyBlockWithComment(
      work,
      await continuityPausedCommentBody({
        attempt: pause.attempt,
        evidencedAttempt: (await readAttemptLedger(dir)).lastAttempt,
        reason: pause.reason,
        id: pause.id,
        detail: pause.detail,
        workDir: dir,
        workspace,
        ...(pause.sessionId === undefined ? {} : { sessionId: pause.sessionId }),
      }),
    );
    writePause(dir, { ...pause, announced: true });
  }

  /**
   * Consent may be discovered on the sweep after the host cleared the pause and
   * died before dispatch: the journal, not the derivation state, says which
   * attempt the retry continues. Anything else about the work is unchanged, so
   * every gate below still applies. Unreadable recovery evidence launches
   * nothing and stays discoverable.
   */
  private async parkAuthorizedCallRetry(
    decision: ReservedDerivation,
    parked: Launchable[],
  ): Promise<boolean> {
    const key = workKeyOf(decision.work);
    if (this.carriedKeys.has(key) || this.slots.workKeys.includes(key)) return false;
    if (!consentAppliesTo(decision.state)) return false;
    let retry: CallRecovery | undefined;
    let ledger: Awaited<ReturnType<typeof readAttemptLedger>>;
    try {
      retry = pendingCallRecovery(decision.dir, decision.work);
      if (retry === undefined) return false;
      ledger = await readAttemptLedger(decision.dir);
    } catch (error) {
      this.log(`call recovery of ${key} cannot be read — ${describeError(error)}; nothing relaunched`);
      return true;
    }
    if (ledger.lastAttempt !== retry.attempt || ledger.recordedAttempt === retry.attempt) return false;
    const feedback = await this.deps.pullRequests.readPullRequestFeedback(workPullRequest(decision.work));
    if (!feedback.known) return false;
    if (feedback.value.pr !== null && feedback.value.pr.state !== "open") return false;
    parked.push({
      work: decision.work,
      dir: decision.dir,
      kind: "recover",
      createdAt: null,
      pr: feedback.value.pr,
      attempt: retry.attempt,
      callRecovery: retry,
      requestedStop: await this.operatorStoppedAttempt(decision.dir, retry.attempt),
    });
    this.announce(decision.work, "reserved");
    return true;
  }

  private reportContinuityPause(work: WorkIdentity, dir: string, pause: PauseRecord): void {
    const message = this.continuityDiagnostics.paused(workKeyOf(work), dir, pause);
    if (message !== null) this.log(message);
  }

  /** The exhausted recovery budget: block the work and ask the operator for
   *  help, naming the configured value and backoff — no attempt was consumed. */
  private async pauseInterrupted(
    work: WorkIdentity,
    dir: string,
    attempt: number,
    decision: Extract<RecoveryDecision, { decision: "pause-help" }>,
  ): Promise<void> {
    const { workspace, config } = this.deps;
    // The exhausted pause spends nothing: it only records the stop that
    // `msf status` reads.
    await recordInterruptionStop(dir, attempt);
    const comment = await interruptionPausedCommentBody({
      attempt,
      budget: config.recovery,
      record: await readOutcomeRecord(dir),
      workDir: dir,
      workspace,
    });
    this.log(
      `the interrupted attempt ${attempt} of ${renderWorkIdentity(work)} is paused (${decision.reason}) — ` +
        "blocked with the evidence; a human decision is needed",
    );
    await this.applyBlockWithComment(work, comment);
    this.announce(work, "reserved");
  }

  /**
   * Settle one model provider failure and apply its decision: the
   * attempt's own log records the failure and each granted retry, the ledger
   * persists the count, and an exhausted budget comments the help request on
   * the issue — keeping the claim, never the blocked label. Idempotent: the
   * same failure settled twice records once; the help request is retryable, so
   * a death between the ledger and the comment never loses it.
   */
  private async applyModelProviderFailure(
    work: WorkIdentity,
    dir: string,
    attempt: number,
    failure: ModelProviderFailure,
  ): Promise<ModelProviderDecision> {
    const { config, tickets, workspace } = this.deps;
    const ledger = await readModelProviderLedger(dir);
    const decision = modelProviderDecision(ledger, config.modelProvider, attempt, failure);

    // The attempt's own log carries the event BEFORE the ledger is written: a
    // death between the two leaves the evidence (at worst a repeated line),
    // never a silent loss of the failure or of the retry it granted.
    const alreadyGranted = isModelProviderRetryGranted(ledger, attempt, failure);
    if (!isModelProviderFailureSettled(ledger, attempt, failure)) {
      appendAttemptEvent(dir, attempt, {
        event: "model-provider-failure",
        message: failure.message,
        failureIdentity: failure.identity,
      });
    }
    if (decision.decision === "retry" && !alreadyGranted) {
      appendAttemptEvent(dir, attempt, {
        event: "model-provider-retry",
        retry: decision.consumed,
        maxRetries: config.modelProvider.maxRetries,
        waitMs: decision.waitMs,
      });
    }

    const settlement = await settleModelProviderFailure(dir, config.modelProvider, attempt, failure);
    if (settlement.decision === "awaiting-model-provider") {
      // The help request is retryable, not tied to the settlement that raised
      // it: a death between the ledger and the comment leaves it unrequested,
      // and the next sweep asks again.
      const helpPending = isModelProviderHelpPending(
        await readModelProviderLedger(dir),
        attempt,
        failure,
      );
      if (helpPending) {
        // Keep the work reserved before asking: re-asserting the (already held)
        // claim is idempotent and is what the operator's answer resumes.
        await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
        const comment = await modelProviderAwaitingCommentBody({
          attempt,
          failure,
          budget: config.modelProvider,
          workDir: dir,
          workspace,
        });
        await tickets.commentOnTicket(work.ticket, comment);
        await this.deliverNotice(helpNotice(work));
        await markModelProviderHelpRequested(dir, attempt, failure);
        this.log(
          `awaiting model provider for ${renderWorkIdentity(work)}: attempt ${attempt} ended by a model provider failure ` +
            `(${settlement.reason}) — a help request on the issue, never a block; the recovery budget is untouched`,
        );
      }
      return settlement;
    }

    if (settlement.recorded) {
      this.log(
        `model provider failure on attempt ${attempt} of ${renderWorkIdentity(work)}: ${failure.message} — ` +
          `retry ${settlement.consumed}/${config.modelProvider.maxRetries} after ${settlement.waitMs}ms ` +
          "(the recovery budget is untouched)",
      );
    }
    return settlement;
  }

  /**
   * The repair reconciliation of the tick: every repair attempt
   * that wrote its facts on disk and is not carried by a live worker is
   * settled against the remote BEFORE the derivation reads the cycle. The
   * settlement is idempotent — a settled attempt is never charged, refunded or
   * counted again — and an unreadable remote leaves the attempt pending: no
   * worker and no budget return until a later sweep gets an answer.
   */
  private async reconcileRepairAttempts(
    works: readonly ReservedWorkInput[],
    inFlight: ReadonlySet<string>,
  ): Promise<void> {
    for (const work of works) {
      const key = workKeyOf(work.work);
      // A live worker owns its attempt: settling it mid-flight would read a
      // half-written branch as a verdict.
      if (inFlight.has(key)) continue;

      const stored = await readRepairCycle(work.dir);
      const requestedStop = stored.attempt !== null && await this.operatorStoppedAttempt(work.dir, stored.attempt.attempt);
      if (stored.attempt !== null && !requestedStop && stored.attempt.publication === "unknown" &&
          !existsSync(join(work.dir, eventLogName(stored.attempt.attempt)))) {
        const journal = readEffectJournal(work.dir);
        const record = await readOutcomeRecord(work.dir);
        if (journal.intact && !journal.sessions.some((entry) => entry.attempt === stored.attempt!.attempt) &&
            record?.attempt !== stored.attempt.attempt) {
          await writeRepairCycle(work.dir, {
            ...stored, usedRounds: Math.max(0, stored.usedRounds - 1), lastEvidence: null, attempt: null,
          });
          this.log(`repair attempt ${stored.attempt.attempt} of ${key} never reached the runtime — round returned, no fall`);
          continue;
        }
      }
      if (stored.attempt !== null && requestedStop &&
          ownWrittenOutcome(await readOutcomeRecord(work.dir), stored.attempt.attempt) === null) {
        continue; // The same Repair is stopped, not finished: no publication verdict or fall yet.
      }
      if (stored.attempt !== null && isSettledPublication(stored.attempt.publication)) continue;
      // A work that never ran a repair round has nothing to reconcile — no git
      // inspection is paid for it on every sweep.
      if (!hasRepairCycle(stored)) continue;

      // Git is read only when there is a verdict to reach: a legacy cycle with
      // no registry gap is not an attempt, and paying an inspection for it on
      // every sweep would be waste, not diligence.
      let cycle: RepairCycle;
      let localWork: LocalWorkFacts | null;
      if (stored.attempt !== null) {
        cycle = stored;
        localWork = await this.inspectLocalWork(work.work);
      } else {
        const adopted = await this.adoptLegacyCycle(work, stored);
        if (adopted === null) continue;
        cycle = adopted;
        localWork = adopted.attempt?.localWork ?? null;
      }

      const remote = await this.observeRemote(work.work);
      // The premise is part of the verdict: a remote the attempt
      // did not produce is a concurrent change ONLY while the impediment the
      // round addressed still exists — a human's own resolution is never
      // taken for a reason to ask for help. The read happens once per
      // settlement: a settled or attempt-less cycle never reaches this line.
      const premise = readRepairPremise(
        await this.deps.pullRequests.readPullRequestRepairFacts(
          workPullRequest(work.work),
        ),
      ).premise;
      const decision = reconcileRepairAttempt({ cycle, remote, localWork, premise });
      if (decision.kind === "none") continue;
      await writeRepairCycle(work.dir, decision.cycle);
      this.logReconciliation(key, decision);
    }
  }

  /**
   * A requested stop whose confirmation failed on a previous invocation:
   * the work is held until a probe proves the previous worker
   * gone, and only then becomes the requested-stop resume it was meant to be. An
   * unreadable probe is uncertainty: the work stays held, the reason said out
   * loud, and no worker is launched on top of it.
   */
  private async reconcileUnconfirmedStops(
    works: readonly ReservedWorkInput[],
    inFlight: ReadonlySet<string>,
  ): Promise<void> {
    const held: Array<{ dir: string; work: WorkIdentity; attempt: number; because: string }> = [];
    for (const work of works) {
      const key = workKeyOf(work.work);
      if (inFlight.has(key)) continue;
      const ledger = await readRecoveryLedger(work.dir);
      const stop = ledger.lastStop;
      if (stop === null || stop.kind !== "stop-unconfirmed") continue;
      held.push({ dir: work.dir, work: work.work, attempt: stop.attempt, because: stop.because });
    }
    if (held.length === 0) {
      this.reportedStopHolds.clear();
      return;
    }

    for (const entry of held) {
      const key = workKeyOf(entry.work);
      const because = this.stopHoldReason(this.liveness, key);
      if (because !== null) {
        this.reportStopHold(key, `${because} — the previous stop (${entry.because}) stays unconfirmed`);
        continue;
      }
      this.reportedStopHolds.delete(key);
      await confirmStopRequest(entry.dir, entry.attempt);
      this.log(
        `derived ${key}: the worker of the previous stop is confirmed gone — attempt ${entry.attempt} resumes ` +
          "without spending a recovery",
      );
    }
  }

  /** Say the hold of a reservation this composition cannot address once per
   *  appearance — the tick repeats it otherwise — and forget the ones that
   *  cleared, so a later reappearance is said again. */
  private reportReservationHolds(held: readonly { key: string; reason: string }[]): void {
    const next = new Map(held.map((entry) => [entry.key, entry.reason]));
    for (const [key, reason] of next) {
      if (this.reportedReservationHolds.get(key) === reason) continue;
      this.log(`reserved work ${key} ${reason}`);
    }
    this.reportedReservationHolds = next;
  }

  /** Say the hold once per appearance (the tick repeats it otherwise). */
  private reportStopHold(key: string, because: string): void {
    if (this.reportedStopHolds.get(key) === because) return;
    this.reportedStopHolds.set(key, because);
    this.log(
      `derived ${key}: NOT relaunching — ${because}. The work stays held until the previous worker is ` +
        "known to be gone (see `msf status`); a human may need to stop it",
    );
  }

  /** The cycle a legacy reparo.json implies: the budget was charged
   *  and the registry shows an attempt after the last recorded outcome — the
   *  attempt whose observed head only the evidence signature names. */
  private async adoptLegacyCycle(work: ReservedWorkInput, cycle: RepairCycle): Promise<RepairCycle | null> {
    const ledger = await readAttemptLedger(work.dir);
    const candidate = legacyRepairAttempt({
      cycle,
      lastAttempt: ledger.lastAttempt,
      recordedAttempt: ledger.recordedAttempt,
    });
    if (candidate === null) return null;
    const localWork = await this.inspectLocalWork(work.work);
    return { ...cycle, attempt: { ...candidate, localWork } };
  }

  /** The reconciliation verdict, said once in the operator's log. */
  private logReconciliation(
    key: string,
    decision: Exclude<RepairReconciliation, { kind: "none" }>,
  ): void {
    const attempt = decision.cycle.attempt;
    if (attempt === null) return;
    switch (decision.kind) {
      case "pending":
        this.log(
          `repair attempt ${attempt.attempt} of ${key}: reconciliation pending (${decision.reason}) — ` +
            "no worker and no budget return while publication is uncertain",
        );
        return;
      case "published":
        this.log(
          `repair attempt ${attempt.attempt} of ${key} confirmed published at ${shortSha(attempt.observedHeadSha)} → ` +
            `${attempt.remoteHeadSha === null ? "the remote" : shortSha(attempt.remoteHeadSha)} — the round stays charged ` +
            `(${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS})`,
        );
        return;
      case "not-published":
        this.log(
          `repair attempt ${attempt.attempt} of ${key} ended without publishing — the round returns ` +
            `(${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS}), ${decision.cycle.consecutiveFalls}/${MAX_REPAIR_FALLS} consecutive falls; ` +
            `local work preserved: ${renderLocalWork(attempt.localWork)}`,
        );
        return;
      case "premise-obsolete":
        this.log(
          `repair attempt ${attempt.attempt} of ${key}: the impediment it was launched for no longer exists ` +
            `(the premise is obsolete) — the round returns (${decision.cycle.usedRounds}/${MAX_REPAIR_ROUNDS}) ` +
            `with no fall counted; local work preserved: ${renderLocalWork(attempt.localWork)}`,
        );
        return;
      case "concurrent-change":
        this.log(
          `repair attempt ${attempt.attempt} of ${key}: the remote branch ` +
            `${describeRemoteChange(attempt.remoteHeadSha)} — a concurrent change the attempt did not produce; ` +
            `local work preserved (${renderLocalWork(attempt.localWork)}), a human is asked`,
        );
        return;
    }
  }

  /** Record that the remote moved to a head the attempt did not produce: the
   * derivation then blocks the work with the help request. */
  private async markConcurrentChange(
    work: WorkIdentity,
    attempt: RepairAttempt,
    remoteHeadSha: string | null,
  ): Promise<void> {
    const dir = workDirOfKey(this.deps.workspace, workKeyOf(work));
    const cycle = await readRepairCycle(dir);
    await writeRepairCycle(dir, {
      ...cycle,
      attempt: { ...attempt, publication: "concurrent-change", remoteHeadSha },
    });
    this.log(
      `repair attempt ${attempt.attempt} of ${renderWorkIdentity(work)}: the remote branch ` +
        `${describeRemoteChange(remoteHeadSha)} while the attempt's observed head was ` +
        `${shortSha(attempt.observedHeadSha)} — local work preserved, nothing is published`,
    );
  }

  /** The local work of a work, or null when git cannot answer — never "nothing there". */
  private async inspectLocalWork(work: WorkIdentity): Promise<LocalWorkFacts | null> {
    try {
      return await this.deps.git.inspectLocalWorkFor(work);
    } catch {
      return null;
    }
  }

  /** The remote head now, or the honest uncertainty (an unreadable remote is
   *  not an empty branch). */
  private async observeRemote(work: WorkIdentity): Promise<RemoteObservation> {
    try {
      return { known: true, headSha: await this.deps.git.observeRemoteHeadFor(work) };
    } catch {
      return { known: false };
    }
  }

  /** Charge one automatic repair round before its session: the budget, the
   *  consumed evidence and the attempt's own facts persist on disk, so a
   *  restart neither renews the cap nor repeats the same round, and a death is
   *  attributable once the remote answers. */
  private async recordRepairRound(
    dir: string,
    work: WorkIdentity,
    trigger: RepairTrigger,
    attempt: number,
    localWork: LocalWorkFacts | null,
  ): Promise<void> {
    const cycle = await readRepairCycle(dir);
    const signature = repairSignature(work, trigger);
    await writeRepairCycle(dir, {
      usedRounds: cycle.usedRounds + 1,
      lastEvidence: signature,
      consecutiveFalls: cycle.consecutiveFalls,
      attempt: {
        evidence: signature,
        attempt,
        observedHeadSha: trigger.facts.headSha,
        remoteHeadSha: null,
        publication: "unknown",
        localWork,
      },
    });
  }

  /**
   * Collection at the act: the ruler applied to the worker this process
   * launched. The result is what the launch returned; the facts the ruler
   * reads are still the attempt's own artifacts and the tracker.
   */
  private async collect(
    launchable: Launchable,
    result: SessionResult,
    attempt: number,
    consecutiveFall: boolean,
  ): Promise<Launchable | null> {
    const outcome = await this.applyEnd(launchable, {
      dir: result.request.workDir,
      attempt,
      consecutiveFall,
      origin: "collected",
    });
    this.collected.push({
      work: launchable.work,
      result,
      prConfirmed: outcome.prConfirmed,
      ruling: outcome.ruling,
    });
    return outcome.next;
  }

  /**
   * The ruler at the act of an end — the survivor ends included — on structured
   * facts alone: the outcome record (absence = an interruption), the PR fact
   * and the label facts from the port, and the
   * registry's consecutiveness. The decided transition is applied here; an
   * interruption returns the SAME attempt as the next launch.
   * `origin` only names the actor in the operator's log: a survivor's end is
   * reconciled by these same facts, never by the launch object this process
   * never had.
   */
  private async applyEnd(launchable: Launchable, end: AttemptEnd): Promise<RulingApplied> {
    const { dir, attempt, consecutiveFall, origin } = end;
    const { config, tickets, pullRequests, workspace } = this.deps;
    const { work } = launchable;
    const key = workKeyOf(work);

    const feedback = await pullRequests.readPullRequestFeedback(
      workPullRequest(work, launchable.pr),
    );
    const pr = feedback.known ? feedback.value.pr : null;
    const prConfirmed = pr !== null && pr.state === "open";
    const issue = await tickets.readTicket(work.ticket);
    const blockedLabelOnIssue = issue.known && issue.value.labels.includes(config.labels.blocked);
    const record = await readOutcomeRecord(dir);
    const ruling = await classifyOutcome({
      record,
      prOpen: prConfirmed,
      prMerged: pr !== null && pr.merged,
      requestedStop: this.stopping || await this.operatorStoppedAttempt(dir, attempt),
      blockedLabelOnIssue,
      consecutiveFall,
      attempt,
      issueClosed: issue.known && issue.value.state === "closed",
      workDir: dir,
      workspace,
    });

    // A settled attempt makes any continuity pause of its own history: the new
    // record (or block) is the current fact, and a stale pause
    // must not keep the work out of later rounds. An interruption keeps it.
    if (ruling.decision !== "interrupt") clearPause(dir);

    // A known PR — open, merged or closed — is persisted beside the Work:
    // the facts survive a restart, and a later attempt appends
    // its own. Persistence never changes the ruling above.
    if (pr !== null) {
      try {
        recordPrAssociation(dir, { work, pullRequest: pr.identity, attempt });
      } catch (error) {
        this.log(
          `PR association of ${key} was not persisted (${describeError(error)}) — ` +
            "the ruling stands and the earlier evidence is untouched",
        );
      }
    }

    // A confirmed Outcome prevails over the interpretation of the stop: the
    // attempt ended with a verdict, so the suspended-stop evidence
    // has done its job and is cleared (a fall replaces it with its own stop).
    if (ruling.decision !== "interrupt") await consumeStopRequest(dir, attempt);

    let resulting: OperationalClass | null;
    let next: Launchable | null = null;
    if (ruling.decision === "done") {
      // The terminal state was reached while this claim was held: archive the
      // artifacts and clean the branches, nothing is released or recorded. A
      // merge that did not close the issue is closed here first — done must
      // always be reflected on the tracker, including a merge
      // that landed mid-round.
      if (ruling.because === "pr-merged") {
        this.log(
          `${origin} ${key}: PR merged while the attempt ran — done; the factory closes the issue ` +
            "(fallback of the linkage), then archives",
        );
        await this.completeMergedWork(work, fallbackDoneComment());
      } else {
        this.log(`${origin} ${key}: issue closed — done; artifacts archived, branches cleaned`);
        await this.finishWork(work);
      }
      resulting = null;
    } else if (ruling.decision === "reserve") {
      this.log(`${origin} ${key}: PR open — stays reserved, waiting for the human`);
      resulting = "reserved";
    } else if (ruling.decision === "record-only") {
      this.log(`${origin} ${key}: blocked self-report — the factory only records the outcome`);
      resulting = "reserved";
    } else if (ruling.decision === "interrupt") {
      // No attempt is consumed and the fall ruler never applies. A
      // repair round is settled by its own reconciliation instead.
      resulting = "reserved";
      if (launchable.kind === "repair") {
        this.log(
          `${origin} ${key}: the repair attempt wrote no outcome record — the repair reconciliation ` +
            "settles its publication before another round",
        );
      } else if (this.stopping) {
        // The operator's requested stop: the attempt is left for
        // the next invocation to resume, never relaunched inside a requested stop.
        this.log(
          `collected ${key}: attempt ${attempt} ended without an outcome record while the factory stops — ` +
            "no recovery is spent and the next run resumes the same attempt",
        );
      } else if (await this.operatorStoppedAttempt(dir, attempt)) {
        // The worker outlived the operator's stop (a survivor whose end this
        // invocation confirmed): the attempt ends where the requested stop
        // left it, so it resumes for free — the stop never charges the budget,
        // no matter which process observes the end.
        this.log(
          `${origin} ${key}: attempt ${attempt} ended without an outcome record, and the operator's requested ` +
            "stop owns that end — it resumes now, spending no recovery",
        );
        next = {
          work,
          dir,
          kind: "recover",
          createdAt: null,
          pr,
          attempt,
          requestedStop: true,
        };
      } else {
        // The attempt's own stream decides whether this was the agent's
        // interruption or a model provider failure: the latter
        // gets its own budget and backoff.
        const failure = await readTurnModelProviderError(dir, attempt);
        if (failure === null) {
          this.log(
            `${origin} ${key}: interrupted (no outcome record) — not a failure; attempt ${attempt} keeps its ` +
              "number and the recovery budget answers it",
          );
        }
        next = {
          work,
          dir,
          // A model provider failure retries on its own budget; an interruption of
          // the agent keeps its interruption recovery. Either way the SAME
          // attempt continues, with the material of the interrupted launch
          // preserved.
          kind: failure === null ? "recover" : "model-provider-retry",
          createdAt: null,
          pr,
          ...(launchable.issueReplies === undefined ? {} : { issueReplies: launchable.issueReplies }),
          attempt,
        };
      }
    } else if (ruling.decision === "release") {
      await this.settleFailure(dir, attempt, record);
      this.log(
        `${origin} ${key}: fall without PR — release (claimed→ready back; ` +
          "the branch stays, the next sweep picks it up)",
      );
      await this.applyRelease(work);
      resulting = "eligible";
    } else {
      await this.settleFailure(dir, attempt, record);
      this.log(
        `${origin} ${key}: 2nd consecutive fall — blocked, the attempt's outcome goes to the issue`,
      );
      await this.applyBlockWithComment(work, ruling.comment);
      resulting = "reserved";
    }
    this.announce(work, resulting);

    // One notice per new occurrence: an applied block already notified help
    // (applyBlockWithComment), so here only the label/self-report of a work
    // the ruler did not block. Help wins over review; the state decision is
    // untouched. The self-report counts only for THIS attempt — desfecho.json
    // survives between attempts. A survivor's end is a review occurrence too:
    // its open PR reaches the operator even though this process never
    // launched it.
    if (needsOccurrenceNotice(ruling)) {
      const selfReportedNow = selfReportedBlocked(record, attempt);
      const isReviewLaunch =
        origin === "survivor" || launchable.kind === "claim" || launchable.kind === "feedback";
      if (blockedLabelOnIssue || selfReportedNow) {
        await this.deliverNotice(helpNotice(work));
      } else if (isReviewLaunch && prConfirmed && pr !== null) {
        await this.deliverNotice(reviewNotice(work, pr.number));
      }
    }
    return { next, prConfirmed, ruling: { decision: ruling.decision, because: ruling.because } };
  }

  /**
   * Persist the WRITTEN failure that ended the attempt: the next
   * attempt starts with a full interruption budget, and `msf status` says the
   * attempt was consumed. A missing or other-attempt record, or a class that
   * is not a failure (pr-open, self-report), settles nothing.
   */
  private async settleFailure(dir: string, attempt: number, record: OutcomeRecord | null): Promise<void> {
    const own = ownWrittenOutcome(record, attempt);
    if (own !== null && isRecordedFailure(own)) await recordFailure(dir, attempt, own.class);
  }

  /** The 1st-fall release (the ruler's mirrored swap): claimed→ready back,
   *  the assignee of the worker account released — the work re-enters the
   *  pool, the branch stays. One write pair, one helper: the derivation's
   *  unreconciled release and the collection's ruled release share it. */
  private async applyRelease(work: WorkIdentity): Promise<void> {
    const { tickets, config } = this.deps;
    await tickets.releaseTicketClaim(work.ticket, config.workerGhAccount, config.labels.ready);
  }

  /** The block transition every 2nd fall and every rejection shares: the
   *  claimed label swaps to blocked (the claim is held until the terminal
   *  state) and the diagnosis is commented on the issue — the human must
   *  SEE why it fell before deciding to resume. Applying a block IS the new
   *  occurrence, so the help notice is delivered here, once. */
  private async applyBlockWithComment(work: WorkIdentity, comment: string): Promise<void> {
    const { tickets, config } = this.deps;
    await tickets.blockTicketClaim(work.ticket, config.labels);
    await tickets.commentOnTicket(work.ticket, comment);
    await this.deliverNotice(helpNotice(work));
  }

  /** The done duties on real disk and real git: archive the work's artifacts
   * (trabalhos/ → arquivo/, nothing deleted) and clean the branches. */
  private async finishWork(work: WorkIdentity): Promise<void> {
    await archiveDoneWorkFor(this.deps.workspace, work);
    await this.deps.git.cleanupDoneWorkFor(work);
  }

  /** The delivery a merge without closure implies: close the issue with the
   *  short fallback comment, then archive and clean — done must always be
   *  reflected on the tracker. Shared by the derivation's done-fallback and by
   *  a merge that landed mid-round. */
  private async completeMergedWork(work: WorkIdentity, comment: string): Promise<void> {
    const { tickets } = this.deps;
    await tickets.markTicketDone(work.ticket);
    await tickets.commentOnTicket(work.ticket, comment);
    await this.finishWork(work);
  }

  /** Best-effort delivery of one occurrence notice; a failure only logs. A
   *  delivery failure never turns unknown safety into permission to launch. */
  private async deliverNotice(notification: Notification): Promise<void> {
    if (!this.deps.config.notifications) return;
    const notifier = this.deps.notifier;
    if (notifier === undefined) return;
    try {
      await notifier.notify(notification);
    } catch (error) {
      this.log(
        `local notification failed (${describeNotification(notification)}): ` +
          describeError(error),
      );
    }
  }

  /** A collected work never stays launchable in this process's memory — nor
   *  does a survivor's pending recovery for it. */
  private discardFromCacheAndParked(key: string): void {
    this.cache = this.cache.filter((entry) => workKeyOf(entry.work) !== key);
    this.parkedQueue = this.parkedQueue.filter((entry) => workKeyOf(entry.work) !== key);
    this.survivorRecoveries = this.survivorRecoveries.filter((entry) => workKeyOf(entry.work) !== key);
  }

  private serializePrepare<T>(repo: string, prepare: () => Promise<T>): Promise<T> {
    const tail = this.preparing.get(repo) ?? Promise.resolve();
    const run = tail.then(prepare, prepare);
    this.preparing.set(
      repo,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }
}

type WakeEvent = "worker-end" | "tick" | "abort";

const logClaim = (log: (message: string) => void, key: string): void =>
  log(`claiming ${key} (ready → claimed on the tracker, before any launch)`);

/**
 * One sweep with the --once boundary: derive the pool AND the
 * reserved states through the port, act on what the derivation decided
 * (archive dones, close fallbacks, block rejections), claim and launch up to
 * `y` workers concurrently — parked reserved first, then new claims by age —
 * collect each one at the act of its end and wait for every launched worker
 * before returning. With an empty pool and nothing parked: no worker is
 * launched and the process ends clean.
 */
export async function runOnce(deps: LoopDeps, stop: StopOptions = {}): Promise<SweepResult> {
  const engine = new SweepEngine(deps, stop);
  const reserved = await engine.deriveAndAct();
  engine.fillSlots();
  const report = await engine.settle();
  return {
    pool: engine.lastPool,
    reserved,
    reconciliation: engine.lastReconciliation,
    launched: engine.launched,
    collected: engine.collected,
    stop: report,
  };
}

/** A launch failure never takes the continuous factory down unobserved. */
function logLaunchFailure(log: (message: string) => void, run: Promise<void>): void {
  void run.catch((error: unknown) => {
    log(`launch failed: ${describeError(error)}`);
  });
}

/**
 * A failed sweep never takes the continuous factory down: a
 * tracker read that GitHub did not answer — or any other error escaping the
 * derivation — ends the sweep, not the factory. Nothing of the sweep is
 * applied, so the pooled work and the parked queue still hold the PREVIOUS
 * sweep's state; the caller launches nothing from them and the next tick
 * repeats the derivation from disk + tracker alone. `false` = failed sweep.
 */
async function sweepOrLog(
  engine: SweepEngine,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await engine.deriveAndAct();
    return true;
  } catch (error) {
    log(`sweep failed: ${describeError(error)} — retrying on the next tick`);
    return false;
  }
}

/**
 * The continuous run: the idle factory keeps sweeping on the
 * fixed tick forever — ending it is a human act (the signal below). The
 * wake is hybrid: end of worker ends the wait immediately (the collection
 * and the slot replenishment already happened at the act); the tick drives
 * the full derivation, so human changes are noticed at most one tick later.
 */
export async function runForever(
  deps: LoopDeps,
  options: StopOptions & { tickMs?: number } = {},
): Promise<StopReport> {
  const engine = new SweepEngine(deps, options);
  const log = operationalLog(deps.log);
  const tickMs = options.tickMs ?? TICK_MS;
  const signal = options.signal;

  // The engine listens to the requested stop from its construction, so a stop
  // landing during a derivation closes admissions without this loop polling
  // for it, and the pre-aborted case is already in the requested stop.
  if (await sweepOrLog(engine, log) && !engine.isStopping) {
    for (const run of engine.fillSlots()) logLaunchFailure(log, run);
  }

  for (;;) {
    const event = await engine.waitForWake(tickMs, signal);
    if (event === "abort" || signal?.aborted || engine.isStopping) {
      // No new launch from here on; the run retains ownership until every
      // started worker ended and the stop is confirmed (or reported as
      // unconfirmed, never presumed).
      const report = await engine.beginRequestedStop();
      log(
        stopConfirmed(report)
          ? "factory ended cleanly (the operator's requested stop was confirmed)"
          : "factory ended with an UNCONFIRMED stop — the next run checks the affected works again",
      );
      return report;
    }
    if (event === "worker-end") {
      // The collection happened at the act; nothing to re-derive — the
      // human changes wait for the tick (staleness bounded by the interval).
      continue;
    }
    if (await sweepOrLog(engine, log) && !engine.isStopping) {
      for (const run of engine.fillSlots()) logLaunchFailure(log, run);
    }
  }
}

/** The repair context a session is launched with: the confirmed
 *  trigger, the unpublished attempt it takes over (when resuming) and the
 *  local work read from the host. */
interface RepairLaunchContext {
  trigger: RepairTrigger;
  resuming: RepairAttempt | null;
  localWork: LocalWorkFacts | null;
  /** The remote head the intervention observed — the force-with-lease value. */
  pinnedHeadSha: string;
}

/**
 * Gather the launch material of a work from the port + git host:
 * the issue (title/body), human issue replies on a blocked retomada, the open
 * PR's conversation on a feedback round, the repair context above, and the
 * diff. Unknown reads degrade to empty — the prompt still carries whatever is
 * known, never a lie.
 */
async function launchMaterial(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
  git: GitWork,
  launchable: Launchable,
  repair?: RepairLaunchContext,
): Promise<WorkerMaterial> {
  const { work, issueReplies } = launchable;
  const issue = await tickets.readTicket(work.ticket);
  const feedback = await pullRequests.readPullRequestFeedback(workPullRequest(work, launchable.pr));
  const diff = await git.diffWorkFor(work);

  const pr =
    feedback.known && feedback.value.pr !== null && feedback.value.pr.state === "open"
      ? {
          number: feedback.value.pr.number,
          comments: [...feedback.value.comments, ...feedback.value.reviews].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          ),
        }
      : undefined;

  const material: WorkerMaterial = {
    ticket: issue.known ? { title: issue.value.title, body: issue.value.body } : { title: "", body: "" },
    diff,
  };
  if (pr !== undefined) material.pr = pr;
  if (issueReplies !== undefined) material.ticketReplies = issueReplies;
  if (repair !== undefined) {
    material.repair = {
      reasons: repair.trigger.reasons,
      observedHeadSha: repair.pinnedHeadSha,
      baseBranch: repair.trigger.facts.baseBranch,
      checks: repair.trigger.failingChecks,
      ...(repair.localWork === null ? {} : { localWork: repair.localWork }),
      ...(repair.resuming === null ? {} : { resuming: repair.resuming.attempt }),
    };
  }
  return material;
}
