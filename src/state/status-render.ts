import {
  renderUnbackedClaim,
  renderUnmarkedReservation,
} from "./derive.js";
import { renderWorkKey } from "../pool/work-key.js";
import { renderWorkIdentity, renderTicketIdentity, renderRepositoryIdentity } from "../tracker/identity.js";
import { MAX_REPAIR_FALLS, MAX_REPAIR_ROUNDS } from "../pool/repair.js";
import { formatDuration } from "../format.js";
import { renderWaits, type RecoveryLedger } from "../pool/recovery.js";
import { awaitingModelProvider } from "../pool/model-provider.js";
import { describePublication, renderLocalWork } from "./repair-view.js";
import type { ContinuityPauseEntry, ModelProviderViewEntry, RepairViewEntry } from "../pool/registry.js";
import { knownAttempt } from "../work-record/continuity.js";
import type { WorkEvidence } from "./evidence.js";
import type {
  AmbiguousJiraTicket,
  JiraSelectionView,
  KnownJiraSelectionView,
  OrphanedAttempt,
  RunningWorker,
  StatusView,
} from "./status.js";
import type { DuplicateWorkers } from "./liveness.js";
import type { ModelProviderBudget, RecoveryBudget } from "../config.js";

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
  // A work whose attempt ended by a model provider failure (issue 144), by the
  // operator's requested stop (issue 146) or by a continuity pause (issue 119)
  // is NOT an interruption: the section that owns the cause already names it,
  // so it is not repeated under the liveness/interruption wording.
  const explainedKeys = new Set([
    ...view.registry.modelProvider.map((entry) => entry.key),
    ...view.registry.continuityPauses.map((entry) => entry.key),
    ...view.registry.recovery
      .filter(
        (entry) =>
          entry.ledger.lastStop?.kind === "stop-requested" ||
          entry.ledger.lastStop?.kind === "stop-unconfirmed",
      )
      .map((entry) => entry.key),
  ]);
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  lines.push(
    ...section(
      "running (worker alive)",
      liveness.state === "known" ? liveness.running.map(renderRunning) : null,
      cap,
    ),
  );

  // Multiplicity is a fact, not a rendering accident (issue 118): two
  // containers of one work are two rows above AND named here, because the
  // operator must decide — the factory neither chooses an owner nor ends one.
  lines.push(
    ...section(
      "duplicate workers (more than one container for the same work — a human decision is needed)",
      liveness.state === "known" ? liveness.duplicates.map(renderDuplicates) : null,
      cap,
    ),
  );

  lines.push(
    ...section(
      "orphaned (attempt interrupted — no outcome record of its own, no worker alive)",
      liveness.state === "known"
        ? liveness.orphaned
            .filter((entry) => !explainedKeys.has(entry.key))
            .map(renderOrphaned)
        : null,
      cap,
    ),
  );

  // Liveness unknown: the registry can still name the works whose outcome was
  // never recorded — it just cannot say which of them a worker still carries.
  if (liveness.state === "unknown" && view.registry.attemptsWithoutOwnOutcome.length > 0) {
    lines.push(
      ...section(
        "interrupted attempts without their own outcome (Running or Orphaned — only Docker can tell)",
        view.registry.attemptsWithoutOwnOutcome
          .filter((entry) => !explainedKeys.has(entry.key))
          .map((entry) => renderInterrupted(entry.key, entry.attempt, entry.recordedAttempt)),
        cap,
      ),
    );
  }

  lines.push(
    ...section(
      "reserved without attempt (the claim landed, no attempt evidence on disk)",
      view.registry.reservedWithoutAttempt.map(renderWorkKey),
      cap,
    ),
  );

  lines.push(
    ...section(
      "recovery (what ended the last stop: the operator's requested stop — confirmed or not — an interruption absorbed by its budget, or a failure that consumed the attempt)",
      view.registry.recovery.map((entry) => renderRecovery(entry.key, entry.ledger, view.recoveryBudget)),
      cap,
    ),
  );

  // The model provider's own budget (issue 144): a work whose last attempt
  // ended by a model provider failure is named here — retrying on its own
  // backoff, or awaiting the operator's help.
  lines.push(
    ...section(
      "model provider (the last attempt ended by a model provider failure — not an interruption of the agent)",
      view.registry.modelProvider.map((entry) => renderModelProvider(entry, view.modelProviderBudget)),
      cap,
    ),
  );

  // A continuity pause is neither a fall nor Docker's silence (issue 119): the
  // attempt cannot be reopened safely, the work waits for the operator, and
  // naming the reason here is what tells it apart from an ordinary reservation.
  lines.push(
    ...section(
      "continuity paused (the interrupted attempt cannot be continued safely — waiting for the operator)",
      view.registry.continuityPauses.map(renderContinuityPause),
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
        (entry) => `${renderWorkKey(entry.key)} = ${entry.record.class} (attempt ${entry.record.attempt})`,
      ),
      cap,
    ),
  );

  lines.push(...section("pool (eligible)", view.pool.map((entry) => renderWorkIdentity(entry.work)), cap));

  lines.push(...renderJiraSelections(view.jira, view.jiraAmbiguous, cap));

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

