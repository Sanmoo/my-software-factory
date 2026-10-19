import type { Config } from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import { readLastAttempt, scanRegistry, workDirOfKey, type RegistryView } from "../pool/registry.js";
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
 * Orphaned (attempt evidence, no outcome record, no live worker — an abrupt
 * fall awaiting the next reconciliation). A work whose outcome is already
 * written while its worker still runs appears in running AND in last outcomes:
 * the overlap is honest, never fused into a third state. Without Docker the
 * liveness is unknown (named, never guessed) and the registry-only view stays
 * complete. No IPC: the per-work artifacts are the interface, and status
 * writes NOTHING.
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

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** A tracker mark with no reservation in this workspace. */
  unbackedClaims: UnbackedClaim[];
  /** A reservation on disk whose work carries no factory mark. */
  unmarkedReservations: UnmarkedReservation[];
  /** The local registry: attempts without an outcome / reserved-without-attempt / last outcomes / archived dones. */
  registry: RegistryView;
  /** The live workers; null when Docker is unreachable — liveness unknown, not zero. */
  running: RunningWorker[] | null;
  /** Attempt evidence with no outcome record and no live worker. */
  orphaned: string[];
}

export async function deriveStatus(
  tracker: TrackerPort,
  config: Config,
  layout: WorkspaceLayout,
  probe: LivenessProbe = dockerWorkerProbe({ image: WORKER_IMAGE, worksRoot: layout.works }),
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
  const { running, orphaned } = await classifyLiveness(registry, layout, probe);
  return {
    pool: state.pool,
    unbackedClaims: state.unbackedClaims,
    unmarkedReservations: state.unmarkedReservations,
    registry,
    running,
    orphaned,
  };
}

/**
 * The two states, from the registry and the probe together (issue 102): a work
 * whose attempt is on disk is Running when a live worker carries it, Orphaned
 * when nothing does. A bare reservation is neither — no attempt ended, so it
 * stays its own line. An unreachable probe answers "unknown", never "none".
 */
async function classifyLiveness(
  registry: RegistryView,
  layout: WorkspaceLayout,
  probe: LivenessProbe,
): Promise<{ running: RunningWorker[] | null; orphaned: string[] }> {
  const live = await probeOrNull(probe);
  // Docker absent or unreachable: unknown, never "none" — and a work cannot be
  // called orphaned without knowing that no worker carries it.
  if (live === null) return { running: null, orphaned: [] };

  const running = await Promise.all(
    live.map(async (worker) => ({
      ...worker,
      attempt: await readLastAttempt(workDirOfKey(layout.works, worker.key)),
    })),
  );
  const carried = new Set(running.map((worker) => worker.key));
  return { running, orphaned: registry.attemptsWithoutOutcome.filter((key) => !carried.has(key)) };
}

/** The probe's answer, or null when it cannot answer at all. */
async function probeOrNull(probe: LivenessProbe): Promise<LiveWorker[] | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}
