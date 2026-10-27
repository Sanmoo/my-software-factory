import type { Config } from "./config.js";
import type { PullRequestTracker, TicketTracker } from "./tracker/expanded-port.js";
import type { SessionResult, WorkerRuntime } from "./runtime/port.js";
import type { JiraMediationComposition } from "./tracker/jira-mediation.js";
import type { GitWork } from "./git/port.js";
import { helpNotice, type Notifier } from "./notify/port.js";
import { SESSIONS_SUBDIR, workDirOfKey, type WorkspaceLayout } from "./layout.js";
import {
  composedTicketSources,
  githubSelections,
  renderWorkIdentity,
  sourceKey,
  type WorkIdentity,
} from "./tracker/identity.js";
import { scanReservations, type IdentifiedReservation } from "./pool/reservation.js";
import {
  deriveTrackerState,
  workPullRequest,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  unbackedClaimKey,
  unmarkedReservationKey,
  type Reconciliation,
  type PoolEntry,
} from "./state/derive.js";
import type { Launch, LaunchCycle, Launchable } from "./launch/launch.js";
import { openPipeline } from "./launch/pipeline.js";
import { openCollect, type Collect } from "./collect/collect.js";
import type { CollectedRulingReport } from "./collect/ruling.js";
import {
  STATE_DECLARATIONS,
  consentAppliesTo as stateConsentAppliesTo,
  openWorkState,
  type OperationalClass,
  type WorkRef,
  type WorkState,
  type WorkStateReading,
} from "./work-state/state.js";
import { readOutcomeRecord } from "./work-record/outcome.js";
import { interruptionPausedCommentBody } from "./state/outcome.js";
import { readAttemptLedger } from "./work-record/attempts.js";
import { EMPTY_REPAIR_CYCLE, writeRepairCycle } from "./work-record/repair.js";
import { readRecoveryLedger } from "./work-record/recovery.js";
import {
  confirmStopRequest,
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
import { workKeyOf } from "./pool/work-key.js";
import { deferred } from "./runtime/deferred.js";
import { recheckPausedEffects, type ContinuityDeps } from "./runtime/continuity.js";
import { pendingCallRecovery, type CallRecovery } from "./runtime/call-recovery.js";
import { openNonFailures, type NonFailures } from "./non-failures/non-failures.js";
import { Slots } from "./pool/slots.js";
import { openSurvivors, type Survivors } from "./survivors/survivors.js";
import { openRepairReconciler, type RepairReconciler } from "./repair/reconcile.js";
import {
  capacityExcess,
  occupiedSlots,
  type LivenessProbe,
} from "./state/liveness.js";
import { processRecoveryRequests } from "./recover.js";
import { operationalLog } from "./log.js";
import { collectFinishedWorks } from "./retro/window.js";
import { RetroBusyError, planAutomaticRound, runRetroRound } from "./retro/round.js";
import { describeError } from "./format.js";
import { join } from "node:path";

/**
 * The loop is the CYCLE: tick, capacity and
 * admission. It is the only module that knows the process is a loop — owner of
 * time (the fixed 60 s tick), of the --once boundary and of waking by event
 * (end of worker vs tick) — and it decides nothing of the domain. Each domain
 * answers at its own module, and the loop asks:
 *
 * - work-state/ answers WHAT happened to a Work and what may be done now, in
 *   one vocabulary: read before a launch (the derivation) and after an Attempt
 *   (the collection);
 * - collect/ collects an ended Attempt and APPLIES its verdict, with every
 *   tracker and disk verb it triggers — archive, close, comment, release,
 *   block, persist, clear, consume, notice;
 * - launch/ runs the pipeline from the decided launch to the collected end:
 *   claim (or resume), prepare, the runtime launch and the budget waits;
 * - survivors/ owns liveness and the survivor ledger (which worker carries each
 *   Work, and every occurrence of that observation said once);
 * - non-failures/ owns the two endings that are not a failure (the Continuity
 *   pause and the model provider failure);
 * - repair/ owns the Repair reconciliation: every repair attempt that wrote its
 *   facts on disk and no live worker carries is settled before the derivation
 *   reads the cycle, and the local-work/remote reads a round's material needs
 *   are its own;
 * - tracker/ + pool/ + git/ + runtime/ are the IO.
 *
 * What is left here is the cycle's own: the tick, the slot of each admission
 * (released even when a collection fails), the capacity read before admitting,
 * the derivation of the pool and the decision of what to launch in which order,
 * the requested-stop boundary (the hold of an unconfirmed stop and the
 * admission a stop interrupts), and the wait for the next event. Each verdict
 * the state decides is executed by the module that owns it; the loop only reads
 * the facts and asks.
 */

export const TICK_MS = 60_000;

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
   *  that could replace a worker. The composition (wireRunDeps)
   *  supplies the real read-only Docker probe; absent means this process sees
   *  only its own launches. Never a CLI flag — tests inject a fake probe. */
  probe?: LivenessProbe;
  /** The bound of one probe query; a hung Docker call is unknown, never a stall. */
  probeTimeoutMs?: number;
  /** The cycle's clock; tests inject one to exercise deadlines without waiting. */
  now?: () => number;
  /** The backoff seam before a recovery relaunch: production waits
   *  on a real timer; a test injects one to observe the configured schedule. */
  wait?: (ms: number) => Promise<void>;
  /** Factory-mediated Jira access: the composition opens a handler per Jira
   *  launch, so a Jira Work has the interaction its worker needs. Supplying it
   *  is what makes a Jira Work launchable; absent, the launch is refused
   *  instead of starting a worker that could not reach its ticket. */
  jiraMediation?: JiraMediationComposition;
}

