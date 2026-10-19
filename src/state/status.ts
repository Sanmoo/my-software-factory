import { join } from "node:path";

import type { Config } from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import { readLastAttempt, scanRegistry, type RegistryView } from "../pool/registry.js";
import type { TrackerPort } from "../tracker/port.js";
import { WORKER_IMAGE } from "../worker-image.js";
import {
  deriveTrackerState,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  workKey,
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
 * the overlap is honest, never fused into a third state. No IPC: the per-work
 * artifacts are the interface, and status writes NOTHING.
 *
 * Issue 100: the SAME single derivation returns the pool and the
 * reconciliation (unbacked claim, unmarked reservation) from one open-issues
 * read per repo.
 */

/** A work a live worker is carrying right now. */
export interface RunningWorker {
  /** "<repo>#<number>" — the key the registry uses for the work dir. */
  key: string;
  /** Milliseconds since the container started — how long the worker has run. */
  ageMs: number;
  /** The attempt in flight, numbered by the registry (the per-attempt logs). */
  attempt: number;
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
      // The registry dir is the mount's source; the key is its relative path.
      attempt: await readLastAttempt(join(layout.works, worker.key)),
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

/** The render cap: a list past it is cut with the omission marker. `--all` lifts it. */
export const LIST_CAP = 10;

export interface RenderOptions {
  /** Lift every list cap (`msf status --all`). */
  all?: boolean;
}

/** The Docker-unreachable note: liveness is unknown, the other answers are not. */
export const LIVENESS_UNKNOWN = "liveness unknown (docker not reachable)";

/** The human view: one line per answer, in the order a human asks for them. */
export function renderStatus(view: StatusView, options: RenderOptions = {}): string {
  const cap = options.all === true ? Number.POSITIVE_INFINITY : LIST_CAP;
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  lines.push(
    ...section(
      "running (a live worker carries the work)",
      view.running === null ? null : view.running.map((worker) => `${worker.key} (${formatAge(worker.ageMs)}, attempt ${worker.attempt})`),
      cap,
    ),
  );

  lines.push(
    ...section(
      "orphaned (attempt ended with no outcome record and no worker alive — the next sweep reconciles)",
      view.running === null ? null : view.orphaned,
      cap,
    ),
  );

  lines.push(
    ...section(
      "reserved without attempt (the claim landed, no attempt evidence on disk)",
      view.registry.reservedWithoutAttempt,
      cap,
    ),
  );

  lines.push(
    ...section(
      "last outcome",
      view.registry.lastOutcome.map(
        (entry) => `${entry.key} = ${entry.record.class} (attempt ${entry.record.attempt})`,
      ),
      cap,
    ),
  );

  lines.push(...section("pool (eligible)", view.pool.map((entry) => workKey(entry.ref)), cap));

  lines.push(...section("archived (dones)", view.registry.archived, cap));

  if (view.unbackedClaims.length === 0 && view.unmarkedReservations.length === 0) {
    lines.push("reconciliation: none");
  } else {
    for (const claim of view.unbackedClaims) lines.push(renderUnbackedClaim(claim));
    for (const reservation of view.unmarkedReservations) {
      lines.push(renderUnmarkedReservation(reservation));
    }
  }

  return lines.join("\n");
}

/**
 * One section: a header with the count, one entry per line, and — past the cap
 * — a marker saying how many were omitted. A null list is the unknown
 * liveness: the section says so instead of claiming nothing.
 */
function section(title: string, entries: readonly string[] | null, cap: number): string[] {
  if (entries === null) return [`${title}: ${LIVENESS_UNKNOWN}`];
  if (entries.length === 0) return [`${title}: none`];
  const shown = entries.slice(0, cap);
  const lines = [`${title}: ${entries.length}`, ...shown.map((entry) => `  ${entry}`)];
  if (entries.length > shown.length) lines.push(`  … and ${entries.length - shown.length} more`);
  return lines;
}

/** The worker's age, coarse enough to read at a glance: 40s, 13m, 2h5m. */
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return `${Math.floor(ageMs / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
