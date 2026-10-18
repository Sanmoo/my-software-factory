import type { Config } from "./config.js";
import type { TrackerPort, IssueRef, PullRequest } from "./tracker/port.js";
import type { SessionResult, WorkerRuntime } from "./runtime/port.js";
import type { GitWork } from "./git/port.js";
import { workDir, type WorkspaceLayout } from "./layout.js";
import { derivePool, deriveReserved, type PoolEntry, type ReservedDerivation } from "./state/derive.js";
import {
  readOutcomeRecord,
  classifyOutcome,
  type OutcomeRuling,
} from "./state/outcome.js";
import { readLaunchFacts, scanReservedWorks, archiveDoneWork } from "./pool/registry.js";
import { Slots } from "./pool/slots.js";
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
  launched: SessionResult[];
  collected: CollectedWork[];
}

export const workKey = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

/** What a launch starts as: a new claim, a parked feedback round or a retomada. */
type LaunchKind = "claim" | "feedback" | "resume";

interface Launchable {
  ref: IssueRef;
  kind: LaunchKind;
  /** ISO 8601 — age-based priority inside each group. */
  createdAt: string;
  /** The work's linked PR when the derivation saw one (the retomada reopens a closed one). */
  pr: PullRequest | null;
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
  private readonly endedWaiters: Array<{ fire: (event: WakeEvent) => void }> = [];
  readonly launched: SessionResult[] = [];
  readonly collected: CollectedWork[] = [];

  // Prepare (clone/fetch/branch) touches the shared clone of a repo — two
  // first-launches of the same repo must not race inside it (ticket 12
  // introduced the parallelism; the serialization stays local to prepares,
  // the launches themselves run concurrently).
  private readonly preparing = new Map<string, Promise<void>>();

  constructor(private readonly deps: LoopDeps) {
    this.slots = new Slots(deps.config.concurrency);
  }

  private get log(): (message: string) => void {
    return this.deps.log ?? (() => {});
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
    const { config, tracker, git, workspace } = this.deps;

    // WHO is reserved: the registry's work dirs, minus what is in flight
    // right now (a running worker is its own state; the tick does not
    // re-launch it and does not act on a terminal state mid-flight).
    const inFlight = new Set(this.slots.workKeys);
    const reservedWorks = (await scanReservedWorks(workspace)).filter(
      (work) => !inFlight.has(workKey(work.ref)),
    );

    const derived = await deriveReserved(
      tracker,
      reservedWorks,
      config.labels,
      config.workerGhAccount,
    );

    // The actions state/ decided — executed here, in the loop's IO duty.
    const parked: Launchable[] = [];
    for (const decision of derived) {
      switch (decision.state) {
        case "done": {
          this.log(`derived ${workKey(decision.ref)}: issue closed — done; archiving artifacts, cleaning branches`);
          await this.finishWork(decision.ref);
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
          break;
        }
        case "rejected": {
          this.log(
            `derived ${workKey(decision.ref)}: PR closed without merge — rejected, ` +
              "blocked with a comment pointing at the PR",
          );
          await tracker.blockClaim(decision.ref, config.labels.claimed, config.labels.blocked);
          await tracker.comment(decision.ref, decision.comment);
          break;
        }
        case "fall": {
          if (decision.decision === "release") {
            this.log(
              `derived ${workKey(decision.ref)}: unreconciled fall (the factory died on it) — ` +
                "release (claimed→ready back; the branch stays)",
            );
            await tracker.releaseClaim(decision.ref, config.workerGhAccount, config.labels.ready);
          } else {
            this.log(
              `derived ${workKey(decision.ref)}: unreconciled fall, 2nd consecutive — ` +
                "blocked with the exact outcome on the issue",
            );
            await tracker.blockClaim(decision.ref, config.labels.claimed, config.labels.blocked);
            await tracker.comment(decision.ref, decision.comment);
          }
          break;
        }
        case "feedback":
        case "resumable":
          parked.push({
            ref: decision.ref,
            kind: decision.state === "feedback" ? "feedback" : "resume",
            createdAt: decision.createdAt,
            pr: decision.pr,
          });
          break;
        default:
          break; // idle / unknown: nothing to decide
      }
    }
    parked.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || workKey(a.ref).localeCompare(workKey(b.ref)));
    this.parkedQueue = parked;

    // The pool: the cached pool of the latest derivation (replenishment
    // draws from it; a cache drained empty waits for the next tick).
    this.lastPool = await derivePool(tracker, config.repos, config.labels);
    this.cache = [...this.lastPool];
    this.log(
      `derived pool: ${this.cache.length} eligible work(s), ` +
        `${parked.length} parked reserved work(s)`,
    );
    return derived;
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
      const launchable = this.takeNextLaunchable();
      if (launchable === undefined) break;
      if (!this.slots.tryAcquire(workKey(launchable.ref))) continue; // already in flight
      const run = this.launchAndCollect(launchable);
      this.pending.add(run);
      void run.finally(() => this.pending.delete(run));
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

  /** The --once boundary: wait for every launched worker, transitively —
   * each collection replenishes the slot within the same cycle. */
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