export interface CollectedWork {
  work: WorkIdentity;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The decided transition, as the collection reports it. */
  ruling: CollectedRulingReport;
}

export interface SweepResult {
  pool: PoolEntry[];
  /** The states read for every reserved work this sweep, in the one
   *  vocabulary the engine decided in. */
  reserved: WorkStateReading[];
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
 * Consent never reopens a terminal state, and a state presumes a worker stopped
 * while liveness is unknown: both are DECLARED beside the state
 * (`STATE_DECLARATIONS`, ADR-0010), which is what makes a new state fail to
 * compile until it says so. The loop only asks; it keeps no list of its own.
 * A hand-kept blacklist silently stranded a valid authorization on
 * `repair-fall-blocked`; consent answers the pause, so it outranks the round
 * the
 * factory planned meanwhile.
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

/** A recovery (no human age) goes first; the rest by creation age, then key. */
function byParkedPriority(a: Launchable, b: Launchable): number {
  if (a.createdAt === null || b.createdAt === null) {
    if (a.createdAt === b.createdAt) return workKeyOf(a.work).localeCompare(workKeyOf(b.work));
    return a.createdAt === null ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt) || workKeyOf(a.work).localeCompare(workKeyOf(b.work));
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

/**
 * One sweep engine, four phases and nothing but the cycle: the
 * derivation (the Work state read before a launch, its actions executed by the
 * module that owns them), the launches into free slots (parked reserved first,
 * then new claims by age), the collection of each worker's end by collect/
 * (slot replenished in the same cycle, even when that collection fails), and
 * the wait for the next event. The --once boundary awaits everything launched;
 * the continuous run keeps sweeping on the tick and wakes by event.
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
  /** The retrospective round in flight — its own lane, never a slot. */
  private retroRun: Promise<void> | null = null;

  /** Liveness and the survivor ledger: which worker
   *  carries each Work, and every occurrence of that observation said once. */
  private readonly survivors: Survivors;
  /** The two endings that are not a failure: the Continuity pause
   *  and the model provider failure. */
  private readonly nonFailures: NonFailures;
  /** The collection: an Attempt's end and the verdict applied,
   *  with every tracker and disk verb it triggers. The engine only asks. */
  private readonly collect: Collect;
  /** The Repair reconciliation: every repair attempt on disk that
   *  no live worker carries, settled before the derivation reads the cycle. */
  private readonly repair: RepairReconciler;
  /** The last reported capacity verdict, so the change is said once. */
  private overCapacity = false;

  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: LoopDeps,
    stop: StopOptions = {},
  ) {
    this.slots = new Slots(deps.config.concurrency);
    this.log = operationalLog(deps.log);
    this.survivors = openSurvivors({
      probe: deps.probe ?? (() => Promise.resolve([])),
      ...(deps.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: deps.probeTimeoutMs }),
      now: () => this.now(),
      log: this.log,
      unavailableWarnMs: deps.config.liveness.unavailableWarnMs,
      cycle: {
        ended: (launchable, attempt) => this.survivorEnded(launchable, attempt),
        notice: (notification) => this.collect.notify(notification),
      },
    });
    // The collection: what the factory DOES with an Attempt that
    // ended — the Work state's second reading applied, every write included.
    // The one process-wide fact it needs (whether this factory is stopping) and
    // the set of works it holds come back through the cycle's port.
    this.collect = openCollect({
      config: deps.config,
      tickets: deps.tickets,
      pullRequests: deps.pullRequests,
      git: deps.git,
      workspace: deps.workspace,
      log: this.log,
      ...(deps.notifier === undefined ? {} : { notifier: deps.notifier }),
      cycle: {
        announce: (work, resulting) => this.announce(work, resulting),
        stopping: () => this.stopping,
        inFlight: () => this.liveInFlight,
      },
    });
    // The two endings that are not a failure: the Continuity pause
    // and the model provider failure. Their decisions live in non-failures/;
    // the
    // engine executes the verdicts and keeps the cycle.
    this.nonFailures = openNonFailures({
      config: deps.config,
      tickets: deps.tickets,
      pullRequests: deps.pullRequests,
      workspace: deps.workspace,
      log: this.log,
      // The evidence read stays the runtime's own: the attempt's session, its
      // journal and the real state — never an mtime.
      recheckEvidence: (work, dir, attempt, pause) =>
        recheckPausedEffects(this.continuityDeps(work, dir, attempt), pause),
      cycle: {
        blockAndAsk: (work, comment) => this.collect.blockWithComment(work, comment),
        reassertBlock: async (work) => {
          await this.deps.tickets.blockTicketClaim(work.ticket, this.deps.config.labels);
        },
        holdAndAsk: (work, comment) => this.holdAndAsk(work, comment),
        unblock: async (work) => {
          await this.deps.tickets.resumeTicketClaim(work.ticket, this.deps.config.labels);
        },
        workerMayBeAlive: (work) => this.workerMayBeAlive(work),
      },
    });
    // The Repair reconciliation: the settlement of an attempt that
    // wrote its facts and no worker carries, before the derivation reads it.
    // The requested-stop boundary is the cycle's, so it comes back as a port.
    this.repair = openRepairReconciler({
      git: deps.git,
      pullRequests: deps.pullRequests,
      log: this.log,
      cycle: { operatorStopped: (dir, attempt) => this.operatorStoppedAttempt(dir, attempt) },
    });
    this.operatorStop = new OperatorStop({
      workspace: deps.workspace,
      runtime: deps.runtime,
      probe: async () => {
        await this.survivors.observe(this.localWorkKeys());
        return this.survivors.observation();
      },
      log: this.log,
      ...(stop.cooperativeMs === undefined ? {} : { cooperativeMs: stop.cooperativeMs }),
    });
    this.launch = openPipeline({
      config: deps.config,
      tickets: deps.tickets,
      pullRequests: deps.pullRequests,
      runtime: deps.runtime,
      git: deps.git,
      workspace: deps.workspace,
      log: this.log,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
      ...(deps.jiraMediation === undefined ? {} : { jiraMediation: deps.jiraMediation }),
      cycle: this.launchCycle(),
    });
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