/** The header counts the selections: a candidate count would make an unreadable
 *  one read as zero. */
function renderJiraSelections(
  selections: readonly JiraSelectionView[],
  ambiguous: readonly AmbiguousJiraTicket[],
  cap: number,
): string[] {
  if (selections.length === 0) return [];
  const lines = [
    `jira candidates (read-only — each selection's JQL result in native Rank order; nothing is claimed, commented or launched): ` +
      plural(selections.length, "selection"),
  ];
  for (const view of selections) {
    const site = view.selection.source.site;
    const destination = renderRepositoryIdentity(view.selection.destination);
    if (view.state === "unknown") {
      lines.push(`  ${site} → ${destination}: unknown (${view.reason})`);
      continue;
    }
    const unverified = unverifiedNote(view.unverified);
    lines.push(`  ${site} → ${destination}: ${describeCandidates(view)}${unverified}`);
    renderCapped(lines, view.candidates, cap, (candidate, index) => {
      const assignee =
        candidate.assignees.length === 0 ? "" : ` [assignee: ${candidate.assignees.join(", ")}]`;
      return `    ${index + 1}. ${renderWorkIdentity(candidate.work)} — ${candidate.title}${assignee}`;
    });
  }
  if (ambiguous.length > 0) {
    lines.push(`  ambiguous (more than one destination — held, no destination chosen): ${ambiguous.length}`);
    renderCapped(lines, ambiguous, cap, (entry, index) => {
      const destinations = entry.destinations.map(renderRepositoryIdentity).join(", ");
      const assignee = entry.assignees.length === 0 ? "" : ` [assignee: ${entry.assignees.join(", ")}]`;
      return `    ${index + 1}. ${renderTicketIdentity(entry.ticket)} — ${entry.title}${assignee} → ${destinations}${unverifiedNote(entry.unverified)}`;
    });
  }
  return lines;
}

/** One wording for "an unreadable selection may hide another destination". */
function unverifiedNote(unverified: boolean): string {
  return unverified ? " (unverified: another selection on this site is unknown)" : "";
}

/** The per-selection counts: candidates kept, and the tickets it lost because
 *  more than one destination promises them. */
