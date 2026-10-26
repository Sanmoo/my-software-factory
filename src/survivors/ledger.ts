import { formatDuration } from "../format.js";
import type { Launchable } from "../launch/launch.js";
import { factoryUnavailableNotice, interventionNotice } from "../notify/port.js";
import { workOfKey } from "../pool/work-key.js";
import { DEFAULT_IDLE_LIMIT_MS } from "../runtime/activity.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  duplicateWorkers,
  probeLiveness,
  type LiveWorker,
  type LivenessObservation,
} from "../state/liveness.js";
import { readLastAttempt } from "../work-record/attempts.js";
import { readRepairCycle } from "../work-record/repair.js";
import {
  freshDuplicates,
  idleWarningDue,
  observeSurvivorActivity,
  survivorWorkKeys,
  unavailableWarningDue,
  type SurvivorRecord,
  type UnavailableEpisode,
} from "./core.js";
import type {
  Carrier,
  ReservedWork,
  ReservationHold,
  Survivors,
  SurvivorsDeps,
} from "./survivors.js";

/**
 * The liveness and the survivor ledger's implementation. The interface is
 * `survivors.ts`; this file is the depth behind it: the
 * observation, the recognition of a survivor, the activity watch, the
 * duplicates, the held container and the end of a survivor.
 *
 * Every occurrence is kept as an APPEARANCE, never as a tick: the episode's
 * announcement and closing, a recognised survivor, a survivor that vanished, a
 * duplicate and a reservation naming no Work are each said once, and the next
 * occurrence of the same fact (a new episode, a worker that came back, a reason
 * that changed) is a new appearance.
 *
 * Nothing here launches, holds, recovers, blocks, archives or ends anything. The
 * end of a survivor is READ here (its attempt evidence, its repair cycle) and
 * ruled by the engine through {@link SurvivorCycle.ended} — applying a verdict
 * writes, and writing is the cycle's.
 */
class Ledger implements Survivors {
  /** The latest probe answer — read before every decision that could replace a
   *  worker; `unknown` suspends launches instead of guessing. */
  private liveness: LivenessObservation = { state: "known", workers: [] };
  /** What this process held an admission for at the latest observation: a
   *  container of one of those works is a launch, never a survivor. */
  private local: ReadonlySet<string> = new Set();
  /** The workers a reliable probe showed and this process did not launch. */
  private readonly survivors = new Map<string, SurvivorRecord>();
  /** The continuations the settled survivors' ends asked for. */
  private recoveries: Launchable[] = [];
  /** The current Docker-unavailability episode: when it began and whether its
   *  one warning was already raised. */
  private episode: UnavailableEpisode | null = null;
  /** The works whose duplicate containers were already reported. */
  private announcedDuplicates: ReadonlySet<string> = new Set();
  /** Live containers whose reservation names no Work this composition can
   *  address: said once, and once more when the worker is gone — never a line
   *  per tick. */
  private readonly heldSurvivors = new Set<string>();
  /** The reason each held reservation was last reported: said once per
   *  appearance, re-said only when the reason changes. */
  private reportedHolds = new Map<string, string>();

  constructor(private readonly deps: SurvivorsDeps) {}

