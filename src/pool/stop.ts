import { existsSync } from "node:fs";

import { describeError, formatDuration } from "../format.js";
import { workDirOfKey, type WorkspaceLayout } from "../layout.js";
import { deferred } from "../runtime/deferred.js";
import type { WorkerRuntime } from "../runtime/port.js";
import type { LivenessObservation } from "../state/liveness.js";
import { ownWrittenOutcome } from "../state/outcome.js";
import { COOPERATIVE_STOP_MS } from "../stop-signals.js";
import { renderWorkIdentity, type WorkIdentity } from "../tracker/identity.js";
import { readLastAttempt } from "../work-record/attempts.js";
import type { OutcomeRecord } from "../work-record/outcome.js";
import { readLaunchFacts } from "./registry.js";
import { readRecoveryLedger, type RecoveryLedger } from "../work-record/recovery.js";
import {
  confirmStopRequest,
  recordStopRequest,
  recordUnconfirmedStop,
  refundRecovery,
} from "./recovery.js";
import { workKeyOf, workOfKey } from "./work-key.js";

/**
 * The operator's requested stop of this run: admissions close, the
 * evidence of the stop is persisted before any worker is asked to end, the
 * workers get one cooperative window (or the second signal's escalation) and
 * what remains is forced before the factory calls the stop safe. A cancelled
 * admission returns the recovery it was granted; an unconfirmed end is
 * persisted so the next invocation holds the work instead of relaunching over
 * a possible worker (ADR 0008).
 *
 * The module owns that whole ordering, and the next invocation's reconciliation
 * of an unconfirmed stop re-derives it here, over the same hold rule the stop
 * applied: one reading of the persisted facts, not two. The sweep supplies only
 * the facts of the run — its in-flight launches, its survivors, the reserved
 * works to reconcile and the latest liveness observation — and calls the
 * interface; the recovery ledger remains `pool/recovery.ts`'s writer,
 * sequenced from here.
 */

/** One work whose stop the factory could not confirm: the registry key and
 *  the reason the hold rule gave. */
export interface StopHold {
  key: string;
  because: string;
}

/**
 * The facts of one requested stop, for the operator and for the exit status:
 * the works the deadline/second signal forced, and the works whose worker the
 * factory could NOT confirm gone (those are held on the next run).
 */
export interface StopReport {
  forced: string[];
  unconfirmed: StopHold[];
  /** Why the liveness probe could not answer: the factory cannot say that no
   *  worker survives, and never calls a stop safe on a guess. */
  unreadBecause: string | null;
}

/** The one verdict of a stop: safe only when every worker's end was confirmed
 *  and the factory could see the workspace while it concluded. */
export function stopConfirmed(report: StopReport): boolean {
  return report.unconfirmed.length === 0 && report.unreadBecause === null;
}

/** What one in-flight launch contributes to the stop. It is mutable because
 *  the stop resolves the attempt and consumes the recovery grant; the launch
 *  that is still running reads the same object back. */
