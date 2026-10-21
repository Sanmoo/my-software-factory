import type { Config } from "./config.js";
import type { TrackerPort, IssueComment, IssueRef, PullRequest } from "./tracker/port.js";
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
import { workDir, workDirOfKey, type WorkspaceLayout } from "./layout.js";
import {
  githubRepository,
  pullRequestIdentity,
  ticketUrl,
  workOfIssueRef,
} from "./tracker/identity.js";
import { reservationRecordOf, reserveWork } from "./pool/reservation.js";
import { recordPrAssociation } from "./pool/pr-association.js";
import {
  deriveTrackerState,
  deriveReserved,
  repairSignature,
  workKey,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  unbackedClaimKey,
  unmarkedReservationKey,
  type Reconciliation,
  type PoolEntry,
  type RepairTrigger,
  type ReservedDerivation,
} from "./state/derive.js";
import {
  readOutcomeRecord,
  classifyOutcome,
  selfReportedBlocked,
  isRecordedFailure,
  ownWrittenOutcome,
  interruptionPausedCommentBody,
  type OutcomeRecord,
  type OutcomeRuling,
} from "./state/outcome.js";
import {
  readLaunchFacts,
  scanReservedWorks,
  archiveDoneWork,
  readAttemptLedger,
  readLastAttempt,
  parseWorkKey,
  type ReservedWorkEntry,
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
import { consumeRecovery, readRecoveryLedger, recordFailure, recordInterruptionStop, type RecoveryDecision } from "./pool/recovery.js";
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
import { describeError, operationalLog } from "./log.js";
import { formatDuration } from "./format.js";
import { mkdirSync } from "node:fs";

/**
 * The loop is the general workflow and is thin: the only module that knows
 * the process is a loop — owner of time (the fixed 60 s tick), of the --once
 * boundary and of waking by event (end of worker vs tick). It interlaces the
 * four phases deciding nothing of the domain: the states live in state/, the
 * liveness policy and the survivor ledger in state/ + pool/, and IO in
 * tracker/ + pool/ + git/ + runtime/ (ticket 07) — the loop only reads the
 * facts and applies what they decide (issue 118).
 *
 * Ticket 14: the derivation of the tick covers the states of ALL reserved
 * works (done · done-fallback · rejected · feedback · resumable — state/
 * decides, the loop executes the tracker and disk writes), the launches
 * prioritize the parked reserved works before new claims by age, and the
 * continuous run wakes by event (end of worker), not only by the clock.
 */

export const TICK_MS = 60_000;

/** The production backoff timer; tests inject {@link LoopDeps.wait}. */
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoopDeps {
  config: Config;
  tracker: TrackerPort;
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

/** The ruler's decided transition, as the sweep reports it (ticket 13). */
export interface AppliedRuling {
  decision: OutcomeRuling["decision"];
  because: string;
}

export interface CollectedWork {
  ref: IssueRef;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The ruler's decided transition, applied at the act (ticket 13). */
  ruling: AppliedRuling;
}

/** The facts that settle one attempt's end (issue 118): its own dir, its
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
  /** The states derived for every reserved work this sweep (ticket 14). */
  reserved: ReservedDerivation[];
  /** The tracker↔workspace reconciliation reported this sweep (issue 100). */
  reconciliation: Reconciliation;
  launched: SessionResult[];
  collected: CollectedWork[];
}

type OperationalClass = "eligible" | "reserved" | "feedback" | "resumable";

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
  unknown: "reserved",
  feedback: "feedback",
  resumable: "resumable",
  repair: "reserved",
  "repair-recovered": "reserved",
  "repair-blocked": "reserved",
  "repair-fall-blocked": "reserved",
} satisfies Record<ReservedDerivation["state"], OperationalClass | null>;

/**
 * The derivations that presume a worker has stopped (issue 118): while Docker
 * cannot answer, archiving an attempt whose worker may be alive, spending an
 * attempt or recovery on a silence, or publishing a block over a worker that
 * may still be writing are exactly the presumptions to avoid.
 */
