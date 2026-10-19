import type { Config } from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import { scanRegistry, type RegistryView } from "../pool/registry.js";
import type { TrackerPort } from "../tracker/port.js";
import {
  deriveTrackerState,
  renderUnbackedClaim,
  renderUnmarkedReservation,
  type PoolEntry,
  type UnbackedClaim,
  type UnmarkedReservation,
} from "./derive.js";

/**
 * `msf status`: derivation on demand through the port (it works with the
 * factory stopped — the tracker is the truth) plus the local registry scan
 * (ticket 07 Q7): a work dir with attempt evidence but no desfecho.json is in
 * flight (an orphan when the run is not up); a dir with no attempt evidence is
 * a bare reservation (the claim landed, the worker has not); with a desfecho,
 * the outcome of the last attempt; the archive holds the dones. No IPC: the
 * per-work artifacts are the interface.
 *
 * Issue 100: the SAME single derivation returns the pool and the two
 * leftovers (unbacked claim, unmarked reservation) — one open-issues read per
 * repo, from which the reconciliation against the workspace reservations and
 * the registry view are rendered.
 */

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** A tracker mark with no reservation in this workspace. */
  unbackedClaims: UnbackedClaim[];
  /** A reservation on disk whose work carries no factory mark. */
  unmarkedReservations: UnmarkedReservation[];
  /** The local registry: in flight / reserved-without-attempt / last outcomes / archived dones. */
  registry: RegistryView;
}

export async function deriveStatus(
  tracker: TrackerPort,
  config: Config,
  layout: WorkspaceLayout,
): Promise<StatusView> {
  const registry = await scanRegistry(layout);
  // The reservations this workspace holds: every dir still under trabalhos/.
  const reservations = new Set<string>([
    ...registry.inFlight,
    ...registry.reservedWithoutAttempt,
    ...registry.lastOutcome.map((entry) => entry.key),
  ]);
  const state = await deriveTrackerState(
    tracker,
    config.repos,
    config.labels,
    config.workerGhAccount,
    reservations,
  );
  return {
    pool: state.pool,
    unbackedClaims: state.unbackedClaims,
    unmarkedReservations: state.unmarkedReservations,
    registry,
  };
}

/** The human view: one line per answer, in the order a human asks for them. */
export function renderStatus(view: StatusView): string {
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  if (view.pool.length === 0) {
    lines.push("pool: 0 eligible — nothing waiting in the pool");
  } else {
    const refs = view.pool.map((e) => `${e.ref.repo}#${e.ref.number}`).join(", ");
    lines.push(`pool: ${view.pool.length} eligible — ${refs}`);
  }

  lines.push(
    view.registry.reservedWithoutAttempt.length === 0
      ? "reserved without recorded attempt: none"
      : `reserved without recorded attempt (the claim landed, no attempt on disk): ${view.registry.reservedWithoutAttempt.join(", ")}`,
  );

  lines.push(
    view.registry.inFlight.length === 0
      ? "in flight: none"
      : `in flight (attempt evidence on disk — orphan when the run is not up): ${view.registry.inFlight.join(", ")}`,
  );

  if (view.registry.lastOutcome.length === 0) {
    lines.push("last outcome: none");
  } else {
    for (const entry of view.registry.lastOutcome) {
      lines.push(
        `last outcome: ${entry.key} = ${entry.record.class} (attempt ${entry.record.attempt})`,
      );
    }
  }

  lines.push(
    view.registry.archived.length === 0
      ? "archived (dones): none"
      : `archived (dones): ${view.registry.archived.join(", ")}`,
  );

  if (view.unbackedClaims.length === 0 && view.unmarkedReservations.length === 0) {
    lines.push("leftovers: none");
  } else {
    for (const claim of view.unbackedClaims) lines.push(renderUnbackedClaim(claim));
    for (const reservation of view.unmarkedReservations) {
      lines.push(renderUnmarkedReservation(reservation));
    }
  }

  return lines.join("\n");
}
