import type { Config } from "./config.js";
import type { TrackerPort } from "./tracker/port.js";
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
 * IO in tracker/ + pool/ + runtime/ (ticket 07).
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

export interface SweepResult {
  pool: PoolEntry[];
  launched: SessionResult[];
}

/**
 * One sweep with the --once boundary: derive the pool through the port,
 * claim and launch up to `y` workers, wait for every one, exit.
 * With an empty pool: no worker is launched and the process ends clean.
 */
export async function runOnce(deps: LoopDeps): Promise<SweepResult> {
  const { config, tracker, runtime, git, workspace } = deps;
  const log = deps.log ?? (() => {});

  // Derivation — the stateless re-read of the tracker.
  const pool = await derivePool(tracker, config.repos, config.labels);
  log(`derived pool: ${pool.length} eligible work(s)`);
  if (pool.length === 0) {
    log("idle: empty pool — no worker launched");
    return { pool: [], launched: [] };
  }

  // Launches — claims by age, up to the y slots.
  const slots = new Slots(config.concurrency);
  const launched: SessionResult[] = [];
  for (const entry of pool) {
    if (slots.full) break;
    const key = `${entry.ref.repo}#${entry.ref.number}`;
    if (!slots.tryAcquire(key)) continue;
    log(`claiming ${key}`);
    await tracker.claim(entry.ref, config.workerGhAccount);

    // Git host (ticket 15): clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await git.prepareWork(entry.ref);
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
    slots.release(key);
    log(`collected ${key}: outcome ${result.outcome}`);
  }

  return { pool, launched };
}

/**
 * The continuous run: the idle factory keeps sweeping on the fixed tick
 * forever — ending it is a human act (Ctrl-C). Thin on purpose: the same
 * one-sweep body, woken again by the clock.
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