const HOLDS_WHILE_LIVENESS_UNKNOWN: ReadonlySet<ReservedDerivation["state"]> = new Set([
  "done",
  "done-fallback",
  "fall",
  "interrupted",
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
  for (const entry of pool) state.set(workKey(entry.ref), "eligible");
  for (const decision of reserved) {
    const key = workKey(decision.ref);
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
    if (a.createdAt === b.createdAt) return workKey(a.ref).localeCompare(workKey(b.ref));
    return a.createdAt === null ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt) || workKey(a.ref).localeCompare(workKey(b.ref));
}

/** The no-worker view of {@link SweepEngine.carriedKeys} (liveness unknown). */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

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
 *  repair — or the recovery of an interrupted attempt (issue 123). */
type LaunchKind = "claim" | "feedback" | "resume" | "repair" | "recover";

interface Launchable {
  ref: IssueRef;
  kind: LaunchKind;
  /** The ticket's title when the pool supplied it — presentation of the reservation. */
  title?: string;
  /** ISO 8601 — age-based priority inside each group; null for a recovery,
   *  which waits for nothing human and is launched before the parked rounds. */
  createdAt: string | null;
  /** The work's linked PR when the derivation saw one (the retomada reopens a closed one). */
  pr: PullRequest | null;
  /** Human issue replies after the last agent marker, only for a retomada. */
  issueReplies?: IssueComment[];
  /** The confirmed impediments, only for a repair round. */
  repair?: RepairTrigger;
  /** The unpublished attempt this repair takes over (issue 112), when resuming. */
  resuming?: RepairAttempt | null;
  /** The interrupted attempt a recovery continues — the SAME number (issue 123). */
  attempt?: number;
}

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
  /** The full pool of the latest derivation — what `runOnce` reports. */
  lastPool: PoolEntry[] = [];
  /** The working copy the launches drain (parked reserved first). */
  private cache: PoolEntry[] = [];
  private parkedQueue: Launchable[] = [];
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;
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
  /** The last reported capacity verdict, so the change is said once. */
  private overCapacity = false;

  // Prepare (clone/fetch/branch) touches the shared clone of a repo — two
  // first-launches of the same repo must not race inside it (ticket 12
  // introduced the parallelism; the serialization stays local to prepares,
  // the launches themselves run concurrently).
  private readonly preparing = new Map<string, Promise<void>>();

  private readonly log: (message: string) => void;

  constructor(private readonly deps: LoopDeps) {
    this.slots = new Slots(deps.config.concurrency);
    this.log = operationalLog(deps.log);
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
    const { config, tracker, workspace } = this.deps;

    // The liveness facts come FIRST (issue 118): a decision that could
    // substitute a worker or end its resources reads them, and the survivor
    // ledger keeps the executions that outlived a previous factory process.
    await this.observeLiveness();
    const settled = await this.observeSurvivors();
    this.observeCapacity();
    const suspended = this.liveness.state === "unknown";
    const surviving = [...this.carriedKeys];

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight). The
    // in-flight set also goes INTO the derivation (ticket 18): a zero-
    // footprint claim inside it is a legit launch between the claim and the
    // worker's first write — held; outside it, an interruption to recover.
    // Surviving workers and the works just settled join it (issue 118): a
    // live worker keeps its work reserved, and a settled exit is not decided
    // twice in the same sweep.
    const inFlight = new Set([...this.slots.workKeys, ...surviving, ...settled]);
    const reservedDirs = await scanReservedWorks(workspace);
    const reservedWorks = reservedDirs.filter((work) => !inFlight.has(workKey(work.ref)));

    // The repair reconciliation runs BEFORE the derivation (issue 112): a
    // repair attempt that fell is settled against the remote first, so the
    // derivation reads the verdict (resume, block, or uncertainty) instead of
    // a charged round that never published. Unknown liveness holds it too
    // (issue 118): a worker may still be writing the branch its verdict reads.
    if (!suspended) await this.reconcileRepairAttempts(reservedDirs, inFlight);

    const derived = await deriveReserved(
      tracker,
      reservedWorks,
      config.labels,
      config.workerGhAccount,
      workspace,
      config.recovery,
      inFlight,
    );

    // The actions state/ decided — executed here, in the loop's IO duty.
    const parked: Launchable[] = [];
    const heldWhileUnknown: string[] = [];
    for (const decision of derived) {
      // Liveness unknown means no worker can be ruled out (issue 118): a
      // decision that would archive/clean, spend the attempt or its recovery
      // budget must wait for a reliable answer — never presume a stop.
      if (suspended && HOLDS_WHILE_LIVENESS_UNKNOWN.has(decision.state)) {
        heldWhileUnknown.push(workKey(decision.ref));
        continue;
      }
      switch (decision.state) {
        case "done": {
          this.log(`derived ${workKey(decision.ref)}: issue closed — done; archiving artifacts, cleaning branches`);
          await this.finishWork(decision.ref);
          this.announce(decision.ref, null);
          break;
        }
        case "done-fallback": {
          this.log(
            `derived ${workKey(decision.ref)}: PR merged without closing the issue — ` +
              "the factory closes it (fallback of the linkage), then archives",
          );
          await tracker.markDone(decision.ref);
          await tracker.comment(decision.ref, decision.comment);
          await this.finishWork(decision.ref);
          this.announce(decision.ref, null);
          break;
        }
        case "rejected": {
          this.log(
            `derived ${workKey(decision.ref)}: PR closed without merge — rejected, ` +
              "blocked with a comment pointing at the PR",
          );
          await this.applyBlockWithComment(decision.ref, decision.comment);
          this.announce(decision.ref, "reserved");
          break;
        }
        case "fall": {
          // A WRITTEN failure the factory died before ruling: it consumes the
          // attempt and the ruler applies as at collection (issue 123).
          const dir = workDir(workspace, decision.ref.repo, decision.ref.number);
          await this.settleFailure(dir, decision.attempt, await readOutcomeRecord(dir));
          if (decision.decision === "release") {
            this.log(
              `derived ${workKey(decision.ref)}: unreconciled failure (the factory died before ruling it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await this.applyRelease(decision.ref);
            this.announce(decision.ref, "eligible");
          } else {
            this.log(
              `derived ${workKey(decision.ref)}: 2nd consecutive fall, unreconciled — ` +
                "blocked with the attempt's diagnosis on the issue",
            );
            await this.applyBlockWithComment(decision.ref, decision.comment);
            this.announce(decision.ref, "reserved");
          }
          break;
        }
        case "interrupted": {
          // The same attempt continues within its budget; an exhausted budget
          // pauses it and asks the operator for help (issue 123).
          if (decision.recovery.decision === "pause-help") {
            const dir = workDir(workspace, decision.ref.repo, decision.ref.number);
            await this.pauseInterrupted(decision.ref, dir, decision.attempt, decision.recovery);
          } else {
            this.log(
              `derived ${workKey(decision.ref)}: attempt ${decision.attempt} was interrupted (no outcome record) — ` +
                `recovery ${decision.recovery.consumed}/${config.recovery.maxRecoveries} will continue it after ` +
                `${decision.recovery.waitMs}ms`,
            );
            parked.push({
              ref: decision.ref,
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
        case "feedback":
        case "resumable": {
          const launchable: Launchable = {
            ref: decision.ref,
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
            ref: decision.ref,
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
            `derived ${workKey(decision.ref)}: repair attempt ${decision.attempt} fell without publishing — ` +
              "blocked with the attempt's diagnosis on the issue (the open PR does not hide the fall)",
          );
          await this.applyBlockWithComment(decision.ref, decision.comment);
          this.announce(decision.ref, "reserved");
          break;
        }
        case "repair-recovered": {
          this.log(
            `derived ${workKey(decision.ref)}: PR recovered — no conflicts and all required checks approved; repair budget reset`,
          );
          await writeRepairCycle(workDir(workspace, decision.ref.repo, decision.ref.number), EMPTY_REPAIR_CYCLE);
          break;
        }
        case "repair-blocked": {
          this.log(
            `derived ${workKey(decision.ref)}: ${decision.usedRounds} automatic repair rounds without recovery — ` +
              "blocked with the reason on the issue",
          );
          await this.applyBlockWithComment(decision.ref, decision.comment);
          this.announce(decision.ref, "reserved");
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
    const reservationKeys = new Set(reservedDirs.map((work) => workKey(work.ref)));
    const state = await deriveTrackerState(
      tracker,
      config.repos,
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
    if (this.liveness.state !== "known") return EMPTY_KEYS;
    return new Set(this.liveness.workers.map((worker) => worker.key));
  }

  /** Record the class an action/event lands a work in (`null` = it leaves). */
  private announce(ref: IssueRef, resulting: OperationalClass | null): void {
    this.announced.set(workKey(ref), resulting);
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
  private async observeSurvivors(): Promise<Set<string>> {
    const settled = new Set<string>();
    if (this.liveness.state !== "known") return settled;
    const workers = this.liveness.workers;
    const local = new Set(this.slots.workKeys);

    // Exit: a survivor a reliable probe no longer lists has ended.
    for (const key of [...this.survivors.keys()]) {
      if (this.carriedKeys.has(key)) continue;
      this.survivors.delete(key);
      settled.add(key);
      await this.reconcileSurvivorExit(key);
    }

    // Recognition: a work carried by a container this process did not launch.
    for (const key of survivorWorkKeys(workers, local)) {
      if (this.survivors.has(key)) continue;
      const parsed = parseWorkKey(key);
      if (parsed === null) continue;
      const dir = workDirOfKey(this.deps.workspace, key);
      const attempt = await readLastAttempt(dir);
      this.survivors.set(key, {
        key,
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

    this.announceDuplicates();
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
    const parsed = parseWorkKey(key);
    if (parsed !== null) await this.deliverNotice(interventionNotice(parsed));
  }

  /**
   * The duplicate anomaly, said once per appearance: several containers of one
   * work are several occupied slots, no new launch for that work and no owner
   * chosen or ended — the evidence stays for the human.
   */
  private async announceDuplicates(): Promise<void> {
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
      const parsed = parseWorkKey(duplicate.key);
      if (parsed !== null) await this.deliverNotice(interventionNotice(parsed));
    }
  }

  /**
   * A survivor's exit, confirmed by a reliable probe: the ordinary ruler on
   * the attempt's own artifacts and the current tracker — never the in-memory
   * launch this process never had, and never an older attempt's outcome.
   */
  private async reconcileSurvivorExit(key: string): Promise<void> {
    const parsed = parseWorkKey(key);
    if (parsed === null) return;
    const dir = workDir(this.deps.workspace, parsed.repo, parsed.number);
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
      ref: parsed,
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
      if (!this.slots.tryAcquire(workKey(launchable.ref))) continue; // already in flight
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
        if (this.carriedKeys.has(workKey(parked.ref))) continue;
        return parked;
      }
      const entry = this.cache.shift();
      if (entry === undefined) return undefined;
      if (this.carriedKeys.has(workKey(entry.ref))) continue;
      return { ref: entry.ref, kind: "claim", createdAt: entry.createdAt, pr: null, title: entry.title };
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

  /** Ctrl-C: stop launching and stop replenishing finished slots. The
   * launches already started are NOT cancelled — their collection and result
   * registration still complete (below). */
  stopLaunches(): void {
    this.stopping = true;
  }

  /** The --once/shutdown boundary: wait for every launched worker,
   * transitively — each collection replenishes the slot within the same
   * cycle. Once {@link stopLaunches} ran, no replenishment takes the freed
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
    const key = workKey(launchable.ref);
    try {
      // An interruption inside the session returns the SAME attempt as a
      // recovery to launch next, in the same held slot (issue 123).
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
    const { config, tracker, runtime, git, workspace } = this.deps;
    const { ref, kind } = launchable;
    const key = workKey(ref);

    if (kind === "claim") {
      logClaim(this.log, key);
      // The dir is the safety footprint of issue 98 and lands before the claim;
      // the record is the Work's own facts (issue 125). An unknown or
      // unwritable record is reported and never blocks the claim — nor is it
      // overwritten.
      const work = workOfIssueRef(ref);
      mkdirSync(workDir(workspace, ref.repo, ref.number), { recursive: true });
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
      await tracker.claim(ref, config.workerGhAccount, config.labels.ready);
    } else if (kind === "resume") {
      this.log(`resuming ${key}: a human answered after the marker — blocked→claimed on the tracker`);
      await tracker.resumeClaim(ref, config.labels);
      // The rejection's retomada: the SAME PR is reopened, never a new one.
      if (launchable.pr !== null && launchable.pr.state === "closed") {
        await tracker.reopenPr(ref);
      }
    } else if (kind === "repair") {
      this.log(
        `repair round for ${key}: ${launchable.repair?.reasons.join(" + ") ?? "a confirmed impediment"} reactivated the worker — ` +
          "same branch, same PR, no human comment needed",
      );
    } else if (kind === "recover") {
      this.log(
        `recovering ${key}: attempt ${launchable.attempt} was interrupted — ` +
          "the same attempt continues (no new attempt, branch preserved)",
      );
      // The claim swap itself may have been interrupted (issue 98): re-asserting
      // the idempotent claim heals it without releasing the work to the pool.
      await tracker.claim(ref, config.workerGhAccount, config.labels.ready);
    } else {
      this.log(`feedback round for ${key}: the claim is already held — same branch, same PR`);
    }
    // Every launch kind holds the claim, so the work is reserved from here.
    this.announce(ref, "reserved");

    // Git host (ticket 15): clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await this.serializePrepare(ref.repo, () => git.prepareWork(ref));

    // A repair targets the PR's CURRENT base — never the repo default (story 8)
    // — and is pinned to the head the facts were read on. If the remote moved
    // since, the evidence is stale: skip the round (the next tick re-derives).
    const repairTrigger = launchable.repair;
    const resuming = launchable.resuming ?? null;
    // The launch context of a repair round (issue 112), created once here and
    // filled with the local work below: the confirmed trigger, the unpublished
    // attempt it takes over (when resuming) and the lease value — the head
    // observed before the intervention (for a resumption, the head its fallen
    // attempt was launched on: equal to the trigger's by construction, since
    // only the attempt whose evidence still matches the current head is
    // resumed), never a fresh read, so a collaborator's push to the branch
    // after the fall is never overwritten by local history (stories 10/17).
    const repair: RepairLaunchContext | undefined =
      repairTrigger === undefined
        ? undefined
        : {
            trigger: repairTrigger,
            resuming,
            localWork: null,
            pinnedHeadSha: resuming?.observedHeadSha ?? repairTrigger.facts.headSha,
          };
    let baseBranch = prepared.baseBranch;
    if (repair !== undefined) {
      baseBranch = repair.trigger.facts.baseBranch;
      const observed = await this.observeRemote(ref);
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
          await this.markConcurrentChange(ref, resuming, observed.headSha);
        }
        return null;
      }
    }

    this.log(
      `launching worker for ${key} (branch ${prepared.branch}, ` +
        `${prepared.branchCreated ? "created" : "reused"} from base ${baseBranch})`,
    );
    // A work branch reaches the remote only when the worker publishes it
    // (push + PR): a relaunch of a work that fell before publishing reuses a
    // branch the remote never saw, so the reuse has nothing to fast-forward.
    // Said once per launch, next to the launch it explains (issue 96) — the
    // runtime's reuse fetch then reads as expected instead of a broken remote.
    if (!prepared.branchCreated && !prepared.branchOnOrigin) {
      this.log(
        `branch ${prepared.branch} is not on origin yet (the worker pushes it when it opens the PR) — ` +
          `the relaunch has nothing to fast-forward`,
      );
    }

    // The registry numbers the attempt and remembers the previous WRITTEN
    // failure — both are disk facts of this work, not process state (ticket
    // 13; an interruption never counts as a fall, issue 123).
    const dir = workDir(workspace, ref.repo, ref.number);
    const facts = await readLaunchFacts(dir, kind === "recover" ? launchable.attempt : undefined);
    if (kind === "resume" && facts.previousFall) {
      // Ticket 14's decision: the human's answer resets the consecutive
      // failure count — the blocked valve already did its job and was
      // addressed; a new failure starts a fresh count (1st → release again).
      facts.previousFall = false;
    }
    if (kind === "resume") {
      // A human answer that unblocks the work also renews the automatic
      // repair budget (issue 107 story 23); new commits never do.
      await writeRepairCycle(dir, EMPTY_REPAIR_CYCLE);
    }
    // The local work the round takes over, read from real git only once the
    // round is really going out: existing commits are reused, changes are
    // inspected, an unfinished operation is continued — the resumption never
    // restarts the work blind (issue 112).
    if (repair !== undefined) {
      repair.localWork = await this.inspectLocalWork(ref);
      // The round is charged BEFORE the session (issue 107) and the attempt's
      // facts are recorded with it (issue 112): the observed head, the evidence
      // and the commit the branch already holds. A death mid-round refunds the
      // round — but only once publication is provably absent (the sweep's
      // reconciliation), never by presumption.
      await this.recordRepairRound(dir, ref, repair.trigger, facts.attempt, repair.localWork);
    }
    // The launch material (ticket 17): the issue, the open PR with its
    // conversation (a feedback round), the diff of the branch — every
    // session starts from the whole context through the port + git host.
    const material = await launchMaterial(tracker, git, ref, launchable.issueReplies, repair);
    // Ctrl-C perceived after the reservation but before the worker started:
    // do not start a new worker after this point. The reservation (the claim
    // and the registry dir) stays for the next run's reconciliation; the
    // caller releases the slot.
    if (this.stopping) {
      this.log(`the launch of ${key} stopped before the worker started — the reservation stays for reconciliation`);
      return null;
    }
    // The recovery is GRANTED and persisted before the wait and the relaunch
    // (issue 123): a death during the backoff or the session continues the
    // count instead of renewing the allowance. An exhausted budget pauses the
    // work and asks the operator for help — never another blind relaunch.
    if (kind === "recover") {
      const decision = await consumeRecovery(dir, config.recovery, facts.attempt);
      if (decision.decision === "pause-help") {
        this.log(`recovery of ${key} paused: ${decision.reason} — the work is blocked and asks for help`);
        await this.pauseInterrupted(ref, dir, facts.attempt, decision);
        return null;
      }
      this.log(
        `recovery ${decision.consumed}/${config.recovery.maxRecoveries} for ${key} — ` +
          `attempt ${facts.attempt} keeps its number; waiting ${decision.waitMs}ms before the relaunch`,
      );
      await this.wait(decision.waitMs);
      if (this.stopping) {
        this.log(`the recovery of ${key} stopped during the backoff — the grant stays consumed, nothing is launched`);
        return null;
      }
    }
    const result = await runtime.launch({
      ref,
      workDir: dir,
      branch: prepared.branch,
      repoDir: prepared.repoDir,
      baseBranch,
      attempt: facts.attempt,
      material,
    });
    this.launched.push(result);

    return this.collect(launchable, result, facts.attempt, facts.previousFall);
  }

  /** The backoff before a recovery relaunch (the injected seam or a real timer). */
  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await (this.deps.wait ?? sleepMs)(ms);
  }

  /** The exhausted recovery budget: block the work and ask the operator for
   *  help, naming the configured value and backoff — no attempt was consumed. */
  private async pauseInterrupted(
    ref: IssueRef,
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
      `the interrupted attempt ${attempt} of ${workKey(ref)} is paused (${decision.reason}) — ` +
        "blocked with the evidence; a human decision is needed",
    );
    await this.applyBlockWithComment(ref, comment);
    this.announce(ref, "reserved");
  }

  /**
   * The repair reconciliation of the tick (issue 112): every repair attempt
   * that wrote its facts on disk and is not carried by a live worker is
   * settled against the remote BEFORE the derivation reads the cycle. The
   * settlement is idempotent — a settled attempt is never charged, refunded or
   * counted again — and an unreadable remote leaves the attempt pending: no
   * worker and no budget return until a later sweep gets an answer.
   */
  private async reconcileRepairAttempts(
    works: readonly ReservedWorkEntry[],
    inFlight: ReadonlySet<string>,
  ): Promise<void> {
    for (const work of works) {
      const key = workKey(work.ref);
      // A live worker owns its attempt: settling it mid-flight would read a
      // half-written branch as a verdict.
      if (inFlight.has(key)) continue;

      const stored = await readRepairCycle(work.dir);
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
        localWork = await this.inspectLocalWork(work.ref);
      } else {
        const adopted = await this.adoptLegacyCycle(work, stored);
        if (adopted === null) continue;
        cycle = adopted;
        localWork = adopted.attempt?.localWork ?? null;
      }

      const remote = await this.observeRemote(work.ref);
      const decision = reconcileRepairAttempt({ cycle, remote, localWork });
      if (decision.kind === "none") continue;
      await writeRepairCycle(work.dir, decision.cycle);
      this.logReconciliation(key, decision);
    }
  }

  /** The cycle a legacy reparo.json implies (issue 112): the budget was charged
   *  and the registry shows an attempt after the last recorded outcome — the
   *  attempt whose observed head only the evidence signature names. */
  private async adoptLegacyCycle(work: ReservedWorkEntry, cycle: RepairCycle): Promise<RepairCycle | null> {
    const ledger = await readAttemptLedger(work.dir);
    const candidate = legacyRepairAttempt({
      cycle,
      lastAttempt: ledger.lastAttempt,
      recordedAttempt: ledger.recordedAttempt,
    });
    if (candidate === null) return null;
    const localWork = await this.inspectLocalWork(work.ref);
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
   *  derivation then blocks the work with the help request (issue 112). */
  private async markConcurrentChange(
    ref: IssueRef,
    attempt: RepairAttempt,
    remoteHeadSha: string | null,
  ): Promise<void> {
    const dir = workDir(this.deps.workspace, ref.repo, ref.number);
    const cycle = await readRepairCycle(dir);
    await writeRepairCycle(dir, {
      ...cycle,
      attempt: { ...attempt, publication: "concurrent-change", remoteHeadSha },
    });
    this.log(
      `repair attempt ${attempt.attempt} of ${workKey(ref)}: the remote branch ` +
        `${describeRemoteChange(remoteHeadSha)} while the attempt's observed head was ` +
        `${shortSha(attempt.observedHeadSha)} — local work preserved, nothing is published`,
    );
  }

  /** The local work of a work, or null when git cannot answer — never "nothing there". */
  private async inspectLocalWork(ref: IssueRef): Promise<LocalWorkFacts | null> {
    try {
      return await this.deps.git.inspectLocalWork(ref);
    } catch {
      return null;
    }
  }

  /** The remote head now, or the honest uncertainty (an unreadable remote is
   *  not an empty branch). */
  private async observeRemote(ref: IssueRef): Promise<RemoteObservation> {
    try {
      return { known: true, headSha: await this.deps.git.observeRemoteHead(ref) };
    } catch {
      return { known: false };
    }
  }

  /** Charge one automatic repair round before its session: the budget, the
   *  consumed evidence and the attempt's own facts persist on disk, so a
   *  restart neither renews the cap nor repeats the same round, and a death is
   *  attributable once the remote answers (issue 112). */
  private async recordRepairRound(
    dir: string,
    ref: IssueRef,
    trigger: RepairTrigger,
    attempt: number,
    localWork: LocalWorkFacts | null,
  ): Promise<void> {
    const cycle = await readRepairCycle(dir);
    const signature = repairSignature(ref, trigger);
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
      ref: launchable.ref,
      result,
      prConfirmed: outcome.prConfirmed,
      ruling: outcome.ruling,
    });
    return outcome.next;
  }

  /**
   * The ruler at the act of an end (ticket 13, extended by 14/123; survivor
   * ends by issue 118) on structured facts alone — the outcome record (absence
   * = an interruption), the PR fact and the label facts from the port, and the
   * registry's consecutiveness. The decided transition is applied here; an
   * interruption returns the SAME attempt as the next launch (issue 123).
   * `origin` only names the actor in the operator's log: a survivor's end is
   * reconciled by these same facts, never by the launch object this process
   * never had.
   */
  private async applyEnd(launchable: Launchable, end: AttemptEnd): Promise<RulingApplied> {
    const { dir, attempt, consecutiveFall, origin } = end;
    const { config, tracker, workspace } = this.deps;
    const ref = launchable.ref;
    const key = workKey(ref);

    const feedback = await tracker.readPrFeedback(ref);
    const pr = feedback.known ? feedback.value.pr : null;
    const prConfirmed = pr !== null && pr.state === "open";
    const issue = await tracker.readIssue(ref);
    const blockedLabelOnIssue = issue.known && issue.value.labels.includes(config.labels.blocked);
    const record = await readOutcomeRecord(dir);
    const ruling = await classifyOutcome({
      record,
      prOpen: prConfirmed,
      blockedLabelOnIssue,
      consecutiveFall,
      attempt,
      issueClosed: issue.known && issue.value.state === "closed",
      workDir: dir,
      workspace,
    });

    // A known PR — open, merged or closed — is persisted beside the Work
    // (issue 125): a restart correlates it from disk, and a later attempt
    // appends its own. Persistence never changes the ruling above.
    if (pr !== null) {
      try {
        recordPrAssociation(dir, {
          work: workOfIssueRef(ref),
          pullRequest: pullRequestIdentity(githubRepository(ref.repo), pr.number),
          attempt,
        });
      } catch (error) {
        this.log(
          `PR association of ${key} was not persisted (${describeError(error)}) — ` +
            "the ruling stands and the earlier evidence is untouched",
        );
      }
    }

    let resulting: OperationalClass | null;
    let next: Launchable | null = null;
    if (ruling.decision === "done") {
      // The terminal state was reached while this claim was held (the
      // human's merge closed the issue mid-flight — ticket 14): archive the
      // artifacts and clean the branches, nothing is released or recorded.
      this.log(`${origin} ${key}: issue closed — done; artifacts archived, branches cleaned`);
      await this.finishWork(ref);
      resulting = null;
    } else if (ruling.decision === "reserve") {
      this.log(`${origin} ${key}: PR open — stays reserved, waiting for the human`);
      resulting = "reserved";
    } else if (ruling.decision === "record-only") {
      this.log(`${origin} ${key}: blocked self-report — the factory only records the outcome`);
      resulting = "reserved";
    } else if (ruling.decision === "interrupt") {
      // No attempt is consumed and the fall ruler never applies (issue 123). A
      // repair round is settled by its own reconciliation (issue 112) instead.
      resulting = "reserved";
      if (launchable.kind === "repair") {
        this.log(
          `${origin} ${key}: the repair attempt wrote no outcome record — the repair reconciliation ` +
            "settles its publication before another round (issue 112)",
        );
      } else {
        this.log(
          `${origin} ${key}: interrupted (no outcome record) — not a failure; attempt ${attempt} keeps its ` +
            "number and the recovery budget answers it",
        );
        next = {
          ref,
          kind: "recover",
          createdAt: null,
          pr,
          // A recovery continues the SAME launch: the material of an
          // interrupted retomada keeps the human's answer.
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
      await this.applyRelease(ref);
      resulting = "eligible";
    } else {
      await this.settleFailure(dir, attempt, record);
      this.log(
        `${origin} ${key}: 2nd consecutive fall — blocked, the attempt's outcome goes to the issue`,
      );
      await this.applyBlockWithComment(ref, ruling.comment);
      resulting = "reserved";
    }
    this.announce(ref, resulting);

    // One notice per new occurrence: an applied block already notified help
    // (applyBlockWithComment), so here only the label/self-report of a work
    // the ruler did not block. Help wins over review; the state decision is
    // untouched. The self-report counts only for THIS attempt — desfecho.json
    // survives between attempts. A survivor's end is a review occurrence too:
    // its open PR reaches the operator even though this process never
    // launched it (issue 118).
    if (needsOccurrenceNotice(ruling)) {
      const selfReportedNow = selfReportedBlocked(record, attempt);
      const isReviewLaunch =
        origin === "survivor" || launchable.kind === "claim" || launchable.kind === "feedback";
      if (blockedLabelOnIssue || selfReportedNow) {
        await this.deliverNotice(helpNotice(ref));
      } else if (isReviewLaunch && prConfirmed && pr !== null) {
        await this.deliverNotice(reviewNotice(ref, pr.number));
      }
    }
    return { next, prConfirmed, ruling: { decision: ruling.decision, because: ruling.because } };
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

  /** The 1st-fall release (the ruler's mirrored swap): claimed→ready back,
   *  the assignee of the worker account released — the work re-enters the
   *  pool, the branch stays. One write pair, one helper: the derivation's
   *  unreconciled release and the collection's ruled release share it. */
  private async applyRelease(ref: IssueRef): Promise<void> {
    const { tracker, config } = this.deps;
    await tracker.releaseClaim(ref, config.workerGhAccount, config.labels.ready);
  }

  /** The block transition every 2nd fall and every rejection shares: the
   *  claimed label swaps to blocked (the claim is held until the terminal
   *  state) and the diagnosis is commented on the issue — the human must
   * SEE why it fell before deciding to resume. Applying a block IS the
   * new occurrence, so the help notice is delivered here, once. */
  private async applyBlockWithComment(ref: IssueRef, comment: string): Promise<void> {
    const { tracker, config } = this.deps;
    await tracker.blockClaim(ref, config.labels);
    await tracker.comment(ref, comment);
    await this.deliverNotice(helpNotice(ref));
  }

  /** The done duties on real disk and real git: archive the work's artifacts
   * (trabalhos/ → arquivo/, nothing deleted) and clean the branches. */
  private async finishWork(ref: IssueRef): Promise<void> {
    await archiveDoneWork(this.deps.workspace, ref);
    await this.deps.git.cleanupDoneWork(ref);
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
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A collected work never stays launchable in this process's memory — nor
   *  does a survivor's pending recovery for it. */
  private discardFromCacheAndParked(key: string): void {
    this.cache = this.cache.filter((entry) => workKey(entry.ref) !== key);
    this.parkedQueue = this.parkedQueue.filter((entry) => workKey(entry.ref) !== key);
    this.survivorRecoveries = this.survivorRecoveries.filter((entry) => workKey(entry.ref) !== key);
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
 * One sweep with the --once boundary (ticket 07 Q6): derive the pool AND the
 * reserved states through the port, act on what the derivation decided
 * (archive dones, close fallbacks, block rejections), claim and launch up to
 * `y` workers concurrently — parked reserved first, then new claims by age —
 * collect each one at the act of its end and wait for every launched worker
 * before returning. With an empty pool and nothing parked: no worker is
 * launched and the process ends clean.
 */
export async function runOnce(deps: LoopDeps): Promise<SweepResult> {
  const engine = new SweepEngine(deps);
  const reserved = await engine.deriveAndAct();
  engine.fillSlots();
  await engine.awaitAllLaunched();
  return {
    pool: engine.lastPool,
    reserved,
    reconciliation: engine.lastReconciliation,
    launched: engine.launched,
    collected: engine.collected,
  };
}

/** A launch failure never takes the continuous factory down unobserved. */
function logLaunchFailure(log: (message: string) => void, run: Promise<void>): void {
  void run.catch((error: unknown) => {
    log(`launch failed: ${error instanceof Error ? error.message : String(error)}`);
  });
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
  options: { tickMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const engine = new SweepEngine(deps);
  const log = operationalLog(deps.log);
  const tickMs = options.tickMs ?? TICK_MS;
  const signal = options.signal;

  // Ctrl-C stops launching the instant it is perceived — even during a
  // derivation, before the wait for the next event. The launches already
  // started are preserved: the loop below still awaits their collection.
  const onAbort = (): void => engine.stopLaunches();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await engine.deriveAndAct();
    for (const run of engine.fillSlots()) logLaunchFailure(log, run);

    for (;;) {
      const event = await engine.waitForWake(tickMs, signal);
      if (event === "abort" || signal?.aborted) {
        // No new launch from here on; the run retains ownership until every
        // started worker has completed collection and result registration.
        engine.stopLaunches();
        await engine.awaitAllLaunched();
        break;
      }
      if (event === "worker-end") {
        // The collection happened at the act; nothing to re-derive — the
        // human changes wait for the tick (staleness bounded by the interval).
        continue;
      }
      await engine.deriveAndAct();
      for (const run of engine.fillSlots()) logLaunchFailure(log, run);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  log("factory ended cleanly (human act)");
}

/** The repair context a session is launched with (issue 112): the confirmed
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
 * Gather the launch material of a work from the port + git host (ticket 17):
 * the issue (title/body), human issue replies on a blocked retomada, the open
 * PR's conversation on a feedback round, the repair context above, and the
 * diff. Unknown reads degrade to empty — the prompt still carries whatever is
 * known, never a lie.
 */
async function launchMaterial(
  tracker: TrackerPort,
  git: GitWork,
  ref: IssueRef,
  issueReplies?: IssueComment[],
  repair?: RepairLaunchContext,
): Promise<WorkerMaterial> {
  const issue = await tracker.readIssue(ref);
  const feedback = await tracker.readPrFeedback(ref);
  const diff = await git.diffWork(ref);

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
    issue: issue.known ? { title: issue.value.title, body: issue.value.body } : { title: "", body: "" },
    diff,
  };
  if (pr !== undefined) material.pr = pr;
  if (issueReplies !== undefined) material.issueReplies = issueReplies;
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
