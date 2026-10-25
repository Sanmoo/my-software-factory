import type { Launchable } from "../launch/launch.js";
import type { PullRequestTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { OperationalClass } from "../work-state/state.js";
import { openVerdict } from "./verdict.js";
import { openWrites, type WorkWrites, type WriteDeps } from "./writes.js";
import type { AppliedRuling } from "./ruling.js";

/**
 * The collection (epic #198, ticket #208): what the factory DOES with an
 * Attempt that ended, and with the verdict that end asks for.
 *
 * One module owns the second reading of the Work state applied — the tracker
 * and disk verbs it triggers included: archive the work, close the issue with
 * the fallback comment, comment, release the claim, block the claim, persist the
 * written failure, persist the PR association, clear the continuity pause,
 * consume the stop request and deliver the occurrence notice. The caller hands
 * the {@link Launchable} that was launched and the end it collected (its dir,
 * its number, who ended it), and receives the attempt the SAME admission
 * continues — or null — plus the decided state as the operator's report names
 * it.
 *
 * What stays with the engine is the cycle and nothing of this domain: the tick,
 * capacity, admission, the slot and the decision of what to launch. Every write
 * below happens exactly once and in the order the verdict asks for, so the log
 * lines, the labels and the ordering of an end are the same whatever collected
 * it — a worker of this process ({@link AttemptEnd.origin} "collected") or a
 * survivor whose exit Docker confirmed ("survivor").
 *
 * The projection in {@link CollectedEnd.ruling} is the OPERATOR's word for the
 * decided state (D5): computed once, where the decision is made, and read by
 * nobody on the decision path.
 */

/** The Attempt whose end this factory is collecting. */
export interface AttemptEnd {
  /** The dir the attempt wrote to: the engine's collected work dir, or the
   *  reservation's for a survivor — a process that never launched it. */
  dir: string;
  /** The attempt as the launch numbered it. It owns the outcome record. */
  attempt: number;
  /** Who ended the attempt. It names the actor in the operator's log, and it
   *  decides nothing: a survivor's end is reconciled by the same properties. */
  origin: "collected" | "survivor";
}

/** What applying the verdict produced. */
export interface CollectedEnd {
  /** The attempt the SAME admission continues — an interruption (issue 123), a
   *  model provider retry (issue 144) or a requested-stop resume (#146) — or
   *  null when the work needs nothing more from it. */
  next: Launchable | null;
  /** The PR of the work confirmed open through the port at collection time. */
  prConfirmed: boolean;
  /** The decided state as the report names it (a pure projection, D5). */
  ruling: AppliedRuling;
}

/**
 * The engine's side of a collection: the three facts only the cycle holds. Each
 * one is a question the collection asks and never answers for the engine.
 */
export interface CollectCycle {
  /** Record the operational class the applied verdict lands the work in
   *  (`null` = the work leaves the observed state). */
  announce(work: WorkIdentity, resulting: OperationalClass | null): void;
  /** This process is winding down on an operator's requested stop: the ended
   *  attempt is the next run's business and the stop spends no recovery. */
  stopping(): boolean;
  /** The works this process holds RIGHT NOW (its admissions and its survivors):
   *  the second reading is opened with them, so no verdict ever answers for a
   *  world that moved. */
  inFlight(): ReadonlySet<string>;
}

/** What the collection is given once: the ports, the layout, the operator's
 *  channel and the engine's side of the cycle. */
export interface CollectDeps extends WriteDeps {
  pullRequests: PullRequestTracker;
  cycle: CollectCycle;
}

/** The collection as a caller receives it: one end collected, plus the write
 *  verbs the derivation shares with it. */
export interface Collect extends WorkWrites {
  /** Collect one ended Attempt: the Work state's second reading, the verdict it
   *  asks for and every write that verdict implies. */
  attemptEnd(launchable: Launchable, end: AttemptEnd): Promise<CollectedEnd>;
}

export function openCollect(deps: CollectDeps): Collect {
  const writes = openWrites(deps);
  const verdict = openVerdict(deps, writes);
  return { ...writes, ...verdict };
}