export interface StopLaunch {
  /** The Work as the reservation names it — its source is never re-derived. */
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

/**
 * Return the recovery grant an admission still holds, if any: the grant's own
 * ledger event index is its identity, so refunding it twice is impossible and
 * an earlier, legitimate recovery can never be returned. The admission stops
 * naming the grant the moment it is released. The caller decides WHEN a grant
 * may be released — a requested stop that cancelled the admission, or the
 * runtime's own proof that no worker existed (issue 178).
 */
export async function refundHeldGrant(launch: StopLaunch, attempt: number): Promise<boolean> {
  const grant = launch.recoveryIndex;
  launch.recoveryIndex = null;
  return grant === null ? false : refundRecovery(launch.dir, attempt, grant);
}

/** The facts of the run the stop is executed against. */
export interface StopInput {
  /** The launches that may still be carrying a worker, snapshotted as the stop begins. */
  launches: readonly StopLaunch[];
  /** The works a previous process left alive — the stop can only wait for
   *  them and force them, never ask their session. Read when each phase needs
   *  it: a derivation still finishing may recognise one while the stop runs. */
  survivors: () => Iterable<string>;
  /** Whether an admission of this run still carries the work right now. A
   *  launch the cooperative window saw end is not forced a second time. */
  isInFlight: (key: string) => boolean;
  /** Resolves when every launch pending as the stop begins has settled. */
  settled: () => Promise<void>;
}

export interface StopDeps {
  /** The workspace whose registry dirs hold the persisted stop evidence. */
  workspace: WorkspaceLayout;
  /** Asking a session to end, and forcing it with Docker's confirmation. */
  runtime: Pick<WorkerRuntime, "requestStop" | "forceStop">;
  /** The live workers now, as the factory's liveness probe reads them. The
   *  engine supplies the same bounded probe (and episode bookkeeping) its
   *  sweep reads; an unreadable answer is the honest unknown, never empty. */
  probe: () => Promise<LivenessObservation>;
  log: (message: string) => void;
  /** The cooperative window; defaults to ten seconds for the whole run. */
  cooperativeMs?: number;
  /** The deadline seam; tests inject one to end (or hold) the window deterministically. */
  wait?: (ms: number) => Promise<void>;
  /** The clock the persisted evidence is stamped with; tests inject one. */
  now?: () => Date;
}

/** Presentation order for a key set — never the schedule. */
const byKey = (keys: Iterable<string>): string[] => [...keys].sort((a, b) => a.localeCompare(b));

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Why a work's end cannot be confirmed, or null when it is: an unreadable
 *  probe is uncertainty, never an empty factory. */
export function stopHoldReason(observation: LivenessObservation, key: string): string | null {
  if (observation.state === "unknown") {
    return `the worker liveness could not be read (${observation.reason})`;
  }
  return observation.workers.some((worker) => worker.key === key)
    ? "a worker of this work is still alive"
    : null;
}

/** The operator-stop fact of one attempt: no stop owns it, or the persisted
 *  requested/unconfirmed stop that does. */
export type OperatorStopClaim =
  | { kind: "none" }
  | { kind: "requested"; attempt: number }
  | { kind: "unconfirmed"; attempt: number; because: string };

export interface OperatorStopOptions {
  /** The last attempt the record numbers (0 when it numbers none). */
  lastAttempt: number;
  /** Accept the attempt after `lastAttempt` too: the derivation tolerates a
   *  stop recorded for an attempt whose log has not landed yet. The launch
   *  path knows its exact attempt and does not. */
  acceptNextAttempt?: boolean;
  /** The outcome record the caller read, when it read one: an attempt that
   *  wrote its own verdict is not resumed by a stop left over it. */
  outcome?: OutcomeRecord | null;
}

/**
 * Which attempt, if any, the persisted stop owns. The derivation
 * that resumes a stop and the launch path that consumes it ask this one
 * reading instead of comparing kinds and numbers each in its own way; the
 * tolerance for an unnumbered next attempt belongs to the caller.
 */
export function operatorStopClaim(
  ledger: RecoveryLedger,
  options: OperatorStopOptions,
): OperatorStopClaim {
  const stop = ledger.lastStop;
  if (stop === null) return { kind: "none" };
  if (stop.kind !== "stop-requested" && stop.kind !== "stop-unconfirmed") return { kind: "none" };
  const accepted =
    options.acceptNextAttempt === true
      ? stop.attempt >= Math.max(1, options.lastAttempt) && stop.attempt <= options.lastAttempt + 1
      : stop.attempt === options.lastAttempt;
  if (!accepted) return { kind: "none" };
  if (ownWrittenOutcome(options.outcome ?? null, stop.attempt) !== null) return { kind: "none" };
  return stop.kind === "stop-requested"
    ? { kind: "requested", attempt: stop.attempt }
    : { kind: "unconfirmed", attempt: stop.attempt, because: stop.because };
}

/** A reserved Work as the next invocation's reconciliation addresses it: the
 *  registry key and the dir holding its recovery ledger. */
export interface StopWorkRef {
  key: string;
  dir: string;
}

/** What the next invocation decides about a stop a previous invocation could
 *  not confirm: the attempt resumes free of charge, or the work stays held for
 *  the reason the same rule gives. */
export type UnconfirmedStopVerdict =
  | { kind: "resume"; key: string; attempt: number }
  | { kind: "hold"; key: string; because: string };

/**
 * Settle the stops a previous invocation could not confirm (ADR 0008): a worker
 * the fresh observation confirms gone promotes the persisted
 * stop to the requested-stop resume it was meant to be; a hold never
 * relaunches. The caller only presents the verdicts; the recovery write is
 * decided here.
 */
export async function reconcileUnconfirmedStops(
  works: Iterable<StopWorkRef>,
  observation: LivenessObservation,
  now: () => Date = () => new Date(),
): Promise<UnconfirmedStopVerdict[]> {
  const verdicts: UnconfirmedStopVerdict[] = [];
  for (const work of works) {
    const stop = (await readRecoveryLedger(work.dir)).lastStop;
    if (stop === null || stop.kind !== "stop-unconfirmed") continue;
    const because = stopHoldReason(observation, work.key);
    if (because !== null) {
      verdicts.push({
        kind: "hold",
        key: work.key,
        because: `${because} — the previous stop (${stop.because}) stays unconfirmed`,
      });
      continue;
    }
    await confirmStopRequest(work.dir, stop.attempt, now);
    verdicts.push({ kind: "resume", key: work.key, attempt: stop.attempt });
  }
  return verdicts;
}

/** One run's requested stop: begin it once, escalate at will, read the report. */
export class OperatorStop {
  private readonly workspace: WorkspaceLayout;
  private readonly runtime: StopDeps["runtime"];
  private readonly probe: StopDeps["probe"];
  private readonly log: (message: string) => void;
  private readonly cooperativeMs: number;
  private readonly wait: ((ms: number) => Promise<void>) | null;
  private readonly now: () => Date;
  /** Waiters of the cooperative phase — the escalation ends it at once. */
  private readonly escalationWaiters = new Set<() => void>();
  /** The second signal arrived: force what the cooperative window left. */
  private escalated = false;
  /** The one stop of this run; a second begin reads the same execution. */
  private run: Promise<StopReport> | null = null;

