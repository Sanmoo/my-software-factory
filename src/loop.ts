import { randomUUID } from "node:crypto";

import type { Config } from "./config.js";
import type { PullRequestRecord, PullRequestTracker, TicketTracker } from "./tracker/expanded-port.js";
import type { SessionResult, WorkerRuntime } from "./runtime/port.js";
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
  type WorkIdentity,
} from "./tracker/identity.js";
import { scanReservations, type IdentifiedReservation } from "./pool/reservation.js";
import { recordPrAssociation } from "./pool/pr-association.js";
import {
  deriveTrackerState,
  humanCommentsForPause,
  workPullRequest,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  unbackedClaimKey,
  unmarkedReservationKey,
  type Reconciliation,
  type PoolEntry,
} from "./state/derive.js";
import { openLaunch, type Launch, type LaunchCycle, type Launchable } from "./launch/launch.js";
import {
  STATE_DECLARATIONS,
  consentAppliesTo as stateConsentAppliesTo,
  openWorkState,
  type OperationalClass,
  type WorkRef,
  type WorkState,
  type WorkStateReading,
} from "./work-state/state.js";
import { readOutcomeRecord, type OutcomeRecord } from "./work-record/outcome.js";
import {
  isRecordedFailure,
  ownWrittenOutcome,
  interruptionPausedCommentBody,
  modelProviderAwaitingCommentBody,
  continuityPausedCommentBody,
} from "./state/outcome.js";
import { readAttemptLedger, readLastAttempt } from "./work-record/attempts.js";
import { archiveDoneWorkFor } from "./pool/registry.js";
import {
  EMPTY_REPAIR_CYCLE,
  readRepairCycle,
  writeRepairCycle,
  type RepairCycle,
} from "./work-record/repair.js";
import {
  MAX_REPAIR_FALLS,
  MAX_REPAIR_ROUNDS,
  hasRepairCycle,
  legacyRepairAttempt,
  type RemoteObservation,
} from "./pool/repair.js";
import {
  settleRepairRound,
  type RepairRoundStart,
  type RepairSettlement,
} from "./pool/repair-round.js";
import { describeRemoteChange, renderLocalWork, shortSha } from "./state/repair-view.js";
import { readRecoveryLedger } from "./work-record/recovery.js";
import {
  confirmStopRequest,
  consumeStopRequest,
  recordFailure,
  recordInterruptionStop,
  type RecoveryDecision,
} from "./pool/recovery.js";
import {
  OperatorStop,
  operatorStopClaim,
  reconcileUnconfirmedStops,
  stopConfirmed,
  type StopReport,
} from "./pool/stop.js";
import { workKeyOf, workOfKey } from "./pool/work-key.js";
import { readModelProviderLedger } from "./work-record/model-provider.js";
import {
  isModelProviderFailureSettled,
  isModelProviderHelpPending,
  isModelProviderRetryGranted,
  markModelProviderHelpRequested,
  modelProviderDecision,
  settleModelProviderFailure,
  type ModelProviderDecision,
} from "./pool/model-provider.js";
import { deferred } from "./runtime/deferred.js";
import { recheckPausedEffects, type ContinuityDeps } from "./runtime/continuity.js";
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
} from "./work-record/continuity.js";
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
  duplicateWorkers,
  occupiedSlots,
  probeLiveness,
  type LivenessObservation,
  type LivenessProbe,
} from "./state/liveness.js";
import { DEFAULT_IDLE_LIMIT_MS } from "./runtime/activity.js";
import { appendAttemptEvent, eventLogName } from "./work-record/logs.js";
import { processRecoveryRequests } from "./recover.js";
import type { ModelProviderFailure } from "./work-record/model-provider-error.js";
import { operationalLog } from "./log.js";
import { describeError, formatDuration } from "./format.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The loop is the general workflow and is thin: the only module that knows
 * the process is a loop — owner of time (the fixed 60 s tick), of the --once
 * boundary and of waking by event (end of worker vs tick). It interlaces the
 * four phases deciding nothing of the domain: the Work state lives in
 * work-state/ (one vocabulary, read before a launch and after an attempt), the
 * launch pipeline in launch/ (the claim, the prepare, the runtime launch and
 * the collected end of every kind of launch), the liveness policy and the
 * survivor ledger in state/ + pool/, and IO in tracker/ + pool/ + git/ +
 * runtime/ (ticket 07) — the loop only reads the facts and applies what they
 * decide (issue 118).
 *
 * Ticket 14: the derivation of the tick covers the states of ALL reserved
 * works (done · done-fallback · rejected · feedback · resumable — the Work
 * state decides, the loop executes the tracker and disk writes), the launches
 * prioritize the parked reserved works before new claims by age, and the
 * continuous run wakes by event (end of worker), not only by the clock.
 */

export const TICK_MS = 60_000;

export interface LoopDeps {
  config: Config;
  /** Ticket facts and mutations: claims, labels, comments, blockers, closure. */
  tickets: TicketTracker;
  /** PR/code-host facts: linkage, feedback, checks, the branch. */
  pullRequests: PullRequestTracker;
  runtime: WorkerRuntime;
  /** The git host side: one clone per target repo, work branch per work (ticket 15). */
  git: GitWork;
  workspace: WorkspaceLayout;
  /** Where the loop reports progress (the cli wires stdout here). */
  log?: (message: string) => void;
  /** Host-side notice delivery; absent = silent. */
  notifier?: Notifier;
  /** The liveness probe the operational cycle reads before deciding anything
   *  that could replace a worker (issue 118). The composition (wireRunDeps)
   *  supplies the real read-only Docker probe; absent means this process sees
   *  only its own launches. Never a CLI flag — tests inject a fake probe. */
  probe?: LivenessProbe;
  /** The bound of one probe query; a hung Docker call is unknown, never a stall. */
  probeTimeoutMs?: number;
  /** The cycle's clock; tests inject one to exercise deadlines without waiting. */
  now?: () => number;
  /** The backoff seam before a recovery relaunch (issue 123): production waits
   *  on a real timer; a test injects one to observe the configured schedule. */
  wait?: (ms: number) => Promise<void>;
}

