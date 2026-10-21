import {
  renderUnbackedClaim,
  renderUnmarkedReservation,
  workKey,
} from "./derive.js";
import { MAX_REPAIR_FALLS, MAX_REPAIR_ROUNDS } from "../pool/repair.js";
import { renderWaits, type RecoveryLedger } from "../pool/recovery.js";
import { describePublication, renderLocalWork } from "./repair-view.js";
import type { RepairViewEntry } from "../pool/registry.js";
import type { WorkEvidence } from "./evidence.js";
import type { OrphanedAttempt, RunningWorker, StatusView } from "./status.js";
import type { RecoveryBudget } from "../config.js";

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
  const liveness = view.liveness;
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  lines.push(
    ...section(
      "running (worker alive)",
      liveness.state === "known" ? liveness.running.map(renderRunning) : null,
      cap,
    ),
  );

  lines.push(
    ...section(
      "orphaned (attempt interrupted — no outcome record of its own, no worker alive)",
      liveness.state === "known" ? liveness.orphaned.map(renderOrphaned) : null,
      cap,
    ),
  );

  // Liveness unknown: the registry can still name the works whose outcome was
  // never recorded — it just cannot say which of them a worker still carries.
  if (liveness.state === "unknown" && view.registry.attemptsWithoutOwnOutcome.length > 0) {
    lines.push(
      ...section(
        "interrupted attempts without their own outcome (Running or Orphaned — only Docker can tell)",
        view.registry.attemptsWithoutOwnOutcome.map((entry) =>
          renderInterrupted(entry.key, entry.attempt, entry.recordedAttempt),
        ),
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
      "recovery (interruptions absorbed by their own budget — separate from the attempts)",
      view.registry.recovery.map((entry) => renderRecovery(entry.key, entry.ledger, view.recoveryBudget)),
      cap,
    ),
  );

  lines.push(
    ...section(
      "repair (unpublished attempts, local work, pending reconciliation)",
      view.registry.repair.map(renderRepair),
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

  lines.push(
    ...section(
      "reconciliation",
      [
        ...view.unbackedClaims.map(renderUnbackedClaim),
        ...view.unmarkedReservations.map(renderUnmarkedReservation),
      ],
      cap,
    ),
  );

  return lines.join("\n");
}

/** One live worker: the work, how long it has run, which attempt it carries. */
function renderRunning(worker: RunningWorker): string {
  const attempt = worker.attempt === null ? "" : `, attempt ${worker.attempt}`;
  return `${worker.key} (${formatAge(worker.ageMs)}${attempt})`;
}

/** One interrupted attempt: the attempt itself, and the record that is NOT its own. */
function renderOrphaned(orphan: OrphanedAttempt): string {
  return renderInterrupted(orphan.key, orphan.attempt, orphan.recordedAttempt);
}

/** The interrupted attempt (issues 112/123): the current one named, the
 *  historical record disowned — a human must not read attempt 1's outcome as
 *  attempt 2's result. */
function renderInterrupted(key: string, attempt: number, recordedAttempt: number | null): string {
  const history =
    recordedAttempt === null
      ? "no outcome record on disk"
      : `the record on disk is attempt ${recordedAttempt}'s — history, not this attempt's`;
  return `${key} (attempt ${attempt} was interrupted — ${history})`;
}

/**
 * One work's interruption budget: what it cost and what ended the last stop.
 * An interruption names the recoveries spent and the configured backoff; a
 * failure names only the outcome class that consumed the attempt.
 */
function renderRecovery(key: string, ledger: RecoveryLedger, budget: RecoveryBudget): string {
  const spend = `${ledger.consumed}/${budget.maxRecoveries} recoveries (waits ${renderWaits(budget.waitsMs)})`;
  const attempt = `attempt ${ledger.attempt}`;
  const last = ledger.lastStop;
  if (last === null) return `${key} (${attempt}: ${spend}; no stop settled yet)`;
  if (last.kind === "interruption") {
    return `${key} (${attempt}: last stop was an interruption — no attempt consumed; ${spend})`;
  }
  return `${key} (${attempt}: last stop was a failure (${last.outcome}) — the attempt was consumed)`;
}

/**
 * One repair cycle: the two ledgers, the attempt's publication, the local work
 * it preserved and the evidence the operator opens by hand (issue 112, story
 * 32 — paths always shown, workspace-relative, whatever their presence).
 */
function renderRepair(entry: RepairViewEntry): string {
  const { cycle, evidence } = entry;
  const parts = [
    `rounds ${cycle.usedRounds}/${MAX_REPAIR_ROUNDS}`,
    `falls ${cycle.consecutiveFalls}/${MAX_REPAIR_FALLS}`,
  ];
  if (cycle.attempt !== null) {
    parts.push(`attempt ${cycle.attempt.attempt}: ${describePublication(cycle.attempt.publication)}`);
    parts.push(`local work: ${renderLocalWork(cycle.attempt.localWork)}`);
  }
  if (evidence !== null) parts.push(`evidence: ${renderEvidence(evidence)}`);
  return `${entry.key} (${parts.join("; ")})`;
}

/** The three evidence locations in one clause: path, then what the probe said. */
function renderEvidence(evidence: WorkEvidence): string {
  return [
    `reservation ${evidence.workDir.path} ${evidence.workDir.presence}`,
    `event log ${evidence.eventLog.path} ${evidence.eventLog.presence}`,
    `sandcastle log ${evidence.sandcastleLog.path} ${evidence.sandcastleLog.presence}`,
  ].join(", ");
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
