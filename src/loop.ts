import type { Config } from "./config.js";
import type { TrackerPort, IssueRef } from "./tracker/port.js";
import type { SessionResult, WorkerRuntime } from "./runtime/port.js";
import type { GitWork } from "./git/port.js";
import { workDir, type WorkspaceLayout } from "./layout.js";
import { derivePool, type PoolEntry } from "./state/derive.js";
import { Slots } from "./pool/slots.js";

/**
 * The loop is the general workflow and is thin: the only module that knows
 * the process is a loop — owner of time (the fixed 60 s tick), of the --once
 * boundary and of waking by event (end of worker vs tick). It interlaces the
 * four phases deciding nothing of the domain: decisions live in state/,
 * IO in tracker/ + pool/ + git/ + runtime/ (ticket 07).
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
  entry: PoolEntry;
  result: SessionResult;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
}

export interface SweepResult {
  pool: PoolEntry[];
  launched: SessionResult[];
  collected: CollectedWork[];
}

export const workKey = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

/**
 * One sweep with the --once boundary: derive the pool through the port,
 * claim and launch up to `y` workers concurrently, collect each one at the
 * act of its end and wait for every launched worker before returning.
 * With an empty pool: no worker is launched and the process ends clean.
 *
 * No barrier in the path of the works (ticket 12): the freed slot is
 * replenished in the same cycle, from the cached pool of the latest
 * derivation — a slow worker never holds the others back. The only
 * wait-for-all is the --once boundary itself.
 */
export async function runOnce(deps: LoopDeps): Promise<SweepResult> {
  const { config, tracker, runtime, git, workspace } = deps;
  const log = deps.log ?? (() => {});

  // Derivation — the stateless re-read of the tracker.
  const pool = await derivePool(tracker, config.repos, config.labels);
  log(`derived pool: ${pool.length} eligible work(s)`);
  if (pool.length === 0) {
    log("idle: empty pool — no worker launched");
    return { pool: [], launched: [], collected: [] };
  }

  // The cached pool of the latest derivation: replenishment draws from it;
  // a cache drained empty waits for the next tick (ticket 14).
  const cache = [...pool];
  const slots = new Slots(config.concurrency);
  const launched: SessionResult[] = [];
  const collected: CollectedWork[] = [];

  // Prepare (clone/fetch/branch) touches the shared clone of a repo — two
  // first-launches of the same repo must not race inside it (ticket 12
  // introduced the parallelism; the serialization stays local to prepares,
  // the launches themselves run concurrently).
  const preparing = new Map<string, Promise<void>>();
  const serializePrepare = <T>(repo: string, prepare: () => Promise<T>): Promise<T> => {
    const tail = preparing.get(repo) ?? Promise.resolve();
    const run = tail.then(prepare, prepare);
    preparing.set(
      repo,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  };

  /** Claim, launch and collect one work; replenish in the same cycle. */
  const launchAndCollect = async (entry: PoolEntry): Promise<void> => {
    const key = workKey(entry.ref);
    log(`claiming ${key} (ready → claimed on the tracker, before any launch)`);
    // The reservation lands BEFORE the launch: the ready label is swapped
    // away, so a concurrent sweep never picks the same work.
    await tracker.claim(entry.ref, config.workerGhAccount, config.labels.ready);

    // Git host (ticket 15): clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await serializePrepare(entry.ref.repo, () => git.prepareWork(entry.ref));
    log(
      `launching worker for ${key} (branch ${prepared.branch}, ` +
        `${prepared.branchCreated ? "created" : "reused"} from base ${prepared.baseBranch})`,
    );
    const result = await runtime.launch({
      ref: entry.ref,
      workDir: workDir(workspace, entry.ref.repo, entry.ref.number),
      branch: prepared.branch,
      repoDir: prepared.repoDir,
      baseBranch: prepared.baseBranch,
      attempt: 1,
    });
    launched.push(result);

    // Collection at the act: confirm the PR through the port — a structured
    // fact, never prose. With PR: the work stays reserved for the human.
    // Without PR: any end is a fall — the 1st fall releases the claim (the
    // full ruler, double fall → blocked, is ticket 13).
    const feedback = await tracker.readPrFeedback(entry.ref);
    const prConfirmed =
      feedback.known && feedback.value.pr !== null && feedback.value.pr.state === "open";
    if (prConfirmed) {
      log(`collected ${key}: PR open — stays reserved, waiting for the human`);
    } else {
      log(`collected ${key}: outcome ${result.outcome} without PR — releasing the claim`);
      await tracker.releaseClaim(entry.ref, config.workerGhAccount);
    }
    slots.release(key);
    collected.push({ entry, result, prConfirmed });

    // Replenish the freed slot in the same cycle — the act of collection
    // triggers the next claims; no barrier waits for the slowest.
    await launchNext();
  };

  /** Take every free slot from the cached pool, oldest first. */
  const launchNext = async (): Promise<void> => {
    const batch: Promise<void>[] = [];
    while (!slots.full) {
      const entry = cache.shift();
      if (entry === undefined) break;
      if (!slots.tryAcquire(workKey(entry.ref))) continue; // already in flight
      batch.push(launchAndCollect(entry));
    }
    // The --once boundary: waiting for everything launched, transitively —
    // the sweep ends only when every worker it (re)filled has ended.
    await Promise.all(batch);
  };

  await launchNext();
  return { pool, launched, collected };
}

/**
 * The continuous run: the idle factory keeps sweeping on the fixed tick
 * forever — ending it is a human act (Ctrl-C). Thin on purpose: the same
 * one-sweep body, woken again by the clock. (Ticket 14 replaces the fixed
 * sleep with the event wake: end of worker vs tick.)
 */
export async function runForever(deps: LoopDeps): Promise<never> {
  const log = deps.log ?? (() => {});
  for (;;) {
    await runOnce(deps);
    log(`sleeping ${TICK_MS}ms until the next tick`);
    await sleep(TICK_MS);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
