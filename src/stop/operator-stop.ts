import { existsSync } from "node:fs";

import { workDirOfKey, type WorkspaceLayout } from "../layout.js";
import { renderWorkIdentity, type WorkIdentity } from "../tracker/identity.js";
import { workKeyOf, workOfKey } from "../pool/work-key.js";
import { readLastAttempt, readLaunchFacts } from "../pool/registry.js";
import {
  confirmStopRequest,
  readRecoveryLedger,
  recordStopRequest,
  recordUnconfirmedStop,
  refundRecovery,
} from "../pool/recovery.js";
import type { LivenessObservation } from "../state/liveness.js";
import { describeError, formatDuration } from "../format.js";

/**
 * The operator's requested stop (issue #146, ADR 0008) — the whole protocol of
 * ONE execution's stop. The ordering is this module's: the evidence of the stop
 * is persisted BEFORE any worker is asked to end, the cooperative request
 * precedes the window, the second signal (or the window's end) precedes the
 * forced stop, and nothing is called stopped before a fresh read confirms that
 * no worker survives. The recovery ledger's writes stay in the pool — this
 * module sequences them.
 *
 * The sweep's reconciliation of an unconfirmed stop reads the SAME verdict
 * ({@link stopHoldReason}) over the SAME ledger, so the stop and the sweep
 * cannot hold two opinions about whether a worker of a work is still alive.
 */

/**
 * The facts of one requested stop, for the operator and for the exit status:
 * the works the deadline/second signal forced, and the works whose worker the
 * factory could NOT confirm gone (those are held on the next run).
 */
export interface StopReport {
  forced: string[];
  unconfirmed: UnconfirmedStop[];
  /** Why the liveness probe could not answer: the factory cannot say that no
   *  worker survives, and never calls a stop safe on a guess. */
  unreadBecause: string | null;
}

/** A work whose worker's end the stop could not prove, and why. */
export interface UnconfirmedStop {
  key: string;
  because: string;
}

/** The one verdict of a stop: safe only when every worker's end was confirmed
 *  and the factory could see the workspace while it concluded. */
export function stopConfirmed(report: StopReport): boolean {
  return report.unconfirmed.length === 0 && report.unreadBecause === null;
}

/**
 * One launch the stop may have to end. The sweep's in-flight launch satisfies
 * it structurally, so the stop mutates the very entry the sweep keeps: the
 * attempt it resolved and the recovery it refunded stay visible to the launch.
 */
