import type { Config } from "./config.js";
import type { TrackerPort, IssueComment, IssueRef, PullRequest } from "./tracker/port.js";
import type { SessionResult, WorkerMaterial, WorkerRuntime } from "./runtime/port.js";
import type { GitWork } from "./git/port.js";
import { helpNotice, reviewNotice, type Notifier, type WorkNotification } from "./notify/port.js";
import { workDir, type WorkspaceLayout } from "./layout.js";
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
  type OutcomeRuling,
} from "./state/outcome.js";
import { readLaunchFacts, scanReservedWorks, archiveDoneWork } from "./pool/registry.js";
import { readRepairCycle, writeRepairCycle, EMPTY_REPAIR_CYCLE } from "./pool/repair.js";
import { Slots } from "./pool/slots.js";
import { operationalLog } from "./log.js";
import { mkdirSync } from "node:fs";

/**
 * The loop is the general workflow and is thin: the only module that knows
 * the process is a loop — owner of time (the fixed 60 s tick), of the --once
 * boundary and of waking by event (end of worker vs tick). It interlaces the
 * four phases deciding nothing of the domain: decisions live in state/,
 * IO in tracker/ + pool/ + git/ + runtime/ (ticket 07).
 *
 * Ticket 14: the derivation of the tick covers the states of ALL reserved
 * works (done · done-fallback · rejected · feedback · resumable — state/
 * decides, the loop executes the tracker and disk writes), the launches
 * prioritize the parked reserved works before new claims by age, and the
 * continuous run wakes by event (end of worker), not only by the clock.
 */

export const TICK_MS = 60_000;

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
}

export interface CollectedWork {
  ref: IssueRef;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The ruler's decided transition, applied at the act (ticket 13). */
  ruling: { decision: OutcomeRuling["decision"]; because: string };
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
  unknown: "reserved",
  feedback: "feedback",
  resumable: "resumable",
  repair: "reserved",
  "repair-recovered": "reserved",
  "repair-blocked": "reserved",
} satisfies Record<ReservedDerivation["state"], OperationalClass | null>;

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

/** What a launch starts as: a new claim, a parked feedback round, a retomada or a repair. */
type LaunchKind = "claim" | "feedback" | "resume" | "repair";