  constructor(deps: StopDeps) {
    this.workspace = deps.workspace;
    this.runtime = deps.runtime;
    this.probe = deps.probe;
    this.log = deps.log;
    this.cooperativeMs = deps.cooperativeMs ?? COOPERATIVE_STOP_MS;
    this.wait = deps.wait ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  /** The requested stop in progress (or finished); null before any request. */
  get report(): Promise<StopReport> | null {
    return this.run;
  }

  begin(input: StopInput): Promise<StopReport> {
    if (this.run !== null) return this.run;
    this.run = this.runStop(input.launches, input.survivors, input.isInFlight, input.settled);
    return this.run;
  }

  /** The second signal: force what the cooperative window still waits for. */
  escalate(): void {
    this.escalated = true;
    for (const fire of [...this.escalationWaiters]) fire();
    this.escalationWaiters.clear();
  }

  /**
   * A stop cancelled this admission before any worker existed: the granted
   * recovery is returned and the requested stop is (re)recorded, so the next
   * invocation resumes the attempt for free. The grant's own event index makes
   * it idempotent — the requested stop and the admission may both reach it,
   * and neither can return an earlier, legitimate recovery. Returns whether a
   * grant was actually returned.
   */
  async cancelAdmission(launch: StopLaunch, attempt: number): Promise<boolean> {
    // A stop refunds only a grant no worker may already be carrying; the grant
    // stays named, so the runtime that then proves no worker existed (issue
    // 178) still returns it through the launch's own refusal.
    const refunded = launch.launched ? false : await refundHeldGrant(launch, attempt);
    await recordStopRequest(launch.dir, attempt, this.now);
    return refunded;
  }

  private async runStop(
    launches: readonly StopLaunch[],
    survivors: () => Iterable<string>,
    isInFlight: (key: string) => boolean,
    settled: () => Promise<void>,
  ): Promise<StopReport> {
    const knownSurvivors = [...survivors()];
    this.log(
      `stop requested: no new worker is admitted; asking ${launches.length} in-flight launch(es) to stop ` +
        `(cooperative window ${formatDuration(this.cooperativeMs)})`,
    );
    // The workers a previous factory process left are the
    // operator's workers too: this process has no session to ask, so they get
    // the same window to end on their own and are forced with the rest.
    if (knownSurvivors.length > 0) {
      this.log(
        `the stop also covers ${knownSurvivors.length} surviving worker(s) of a previous run (${byKey(knownSurvivors).join(", ")}) — ` +
          "they are not this process's sessions, so they are never asked, only waited for and then forced",
      );
    }

    // The evidence of the requested stop is persisted BEFORE any worker is
    // asked to end: a factory that dies inside the requested stop still lets
    // the
    // next invocation resume the attempt without charging it. A recovery
    // granted but never launched is returned — the stop cancelled it.
    for (const entry of launches) {
      const attempt = entry.attempt ?? (await this.plannedAttempt(entry));
      if (attempt === null) continue;
      entry.attempt = attempt;
      if (await this.cancelAdmission(entry, attempt)) {
        this.log(
          `the recovery granted to ${renderWorkIdentity(entry.work)} is returned: the requested stop cancelled its relaunch`,
        );
      }
    }

    // The runtime's stop request speaks the Work identity — a ticket from any
    // source and the destination are addressable without a GitHub issue number.
    for (const entry of launches) {
      this.runtime.requestStop(entry.work);
    }

    // Whatever still carries a work is forced now. The evidence of the stop
    // lands on a survivor's attempt BEFORE it is ended, exactly as for the
    // launches below: the next invocation resumes it instead of charging it.
    await this.awaitCooperativeWindow(settled);
    const doomed = await this.stopCandidates(launches, survivors, isInFlight);
    const own = new Set(launches.map((entry) => workKeyOf(entry.work)));
    for (const key of doomed) if (!own.has(key)) await this.recordStopOf(key);

    const forced: string[] = [];
    if (doomed.length > 0) {
      this.log(
        `the cooperative phase is over: forcing the stop of ${doomed.length} worker(s) now — ` +
          "the end of each one is still confirmed before the factory calls the stop safe",
      );
    }
    await Promise.all(
      doomed.map(async (key) => {
        const work = workOfKey(key);
        if (work === null) return undefined;
        try {
          await this.runtime.forceStop(work);
          forced.push(key);
          this.log(`forced stop of ${key}: its worker is gone`);
        } catch (error) {
          this.log(`forcing ${key} failed: ${describeError(error)}`);
        }
        return undefined;
      }),
    );

    const { unconfirmed, observation } = await this.confirmStop(launches, survivors);
    const unreadBecause = observation.state === "unknown" ? observation.reason : null;
    if (unreadBecause !== null) {
      this.log(
        `stop NOT confirmed: the worker liveness could not be read (${unreadBecause}) — the factory cannot ` +
          "say that no worker survives; the next run asks the same question again",
      );
    }
    return { forced, unconfirmed, unreadBecause };
  }

  /**
   * Every worker this stop is answerable for, with the attempt
   * already known when the caller has it: the launches this run carried, the
   * survivors it recognised — which it knows were alive even when
   * the probe stops answering — and whatever a live container names right now.
   * An unreadable probe cannot LOSE a known worker, it only fails to add one.
   */
  private async stopWorkers(
    entries: readonly StopLaunch[],
    survivors: () => Iterable<string>,
  ): Promise<{ workers: Map<string, number | null>; observation: LivenessObservation }> {
    const workers = new Map<string, number | null>();
    for (const entry of entries) {
      if (entry.launched) workers.set(workKeyOf(entry.work), entry.attempt);
    }
    for (const key of survivors()) if (!workers.has(key)) workers.set(key, null);
    const observation = await this.probe();
    if (observation.state === "known") {
      for (const worker of observation.workers) if (!workers.has(worker.key)) workers.set(worker.key, null);
    }
    return { workers, observation };
  }

  /**
   * The works the stop has to end: every worker the stop knows about — the
   * survivors of a previous process included, which it can only end, never
   * ask — minus the launches that really ended. A launch whose end the window
   * saw is gone, and forcing it again would only race a container that is
   * already going away; one whose container the probe still names is forced.
   */
  private async stopCandidates(
    entries: readonly StopLaunch[],
    survivors: () => Iterable<string>,
    isInFlight: (key: string) => boolean,
  ): Promise<string[]> {
    const { workers, observation } = await this.stopWorkers(entries, survivors);
    const live =
      observation.state === "known" ? new Set(observation.workers.map((worker) => worker.key)) : EMPTY_KEYS;
    for (const entry of entries) {
      const key = workKeyOf(entry.work);
      if (isInFlight(key) || live.has(key)) continue;
      workers.delete(key);
    }
    return byKey(workers.keys());
  }

  /** Persist the operator's stop on a work the stop ends: the next
   *  invocation resumes that attempt rather than charging it a recovery. A work
   *  with no registry dir has nothing to resume. */
  private async recordStopOf(key: string): Promise<void> {
    const attempt = await this.lastAttemptOf(key);
    if (attempt === null) return;
    await recordStopRequest(workDirOfKey(this.workspace, key), attempt, this.now);
  }

  /**
   * The attempt a work is on right now, or null when the registry has no dir
   * for it. A bare reservation (a claim whose worker never wrote anything) is
   * on attempt 1 — the number its first launch would carry — so the stop is
   * recorded for it and its resume is free.
   */
  private async lastAttemptOf(key: string): Promise<number | null> {
    const dir = workDirOfKey(this.workspace, key);
    if (!existsSync(dir)) return null;
    return (await readLastAttempt(dir)) ?? 1;
  }

  /**
   * Wait out the cooperative phase: until every launch of this run settled,
   * the window ran out, or the second signal escalated it — whichever is first.
   * Callers only need the wait to be over; why it ended is the deadline's or
   * the
   * escalation's own fact, not a value to branch on.
   */
  private async awaitCooperativeWindow(settled: () => Promise<void>): Promise<void> {
    const escalation = deferred();
    if (this.escalated) escalation.resolve();
    else this.escalationWaiters.add(escalation.resolve);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      this.wait !== null
        ? this.wait(this.cooperativeMs)
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.cooperativeMs);
          });
    try {
      await Promise.race([settled(), deadline, escalation.promise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.escalationWaiters.delete(escalation.resolve);
    }
  }

  /**
   * Confirm the end of every worker this stop is answerable for, over a fresh
   * probe: the workers just ended or were forced, so the confirmation never
   * reuses the stop's own observation. An unconfirmed work is persisted, so
   * the next invocation holds it.
   */
  private async confirmStop(
    entries: readonly StopLaunch[],
    survivors: () => Iterable<string>,
  ): Promise<{ unconfirmed: StopHold[]; observation: LivenessObservation }> {
    const { workers: answerable, observation } = await this.stopWorkers(entries, survivors);

    const unconfirmed: StopHold[] = [];
    for (const [key, knownAttempt] of answerable) {
      const because = stopHoldReason(observation, key);
      if (because === null) continue;
      unconfirmed.push({ key, because });
      const attempt = knownAttempt ?? (await this.lastAttemptOf(key));
      if (attempt !== null) {
        await recordUnconfirmedStop(workDirOfKey(this.workspace, key), attempt, because, this.now);
      }
      this.log(
        `cannot confirm the stop of ${key}: ${because} — the work will not relaunch until a worker is known to be gone`,
      );
    }

    if (unconfirmed.length > 0) {
      this.log(
        `stop NOT confirmed for ${unconfirmed.length} work(s) — the next run holds them until the worker is known gone`,
      );
    } else if (observation.state === "known" && answerable.size === 0) {
      this.log("stop confirmed: no worker had started and none survives");
    } else if (observation.state === "known") {
      this.log(`stop confirmed: every worker ended and none survives (${answerable.size} checked)`);
    }
    return { unconfirmed, observation };
  }

  /** The attempt the pending launch would use, read from the registry. A work
   *  with no registry dir left no reservation behind: nothing to reconcile, so
   *  no stop evidence is recorded for it. */
  private async plannedAttempt(entry: StopLaunch): Promise<number | null> {
    if (!existsSync(entry.dir)) return null;
    try {
      const facts = await readLaunchFacts(entry.dir, entry.attemptHint);
      return facts.attempt;
    } catch {
      return null;
    }
  }
}