function describeCandidates(view: KnownJiraSelectionView): string {
  const notes: string[] = [];
  if (view.held > 0) notes.push(`${view.held} held as ambiguous`);
  if (view.repeated > 0) notes.push(`${view.repeated} already listed by another selection`);
  if (view.candidates.length === 0 && notes.length === 0) return "none";
  const candidates = plural(view.candidates.length, "candidate");
  return notes.length === 0 ? candidates : `${candidates}, ${notes.join(", ")}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderCapped<T>(
  lines: string[],
  entries: readonly T[],
  cap: number,
  render: (entry: T, index: number) => string,
  indent = "    ",
): void {
  const shown = entries.slice(0, cap);
  for (const [index, entry] of shown.entries()) lines.push(render(entry, index));
  if (entries.length > shown.length) {
    lines.push(`${indent}… and ${entries.length - shown.length} more`);
  }
}

/** One live worker: the work, how long it has run, which attempt it carries
 *  and which container — the container is the identity duplicates are read by. */
function renderRunning(worker: RunningWorker): string {
  const attempt = worker.attempt === null ? "" : `, attempt ${worker.attempt}`;
  return `${renderWorkKey(worker.key)} (${formatDuration(worker.ageMs)}${attempt}, container ${shortId(worker.containerId)})`;
}

/** One persisted continuity pause: the work, the attempt it waits for, its
 *  session and why it waits. The attempt is the one the pause's launch PLANNED;
 *  when the ledger evidences a different one, both are named — the divergence
 *  is the operator's fact, never repaired here (issue 175). A record too
 *  unreadable to name its attempt or its work says so instead of printing a
 *  fabricated `attempt 0` or an identity it does not carry.
 */
function renderContinuityPause(entry: ContinuityPauseEntry): string {
  const work = entry.pause.work === undefined ? renderWorkKey(entry.key) : renderWorkIdentity(entry.pause.work);
  const facts = [describePauseAttempt(knownAttempt(entry.pause.attempt), knownAttempt(entry.lastAttempt))];
  if (entry.pause.sessionId !== undefined) facts.push(`session ${entry.pause.sessionId}`);
  return `${work} (${facts.join("; ")}: ${entry.pause.reason} — ${entry.pause.detail})`;
}

/** The attempt a pause waits for, against the one the ledger evidences: one
 *  number when they agree (or nothing is evidenced), both when the launch
 *  planned an attempt the runtime never got to write. */
function describePauseAttempt(planned: number | null, evidenced: number | null): string {
  if (planned === null) return "attempt unknown";
  if (evidenced === null || evidenced === planned) return `attempt ${planned}`;
  return `planned attempt ${planned}; last evidenced attempt ${evidenced}`;
}

/** The duplicate anomaly: the count per work, with no owner chosen. */
function renderDuplicates(entry: DuplicateWorkers): string {
  return `${renderWorkKey(entry.key)} — ${entry.containers} containers carry this work; nothing was chosen or ended automatically`;
}

/** The container id short enough to read: Docker's own 12-character form. */
function shortId(containerId: string): string {
  return containerId.slice(0, 12);
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
  return `${renderWorkKey(key)} (attempt ${attempt} was interrupted — ${history})`;
}

/**
 * One work's interruption budget: what it cost and what ended the last stop.
 * An interruption names the recoveries spent and the configured backoff; the
 * operator's requested stop says it cost nothing; an unconfirmed one carries
 * the reason the work is held; a failure names only the outcome class that
 * consumed the attempt.
 */
function renderRecovery(key: string, ledger: RecoveryLedger, budget: RecoveryBudget): string {
  const label = renderWorkKey(key);
  const spend = `${ledger.consumed}/${budget.maxRecoveries} recoveries (waits ${renderWaits(budget.waitsMs)})`;
  const attempt = `attempt ${ledger.attempt}`;
  const last = ledger.lastStop;
  if (last === null) return `${label} (${attempt}: ${spend}; no stop settled yet)`;
  if (last.kind === "interruption") {
    return `${label} (${attempt}: last stop was an interruption — no attempt consumed; ${spend})`;
  }
  if (last.kind === "stop-requested") {
    return `${label} (${attempt}: last stop was the operator's requested stop — no attempt consumed and no recovery spent; it resumes on the next run)`;
  }
  if (last.kind === "stop-unconfirmed") {
    return `${label} (${attempt}: the requested stop could not be confirmed — ${last.because}; it will not relaunch until the previous worker is known to be gone)`;
  }
  return `${label} (${attempt}: last stop was a failure (${last.outcome}) — the attempt was consumed)`;
}

/**
 * One work's model provider failure budget: the retries spent, the provider's
 * own last message and whether the work is retrying or awaiting the operator.
 * Awaiting is a help request — the work is not blocked.
 */
function renderModelProvider(entry: ModelProviderViewEntry, budget: ModelProviderBudget): string {
  const { last } = entry;
  const spend = `${entry.ledger.consumed}/${budget.maxRetries} retries (waits ${renderWaits(budget.waitsMs)})`;
  const state = awaitingModelProvider(entry.ledger, entry.attempt, budget)
    ? "awaiting model provider — a help request, not a block"
    : "retrying after the model provider backoff";
  return (
    `${renderWorkKey(entry.key)} (attempt ${entry.attempt}: ${spend}; ` +
    `last model provider error: ${collapseWhitespace(last.message)} — ${state})`
  );
}

/** The model provider's message as one status line: whitespace collapsed, never a new section. */
function collapseWhitespace(message: string): string {
  return message.replace(/\s+/g, " ").trim();
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
  return `${renderWorkKey(entry.key)} (${parts.join("; ")})`;
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
  const lines = [`${title}: ${entries.length}`];
  renderCapped(lines, entries, cap, (entry) => `  ${entry}`, "  ");
  return lines;
}
