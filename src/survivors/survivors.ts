import type { Launchable } from "../launch/launch.js";
import type { Notification } from "../notify/port.js";
import type { LivenessObservation, LivenessProbe } from "../state/liveness.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { openSurvivorLedger } from "./ledger.js";

/**
 * The liveness and the survivor ledger (epic #198, ticket #206): **which worker
 * carries each Work** right now, and the occurrences of that observation the
 * cycle must announce EXACTLY once — never once per tick.
 *
 * Two readings of one answer live here because they are one fact, and the
 * factory's whole conduct differs between them:
 *
 * - **Liveness unknown** — Docker did not answer (a failure, a timeout, an
 *   answer it cannot name). Nothing may be decided: launches are suspended,
 *   and no Attempt, recovery or Block is spent. The suspension is announced
 *   once and closed once, when the reads resume.
 * - **The decided zero** — Docker answered and nobody carries the Work. The
 *   cycle acts on it: the Work is not running, and everything that presumes a
 *   stopped worker may proceed.
 *
 * The module is OBSERVATION. It recognises a survivor, watches its activity,
 * announces a duplicate, holds a live container whose reservation names no Work
 * this composition can address, and reconciles the end of a survivor — the reads
 * and what they report. It never launches, holds, recovers, blocks, archives or
 * ends anything: those are the engine's decisions over what is reported here.
 * Capacity is the engine's too: the module answers with the live workforce
 * ({@link Survivors.observation}), and the engine counts the slots it may take.
 *
 * The ledger is process-local on purpose: a restart re-reads the same facts
 * from Docker, and the Work whose exit is confirmed is reconciled from disk and
 * tracker by the ordinary ruler.
 */

/** The worker carrying a Work right now — one entry per live container, so two
 *  containers of one Work stay two carriers (the duplicate anomaly). */
export interface Carrier {
  /** The container that carries it — the identity two containers never share. */
  containerId: string;
  /** Milliseconds since the container started. */
  ageMs: number;
  /**
   * This process's own admission, a survivor it recognised, or neither — a live
   * container this process did not launch and the ledger did not adopt: its
   * reservation names no Work this composition can serve (held, and said once),
   * and it occupies a slot nothing is launched over.
   */
  role: "launch" | "survivor" | "held";
}

/** A reserved Work as the ledger needs it: the Work the reservation names, and
 *  where the attempt evidence of it lives. Nothing else crosses. */
export interface ReservedWork {
  key: string;
  work: WorkIdentity;
  dir: string;
}

/** A reservation the engine holds: it names no Work this composition can
 *  address, and the reason — the reason is part of the occurrence's identity,
 *  so a change of cause is said again and a steady one is not. */
export interface ReservationHold {
  key: string;
  reason: string;
}

/**
 * The engine's side of what this module settles: the two duties that STAY in the
 * cycle because they write, or because they own the operator's channel.
 */
export interface SurvivorCycle {
  /**
   * The end of a survivor, ruled by the ordinary ruler over the attempt's own
   * artifacts and the current tracker — never the in-memory launch this process
   * never had, and never an older attempt's outcome. Resolves with the attempt
   * the SAME end continues (an interruption to recover), or null.
   */
  ended(launchable: Launchable, attempt: number): Promise<Launchable | null>;
  /** Deliver an occurrence to the operator (absent = silent). */
  notice(notification: Notification): Promise<void>;
}

/** What the module is opened with, once. */
export interface SurvivorsDeps {
  /** Docker, read-only. The composition supplies the real probe; a test a fake. */
  probe: LivenessProbe;
  /** The bound of one query; a hung Docker call is unknown, never a stall. */
  probeTimeoutMs?: number;
  /** The cycle's clock; a test injects one to reach deadlines without waiting. */
  now: () => number;
  log: (message: string) => void;
  /** The continuous Docker silence owed a notice (the configured threshold). */
  unavailableWarnMs: number;
  /** The silence a survivor is owed a warning for; the runtime's own limit. */
  idleLimitMs?: number;
  cycle: SurvivorCycle;
}

/** The module as a caller receives it. */
export interface Survivors {
  /**
   * Ask Docker now and read the cycle's liveness. The episode's ONE announcement
   * and its ONE closing happen here. `local` is what this process holds an
   * admission for right now: a container of one of those works is a launch, not
   * a survivor.
   */
  observe(local: ReadonlySet<string>): Promise<void>;
  /** The latest answer, unedited — the engine's capacity decision input. */
  observation(): LivenessObservation;
  /** A reliable answer: launches, and every decision that presumes a worker
   *  stopped, may proceed. */
  isKnown(): boolean;
  /** Which worker carries each Work right now. An unreadable answer carries
   *  nobody, and that empty map is the unknown — never the decided zero. */
  carriers(): ReadonlyMap<string, readonly Carrier[]>;
  /** Whether a worker carries this Work right now (the launch and the
   *  continuity decisions ask exactly this). */
  carries(key: string): boolean;
  /** The works a RECOGNISED survivor carries — the executions a previous
   *  process launched and this one adopted (the stop's view of what it must
   *  never orphan). A container this process launched is not here. */
  survivorKeys(): ReadonlySet<string>;
  /**
   * Recognise the workers a reliable probe shows and this process did not
   * launch, watch the activity of each, announce the duplicates, and settle the
   * survivors a reliable probe no longer shows. Returns the works settled by an
   * exit: the derivation must not decide them a second time.
   */
  reconcile(reservations: ReadonlyMap<string, ReservedWork>): Promise<ReadonlySet<string>>;
  /** The continuations the settled survivors' ends asked for, taken once by the
   *  next derivation. */
  takeRecoveries(): Launchable[];
  /** Say the reservations that name no Work once per appearance — and again
   *  only when the reason changes. */
  reportHolds(held: readonly ReservationHold[]): void;
}

export function openSurvivors(deps: SurvivorsDeps): Survivors {
  return openSurvivorLedger(deps);
}
