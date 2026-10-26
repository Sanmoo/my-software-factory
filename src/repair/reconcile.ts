import type { GitWork, LocalWorkFacts } from "../git/port.js";
import type { RemoteObservation } from "../pool/repair.js";
import { workKeyOf } from "../pool/work-key.js";
import type { PullRequestTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { inspectLocalWork, observeRemote } from "./inspect.js";
import { reconcileRepairAttempt, type RepairWork } from "./settlement.js";

export type { RepairWork };

/**
 * The Repair reconciliation: every repair attempt that
 * wrote its facts on disk and is not carried by a live worker is settled before
 * the derivation reads the cycle, so the work's state is decided over an
 * attempt whose publication is already known.
 *
 * The module was the engine's own methods and is now a domain of its own, in the
 * same shape as `collect/` and `survivors/`: this file is the interface a caller
 * receives and the factory that binds the ports; the depth — the settlement,
 * the log wording, the adoption of a legacy cycle, the round-start proof — lives
 * behind it in `settlement.ts`, and the git reads in `inspect.ts`. The VERDICTS
 * are `pool/repair-round.ts`'s, and the persisted cycle is the Work record's.
 *
 * What stays in the cycle: the tick that calls this, the requested-stop boundary
 * ({@link ReconciliationCycle}) and the launch admission. What never crosses:
 * nothing here launches, blocks, archives or releases a Work — a settlement that
 * ended an attempt only changes the repair cycle, and the derivation reads it.
 */

/**
 * The engine's side of the reconciliation — one duty, because it is the one fact
 * only the cycle owns. Whether the operator's requested stop owns the end of an
 * attempt is decided at the engine's stop boundary (which may have
 * to confirm a stop first), so the settlement asks instead of reading the
 * ledger itself.
 */
export interface ReconciliationCycle {
  operatorStopped(dir: string, attempt: number): Promise<boolean>;
}

/** What the reconciliation is given once: the ports and the operator's channel. */
export interface RepairDeps {
  /** The git host: the local work and the remote head of an attempt. */
  git: GitWork;
  /** The PR's current facts — the premise of the round. */
  pullRequests: PullRequestTracker;
  cycle: ReconciliationCycle;
  log: (message: string) => void;
}

/** The Repair reconciliation as a caller receives it. */
export interface RepairReconciler {
  /** Settle every repair attempt on disk that no live worker carries. */
  reconcile(works: readonly RepairWork[], inFlight: ReadonlySet<string>): Promise<void>;
  /** The local work of a Work, read from git — or null when git cannot answer
   *  (the launch pipeline reads it for the material of a round). */
  inspectLocalWork(work: WorkIdentity): Promise<LocalWorkFacts | null>;
  /** The remote head of a Work now, or the honest uncertainty. */
  observeRemote(work: WorkIdentity): Promise<RemoteObservation>;
}

export function openRepairReconciler(deps: RepairDeps): RepairReconciler {
  const read = {
    inspectLocalWork: (work: WorkIdentity) => inspectLocalWork(deps.git, work),
    observeRemote: (work: WorkIdentity) => observeRemote(deps.git, work),
  };
  const settlement = {
    pullRequests: deps.pullRequests,
    operatorStopped: (dir: string, attempt: number) => deps.cycle.operatorStopped(dir, attempt),
    ...read,
    log: deps.log,
  };

  return {
    ...read,
    async reconcile(works: readonly RepairWork[], inFlight: ReadonlySet<string>): Promise<void> {
      for (const work of works) {
        // A live worker owns its attempt: settling it mid-flight would read a
        // half-written branch as a verdict.
        if (inFlight.has(workKeyOf(work.work))) continue;
        await reconcileRepairAttempt(work, settlement);
      }
    },
  };
}