/** The ruler's decided transition, as the sweep REPORTS it (ticket 13).
 *  A PROJECTION of the Work state the module answered with (D5): the engine
 *  decides in one vocabulary, and this is the operator's — and the suites' —
 *  word for what it decided. It is built where the result is built and read by
 *  nobody on the decision path. */
export interface AppliedRuling {
  decision: "reserve" | "record-only" | "release" | "block" | "interrupt" | "done";
  because: string;
}

export interface CollectedWork {
  work: WorkIdentity;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The ruler's decided transition, applied at the act (ticket 13). */
  ruling: AppliedRuling;
}

/** The facts that settle one attempt's end (issue 118): its own dir, its number
 *  and who ended it. What the end MEANS is the Work state's reading, not a
 *  launch-time fact handed over by the registry. */
interface AttemptEnd {
  dir: string;
  attempt: number;
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
  /** The states read for every reserved work this sweep (ticket 14), in the one
   *  vocabulary the engine decided in. */
  reserved: WorkStateReading[];
  /** The tracker↔workspace reconciliation reported this sweep (issue 100). */
  reconciliation: Reconciliation;
  launched: SessionResult[];
  collected: CollectedWork[];
  /** What the operator's stop left behind (issue #146); null when none was requested. */
  stop: StopReport | null;
}

/**
 * The operator's stop as the run receives it (issue #146): the first signal and
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
 * Consent never reopens a terminal state, and a state presumes a worker stopped
 * while liveness is unknown: both are DECLARED beside the state
 * (`STATE_DECLARATIONS`, ADR-0010), which is what makes a new state fail to
 * compile until it says so. The loop only asks; it keeps no list of its own.
 * (Issue #128: a hand-kept blacklist silently stranded a valid authorization on
 * `repair-fall-blocked`; consent answers the pause, so it outranks the round the
 * factory planned meanwhile.)
 */
export function consentAppliesTo(state: WorkStateReading["state"]): boolean {
  return stateConsentAppliesTo(state);
}

