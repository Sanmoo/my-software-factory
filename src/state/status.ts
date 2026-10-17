import type { Config } from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import { scanRegistry, type RegistryView } from "../pool/registry.js";
import type { TrackerPort } from "../tracker/port.js";
import { derivePool, type PoolEntry } from "./derive.js";

/**
 * `msf status`: derivation on demand through the port (it works with the
 * factory stopped — the tracker is the truth) plus the local registry scan
 * (ticket 07 Q7): a work dir without desfecho.json is in flight (an orphan
 * when the run is not up), with it the outcome of the last attempt, and the
 * archive holds the dones. No IPC: the per-work artifacts are the interface.
 */

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** The local registry: in flight / last outcomes / archived dones. */
  registry: RegistryView;
}

export async function deriveStatus(
  tracker: TrackerPort,
  config: Config,
  layout: WorkspaceLayout,
): Promise<StatusView> {
  const pool = await derivePool(tracker, config.repos, config.labels);
  const registry = await scanRegistry(layout);
  return { pool, registry };
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
    view.registry.inFlight.length === 0
      ? "in flight: none"
      : `in flight (no outcome record — orphan when the run is not up): ${view.registry.inFlight.join(", ")}`,
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

  return lines.join("\n");
}