    // The liveness facts come FIRST: a decision that could
    // substitute a worker or end its resources reads them, and the survivor
    // ledger keeps the executions that outlived a previous factory process.
    await this.survivors.observe(this.localWorkKeys());
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
    this.survivors.reportHolds(held);
    // The same list feeds the survivor reconciliation and the derivation: a
    // held Work is held on EVERY path, never launched just because a container
    // still carries it.
    const reservationByKey = new Map(serveable.map((entry) => [entry.key, entry]));
    const settled = await this.survivors.reconcile(reservationByKey);
    this.observeCapacity();
    const suspended = !this.survivors.isKnown();

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight). The
    // in-flight set also goes INTO the derivation: a zero-
    // footprint claim inside it is a legit launch between the claim and the
    // worker's first write — held; outside it, an interruption to recover.
    // Surviving workers (in the live set) and the works just settled join it: a
    // live worker keeps its work reserved, and a settled exit is
    // not decided twice in the same sweep.
    const inFlight = new Set([...this.liveInFlight, ...settled]);
    // The pool is read from the configured selections — the same repos the
    // operator names, never a second source of truth.
    const selections = githubSelections(config.repos);
    const allReserved: WorkRef[] = serveable.map((entry) => ({
      work: entry.work,
      dir: entry.dir,
    }));
    const reservedWorks = allReserved.filter((work) => !inFlight.has(workKeyOf(work.work)));

    // The repair reconciliation runs BEFORE the derivation: a
    // repair attempt that fell is settled against the remote first, so the
    // derivation reads the verdict (resume, block, or uncertainty) instead of
    // a charged round that never published. Unknown liveness holds it too: a
    // worker may still be writing the branch its verdict reads.
    if (!suspended && !this.stopping) {
      await processRecoveryRequests(config, {
        probe: this.deps.probe ?? (async () => []), inFlight,
        log: (line) => this.log(line),
      });
    }
    if (!suspended) await this.repair.reconcile(allReserved, inFlight);

    // A stop whose confirmation failed on the previous invocation is settled
    // BEFORE the derivation: the work only resumes once the
    // previous worker is known to be gone. The stop module re-reads the rule
    // the stop applied; this tick only says the verdicts.
    await this.settleUnconfirmedStops(allReserved, inFlight);

    // The Work state, read once for this sweep: the module is opened with the
    // LIVE in-flight set — a running worker is its own state — so no reading
    // ever answers for a world that moved (the collection opens it with the
    // same live set below).
    const workState = this.workState(inFlight);
    const derived = await Promise.all(reservedWorks.map((ref) => workState.beforeLaunch(ref)));

    // The actions the Work state decided — executed here, in the loop's IO
    // duty.
    const parked: Launchable[] = [];
    const heldWhileUnknown: string[] = [];
    for (const decision of derived) {
      // Liveness unknown means no worker can be ruled out: a
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
          await this.collect.archiveDone(decision.work);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "done-fallback": {
          this.log(
            `derived ${key}: PR merged without closing the issue — ` +
              "the factory closes it (fallback of the linkage), then archives",
          );
          await this.collect.closeIssueAndArchive(decision.work, decision.comment);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "rejected": {
          this.log(
            `derived ${key}: PR closed without merge — rejected, ` +
              "blocked with a comment pointing at the PR",
          );
          await this.collect.blockWithComment(decision.work, decision.comment);
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "fall": {
          // A WRITTEN failure the factory died before ruling: it consumes the
          // attempt and the ruler applies as at collection.
          const dir = decision.dir;
          await this.collect.settleFailure(dir, decision.attempt, await readOutcomeRecord(dir));
          if (decision.decision === "release") {
            this.log(
              `derived ${key}: unreconciled failure (the factory died before ruling it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await this.collect.releaseClaim(decision.work);
            // A released fall lands ELIGIBLE, not the class the state declares:
            // the action says so here, where it acts (ADR-0010).
            this.announce(decision.work, "eligible");
          } else {
            this.log(
              `derived ${key}: 2nd consecutive fall, unreconciled — ` +
                "blocked with the attempt's diagnosis on the issue",
            );
            await this.collect.blockWithComment(decision.work, decision.comment);
            this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
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
            await this.nonFailures.settleModelProvider(
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
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          break;
        }
        case "continuity-paused": {
          // The Attempt cannot safely continue. The Continuity pause
          // decides at its own seam whether reliable evidence settles it — a
          // continuation of the SAME attempt, or a NEW round oriented by the
          // human answer — or whether the Work keeps waiting for the operator,
          // having asked once. Other works keep going.
          this.announce(decision.work, STATE_DECLARATIONS[decision.state].announces);
          const verdict = await this.nonFailures.recheckPause(
            decision.work,
            decision.dir,
            decision.pause,
            decision.attempt,
          );
          if (verdict.kind === "continue") parked.push(verdict.launch);
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
          await this.collect.blockWithComment(decision.work, decision.comment);
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
          await this.collect.blockWithComment(decision.work, decision.comment);
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
          // Never acted on: the ticket could not be read. A failed read is not
          // a
          // verdict, so no attempt, no archive and no block is invented from
          // it.
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
    // A recovery for a survivor's ended attempt joins the queue;
    // while liveness is unknown the pending recoveries are preserved untouched
    // — the launch gate keeps them from starting.
    this.parkedQueue = suspended
      ? parked
      : [...this.survivors.takeRecoveries(), ...parked].sort(byParkedPriority);

    // The pool AND the reconciliation from ONE open-issues read per repo: the
    // cached pool of the latest derivation (replenishment
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
   * holds at most one (the promise below), the lane's pid-owned in-flight
   * record keeps every other factory process out, and the report's marker
   * keeps the windows apart.
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
    if (this.survivors.observation().state !== "known") {
      this.log("retro: liveness is unknown — no round is launched; the window is analyzed once Docker answers");
      return;
    }
    const finished = await collectFinishedWorks(workspace, this.carriedKeys);
    // No plan means no material: the threshold counts only works no report has
    // covered yet, so the lane waits quietly instead of announcing an empty
    // window every sweep.
    const plan = await planAutomaticRound(config, workspace, finished, now);
    if (plan === null) return;
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

  /** The works a live container carries, read from the latest answer: the launch
   * and capacity decisions never ask Docker a second question. Unknown liveness
   *  carries nobody — the ledger's empty answer, never the decided zero. */
  private get carriedKeys(): ReadonlySet<string> {
    return new Set(this.survivors.carriers().keys());
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
   * engine decides and executes in.
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

  /**
   * What this process holds an admission for right now — the admission fact the
   * survivor ledger is told, so a container of those works is a launch and
   * never
   * a survivor. Capacity and admittance stay here: the ledger is asked who
   * carries what, and the engine counts the slots it may take.
   */
  private localWorkKeys(): ReadonlySet<string> {
    return new Set(this.slots.workKeys);
  }

  /**
   * The end of a survivor, ruled by the ordinary ruler over the attempt's own
   * artifacts and the current tracker — the ledger read the facts
   * and asked; applying a verdict is the cycle's write.
   */
  private async survivorEnded(launchable: Launchable, attempt: number): Promise<Launchable | null> {
    const outcome = await this.collect.attemptEnd(launchable, {
      dir: launchable.dir,
      attempt,
      origin: "survivor",
    });
    return outcome.next;
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
    const observation = this.survivors.observation();
    if (observation.state !== "known") return; // the unknown episode has its own line
    const excess = capacityExcess(
      observation.workers,
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
    if (this.stopping || !this.survivors.isKnown()) return started;
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
   *  work a live container carries is never relaunched: a survivor
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
    const observation = this.survivors.observation();
    if (observation.state !== "known") return false;
    return (
      occupiedSlots(observation.workers, this.localWorkKeys()) < this.deps.config.concurrency
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
      // admission, never after it — the launch reads {@link
      // LaunchCycle.stopped}.
      this.requestedStopBegan.resolve();
    }
    return this.operatorStop.begin({
      launches: this.launch.admissions(),
      survivors: () => this.survivors.survivorKeys(),
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
    // The retrospective lane is outside the slots, so the boundary waits for
    // it explicitly. A requested stop does not wait: the stop is the operator's
    // act and the round advances no marker without its report.
    if (this.operatorStop.report === null && this.retroRun !== null) await this.retroRun;
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
   *  slot would never retry the work. The rejection belongs to the
   *  caller (runOnce awaits it, runForever logs it as a failed launch). */
  private async launchAndCollect(launchable: Launchable): Promise<void> {
    const key = workKeyOf(launchable.work);
    try {
      // An interruption inside the session returns the SAME attempt as a
      // recovery to launch next, in the same held slot.
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
   * The engine's side of an admission: the duties the
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
        const outcome = await this.collect.attemptEnd(launchable, {
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
      // Both are the non-failures module's: the pause persists and asks once
      // (the launch path is where a refused continuation is told), and the
      // model provider failure settles on its own budget before the wait.
      pauseForContinuity: async (work, dir, pause, attempt) => {
        this.announce(work, "reserved");
        await this.nonFailures.askForContinuity(work, dir, pause, attempt);
      },
      settleModelProviderFailure: (work, dir, attempt, failure) =>
        this.nonFailures.settleModelProvider(work, dir, attempt, failure),
      inspectLocalWork: (work) => this.repair.inspectLocalWork(work),
      observeRemote: (work) => this.repair.observeRemote(work),
    };
  }

  /**
   * Whether the operator's own requested stop owns the end of this attempt: the
   * persisted requested stop of exactly this attempt, or a
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

  /** The exhausted recovery budget: block the work and ask the operator for
   * help, naming the configured value and backoff — no attempt was consumed. */
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
    await this.collect.blockWithComment(work, comment);
    this.announce(work, "reserved");
  }


  /**
   * A requested stop whose confirmation failed on a previous invocation: the
   * stop module re-derives the hold over the same rule it
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
      this.survivors.observation(),
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


  /** Say the hold once per appearance (the tick repeats it otherwise). */
  private reportStopHold(key: string, because: string): void {
    if (this.reportedStopHolds.get(key) === because) return;
    this.reportedStopHolds.set(key, because);
    this.log(
      `derived ${key}: NOT relaunching — ${because}. The work stays held until the previous worker is ` +
        "known to be gone (see `msf status`); a human may need to stop it",
    );
  }

  /** The engine's side of an exhausted model provider budget: keep the claim and
   *  ask the operator — the comment and the notice, never the blocked label (an
   *  awaiting model provider is not a Block). */
  private async holdAndAsk(work: WorkIdentity, comment: string): Promise<void> {
    const { tickets, config } = this.deps;
    await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
    await tickets.commentOnTicket(work.ticket, comment);
    await this.collect.notify(helpNotice(work));
  }

  /** Whether a worker of this Work may still be alive — an admission of this
   *  process or a survivor: the one liveness fact the endings ask, and the one
   *  only the engine holds. */
  private workerMayBeAlive(work: WorkIdentity): boolean {
    const key = workKeyOf(work);
    return this.slots.workKeys.includes(key) || this.carriedKeys.has(key);
  }

  /** A collected work never stays launchable in this process's memory. A
   *  survivor's pending recovery is already in the parked queue: the ledger
   *  hands its continuations over once per derivation. */
  private discardFromCacheAndParked(key: string): void {
    this.cache = this.cache.filter((entry) => workKeyOf(entry.work) !== key);
    this.parkedQueue = this.parkedQueue.filter((entry) => workKeyOf(entry.work) !== key);
  }
}

type WakeEvent = "worker-end" | "tick" | "abort";

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