interface Launchable {
  ref: IssueRef;
  kind: LaunchKind;
  /** ISO 8601 — age-based priority inside each group. */
  createdAt: string;
  /** The work's linked PR when the derivation saw one (the retomada reopens a closed one). */
  pr: PullRequest | null;
  /** Human issue replies after the last agent marker, only for a retomada. */
  issueReplies?: IssueComment[];
  /** The confirmed impediments, only for a repair round. */
  repair?: RepairTrigger;
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

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight). The
    // in-flight set also goes INTO the derivation (ticket 18): a zero-
    // footprint claim inside it is a legit launch between the claim and the
    // worker's first write — held; outside it, an orphan — an abrupt fall.
    const inFlight = new Set(this.slots.workKeys);
    const reservedDirs = await scanReservedWorks(workspace);
    const reservedWorks = reservedDirs.filter((work) => !inFlight.has(workKey(work.ref)));

    const derived = await deriveReserved(
      tracker,
      reservedWorks,
      config.labels,
      config.workerGhAccount,
      inFlight,
    );

    // The actions state/ decided — executed here, in the loop's IO duty.
    const parked: Launchable[] = [];
    for (const decision of derived) {
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
          if (decision.decision === "release") {
            this.log(
              `derived ${workKey(decision.ref)}: unreconciled fall (the factory died on it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await this.applyRelease(decision.ref);
            this.announce(decision.ref, "eligible");
          } else {
            this.log(
              `derived ${workKey(decision.ref)}: unreconciled fall, 2nd consecutive — ` +
                "blocked with the exact outcome on the issue",
            );
            await this.applyBlockWithComment(decision.ref, decision.comment);
            this.announce(decision.ref, "reserved");
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
          });
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
    parked.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || workKey(a.ref).localeCompare(workKey(b.ref)));
    this.parkedQueue = parked;

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

  /** Record the class an action/event lands a work in (`null` = it leaves). */
  private announce(ref: IssueRef, resulting: OperationalClass | null): void {
    this.announced.set(workKey(ref), resulting);
  }

  /**
   * Phase 3 (launches): fill every free slot — first the parked reserved
   * works (feedback rounds, retomadas: they already hold the claim), then
   * new claims by createdAt. Returns the raw launch promises (the --once
   * boundary awaits them transitively; the continuous run only guards them).
   */
  fillSlots(): Promise<void>[] {
    const started: Promise<void>[] = [];
    while (!this.slots.full) {
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

  /** The parked reserved works first, then the cached pool — each by age. */
  private takeNextLaunchable(): Launchable | undefined {
    const parked = this.parkedQueue.shift();
    if (parked !== undefined) return parked;
    const entry = this.cache.shift();
    if (entry === undefined) return undefined;
    return { ref: entry.ref, kind: "claim", createdAt: entry.createdAt, pr: null };
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
      await this.launchOnce(launchable);
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
  private async launchOnce(launchable: Launchable): Promise<void> {
    const { config, tracker, runtime, git, workspace } = this.deps;
    const { ref, kind } = launchable;
    const key = workKey(ref);

    if (kind === "claim") {
      logClaim(this.log, key);
      // The reservation comes first (issue 98): if the tracker write fails, the
      // next sweep re-claims and reuses this directory instead of leaving a mark
      // with no footprint.
      mkdirSync(workDir(workspace, ref.repo, ref.number), { recursive: true });
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
    let baseBranch = prepared.baseBranch;
    if (repairTrigger !== undefined) {
      baseBranch = repairTrigger.facts.baseBranch;
      const observed = await git.observeRemoteHead(ref);
      if (observed === null || observed !== repairTrigger.facts.headSha) {
        this.log(
          `repair round for ${key} skipped: the remote head ${observed ?? "(absent)"} no longer matches the ` +
            `observed ${repairTrigger.facts.headSha} — the evidence is stale, nothing is launched`,
        );
        return;
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

    // The registry numbers the attempt and remembers the previous fall —
    // both are disk facts of this work, not process state (ticket 13).
    const dir = workDir(workspace, ref.repo, ref.number);
    const facts = await readLaunchFacts(dir);
    if (kind === "resume" && facts.previousFall) {
      // Ticket 14's decision: the human's answer resets the consecutive
      // fall count — the blocked valve already did its job and was addressed;
      // a new fall starts a fresh count (1st → release again).
      facts.previousFall = false;
    }
    if (kind === "resume") {
      // A human answer that unblocks the work also renews the automatic
      // repair budget (issue 107 story 23); new commits never do.
      await writeRepairCycle(dir, EMPTY_REPAIR_CYCLE);
    }
    if (repairTrigger !== undefined) {
      // The round is consumed BEFORE the session: a death mid-round must not
      // renew the budget nor repeat the same evidence (issue 107).
      await this.recordRepairRound(dir, ref, repairTrigger);
    }
    // The launch material (ticket 17): the issue, the open PR with its
    // conversation (a feedback round), the diff of the branch — every
    // session starts from the whole context through the port + git host.
    const material = await launchMaterial(
      tracker,
      git,
      ref,
      kind === "resume" ? launchable.issueReplies : undefined,
      repairTrigger,
    );
    // Ctrl-C perceived after the reservation but before the worker started:
    // do not start a new worker after this point. The reservation (the claim
    // and the registry dir) stays for the next run's reconciliation; the
    // caller releases the slot.
    if (this.stopping) {
      this.log(`the launch of ${key} stopped before the worker started — the reservation stays for reconciliation`);
      return;
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

    await this.collect(launchable, result, dir, facts.attempt, facts.previousFall);
  }

  /** Consume one automatic repair round before its session: the budget and
   *  the consumed evidence signature persist on disk, so a restart neither
   *  renews the cap nor repeats the same round. */
  private async recordRepairRound(dir: string, ref: IssueRef, trigger: RepairTrigger): Promise<void> {
    const cycle = await readRepairCycle(dir);
    await writeRepairCycle(dir, {
      usedRounds: cycle.usedRounds + 1,
      lastEvidence: repairSignature(ref, trigger),
    });
  }

  /**
   * Collection at the act: the ruler (ticket 13, extended by 14) on
   * structured facts alone — the outcome record (absence = abrupt fall), the
   * PR fact and the label facts from the port, and the registry's
   * consecutiveness. The decided transition is applied here.
   */
  private async collect(
    launchable: Launchable,
    result: SessionResult,
    dir: string,
    attempt: number,
    consecutiveFall: boolean,
  ): Promise<void> {
    const { config, tracker } = this.deps;
    const ref = launchable.ref;
    const key = workKey(ref);

    const feedback = await tracker.readPrFeedback(ref);
    const pr = feedback.known ? feedback.value.pr : null;
    const prConfirmed = pr !== null && pr.state === "open";
    const issue = await tracker.readIssue(ref);
    const blockedLabelOnIssue = issue.known && issue.value.labels.includes(config.labels.blocked);
    const record = await readOutcomeRecord(dir);
    const ruling = classifyOutcome({
      record,
      prOpen: prConfirmed,
      blockedLabelOnIssue,
      consecutiveFall,
      attempt,
      issueClosed: issue.known && issue.value.state === "closed",
    });

    let resulting: OperationalClass | null;
    if (ruling.decision === "done") {
      // The terminal state was reached while this claim was held (the
      // human's merge closed the issue mid-flight — ticket 14): archive the
      // artifacts and clean the branches, nothing is released or recorded.
      this.log(`collected ${key}: issue closed — done; artifacts archived, branches cleaned`);
      await this.finishWork(ref);
      resulting = null;
    } else if (ruling.decision === "reserve") {
      this.log(`collected ${key}: PR open — stays reserved, waiting for the human`);
      resulting = "reserved";
    } else if (ruling.decision === "record-only") {
      this.log(`collected ${key}: blocked self-report — the factory only records the outcome`);
      resulting = "reserved";
    } else if (ruling.decision === "release") {
      this.log(
        `collected ${key}: fall without PR — release (claimed→ready back; ` +
          "the branch stays, the next sweep picks it up)",
      );
      await this.applyRelease(ref);
      resulting = "eligible";
    } else {
      this.log(`collected ${key}: 2nd consecutive fall — blocked, the exact outcome goes to the issue`);
      await this.applyBlockWithComment(ref, ruling.comment);
      resulting = "reserved";
    }
    this.announce(ref, resulting);
    this.collected.push({
      ref,
      result,
      prConfirmed,
      ruling: { decision: ruling.decision, because: ruling.because },
    });

    // One notice per new occurrence: an applied block already notified help
    // (applyBlockWithComment), so here only the label/self-report of a work
    // the ruler did not block. Help wins over review; the state decision is
    // untouched. The self-report counts only for THIS attempt — desfecho.json
    // survives between attempts.
    if (ruling.decision !== "done" && ruling.decision !== "block") {
      const selfReportedNow =
        record !== null && record.attempt === attempt && record.class === "blocked-self-report";
      const isReviewLaunch = launchable.kind === "claim" || launchable.kind === "feedback";
      if (blockedLabelOnIssue || selfReportedNow) {
        await this.deliverNotice(helpNotice(ref));
      } else if (isReviewLaunch && prConfirmed && pr !== null) {
        await this.deliverNotice(reviewNotice(ref, pr.number));
      }
    }
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
   *  state) and the exact outcome is commented on the issue — the human
   * must SEE why it fell before deciding to resume. Applying a block IS the
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

  /** Best-effort delivery of one occurrence notice; a failure only logs. */
  private async deliverNotice(notification: WorkNotification): Promise<void> {
    if (!this.deps.config.notifications) return;
    const notifier = this.deps.notifier;
    if (notifier === undefined) return;
    try {
      await notifier.notify(notification);
    } catch (error) {
      this.log(
        `local notification failed (${notification.kind} ${workKey(notification.ref)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A collected work never stays launchable in this process's memory. */
  private discardFromCacheAndParked(key: string): void {
    this.cache = this.cache.filter((entry) => workKey(entry.ref) !== key);
    this.parkedQueue = this.parkedQueue.filter((entry) => workKey(entry.ref) !== key);
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

/**
 * Gather the launch material of a work from the port + git host (ticket 17):
 * the issue (title/body), human issue replies on a blocked retomada, the open
 * PR's conversation on a feedback round, and the diff. Unknown reads degrade
 * to empty — the prompt still carries whatever is known, never a lie.
 */
async function launchMaterial(
  tracker: TrackerPort,
  git: GitWork,
  ref: IssueRef,
  issueReplies?: IssueComment[],
  repair?: RepairTrigger,
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
      reasons: repair.reasons,
      observedHeadSha: repair.facts.headSha,
      baseBranch: repair.facts.baseBranch,
      checks: repair.failingChecks,
    };
  }
  return material;
}