/** In-flight counts as reserved. Titles and order never enter — the schedule order stays untouched. */
function operationalState(
  pool: readonly PoolEntry[],
  reserved: readonly WorkStateReading[],
  inFlight: ReadonlySet<string>,
): Map<string, OperationalClass> {
  const state = new Map<string, OperationalClass>();
  for (const entry of pool) state.set(workKeyOf(entry.work), "eligible");
  for (const decision of reserved) {
    const key = workKeyOf(decision.work);
    // The class each state contributes is declared with the state; `null` means
    // the work leaves the observed state (a done work is archived by the same
    // tick). An ACTION may announce another class — a released fall lands
    // eligible — and says so where it acts.
    const operationalClass = STATE_DECLARATIONS[decision.state].announces;
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

/**
 * The decided transition as the sweep reports it: a PROJECTION of the Work
 * state the module answered with, and nothing else (D5/epic #198). The engine
 * decides in one vocabulary; the seven e2e suites that read the collection
 * report keep the words of ticket 13. Computed once, where the result is built,
 * and never read back by a decision — no arm below consults it.
 */
export function projectCollectedRuling(reading: WorkStateReading): AppliedRuling {
  switch (reading.state) {
    case "done":
      return { decision: "done", because: "issue-closed" };
    case "done-fallback":
      return { decision: "done", because: "pr-merged" };
    case "parked": {
      // Two facts park a work at collection: the human owns the PR, or the
      // worker reported itself blocked.
      return reading.because === "blocked-self-report"
        ? { decision: "record-only", because: "blocked-self-report" }
        : { decision: "reserve", because: "pr-open" };
    }
    case "fall":
      return reading.decision === "release"
        ? { decision: "release", because: "fall-first" }
        : { decision: "block", because: "fall-second" };
    case "interrupted":
    case "model-provider-failure":
    case "stop-resume":
    case "stop-unconfirmed":
      // No attempt was consumed and the fall ruler never applies (issue 123):
      // the end is an interruption, whatever ended the turn or who ordered it.
      return { decision: "interrupt", because: "no-outcome" };
    case "rejected":
      // A PR closed without merge is the Block the state declares (epic #198's
      // one delta): the report names the fact itself, never a fall.
      return { decision: "block", because: "pr-closed-unmerged" };
    // The states the read AFTER an attempt never answers — they belong to the
    // read before a launch. Named so the projection is total over the one
    // vocabulary; the collection's own "no verdict was written" is what an end
    // reaches when no other word applies.
    case "feedback":
    case "resumable":
    case "repair":
    case "repair-recovered":
    case "repair-blocked":
    case "repair-fall-blocked":
    case "continuity-paused":
    case "unreadable":
    case "not-planned":
      return { decision: "interrupt", because: "no-outcome" };
  }
}

/**
 * The PR the collection read saw, when the reading handed one over. The read
 * before a launch leaves it out (it has no association to persist), and the
 * states whose PR is their own payload carry it under that name.
 */
function prOf(reading: WorkStateReading): PullRequestRecord | null {
  return "pr" in reading ? reading.pr ?? null : null;
}

/**
 * Whether this end wrote a verdict of its own. An INTERRUPTION has none — the
 * agent's (issue 123), a model provider failure's (issue 144) or the operator's
 * requested stop (#146) — so the pause that keeps a work out of later rounds
 * (issue 119) and the stop evidence that owns the end both survive it.
 */
function wroteNoVerdict(reading: WorkStateReading): boolean {
  switch (reading.state) {
    case "interrupted":
    case "model-provider-failure":
    case "stop-resume":
      return true;
    case "done":
    case "done-fallback":
    case "parked":
    case "fall":
    case "rejected": // a rejection WROTE a verdict: a closed PR is a Block, never an interruption
    case "feedback":
    case "repair":
    case "repair-recovered":
    case "repair-blocked":
    case "repair-fall-blocked":
    case "resumable":
    case "continuity-paused":
    case "stop-unconfirmed":
    case "unreadable":
    case "not-planned":
      return false;
  }
}

/** A recovery (no human age) goes first; the rest by creation age, then key. */
function byParkedPriority(a: Launchable, b: Launchable): number {
  if (a.createdAt === null || b.createdAt === null) {
    if (a.createdAt === b.createdAt) return workKeyOf(a.work).localeCompare(workKeyOf(b.work));
    return a.createdAt === null ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt) || workKeyOf(a.work).localeCompare(workKeyOf(b.work));
}

/** The no-worker view of {@link SweepEngine.carriedKeys} (liveness unknown). */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

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
 *  outcome: the recovery of an interruption (issue 123) or the retry of a
 *  model provider failure (issue 144). */

/**
 * One sweep engine, four phases (ticket 07): derivation (+ the reserved
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
  /** Resolves the moment a requested stop begins — the boundary's wake. */
  private readonly requestedStopBegan = deferred();
  /** The launch island: the pipeline from claim to the collected end. */
  private readonly launch: Launch;
  /** The operator's requested stop: the whole protocol lives in the module. */
  private readonly operatorStop: OperatorStop;
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

  // ---- liveness and the surviving workers (issue 118) ----
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
   *  address: said once, and once more when the worker is gone (issue 126) —
   *  never a line per tick. */
  private readonly heldSurvivors = new Set<string>();
  /** The reason each held reservation was last reported: said once per
   *  appearance, re-said only when the reason changes (issue 126). */
  private reportedReservationHolds = new Map<string, string>();
  /** The last reported capacity verdict, so the change is said once. */
  private overCapacity = false;

  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: LoopDeps,
    stop: StopOptions = {},
  ) {
    this.slots = new Slots(deps.config.concurrency);
    this.log = operationalLog(deps.log);
    this.operatorStop = new OperatorStop({
      workspace: deps.workspace,
      runtime: deps.runtime,
      probe: async () => {
        await this.observeLiveness();
        return this.liveness;
      },
      log: this.log,
      ...(stop.cooperativeMs === undefined ? {} : { cooperativeMs: stop.cooperativeMs }),
    });
    this.launch = openLaunch({
      config: deps.config,
      tickets: deps.tickets,
      pullRequests: deps.pullRequests,
      runtime: deps.runtime,
      git: deps.git,
      workspace: deps.workspace,
      log: this.log,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
      cycle: this.launchCycle(),
    });
    // The signals are listened to from the START of the run (issue #146): a
    // stop requested during the derivation, before the first admission, is
    // honoured exactly like one during a worker.
    if (stop.signal?.aborted === true) {
      // A stop requested before the engine existed (a signal during the
      // startup) never fires the listener: it closes admission right here.
      void this.beginRequestedStop();
    } else {
      stop.signal?.addEventListener("abort", () => void this.beginRequestedStop(), { once: true });
    }
    if (stop.escalate?.aborted === true) this.operatorStop.escalate();
    else stop.escalate?.addEventListener("abort", () => this.operatorStop.escalate(), { once: true });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Phase 2 (derivation) + the reserved actions it decides: WHO is reserved
   * comes from the registry's dirs on disk (what survives a restart); the
   * states come from the Work state module, in the one vocabulary. Done works
   * are archived and cleaned, the fallback closes their issue first, rejections
   * go blocked with the PR pointed out. The parked queue (feedback, retomada —
   * by age) and the cached pool (by age) are what the launches draw from.
   */
  async deriveAndAct(): Promise<WorkStateReading[]> {
    const { config, workspace } = this.deps;

    // The liveness facts come FIRST (issue 118): a decision that could
    // substitute a worker or end its resources reads them, and the survivor
    // ledger keeps the executions that outlived a previous factory process.
    await this.observeLiveness();
    // WHO is reserved is what the reservation on disk says — a work's source is
    // never reconstructed from the current selection configuration (issue 126).
    const reservations = await scanReservations(workspace);
    // The guard is about the SOURCES the composed adapter serves, never about
    // the configured repos: a repo leaving the selection never strands a
    // reserved Work — done, archive and recovery still apply to it (issue 126,
    // AC4). A Work from a source the composition does not serve is held where
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

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight). The
    // in-flight set also goes INTO the derivation (ticket 18): a zero-
    // footprint claim inside it is a legit launch between the claim and the
    // worker's first write — held; outside it, an interruption to recover.
    // Surviving workers (in the live set) and the works just settled join it
    // (issue 118): a live worker keeps its work reserved, and a settled exit is
    // not decided twice in the same sweep.
    const inFlight = new Set([...this.liveInFlight, ...settled]);
    // The pool is read from the configured selections — the same repos the
    // operator names, never a second source of truth (issue 126).
    const selections = githubSelections(config.repos);
    const allReserved: WorkRef[] = serveable.map((entry) => ({
      work: entry.work,
      dir: entry.dir,
    }));
    const reservedWorks = allReserved.filter((work) => !inFlight.has(workKeyOf(work.work)));

    // The repair reconciliation runs BEFORE the derivation (issue 112): a
    // repair attempt that fell is settled against the remote first, so the
    // derivation reads the verdict (resume, block, or uncertainty) instead of
    // a charged round that never published. Unknown liveness holds it too
    // (issue 118): a worker may still be writing the branch its verdict reads.
    if (!suspended && !this.stopping) {
      await processRecoveryRequests(config, {
        probe: this.deps.probe ?? (async () => []), inFlight,
        log: (line) => this.log(line),
      });
    }
    if (!suspended) await this.reconcileRepairAttempts(allReserved, inFlight);

    // A stop whose confirmation failed on the previous invocation is settled
    // BEFORE the derivation (issue #146): the work only resumes once the
    // previous worker is known to be gone. The stop module re-reads the rule
    // the stop applied; this tick only says the verdicts.
    await this.settleUnconfirmedStops(allReserved, inFlight);

    // The Work state, read once for this sweep: the module is opened with the
    // LIVE in-flight set — a running worker is its own state — so no reading
    // ever answers for a world that moved (the collection opens it with the
    // same live set below).
    const workState = this.workState(inFlight);
    const derived = await Promise.all(reservedWorks.map((ref) => workState.beforeLaunch(ref)));

    // The actions the Work state decided — executed here, in the loop's IO duty.
    const parked: Launchable[] = [];
    const heldWhileUnknown: string[] = [];
    for (const decision of derived) {
      // Liveness unknown means no worker can be ruled out (issue 118): a
      // decision that would archive/clean, spend the attempt or its recovery
      // budget must wait for a reliable answer — never presume a stop.
      if (suspended && STATE_DECLARATIONS[decision.state].holdsWhileLivenessUnknown) {
        heldWhileUnknown.push(workKeyOf(decision.work));
        continue;
      }
      const key = workKeyOf(decision.work);
      if (await this.parkAuthorizedCallRetry(decision, parked)) continue;
      switch (decision.state) {
        case "done": {
          this.log(`derived ${key}: issue closed — done; archiving artifacts, cleaning branches`);
          await this.finishWork(decision.work);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "done-fallback": {
          this.log(
            `derived ${key}: PR merged without closing the issue — ` +
              "the factory closes it (fallback of the linkage), then archives",
          );
          await this.completeMergedWork(decision.work, decision.comment);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "rejected": {
          this.log(
            `derived ${key}: PR closed without merge — rejected, ` +
              "blocked with a comment pointing at the PR",
          );
          await this.applyBlockWithComment(decision.work, decision.comment);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "fall": {
          // A WRITTEN failure the factory died before ruling: it consumes the
          // attempt and the ruler applies as at collection (issue 123).
          const dir = decision.dir;
          await this.settleFailure(dir, decision.attempt, await readOutcomeRecord(dir));
          if (decision.decision === "release") {
            this.log(
              `derived ${key}: unreconciled failure (the factory died before ruling it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await this.applyRelease(decision.work);
            // A released fall lands ELIGIBLE, not the class the state declares:
            // the action says so here, where it acts (ADR-0010).
            this.announce(decision.work, "eligible");
          } else {
            this.log(
              `derived ${key}: 2nd consecutive fall, unreconciled — ` +
                "blocked with the attempt's diagnosis on the issue",
            );
            await this.applyBlockWithComment(decision.work, decision.comment);
            this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          }
          break;
        }
        case "interrupted": {
          // The same attempt continues within its budget; an exhausted budget
          // pauses it and asks the operator for help (issue 123).
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
          // A model provider outage is not an interruption of the agent (issue 144):
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
          // The operator's requested stop (issue #146): the same attempt
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
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
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
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
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
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
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
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "parked": {
          // Waiting for the human (the PR is theirs, or the worker reported
          // itself blocked), or a released work the pool owns. Nothing to
          // decide and nothing to write.
          break;
        }
        case "unreadable": {
          // Never acted on: the ticket could not be read. A failed read is not a
          // verdict, so no attempt, no archive and no block is invented from it.
          break;
        }
        case "not-planned": {
          // Never acted on: the issue was read fine and closed as not-planned.
          break;
        }
      }
    }
    if (heldWhileUnknown.length > 0) {
      this.log(
        `liveness unknown — held ${heldWhileUnknown.length} decision(s) that presume a worker stopped: ` +
          `${byKey(heldWhileUnknown).join(", ")}; nothing was consumed, archived or cleaned`,
      );
    }
    parked.sort(byParkedPriority);
    // A recovery for a survivor's ended attempt joins the queue (issue 118);
    // while liveness is unknown the pending recoveries are preserved untouched
    // — the launch gate keeps them from starting.
    this.parkedQueue = suspended
      ? parked
      : [...this.survivorRecoveries.splice(0), ...parked].sort(byParkedPriority);

    // The pool AND the reconciliation from ONE open-issues read per repo
    // (issue 100): the cached pool of the latest derivation (replenishment
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
    return derived;
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
    reserved: readonly WorkStateReading[],
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
    if (this.liveness.state !== "known") return EMPTY_KEYS;
    return new Set(this.liveness.workers.map((worker) => worker.key));
  }

  /** Record the class an action/event lands a work in (`null` = it leaves). */
  private announce(work: WorkIdentity, resulting: OperationalClass | null): void {
    this.announced.set(workKeyOf(work), resulting);
  }

  /**
   * The works this process holds a launch for, RIGHT NOW: a running worker is
   * its own state, and the state module must never answer for a world that
   * moved. Both readings open the module with a fresh set — the sweep adds the
   * works it just settled to it, and nothing keeps the set once the sweep ends.
   */
  private get liveInFlight(): ReadonlySet<string> {
    return new Set([...this.slots.workKeys, ...this.carriedKeys]);
  }

  /**
   * The Work state module, opened for one moment with that moment's in-flight
   * set. The caller hands over the Work — never a list of facts — and the state
   * comes back with the payload its action needs, in the one vocabulary the
   * engine decides and executes in (ADR-0010; tickets #200–#202).
   */
  private workState(inFlight: ReadonlySet<string>): WorkState {
    const { config, workspace } = this.deps;
    return openWorkState({
      tickets: this.deps.tickets,
      pullRequests: this.deps.pullRequests,
      workspace,
      labels: config.labels,
      workerAccount: config.workerGhAccount,
      recovery: config.recovery,
      modelProvider: config.modelProvider,
      inFlight,
    });
  }

  // ---- liveness and the surviving workers (issue 118) ----

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
   * runtime's idle limit only WARNS (issue 118) — never a kill, a substitute
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
    // The consecutiveness is the Work state's own fact now (it reads the
    // persisted ledger), so the exit is reconciled exactly like a collected end.
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
    const outcome = await this.applyEnd(ended, { dir, attempt, origin: "survivor" });
    if (outcome.next !== null) this.survivorRecoveries.push(outcome.next);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The capacity verdict (issue 118): survivors above the configured
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
    // collection triggers (issue 118): without a reliable answer the factory
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
      // next tick must retry (issue 98).
      void run.then(
        () => this.pending.delete(run),
        () => this.pending.delete(run),
      );
      started.push(run);
    }
    return started;
  }

  /** The parked reserved works first, then the cached pool — each by age. A
   *  work a live container carries is never relaunched (issue 118): a survivor
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
   * Free capacity for one more launch (issue 118): every live container counts
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
   * The operator's requested stop: admissions close, the evidence of the stop
   * is persisted, the workers are asked to end, and the module waits the
   * cooperative window (or the escalation) before forcing what remains. The
   * sweep only supplies the facts of this run and invokes the module.
   */
  beginRequestedStop(): Promise<StopReport> {
    if (!this.stopping) {
      this.stopping = true;
      // A backoff waiting to relaunch is a pending admission: it ends with the
      // admission, never after it — the launch reads {@link LaunchCycle.stopped}.
      this.requestedStopBegan.resolve();
    }
    return this.operatorStop.begin({
      launches: this.launch.admissions(),
      survivors: () => this.survivors.keys(),
      isInFlight: (key) => this.launch.carries(key),
      settled: () => this.waitPending(),
    });
  }

  /** Wait until no launch of this engine is pending, failures included. */
  private async waitPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** The boundary of `run --once`: the launch settling, or the requested stop
   *  and its confirmation. */
  async settle(): Promise<StopReport | null> {
    if (this.operatorStop.report !== null) return this.operatorStop.report;
    // The boundary waits for the launches — OR for the requested stop, which
    // may legitimately finish without every launch promise settling (an
    // unconfirmed end; the report carries the uncertainty).
    await Promise.race([this.awaitAllLaunched(), this.requestedStopBegan.promise]);
    return this.operatorStop.report;
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
   *  slot would never retry the work (issue 98). The rejection belongs to the
   *  caller (runOnce awaits it, runForever logs it as a failed launch). */
  private async launchAndCollect(launchable: Launchable): Promise<void> {
    const key = workKeyOf(launchable.work);
    try {
      // An interruption inside the session returns the SAME attempt as a
      // recovery to launch next, in the same held slot (issue 123).
      let next: Launchable | null = launchable;
      while (next !== null) next = await this.launch.attempt(next);
    } finally {
      // The work stays reconcilable by the next derivation even when the
      // collection's transition fails: its claim is already on the tracker.
      this.slots.release(key);
      this.discardFromCacheAndParked(key);
      this.fillSlots();
      this.notifyWorkerEnded();
    }
  }

  /**
   * The engine's side of an admission (epic #198, ticket #205): the duties the
   * launch module asks the cycle to perform at the moments the domain decides
   * them. The pipeline decides WHEN; what each one writes stays here, so the
   * requested stop, the operational log, the report and the verdict application
   * keep their single owner.
   */
  private launchCycle(): LaunchCycle {
    return {
      stopping: () => this.stopping,
      stopped: this.requestedStopBegan.promise,
      announce: (work, resulting) => this.announce(work, resulting),
      cancelAdmission: (entry, attempt) => this.operatorStop.cancelAdmission(entry, attempt),
      launched: (result) => {
        this.launched.push(result);
      },
      // The collection of the attempt's end: the Work state's second reading
      // and the verdict it asks for — the report is what this sweep collected.
      collect: async (launchable, result, attempt) => {
        const outcome = await this.applyEnd(launchable, {
          dir: result.request.workDir,
          attempt,
          origin: "collected",
        });
        this.collected.push({
          work: launchable.work,
          result,
          prConfirmed: outcome.prConfirmed,
          ruling: outcome.ruling,
        });
        return outcome.next;
      },
      pauseInterrupted: (work, dir, attempt, decision) => this.pauseInterrupted(work, dir, attempt, decision),
      pauseForContinuity: (work, dir, pause, attempt) => this.pauseForContinuity(work, dir, pause, attempt),
      settleModelProviderFailure: (work, dir, attempt, failure) =>
        this.applyModelProviderFailure(work, dir, attempt, failure),
      inspectLocalWork: (work) => this.inspectLocalWork(work),
      observeRemote: (work) => this.observeRemote(work),
    };
  }

  /**
   * Whether the operator's own requested stop owns the end of this attempt
   * (issue #146): the persisted requested stop of exactly this attempt, or a
   * stop-unconfirmed one of it, promoted here so the launch consumes it like
   * any other requested stop. A stop of another attempt, or a failure, never
   * answers yes.
   */
  private async operatorStoppedAttempt(dir: string, attempt: number): Promise<boolean> {
    const ledger = await readRecoveryLedger(dir);
    const claim = operatorStopClaim(ledger, { lastAttempt: attempt });
    if (claim.kind === "unconfirmed") await confirmStopRequest(dir, attempt);
    return claim.kind !== "none";
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
   * A continuity pause (issue 119): the interrupted attempt cannot be reopened
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
    decision: WorkStateReading,
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
    this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
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
   * Settle one model provider failure and apply its decision (issue 144): the
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
   * The repair reconciliation of the tick (issue 112): every repair attempt
   * that wrote its facts on disk and is not carried by a live worker is
   * settled BEFORE the derivation reads the cycle. The verdict lives in the
   * Repair round module (pool/repair-round.ts); this method supplies its
   * observations, persists the cycle through the record and says the verdict
   * in the operator's log. The settlement is idempotent — a settled attempt is
   * never charged, refunded or counted again — and an unreadable remote leaves
   * the attempt pending: no worker and no budget return until a later sweep
   * gets an answer.
   */
  private async reconcileRepairAttempts(
    works: readonly WorkRef[],
    inFlight: ReadonlySet<string>,
  ): Promise<void> {
    for (const work of works) {
      const key = workKeyOf(work.work);
      // A live worker owns its attempt: settling it mid-flight would read a
      // half-written branch as a verdict.
      if (inFlight.has(key)) continue;

      const stored = await readRepairCycle(work.dir);
      const recorded = stored.attempt;
      let cycle: RepairCycle;
      let operatorStopped = false;
      let observeRoundStart: () => Promise<RepairRoundStart>;
      let inspectLocalWork: () => Promise<LocalWorkFacts | null>;
      if (recorded !== null) {
        operatorStopped = await this.operatorStoppedAttempt(work.dir, recorded.attempt);
        cycle = stored;
        observeRoundStart = () => this.observeRepairRoundStart(work.dir, recorded.attempt);
        inspectLocalWork = () => this.inspectLocalWork(work.work);
      } else {
        // A work that never ran a repair round has nothing to reconcile — no
        // registry read or git inspection is paid for it on every sweep.
        if (!hasRepairCycle(stored)) continue;
        // A legacy cycle with no attempt on disk: only the registry gap can
        // establish the attempt, and its local work is read once, by adoption.
        const adopted = await this.adoptLegacyCycle(work, stored);
        const adoptedAttempt = adopted?.attempt ?? null;
        if (adopted === null || adoptedAttempt === null) continue;
        cycle = adopted;
        // The adoption's registry gap says an attempt ran; the settlement
        // re-reads that from the attempt's own artifacts (issue 181), so a
        // legacy cycle the artifacts do not back never blocks the work.
        observeRoundStart = () => this.observeRepairRoundStart(work.dir, adoptedAttempt.attempt);
        inspectLocalWork = async () => adoptedAttempt.localWork;
      }

      const decision = await settleRepairRound({
        cycle,
        operatorStopped,
        observeRoundStart,
        readOutcomeRecord: () => readOutcomeRecord(work.dir),
        observeRemote: () => this.observeRemote(work.work),
        inspectLocalWork,
        // The premise is part of the verdict (issue 149): a remote the attempt
        // did not produce is a concurrent change ONLY while the impediment the
        // round addressed still exists — a human's own resolution is never
        // taken for a reason to ask for help. Read once per settlement.
        readPremise: () => this.deps.pullRequests.readPullRequestRepairFacts(workPullRequest(work.work)),
      });
      if (decision.kind === "none") continue;
      await writeRepairCycle(work.dir, decision.cycle);
      this.logSettlement(key, decision);
    }
  }

  /**
   * A requested stop whose confirmation failed on a previous invocation
   * (issue #146): the stop module re-derives the hold over the same rule it
   * applied — the persisted `lastStop` and the latest liveness observation —
   * and promotes a worker confirmed gone to the free resume. An unreadable
   * probe is uncertainty: the work stays held, said out loud, and no worker is
   * launched on top of it.
   */
  private async settleUnconfirmedStops(
    works: readonly WorkRef[],
    inFlight: ReadonlySet<string>,
  ): Promise<void> {
    const verdicts = await reconcileUnconfirmedStops(
      works
        .map((work) => ({ key: workKeyOf(work.work), dir: work.dir }))
        .filter((work) => !inFlight.has(work.key)),
      this.liveness,
    );
    if (verdicts.length === 0) {
      this.reportedStopHolds.clear();
      return;
    }

    for (const verdict of verdicts) {
      if (verdict.kind === "hold") {
        this.reportStopHold(verdict.key, verdict.because);
        continue;
      }
      this.reportedStopHolds.delete(verdict.key);
      this.log(
        `derived ${verdict.key}: the worker of the previous stop is confirmed gone — attempt ${verdict.attempt} resumes ` +
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

  /** The cycle a legacy reparo.json implies (issue 112): the budget was charged
   *  and the registry shows an attempt after the last recorded outcome — the
   *  attempt whose observed head only the evidence signature names. */
  private async adoptLegacyCycle(work: WorkRef, cycle: RepairCycle): Promise<RepairCycle | null> {
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

  /** The settlement verdict, said once in the operator's log. */
  private logSettlement(
    key: string,
    decision: Exclude<RepairSettlement, { kind: "none" }>,
  ): void {
    if (decision.kind === "returned-unstarted") {
      this.log(
        `repair attempt ${decision.attempt.attempt} of ${key} never reached the runtime — round returned, no fall`,
      );
      return;
    }
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

  /** The local work of a work, or null when git cannot answer — never "nothing there". */
  private async inspectLocalWork(work: WorkIdentity): Promise<LocalWorkFacts | null> {
    try {
      return await this.deps.git.inspectLocalWorkFor(work);
    } catch {
      return null;
    }
  }

  /** Whether a round with a recorded attempt ever reached the runtime: its own
   *  event log is the cheap proof; when it is absent, the guardrail journal is
   *  the remaining direct fact (an unreadable one proves nothing either way). */
  private async observeRepairRoundStart(dir: string, attempt: number): Promise<RepairRoundStart> {
    if (existsSync(join(dir, eventLogName(attempt)))) return { reached: true };
    const journal = readEffectJournal(dir);
    return {
      reached: false,
      journalIntact: journal.intact,
      journaledAttempts: journal.sessions.map((session) => session.attempt),
    };
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

  /**
   * The end of an attempt (ticket 13, extended by 14/123; survivor ends by
   * issue 118), read as ONE Work state: the module is asked what happened to the
   * attempt and what may the factory do now, and the loop executes exactly that.
   * An interruption returns the SAME attempt as the next launch (issue 123).
   * `origin` only names the actor in the operator's log: a survivor's end is
   * reconciled by these same properties, never by the launch object this
   * process never had.
   */
  private async applyEnd(launchable: Launchable, end: AttemptEnd): Promise<RulingApplied> {
    const { dir, attempt, origin } = end;
    const { work } = launchable;
    const key = workKeyOf(work);

    const reading = await this.workState(this.liveInFlight).afterAttempt({
      work,
      dir,
      attempt,
      stopping: this.stopping,
    });
    const pr = prOf(reading);
    const prConfirmed = pr !== null && pr.state === "open";
    // The attempt's own artifact: settling it is a WRITE the loop owns (see
    // settleFailure), so it is read here — never to decide anything.
    const record = await readOutcomeRecord(dir);

    // A settled attempt makes any continuity pause of its own history (issue
    // 119): the new record (or block) is the current fact, and a stale pause
    // must not keep the work out of later rounds. An interruption keeps it.
    if (!wroteNoVerdict(reading)) clearPause(dir);

    // A known PR — open, merged or closed — is persisted beside the Work
    // (issue 125): the facts survive a restart, and a later attempt appends
    // its own. Persistence never changes the reading above.
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

    // A confirmed Outcome prevails over the interpretation of the stop (issue
    // #146): the attempt ended with a verdict, so the suspended-stop evidence
    // has done its job and is cleared (a fall replaces it with its own stop).
    if (!wroteNoVerdict(reading)) await consumeStopRequest(dir, attempt);

    let resulting: OperationalClass | null;
    let next: Launchable | null = null;
    // Whether landing in this state is an occurrence the operator must see: a
    // work held for them (the PR is theirs, or they were asked for help) and a
    // released fall (ticket 13). A block and the done already notify; an
    // interruption is absorbed by its budget.
    let occurrence = false;
    switch (reading.state) {
      case "done": {
        // The terminal state was reached while this claim was held: archive the
        // artifacts and clean the branches, nothing is released or recorded.
        this.log(`${origin} ${key}: issue closed — done; artifacts archived, branches cleaned`);
        await this.finishWork(work);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      case "done-fallback": {
        // Delivery, whatever the attempt wrote (issue 149): a merge that did not
        // close the issue is closed here first — done must always be reflected
        // on the tracker (ticket 04 Q11), including a merge that landed mid-round.
        this.log(
          `${origin} ${key}: PR merged while the attempt ran — done; the factory closes the issue ` +
            "(fallback of the linkage), then archives",
        );
        await this.completeMergedWork(work, reading.comment);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      case "parked": {
        // Nothing is consumed, no fall is recorded and the claim is held: the PR
        // is the human's, or the worker reported itself blocked.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        occurrence = true;
        if (reading.because === "blocked-self-report") {
          this.log(`${origin} ${key}: blocked self-report — the factory only records the outcome`);
        } else {
          this.log(`${origin} ${key}: PR open — stays reserved, waiting for the human`);
        }
        break;
      }
      case "fall": {
        // A written failure/abandon without a PR: the attempt is consumed and the
        // ruler applies — the 1st releases, the 2nd blocks (ticket 05 Q3).
        await this.settleFailure(dir, attempt, record);
        if (reading.decision === "release") {
          this.log(
            `${origin} ${key}: fall without PR — release (claimed→ready back; ` +
              "the branch stays, the next sweep picks it up)",
          );
          await this.applyRelease(work);
          // The released fall lands ELIGIBLE, not the class its state declares:
          // the action says so here, where it acts (ADR-0010).
          resulting = "eligible";
          occurrence = true;
        } else {
          this.log(
            `${origin} ${key}: 2nd consecutive fall — blocked, the attempt's outcome goes to the issue`,
          );
          await this.applyBlockWithComment(work, reading.comment);
          resulting = STATE_DECLARATIONS[reading.state].announces;
        }
        break;
      }
      case "interrupted": {
        // No attempt is consumed and the fall ruler never applies (issue 123). A
        // repair round is settled by its own reconciliation (issue 112) instead.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") {
          this.logRepairEnded(origin, key);
        } else {
          this.log(
            `${origin} ${key}: interrupted (no outcome record) — not a failure; attempt ${attempt} keeps its ` +
              "number and the recovery budget answers it",
          );
          next = this.continuation(launchable, attempt, null, pr);
        }
        break;
      }
      case "model-provider-failure": {
        // A model provider outage is not an interruption of the agent (issue
        // 144): the SAME attempt retries on its own budget, and the retry launch
        // says what it consumed.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") this.logRepairEnded(origin, key);
        else next = this.continuation(launchable, attempt, reading.failure, pr);
        break;
      }
      case "stop-resume": {
        // The operator's requested stop (#146): the attempt is left for the next
        // invocation to resume, never relaunched inside a requested stop.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") {
          this.logRepairEnded(origin, key);
        } else if (reading.because === "stop-in-progress") {
          this.log(
            `collected ${key}: attempt ${attempt} ended without an outcome record while the factory stops — ` +
              "no recovery is spent and the next run resumes the same attempt",
          );
        } else {
          // Promoting a stop whose confirmation failed is a WRITE: the module
          // reports the fact and the loop settles it (issue #146).
          await this.confirmRequestedStop(dir, attempt);
          this.log(
            `${origin} ${key}: attempt ${attempt} ended without an outcome record, and the operator's requested ` +
              "stop owns that end — it resumes now, spending no recovery",
          );
          next = { work, dir, kind: "recover", createdAt: null, pr, attempt, requestedStop: true };
        }
        break;
      }
      case "rejected": {
        // A PR closed without merge, SEEN AT COLLECTION (epic #198's one
        // delta): the Block the state already declares — the ticket is blocked
        // with the comment pointing at the PR and the claim is HELD, so the
        // work never returns to the pool carrying a closed PR. The attempt is
        // liquidated as ONE outcome: a closed PR is not a written failure, so
        // no fall is recorded and no recovery is spent.
        this.log(
          `${origin} ${key}: the PR was closed without merging (PR #${reading.pr.number}) — ` +
            "blocked with a comment pointing at the PR; the work stays reserved",
        );
        await this.applyBlockWithComment(work, reading.comment);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      // The states only the read BEFORE a launch answers: an attempt that ended
      // cannot be one of them. Named here so the switch speaks the whole
      // vocabulary — with no `default` that could hide a state a later change
      // adds — and they leave the work in the class their declaration states.
      case "feedback":
      case "resumable":
      case "repair":
      case "repair-recovered":
      case "repair-blocked":
      case "repair-fall-blocked":
      case "continuity-paused":
      case "stop-unconfirmed":
      case "unreadable":
      case "not-planned": {
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
    }
    this.announce(work, resulting);

    // One notice per new occurrence: an applied block already notified help
    // (applyBlockWithComment), so here only what the ruler did not block. Help
    // wins over review; the state decision is untouched. The self-report is the
    // fact the reading kept (the blocked label, or this attempt's own record) and
    // it counts only for THIS attempt — desfecho.json survives between attempts.
    // A survivor's end is a review occurrence too: its open PR reaches the
    // operator even though this process never launched it (issue 118).
    if (occurrence) {
      const isReviewLaunch =
        origin === "survivor" || launchable.kind === "claim" || launchable.kind === "feedback";
      if (reading.state === "parked" && reading.helpRequested === true) {
        await this.deliverNotice(helpNotice(work));
      } else if (isReviewLaunch && prConfirmed && pr !== null) {
        await this.deliverNotice(reviewNotice(work, pr.number));
      }
    }
    return { next, prConfirmed, ruling: projectCollectedRuling(reading) };
  }

  /**
   * Persist the WRITTEN failure that ended the attempt (issue 123): the next
   * attempt starts with a full interruption budget, and `msf status` says the
   * attempt was consumed. A missing or other-attempt record, or a class that
   * is not a failure (pr-open, self-report), settles nothing.
   */
  private async settleFailure(dir: string, attempt: number, record: OutcomeRecord | null): Promise<void> {
    const own = ownWrittenOutcome(record, attempt);
    if (own !== null && isRecordedFailure(own)) await recordFailure(dir, attempt, own.class);
  }

  /**
   * The operator's requested stop whose confirmation failed (issue #146) is
   * PROMOTED once the end of its attempt is read: a reading reports the fact, so
   * settling it is a write and belongs to the loop.
   */
  private async confirmRequestedStop(dir: string, attempt: number): Promise<void> {
    const claim = operatorStopClaim(await readRecoveryLedger(dir), { lastAttempt: attempt });
    if (claim.kind === "unconfirmed") await confirmStopRequest(dir, attempt);
  }

  /**
   * The launch of an attempt that ended without publishing a record: the SAME
   * number continues, with the material of the interrupted launch preserved. A
   * model provider failure retries on its own budget (issue 144); an
   * interruption of the agent keeps issue 123's recovery.
   */
  private continuation(
    launchable: Launchable,
    attempt: number,
    failure: ModelProviderFailure | null,
    pr: PullRequestRecord | null,
  ): Launchable {
    return {
      work: launchable.work,
      dir: launchable.dir,
      kind: failure === null ? "recover" : "model-provider-retry",
      createdAt: null,
      pr,
      ...(launchable.issueReplies === undefined ? {} : { issueReplies: launchable.issueReplies }),
      attempt,
    };
  }

  /** A repair attempt that ended without publishing is settled by its own
   *  reconciliation (issue 112): the loop relaunches nothing over it. */
  private logRepairEnded(origin: string, key: string): void {
    this.log(
      `${origin} ${key}: the repair attempt wrote no outcome record — the repair reconciliation ` +
        "settles its publication before another round (issue 112)",
    );
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
   * SEE why it fell before deciding to resume. Applying a block IS the
   * new occurrence, so the help notice is delivered here, once. */
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
   *  reflected on the tracker (ticket 04 Q11). Shared by the derivation's
   *  done-fallback and by a merge that landed mid-round (issue 149). */
  private async completeMergedWork(work: WorkIdentity, comment: string): Promise<void> {
    const { tickets } = this.deps;
    await tickets.markTicketDone(work.ticket);
    await tickets.commentOnTicket(work.ticket, comment);
    await this.finishWork(work);
  }

  /** A collected work never stays launchable in this process's memory — nor
   *  does a survivor's pending recovery for it. */
  private discardFromCacheAndParked(key: string): void {
    this.cache = this.cache.filter((entry) => workKeyOf(entry.work) !== key);
    this.parkedQueue = this.parkedQueue.filter((entry) => workKeyOf(entry.work) !== key);
    this.survivorRecoveries = this.survivorRecoveries.filter((entry) => workKeyOf(entry.work) !== key);
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
}

type WakeEvent = "worker-end" | "tick" | "abort";

/**
 * One sweep with the --once boundary (ticket 07 Q6): derive the pool AND the
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
 * A failed sweep never takes the continuous factory down (issue 158): a
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
 * The continuous run (ticket 14): the idle factory keeps sweeping on the
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