  /** Claim (or resume), prepare, launch and collect one work; replenish in
   * the same cycle. The reservation lands BEFORE the launch. */
  private async launchAndCollect(launchable: Launchable): Promise<void> {
    const { config, tracker, runtime, git, workspace } = this.deps;
    const { ref, kind } = launchable;
    const key = workKey(ref);

    if (kind === "claim") {
      logClaim(this.log, key);
      // The swap ready→claimed is one composite write: removing the ready
      // label is what keeps a concurrent sweep from ever seeing the work.
      await tracker.claim(ref, config.workerGhAccount, config.labels.ready);
      // The registry dir exists from the reservation on — a crash after the
      // claim (before any worker) is still a visible, reconcilable fact.
      mkdirSync(workDir(workspace, ref.repo, ref.number), { recursive: true });
    } else if (kind === "resume") {
      this.log(`resuming ${key}: a human answered after the marker — blocked→claimed on the tracker`);
      await tracker.resumeClaim(ref, config.labels.blocked, config.labels.claimed);
      // The rejection's retomada: the SAME PR is reopened, never a new one.
      if (launchable.pr !== null && launchable.pr.state === "closed") {
        await tracker.reopenPr(ref);
      }
    } else {
      this.log(`feedback round for ${key}: the claim is already held — same branch, same PR`);
    }

    // Git host (ticket 15): clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await this.serializePrepare(ref.repo, () => git.prepareWork(ref));
    this.log(
      `launching worker for ${key} (branch ${prepared.branch}, ` +
        `${prepared.branchCreated ? "created" : "reused"} from base ${prepared.baseBranch})`,
    );

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
    const result = await runtime.launch({
      ref,
      workDir: dir,
      branch: prepared.branch,
      repoDir: prepared.repoDir,
      baseBranch: prepared.baseBranch,
      attempt: facts.attempt,
    });
    this.launched.push(result);

    try {
      await this.collect(launchable, result, dir, facts.attempt, facts.previousFall);
    } finally {
      // The slot is released even when the collection's transition fails —
      // the work stays reconcilable by the next derivation (the claim or its
      // swap is already on the tracker; a failed write leaves it auditable).
      this.slots.release(key);
      this.discardFromCacheAndParked(key);
      this.fillSlots();
      this.notifyWorkerEnded();
    }
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
    const prConfirmed =
      feedback.known && feedback.value.pr !== null && feedback.value.pr.state === "open";
    const issue = await tracker.readIssue(ref);
    const record = await readOutcomeRecord(dir);
    const ruling = classifyOutcome({
      record,
      prOpen: prConfirmed,
      blockedLabelOnIssue:
        issue.known && issue.value.labels.includes(config.labels.blocked),
      consecutiveFall,
      attempt,
      issueClosed: issue.known && issue.value.state === "closed",
    });

    if (ruling.decision === "done") {
      // The terminal state was reached while this claim was held (the
      // human's merge closed the issue mid-flight — ticket 14): archive the
      // artifacts and clean the branches, nothing is released or recorded.
      this.log(`collected ${key}: issue closed — done; artifacts archived, branches cleaned`);
      await this.finishWork(ref);
    } else if (ruling.decision === "reserve") {
      this.log(`collected ${key}: PR open — stays reserved, waiting for the human`);
    } else if (ruling.decision === "record-only") {
      this.log(`collected ${key}: blocked self-report — the factory only records the outcome`);
    } else if (ruling.decision === "release") {
      this.log(
        `collected ${key}: fall without PR — release (claimed→ready back; ` +
          "the branch stays, the next sweep picks it up)",
      );
      await tracker.releaseClaim(ref, config.workerGhAccount, config.labels.ready);
    } else {
      this.log(`collected ${key}: 2nd consecutive fall — blocked, the exact outcome goes to the issue`);
      await tracker.blockClaim(ref, config.labels.claimed, config.labels.blocked);
      await tracker.comment(ref, ruling.comment);
    }
    this.collected.push({
      ref,
      result,
      prConfirmed,
      ruling: { decision: ruling.decision, because: ruling.because },
    });
  }

  /** The done duties on real disk and real git: archive the work's artifacts
   * (trabalhos/ → arquivo/, nothing deleted) and clean the branches. */
  private async finishWork(ref: IssueRef): Promise<void> {
    await archiveDoneWork(this.deps.workspace, ref);
    await this.deps.git.cleanupDoneWork(ref);
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
  const log = deps.log ?? (() => {});
  const tickMs = options.tickMs ?? TICK_MS;
  const signal = options.signal;

  await engine.deriveAndAct();
  for (const run of engine.fillSlots()) logLaunchFailure(log, run);

  for (;;) {
    const event = await engine.waitForWake(tickMs, signal);
    if (event === "abort" || signal?.aborted) break;
    if (event === "worker-end") {
      // The collection happened at the act; nothing to re-derive — the
      // human changes wait for the tick (staleness bounded by the interval).
      continue;
    }
    await engine.deriveAndAct();
    for (const run of engine.fillSlots()) logLaunchFailure(log, run);
  }
  log("factory ended cleanly (human act)");
}