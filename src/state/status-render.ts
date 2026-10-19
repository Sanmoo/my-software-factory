import {
  renderUnbackedClaim,
  renderUnmarkedReservation,
  workKey,
} from "./derive.js";
import type { RunningWorker, StatusView } from "./status.js";

/**
 * The rendering half of `msf status` (issue 102): the human view, one line per
 * answer in the order a human asks for them, with every list capped and an
 * omission marker past the cap. Pure view → string: no reads, no writes.
 */

/** How many entries a list shows before the omission marker. `--all` lifts it. */
const LIST_CAP = 10;

/** The Docker-unreachable note: liveness is unknown, the other answers are not. */
const LIVENESS_UNKNOWN = "liveness unknown (docker not reachable)";

export interface RenderOptions {
  /** `msf status --all`: lift every list cap. */
  all?: boolean;
}

export function renderStatus(view: StatusView, options: RenderOptions = {}): string {
  const cap = options.all === true ? Number.POSITIVE_INFINITY : LIST_CAP;
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  lines.push(
    ...section(
      "running (a live worker carries the work)",
      view.running === null ? null : view.running.map(renderRunning),
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

  // Liveness unknown: the registry can still name the works whose outcome was
  // never recorded — it just cannot say which of them a worker still carries.
  if (view.running === null && view.registry.attemptsWithoutOutcome.length > 0) {
    lines.push(
      ...section(
        "attempts without outcome (Running or Orphaned — only Docker can tell)",
        view.registry.attemptsWithoutOutcome,
        cap,
      ),
    );
  }

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

/** One live worker: the work, how long it has run, which attempt it carries. */
function renderRunning(worker: RunningWorker): string {
  const attempt = worker.attempt === null ? "" : `, attempt ${worker.attempt}`;
  return `${worker.key} (${formatAge(worker.ageMs)}${attempt})`;
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