export interface StopAdmission {
  /** The Work as the reservation names it. */
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

/** What the stop reads and writes outside its own memory. */
export interface StopDeps {
  workspace: WorkspaceLayout;
  /** The stop request to, and the forced end of, a worker this process launched. */
  runtime: {
    requestStop: (work: WorkIdentity) => void;
    forceStop: (work: WorkIdentity) => Promise<unknown>;
  };
  /** The liveness reading, taken freshly at each moment the protocol needs it
   *  (the sweep's own observation, so the stop's facts and the sweep's agree). */
  observe: () => Promise<LivenessObservation>;
  /** The survivors a previous factory process left: this process has no session
   *  to ask, so they are only waited for and then forced. */
  survivors: () => Iterable<string>;
  /** True while the sweep still carries the launch of this key. */
  isCarried: (key: string) => boolean;
  /** Resolves when every launch of this execution settled, failures included. */
  launchesSettled: () => Promise<void>;
  /** The operator's second signal: the promise the cooperative window races,
   *  and the unsubscribe the window's end owes it. */
  escalation: () => { readonly promise: Promise<void>; dispose: () => void };
  cooperativeMs: number;
  log: (message: string) => void;
}

/** The stable rendering order of a key set — presentation only, never the schedule. */
const byKey = (keys: Iterable<string>): string[] => [...keys].sort((a, b) => a.localeCompare(b));

/**
 * Why a work's end cannot be confirmed, or null when it is: an unreadable
 * probe is uncertainty, never an empty factory. The one reading the stop's
 * confirmation and the sweep's reconciliation of an unconfirmed stop share.
 */
export function stopHoldReason(observation: LivenessObservation, key: string): string | null {
  if (observation.state === "unknown") {
    return `the worker liveness could not be read (${observation.reason})`;
  }
  return observation.workers.some((worker) => worker.key === key)
    ? "a worker of this work is still alive"
    : null;
}

/**
 * Whether the operator's own requested stop owns the end of this attempt
 * (issue #146): the persisted stop-requested, or a stop-unconfirmed one whose
 * worker this invocation just confirmed gone (promoted, so the launch consumes
 * it like any other requested stop). A stop of another attempt, or a failure,
 * never answers yes.
 */
export async function operatorStoppedAttempt(dir: string, attempt: number): Promise<boolean> {
  const { lastStop } = await readRecoveryLedger(dir);
  if (lastStop === null || lastStop.attempt !== attempt) return false;
  if (lastStop.kind === "stop-unconfirmed") {
    await confirmStopRequest(dir, attempt);
    return true;
  }
  return lastStop.kind === "stop-requested";
}

/**
 * The operator's requested stop: admissions close (the caller's job — it owns
 * admission), the evidence of the stop is persisted, the workers are asked to
 * end, the cooperative window (or the escalation) is waited out, what remains
 * is forced, and the end of every worker is confirmed. The returned report says
 * what was forced and what could not be confirmed.
 */
export async function beginOperatorStop(
  admissions: readonly StopAdmission[],
  deps: StopDeps,
): Promise<StopReport> {
  const { log } = deps;
  log(
    `stop requested: no new worker is admitted; asking ${admissions.length} in-flight launch(es) to stop ` +
      `(cooperative window ${formatDuration(deps.cooperativeMs)})`,
  );
  // The workers a previous factory process left (issue 118) are the operator's
  // workers too: this process has no session to ask, so they get the same
  // window to end on their own and are forced with the rest.
  const survivors = [...deps.survivors()];
  if (survivors.length > 0) {
    log(
      `the stop also covers ${survivors.length} surviving worker(s) of a previous run (${byKey(survivors).join(", ")}) — ` +
        "they are not this process's sessions, so they are never asked, only waited for and then forced",
    );
  }

  // The evidence of the requested stop is persisted BEFORE any worker is asked
  // to end: a factory that dies inside the requested stop still lets the next
  // invocation resume the attempt without charging it. A recovery granted but
  // never launched is returned — the stop cancelled it.
  for (const admission of admissions) {
    const attempt = admission.attempt ?? (await plannedAttempt(admission));
    if (attempt === null) continue;
    admission.attempt = attempt;
    if (await settleStoppedAdmission(admission, attempt)) {
      log(
        `the recovery granted to ${renderWorkIdentity(admission.work)} is returned: ` +
          "the requested stop cancelled its relaunch",
      );
    }
  }

  // The runtime's stop request speaks the Work identity — a ticket from any
  // source and the destination are addressable without a GitHub issue number.
  for (const admission of admissions) deps.runtime.requestStop(admission.work);

  await awaitCooperativeWindow(deps);

  // Whatever still carries a work is forced now. The evidence of the stop lands
  // on a survivor's attempt BEFORE it is ended, exactly as for the launches
  // above: the next invocation resumes it instead of charging it.
  const toForce = await stopCandidates(admissions, deps);
  const own = new Set(admissions.map((admission) => workKeyOf(admission.work)));
  for (const key of toForce) if (!own.has(key)) await recordStopOf(key, deps);

  const forced: string[] = [];
  if (toForce.length > 0) {
    log(
      `the cooperative phase is over: forcing the stop of ${toForce.length} worker(s) now — ` +
        "the end of each one is still confirmed before the factory calls the stop safe",
    );
  }
  await Promise.all(
    toForce.map(async (key) => {
      const work = workOfKey(key);
      if (work === null) return undefined;
      try {
        await deps.runtime.forceStop(work);
        forced.push(key);
        log(`forced stop of ${key}: its worker is gone`);
      } catch (error) {
        log(`forcing ${key} failed: ${describeError(error)}`);
      }
      return undefined;
    }),
  );

  const { unconfirmed, observation } = await confirmStop(admissions, deps);
  const unreadBecause = observation.state === "unknown" ? observation.reason : null;
  if (unreadBecause !== null) {
    log(
      `stop NOT confirmed: the worker liveness could not be read (${unreadBecause}) — the factory cannot ` +
        "say that no worker survives; the next run asks the same question again",
    );
  }
  return { forced, unconfirmed, unreadBecause };
}

/** The cooperative window: until every launch settled, the window ran out, or
 *  the second signal escalated it — whichever is first. */
async function awaitCooperativeWindow(deps: StopDeps): Promise<void> {
  const escalation = deps.escalation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.cooperativeMs);
  });
  try {
    await Promise.race([deps.launchesSettled(), deadline, escalation.promise]);
  } finally {
    escalation.dispose();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Every worker this stop is answerable for, with the attempt already known when
 * the caller has it: the launches this run carried, the survivors it recognised
 * — which it knows were alive even when the probe stops answering — and
 * whatever a live container names right now. An unreadable probe cannot LOSE a
 * known worker, it only fails to add one.
 */
async function stopWorkers(
  admissions: readonly StopAdmission[],
  deps: StopDeps,
): Promise<{ workers: Map<string, number | null>; observation: LivenessObservation }> {
  const workers = new Map<string, number | null>();
  for (const admission of admissions) {
    if (admission.launched) workers.set(workKeyOf(admission.work), admission.attempt);
  }
  for (const key of deps.survivors()) if (!workers.has(key)) workers.set(key, null);
  const observation = await deps.observe();
  if (observation.state === "known") {
    for (const worker of observation.workers) if (!workers.has(worker.key)) workers.set(worker.key, null);
  }
  return { workers, observation };
}

/**
 * The works the stop has to end: every worker the stop knows about — the
 * survivors of a previous process included, which it can only end, never ask —
 * minus the launches that really ended. A launch whose end the window saw is
 * gone, and forcing it again would only race a container that is already going
 * away; one whose container the probe still names is forced.
 */
async function stopCandidates(
  admissions: readonly StopAdmission[],
  deps: StopDeps,
): Promise<string[]> {
  const { workers, observation } = await stopWorkers(admissions, deps);
  const live =
    observation.state === "known" ? new Set(observation.workers.map((worker) => worker.key)) : new Set<string>();
  for (const admission of admissions) {
    const key = workKeyOf(admission.work);
    if (deps.isCarried(key) || live.has(key)) continue;
    workers.delete(key);
  }
  return byKey(workers.keys());
}

/** Persist the operator's stop on a work the stop ends: the next invocation
 *  resumes that attempt rather than charging it a recovery. A work with no
 *  registry dir has nothing to resume. */
async function recordStopOf(key: string, deps: StopDeps): Promise<void> {
  const attempt = await lastAttemptOf(key, deps);
  if (attempt === null) return;
  await recordStopRequest(workDirOfKey(deps.workspace, key), attempt);
}

/**
 * The attempt a work is on right now, or null when the registry has no dir for
 * it. A bare reservation (a claim whose worker never wrote anything) is on
 * attempt 1 — the number its first launch would carry — so the stop is recorded
 * for it and its resume is free.
 */
async function lastAttemptOf(key: string, deps: StopDeps): Promise<number | null> {
  const dir = workDirOfKey(deps.workspace, key);
  if (!existsSync(dir)) return null;
  return (await readLastAttempt(dir)) ?? 1;
}

/**
 * The confirmation the factory never skips (issue #146): no worker of this
 * workspace may survive — neither the launches this process started nor the
 * ones it found alive (issue 118). The liveness probe answers, freshly, because
 * the workers just ended or were forced; an unreadable answer is uncertainty,
 * never an empty factory. An unconfirmed work is persisted so the next
 * invocation holds it.
 */
async function confirmStop(
  admissions: readonly StopAdmission[],
  deps: StopDeps,
): Promise<{ unconfirmed: Array<{ key: string; because: string }>; observation: LivenessObservation }> {
  const { workers: answerable, observation } = await stopWorkers(admissions, deps);

  const unconfirmed: UnconfirmedStop[] = [];
  for (const [key, knownAttempt] of answerable) {
    const because = stopHoldReason(observation, key);
    if (because === null) continue;
    unconfirmed.push({ key, because });
    const attempt = knownAttempt ?? (await lastAttemptOf(key, deps));
    if (attempt !== null) {
      await recordUnconfirmedStop(workDirOfKey(deps.workspace, key), attempt, because);
    }
    deps.log(
      `cannot confirm the stop of ${key}: ${because} — the work will not relaunch until a worker is known to be gone`,
    );
  }

  if (unconfirmed.length > 0) {
    deps.log(
      `stop NOT confirmed for ${unconfirmed.length} work(s) — the next run holds them until the worker is known gone`,
    );
  } else if (observation.state === "known" && answerable.size === 0) {
    deps.log("stop confirmed: no worker had started and none survives");
  } else if (observation.state === "known") {
    deps.log(`stop confirmed: every worker ended and none survives (${answerable.size} checked)`);
  }
  return { unconfirmed, observation };
}

/**
 * A stop cancelled this admission before any worker existed: the granted
 * recovery is returned and the requested stop is (re)recorded, so the next
 * invocation resumes the attempt for free. The grant's own event index makes it
 * idempotent — the requested stop and the admission may both reach it, and
 * neither can return an earlier, legitimate recovery. Returns whether a grant
 * was actually returned.
 */
export async function settleStoppedAdmission(admission: StopAdmission, attempt: number): Promise<boolean> {
  const grant =
    admission.recoveryIndex !== null && !admission.launched ? admission.recoveryIndex : null;
  admission.recoveryIndex = null;
  const refunded = grant === null ? false : await refundRecovery(admission.dir, attempt, grant);
  await recordStopRequest(admission.dir, attempt);
  return refunded;
}

/** Persist the operator's stop on one attempt: the evidence a cancelled
 *  admission (or a launch that failed while a stop stood) leaves behind, so the
 *  next invocation resumes the attempt instead of charging it. */
export async function recordStopEvidence(dir: string, attempt: number): Promise<void> {
  await recordStopRequest(dir, attempt);
}

/** The attempt the pending launch would use, read from the registry. A work with
 *  no registry dir left no reservation behind: nothing to reconcile, so no stop
 *  evidence is recorded for it. */
async function plannedAttempt(admission: StopAdmission): Promise<number | null> {
  if (!existsSync(admission.dir)) return null;
  try {
    const facts = await readLaunchFacts(admission.dir, admission.attemptHint);
    return facts.attempt;
  } catch {
    return null;
  }
}

/** The sweep's view of an unconfirmed stop it may now be able to promote. */
export interface UnconfirmedStopReconciliation {
  /** Works whose previous stop stays unconfirmed, with the reason to report. */
  held: Array<UnconfirmedStop & { previous: string }>;
  /** Works whose previous worker is now confirmed gone: the attempt resumes. */
  resumed: Array<{ key: string; attempt: number }>;
}

/**
 * A requested stop whose confirmation failed on a previous invocation (issue
 * #146): the work is held until a probe proves the previous worker gone, and
 * only then becomes the requested-stop resume it was meant to be. An unreadable
 * probe is uncertainty: the work stays held and no worker is launched on top of
 * it. The reading is {@link stopHoldReason}'s — the same one the stop itself
 * confirms with.
 */
export async function reconcileUnconfirmedStops(input: {
  works: readonly { dir: string; work: WorkIdentity }[];
  /** The launches this sweep carries: their attempt owns its own end. */
  inFlight: ReadonlySet<string>;
  observation: LivenessObservation;
}): Promise<UnconfirmedStopReconciliation> {
  const held: UnconfirmedStopReconciliation["held"] = [];
  const resumed: UnconfirmedStopReconciliation["resumed"] = [];
  for (const work of input.works) {
    const key = workKeyOf(work.work);
    if (input.inFlight.has(key)) continue;
    const stop = (await readRecoveryLedger(work.dir)).lastStop;
    if (stop === null || stop.kind !== "stop-unconfirmed") continue;
    const because = stopHoldReason(input.observation, key);
    if (because !== null) {
      held.push({ key, because, previous: stop.because });
      continue;
    }
    await confirmStopRequest(work.dir, stop.attempt);
    resumed.push({ key, attempt: stop.attempt });
  }
  return { held, resumed };
}
