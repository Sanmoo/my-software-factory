import type { Config } from "../config.js";
import { workDirOfKey, type WorkspaceLayout } from "../layout.js";
import { readLastAttempt, scanRegistry, type RegistryView } from "../pool/registry.js";
import type { TrackerPort } from "../tracker/port.js";
import { WORKER_IMAGE } from "../worker-image.js";
import {
  deriveTrackerState,
  type PoolEntry,
  type UnbackedClaim,
  type UnmarkedReservation,
} from "./derive.js";
import { dockerWorkerProbe, type LiveWorker, type LivenessProbe } from "./liveness.js";

/**
 * `msf status`: derivation on demand through the port (it works with the
 * factory stopped — the tracker is the truth) plus the local registry scan
 * (ticket 07 Q7) and the read-only Docker probe (issue 102, ADR 0002). The
 * registry knows what was written to disk; only Docker knows what is alive
 * now, so the two together say Running (a live worker carries the work) or
 * Orphaned (no outcome record, no live worker). A work whose outcome is
 * already written while its worker still runs appears in running AND in last
 * outcomes: the overlap is honest, never fused into a third state. Without
 * Docker the liveness is unknown — named, never guessed — and the
 * registry-only view stays complete. No reports are written: the per-work
 * artifacts are the interface.
 *
 * Issue 100: the SAME single derivation returns the pool and the
 * reconciliation (unbacked claim, unmarked reservation) from one open-issues
 * read per repo.
 */

/** A work a live worker is carrying right now: the container's facts + the attempt. */
export interface RunningWorker extends LiveWorker {
  /** The attempt the registry numbers on disk, or null when its dir is gone. */
  attempt: number | null;
}

/** What the probe could say: the two states, or that it could not tell. */
export type Liveness =
  | { state: "unknown" }
  | { state: "known"; running: RunningWorker[]; orphaned: string[] };

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** A tracker mark with no reservation in this workspace. */
  unbackedClaims: UnbackedClaim[];
  /** A reservation on disk whose work carries no factory mark. */
  unmarkedReservations: UnmarkedReservation[];
  /** The local registry: attempts without an outcome / reserved-without-attempt / last outcomes / archived dones. */
  registry: RegistryView;
  /** Running and Orphaned, or unknown when Docker could not answer. */
  liveness: Liveness;
}

/** The production liveness probe: the real Docker probe over this workspace. */
export function statusLivenessProbe(layout: WorkspaceLayout): LivenessProbe {
  return dockerWorkerProbe({ image: WORKER_IMAGE, worksRoot: layout.works });
}

export async function deriveStatus(
  tracker: TrackerPort,
  config: Config,
  layout: WorkspaceLayout,
  probe: LivenessProbe = statusLivenessProbe(layout),
): Promise<StatusView> {
  const registry = await scanRegistry(layout);
  // The reservations this workspace holds: every dir still under trabalhos/.
  const reservations = new Set<string>([
    ...registry.attemptsWithoutOutcome,
    ...registry.reservedWithoutAttempt,
    ...registry.lastOutcome.map((entry) => entry.key),
  ]);
  const state = await deriveTrackerState(
    tracker,
    config.repos,
    config.labels,
    reservations,
  );
  return {
    pool: state.pool,
    unbackedClaims: state.unbackedClaims,
    unmarkedReservations: state.unmarkedReservations,
    registry,
    liveness: await classifyLiveness(registry, layout, probe),
  };
}

/**
 * The two states, from the registry and the probe together (issue 102): a work
 * whose attempt is on disk is Running when a live worker carries it, Orphaned
 * when nothing does. A bare reservation is neither — no attempt ended, so it
 * stays its own line. An unreachable probe is unknown, never "none": without
 * it a work cannot be called orphaned either.
 */
async function classifyLiveness(
  registry: RegistryView,
  layout: WorkspaceLayout,
  probe: LivenessProbe,
): Promise<Liveness> {
  const live = await probeOrNull(probe);
  if (live === null) return { state: "unknown" };

  const running = await Promise.all(
    live.map(async (worker) => ({
      ...worker,
      attempt: await readLastAttempt(workDirOfKey(layout, worker.key)),
    })),
  );
  const carried = new Set(running.map((worker) => worker.key));
  return {
    state: "known",
    running,
    orphaned: registry.attemptsWithoutOutcome.filter((key) => !carried.has(key)),
  };
}

/** The probe's answer, or null when it cannot answer at all. */
async function probeOrNull(probe: LivenessProbe): Promise<LiveWorker[] | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}