  async observe(local: ReadonlySet<string>): Promise<void> {
    this.local = local;
    const observation = await probeLiveness(
      this.deps.probe,
      this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    this.liveness = observation;
    if (observation.state === "unknown") await this.enterEpisode(observation.reason);
    else this.closeEpisode();
  }

  observation(): LivenessObservation {
    return this.liveness;
  }

  isKnown(): boolean {
    return this.liveness.state === "known";
  }

  carriers(): ReadonlyMap<string, readonly Carrier[]> {
    const carriers = new Map<string, Carrier[]>();
    // An unreadable answer carries nobody: the empty ledger IS the unknown, and
    // the engine reads `isKnown` to tell it from the decided zero.
    const workers = this.liveWorkers;
    if (workers === null) return carriers;
    for (const worker of workers) {
      const carrier: Carrier = {
        containerId: worker.containerId,
        ageMs: worker.ageMs,
        role: this.roleOf(worker.key),
      };
      const seen = carriers.get(worker.key);
      if (seen === undefined) carriers.set(worker.key, [carrier]);
      else seen.push(carrier);
    }
    return carriers;
  }

  carries(key: string): boolean {
    return this.liveWorkers?.some((worker) => worker.key === key) ?? false;
  }

  survivorKeys(): ReadonlySet<string> {
    return new Set(this.survivors.keys());
  }

  async reconcile(reservations: ReadonlyMap<string, ReservedWork>): Promise<ReadonlySet<string>> {
    const settled = new Set<string>();
    // Unknown liveness recognises nothing and settles nothing: a survivor whose
    // container the failed read cannot show has not ended — nothing is presumed.
    const workers = this.liveWorkers;
    if (workers === null) return settled;

    // Exit: a survivor a reliable probe no longer lists has ended.
    for (const [key, record] of [...this.survivors.entries()]) {
      if (this.carries(key)) continue;
      this.survivors.delete(key);
      settled.add(key);
      await this.settleExit(key, record);
    }

    const live = new Set(survivorWorkKeys(workers, this.local));

    // A held container whose worker is gone: the reservation still names no
    // Work this composition serves, so the end is said once — the slot it
    // occupied is free, the decision stays human.
    for (const key of [...this.heldSurvivors]) {
      if (live.has(key)) continue;
      this.heldSurvivors.delete(key);
      this.deps.log(
        `the held worker of ${key} is gone; its reservation still names no Work this composition can serve — ` +
          "a human must settle it",
      );
    }

    // Recognition: a work carried by a container this process did not launch.
    for (const key of live) {
      if (this.survivors.has(key)) continue;
      const reserved = reservations.get(key);
      if (reserved === undefined) {
        if (this.heldSurvivors.has(key)) continue;
        this.heldSurvivors.add(key);
        this.deps.log(
          `a live container carries ${key}, but this workspace has no reservation that names a Work this ` +
            "composition serves — it occupies a slot and no substitute is launched; the reservation needs a human",
        );
        continue;
      }
      this.heldSurvivors.delete(key);
      const { work, dir } = reserved;
      const attempt = await readLastAttempt(dir);
      this.survivors.set(key, {
        key,
        work,
        dir,
        activityStamp: null,
        lastActivityAt: this.deps.now(),
        idleWarned: false,
      });
      this.deps.log(
        `recognizing surviving worker ${key}: a live container carries it` +
          `${attempt === null ? "" : ` (attempt ${attempt})`} — its work stays reserved, it occupies a slot, ` +
          "no substitute is launched and no recovery is consumed",
      );
    }

    for (const key of [...this.survivors.keys()]) await this.watchActivity(key);

    await this.announceDuplicates(workers, reservations);
    return settled;
  }

  takeRecoveries(): Launchable[] {
    return this.recoveries.splice(0);
  }

  reportHolds(held: readonly ReservationHold[]): void {
    const next = new Map(held.map((entry) => [entry.key, entry.reason]));
    for (const [key, reason] of next) {
      if (this.reportedHolds.get(key) === reason) continue;
      this.deps.log(`reserved work ${key} ${reason}`);
    }
    this.reportedHolds = next;
  }

  /** The live workforce of a reliable answer; null while liveness is unknown. */
  private get liveWorkers(): readonly LiveWorker[] | null {
    return this.liveness.state === "known" ? this.liveness.workers : null;
  }

  /** The role of the container carrying a work: our own admission, a recognised
   *  survivor, or neither (a live container held for the human). */
  private roleOf(key: string): Carrier["role"] {
    if (this.survivors.has(key)) return "survivor";
    return this.local.has(key) ? "launch" : "held";
  }

  /**
   * The first failure diagnoses the cause; the notice fires ONCE, when the
   * configured continuous unavailability is reached, and never repeats in the
   * same episode. Nothing here asks the human for anything: a reliable answer
   * resumes the factory by itself.
   */
  private async enterEpisode(reason: string): Promise<void> {
    const now = this.deps.now();
    if (this.episode === null) {
      this.episode = { unknownSince: now, warned: false };
      this.deps.log(
        `liveness unknown (${reason}) — new launches suspended; workers, reservations and evidence preserved, ` +
          "no attempt or recovery spent",
      );
    }
    const episode = this.episode;
    const unavailableForMs = unavailableWarningDue(episode, now, this.deps.unavailableWarnMs);
    if (unavailableForMs === null) return;
    episode.warned = true;
    this.deps.log(
      `WARNING: Docker has not answered for ${formatDuration(unavailableForMs)} — the factory keeps launching nothing ` +
        "and preserves every worker and reservation; it resumes automatically when the probe answers",
    );
    await this.deps.cycle.notice(factoryUnavailableNotice(unavailableForMs));
  }

  /** A reliable answer closes the episode; launches resume without any human act. */
  private closeEpisode(): void {
    if (this.episode === null) return;
    const lasted = this.deps.now() - this.episode.unknownSince;
    this.episode = null;
    this.deps.log(
      `liveness reliable again after ${formatDuration(lasted)} — new launches resume automatically (nothing was lost)`,
    );
  }

  /**
   * Verifiable activity keeps a survivor accounted for; silence past the idle
   * limit only WARNS — never a kill, a substitute or a freed slot, and never the
   * same warning twice for the same life.
   */
  private async watchActivity(key: string): Promise<void> {
    const record = this.survivors.get(key);
    if (record === undefined) return;
    const now = this.deps.now();
    const observed = await observeSurvivorActivity(record, now);
    this.survivors.set(key, observed);
    const idleMs = idleWarningDue(observed, now, this.deps.idleLimitMs ?? DEFAULT_IDLE_LIMIT_MS);
    if (idleMs === null) return;
    this.survivors.set(key, { ...observed, idleWarned: true });
    this.deps.log(
      `WARNING: surviving worker ${key} shows no verifiable activity for ${formatDuration(idleMs)} — ` +
        "the factory keeps its slot and launches no substitute; it does not end a worker it did not launch " +
        "(a human decision is needed)",
    );
    await this.deps.cycle.notice(interventionNotice(record.work));
  }

  /**
   * The duplicate anomaly, said once per appearance: several containers of one
   * work are several occupied slots, no new launch for that work and no owner
   * chosen or ended — the evidence stays for the human.
   */
  private async announceDuplicates(
    workers: readonly LiveWorker[],
    reservations: ReadonlyMap<string, ReservedWork>,
  ): Promise<void> {
    const { fresh, next } = freshDuplicates(this.announcedDuplicates, duplicateWorkers(workers));
    this.announcedDuplicates = next;
    for (const duplicate of fresh) {
      this.deps.log(
        `duplicate workers for ${duplicate.key}: ${duplicate.containers} containers carry the same work — ` +
          "no new launch for it, no owner chosen and nothing ended; a human decision is needed",
      );
      const work = reservations.get(duplicate.key)?.work ?? workOfKey(duplicate.key);
      if (work === null) {
        this.deps.log(
          `no intervention notice for duplicate ${duplicate.key}: this workspace has no readable reservation ` +
            "or key that names its Work (the facts above are preserved for the human)",
        );
        continue;
      }
      await this.deps.cycle.notice(interventionNotice(work));
    }
  }

  /**
   * A survivor's exit, confirmed by a reliable probe: the engine rules it over
   * the attempt's own artifacts and the current tracker (never the in-memory
   * launch this process never had, and never an older attempt's outcome), and
   * the continuation it asks for is queued for the next derivation.
   */
  private async settleExit(key: string, record: SurvivorRecord): Promise<void> {
    const { work, dir } = record;
    const attempt = await readLastAttempt(dir);
    if (attempt === null) {
      this.deps.log(
        `survivor ${key} ended with no attempt evidence on disk — the derivation settles the bare reservation`,
      );
      return;
    }
    // The consecutiveness is the Work state's own fact (it reads the persisted
    // ledger), so the exit is reconciled exactly like a collected end.
    const cycle = await readRepairCycle(dir);
    const repairing = cycle.attempt !== null && cycle.attempt.attempt === attempt;
    const ended: Launchable = {
      work,
      dir,
      kind: repairing ? "repair" : "claim",
      createdAt: null,
      pr: null,
    };
    this.deps.log(
      `survivor ${key} ended: attempt ${attempt} confirmed finished by a reliable probe — ` +
        `reconciling by its artifacts and the tracker${repairing ? " (the attempt was a repair round)" : ""}`,
    );
    const next = await this.deps.cycle.ended(ended, attempt);
    if (next !== null) this.recoveries.push(next);
  }
}

export function openSurvivorLedger(deps: SurvivorsDeps): Survivors {
  return new Ledger(deps);
}
