import {
  renderUnbackedClaim,
  renderUnmarkedReservation,
} from "./derive.js";
import { renderWorkKey } from "../pool/work-key.js";
import { renderWorkIdentity, renderTicketIdentity, renderRepositoryIdentity } from "../tracker/identity.js";
import { MAX_REPAIR_FALLS, MAX_REPAIR_ROUNDS } from "../pool/repair.js";
import { formatDuration } from "../format.js";
import { renderWaits } from "../pool/waits.js";
import { describePublication, renderLocalWork } from "./repair-view.js";
import type { RepairViewEntry } from "../pool/registry.js";
import { knownAttempt } from "../work-record/continuity.js";
import type { WorkEvidence } from "../work-record/evidence.js";
import type {
  AmbiguousJiraTicket,
  JiraCandidate,
  JiraSelectionView,
  JiraSiteView,
  KnownJiraSiteView,
  OrphanedAttempt,
  ReservedWorkState,
  RunningWorker,
  StatusView,
} from "./status.js";
import type { DuplicateWorkers } from "./liveness.js";
import type { RecoveryBudget } from "../config.js";
import type { RecoveryDecision } from "../pool/recovery.js";
import type { PauseRecord } from "../work-record/continuity.js";
import type { RepairTrigger, WorkStateReading } from "../work-state/state.js";
import { FIRST_WINDOW_SIZE } from "../retro/window.js";

/**
 * The rendering half of `msf status`: the human view, one line per
 * answer in the order a human asks for them, with every list capped and an
 * omission marker past the cap. Pure view → string: no reads, no writes.
 */

/** How many entries a list shows before the omission marker. `--all` lifts it. */
const LIST_CAP = 10;

/** The Docker-unreachable note: liveness is unknown, the other answers are not. */
const LIVENESS_UNKNOWN = "liveness unknown (docker not reachable)";

/** The reserved-work block's header: what the block answers, in one line. */
const RESERVED_HEADER =
  "reserved work (the state the factory acts on — every reserved Work, grouped by what happens next)";

/**
 * What the operator's next move is, per Work state — the status-only grouping.
 * One group per operator action instead of one section per registry bucket, and
 * `satisfies` makes a state the module adds fail to compile until it is placed
 * here.
 */
type ReservedGroup = "factory" | "operator" | "quiet";

/** The groups in the order an operator reads them: what moves, what waits, what rests. */
const RESERVED_GROUP_ORDER: readonly ReservedGroup[] = ["factory", "operator", "quiet"];

/** The group headings: each says what happens next, never which bucket it is. */
const RESERVED_GROUP_TITLES: Record<ReservedGroup | "unaddressed", string> = {
  factory: "the factory proceeds by itself",
  operator: "waiting for the operator",
  quiet: "nothing to decide",
  unaddressed: "not read (the registry key names no GitHub Work — its readable ticket lives in the reservation record)",
};

const RESERVED_GROUPS = {
  done: "factory",
  "done-fallback": "factory",
  rejected: "factory",
  feedback: "factory",
  repair: "factory",
  "repair-recovered": "factory",
  resumable: "factory",
  fall: "factory",
  interrupted: "factory",
  "stop-resume": "factory",
  "model-provider-failure": "factory",
  "continuity-paused": "operator",
  "stop-unconfirmed": "operator",
  "repair-blocked": "operator",
  "repair-fall-blocked": "operator",
  unreadable: "operator",
  parked: "quiet",
  "not-planned": "quiet",
} satisfies Record<WorkStateReading["state"], ReservedGroup>;

/**
 * What will happen to this reserved Work next — the state's group, with one
 * correction: an `interrupted` attempt whose recovery budget is EXHAUSTED is not
 * something the factory proceeds with. The tick blocks and asks the operator for
 * help, so the work is grouped where it waits.
 */
function reservedGroup(reading: WorkStateReading): ReservedGroup {
  if (reading.state === "interrupted" && reading.recovery.decision === "pause-help") return "operator";
  return RESERVED_GROUPS[reading.state];
}

export interface RenderOptions {
  /** `msf status --all`: lift every list cap. */
  all?: boolean;
}

export function renderStatus(view: StatusView, options: RenderOptions = {}): string {
  const cap = options.all === true ? Number.POSITIVE_INFINITY : LIST_CAP;
  const liveness = view.liveness;
  // WHICH section names a reserved work is the Work state's answer: the
  // liveness section names the interrupted ones — and only those —
  // and the block below names every other state. No hand map decides this any
  // more, so a requested stop, a model provider failure or a continuity pause
  // can never be piled into "orphaned" as an ordinary interruption.
  const interruptedKeys = new Set(
    view.reserved.filter((entry) => entry.reading.state === "interrupted").map((entry) => entry.key),
  );
  const orphaned = liveness.state === "known" ? liveness.orphaned.filter((entry) => interruptedKeys.has(entry.key)) : [];
  const lines: string[] = ["msf status (derived on demand — the factory may be stopped)"];

  lines.push(
    ...section(
      "running (worker alive)",
      liveness.state === "known" ? liveness.running.map(renderRunning) : null,
      cap,
    ),
  );

  // Multiplicity is a fact, not a rendering accident: two
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
      liveness.state === "known" ? orphaned.map((entry) => renderOrphaned(entry, view)) : null,
      cap,
    ),
  );

  lines.push(...renderReserved(view, cap, new Set(orphaned.map((entry) => entry.key))));

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

  lines.push(...renderJiraSites(view.jira, cap));

  lines.push(...section("archived (dones)", view.registry.archived, cap));

  // The retrospective job: the last report that covered a window
  // IS the marker of the next one, and a round in flight is visible even with
  // every slot busy — the lane is outside them.
  if (view.retro !== null) {
    const retro = view.retro;
    lines.push(...section(
      "retro (window reports mark the next window; items land as needs-triage)",
      [
        retro.lastReport === null
          ? `no report yet — the first round covers the last ${FIRST_WINDOW_SIZE} finished works`
          : `${retro.lastReport} — ${retro.filed} item(s) filed by the last round`,
        ...(retro.lastReport !== null && retro.boundaryAt === null
          ? ["no window boundary yet — only single-work post-mortems ran, and they never move it"]
          : []),
        ...(retro.boundaryAt === null
          ? []
          : [
              `window boundary: ${new Date(retro.boundaryAt).toISOString()} ` +
                "(newest finish the last window covered)",
            ]),
      ],
      cap,
    ));
    if (retro.inFlight !== null) {
      lines.push(...section(
        "retro in flight (outside the worker slots)",
        [
          `${retro.inFlight.round} (${retro.inFlight.manual ? "manual" : "automatic"}), started ` +
            `${new Date(retro.inFlight.startedAt).toISOString()}, window: ${retro.inFlight.window.join(", ")}`,
        ],
        cap,
      ));
    }
  }

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

/** The Jira report: one ordered set per site. A candidate count per selection
 *  would read an unreadable selector as empty and a concatenated queue as the
 *  site's Rank; the header therefore counts sites, never candidates. */
function renderJiraSites(sites: readonly JiraSiteView[], cap: number): string[] {
  if (sites.length === 0) return [];
  const lines = [
    `jira candidates (read-only — each site's selections are read as one native Rank order; ` +
      `nothing is claimed, commented or launched): ${plural(sites.length, "site")}`,
  ];
  for (const site of sites) {
    const destinations = site.destinations.map(renderRepositoryIdentity).join(", ");
    const heading = `  ${site.site} (${plural(site.selections.length, "selection")}) → ${destinations}: `;
    if (site.state === "unknown") {
      lines.push(`${heading}unknown (${site.reason})`);
      renderSelections(lines, site.selections);
      continue;
    }
    lines.push(`${heading}${describeSite(site)}`);
    renderCapped(lines, site.candidates, cap, (candidate, index) => renderCandidate(candidate, index));
    if (site.ambiguous.length > 0) {
      lines.push(`    ambiguous (more than one destination — held, no destination chosen): ${site.ambiguous.length}`);
      renderCapped(lines, site.ambiguous, cap, (entry, index) => renderAmbiguous(entry, index), "      ");
    }
    renderSelections(lines, site.selections);
  }
  return lines;
}

/** One site's ordered candidates and the tickets held out of that order. */
function describeSite(site: KnownJiraSiteView): string {
  if (site.candidates.length === 0 && site.ambiguous.length === 0) return "none";
  const facts = [plural(site.candidates.length, "candidate")];
  if (site.ambiguous.length > 0) facts.push(`${site.ambiguous.length} held as ambiguous`);
  return facts.join(", ");
}

/** One candidate: its Work (ticket source + destination), title and assignee. */
function renderCandidate(candidate: JiraCandidate, index: number): string {
  const assignee = candidate.assignees.length === 0 ? "" : ` [assignee: ${candidate.assignees.join(", ")}]`;
  return `    ${index + 1}. ${renderWorkIdentity(candidate.work)} — ${candidate.title}${assignee}${unverifiedNote(candidate.unverified)}`;
}

/** One held ticket: every conflicting destination is named, never chosen. */
function renderAmbiguous(entry: AmbiguousJiraTicket, index: number): string {
  const destinations = entry.destinations.map(renderRepositoryIdentity).join(", ");
  const assignee = entry.assignees.length === 0 ? "" : ` [assignee: ${entry.assignees.join(", ")}]`;
  return `      ${index + 1}. ${renderTicketIdentity(entry.ticket)} — ${entry.title}${assignee} → ${destinations}${unverifiedNote(entry.unverified)}`;
}

/** Each selector's contribution when a site has several. A single selector is
 *  the site line itself; an unknown selector is always named, because it may
 *  hide a destination. */
function renderSelections(lines: string[], selections: readonly JiraSelectionView[]): void {
  const several = selections.length > 1;
  for (const view of selections) {
    const destination = renderRepositoryIdentity(view.selection.destination);
    const query = view.selection.jql ?? "no JQL";
    if (view.state === "unknown") {
      lines.push(`    selection (${query}) → ${destination}: unknown (${view.reason})`);
      continue;
    }
    if (!several) continue;
    const held = view.held === 0 ? "" : `, ${view.held} held as ambiguous`;
    lines.push(`    selection (${query}) → ${destination}: ${view.selected} selected${held}`);
  }
}

/** One wording for "an unreadable selection may hide another destination". */
function unverifiedNote(unverified: boolean): string {
  return unverified ? " (unverified: another selection on this site is unknown)" : "";
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

/**
 * One continuity pause's facts: the attempt it waits for, its session and why
 * it waits. The attempt is the one the pause's launch PLANNED; when the ledger
 * evidences a different one, both are named — the divergence is the operator's
 * fact, never repaired here. A record too unreadable to name its
 * attempt says so instead of printing a fabricated `attempt 0`.
 */
function describePause(pause: PauseRecord, evidenced: number | null, sessionId: string | undefined): string {
  const facts = [
    describePauseAttempt(knownAttempt(pause.attempt), evidenced === null ? null : knownAttempt(evidenced)),
  ];
  if (sessionId !== undefined) facts.push(`session ${sessionId}`);
  return `${facts.join("; ")}: ${pause.reason} — ${pause.detail}`;
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
function renderOrphaned(orphan: OrphanedAttempt, view: StatusView): string {
  return renderInterrupted(orphan.key, orphan.attempt, orphan.recordedAttempt, [
    ...describeRecordFacts(orphan.key, view, readingOf(view, orphan.key)),
  ]);
}

/** The interrupted attempt: the current one named, the
 *  historical record disowned — a human must not read attempt 1's outcome as
 *  attempt 2's result — plus the record facts the state's payload leaves to the
 *  registry (the recoveries already spent, the repair cycle). */
function renderInterrupted(
  key: string,
  attempt: number,
  recordedAttempt: number | null,
  facts: readonly string[],
): string {
  const history =
    recordedAttempt === null
      ? "no outcome record on disk"
      : `the record on disk is attempt ${recordedAttempt}'s — history, not this attempt's`;
  return `${renderWorkKey(key)} (${[`attempt ${attempt} was interrupted — ${history}`, ...facts].join("; ")})`;
}

/**
 * The reserved-work block: every reserved Work, in the state the module the
 * engine acts on reads for it, grouped by what the operator can
 * do next. This is the status's ONLY state vocabulary — a state the module
 * declares is named here, once, and nowhere else.
 */
function renderReserved(view: StatusView, cap: number, named: ReadonlySet<string>): string[] {
  const readings = view.reserved.filter((entry) => !named.has(entry.key));
  const unaddressed = view.unaddressedReservations;
  const total = readings.length + unaddressed.length;
  if (total === 0) return [`${RESERVED_HEADER}: none`];
  const lines = [`${RESERVED_HEADER}: ${total}`];
  for (const group of RESERVED_GROUP_ORDER) {
    const entries = readings
      .filter((entry) => reservedGroup(entry.reading) === group)
      .sort((left, right) => left.key.localeCompare(right.key));
    if (entries.length === 0) continue;
    lines.push(`  ${RESERVED_GROUP_TITLES[group]}: ${entries.length}`);
    renderCapped(lines, entries, cap, (entry) => `    ${describeReserved(entry, view)}`, "    ");
  }
  if (unaddressed.length > 0) {
    lines.push(`  ${RESERVED_GROUP_TITLES.unaddressed}: ${unaddressed.length}`);
    renderCapped(
      lines,
      [...unaddressed].sort(),
      cap,
      (key) => `    ${describeUnaddressed(key, view)}`,
      "    ",
    );
  }
  return lines;
}

/** One reserved Work: the state the module reads, plus the record facts the
 *  state's payload does not carry. */
function describeReserved(entry: ReservedWorkState, view: StatusView): string {
  const facts = [describeState(entry.key, entry.reading, view), ...describeRecordFacts(entry.key, view, entry.reading)];
  return `${renderWorkIdentity(entry.reading.work)} — ${facts.join("; ")}`;
}

/** The state the module read for a reserved work, when it read one. */
function readingOf(view: StatusView, key: string): WorkStateReading | undefined {
  return view.reserved.find((entry) => entry.key === key)?.reading;
}

/**
 * The facts the STATE's payload leaves to the record — appended to whichever
 * section names the work, never a state of their own: the repair cycle (its two
 * ledgers, the unpublished attempt, the evidence paths) and, for an
 * interruption, the recoveries already spent.
 */
function describeRecordFacts(key: string, view: StatusView, reading: WorkStateReading | undefined): string[] {
  const facts: string[] = [];
  const repair = view.registry.repair.find((candidate) => candidate.key === key);
  if (repair !== undefined) facts.push(`repair cycle: ${describeRepair(repair)}`);
  if (reading?.state === "interrupted") facts.push(describeRecovery(reading.recovery, view.recoveryBudget));
  return facts;
}

/**
 * A reserved dir the state cannot be asked about — its key names no Work it may
 * read. Reported as the registry facts it is: the key (or the Work the pause's
 * own record carries, which the key cannot), plus the pause that waits for it.
 * No state is invented for a work the module never read.
 */
function describeUnaddressed(key: string, view: StatusView): string {
  const pause = view.registry.continuityPauses.find((entry) => entry.key === key);
  const facts = ["the Work state cannot address this dir (its key names no GitHub Work)"];
  // The readable ticket key the dir key cannot carry lives in the record: it is
  // named as what it is, never fabricated into the key.
  if (pause?.pause.work !== undefined) facts.push(`the record names it ${renderWorkIdentity(pause.pause.work)}`);
  if (pause !== undefined) {
    facts.push(`a continuity pause waits: ${describePause(pause.pause, pause.lastAttempt, pause.pause.sessionId)}`);
  }
  return `${renderWorkKey(key)} (${facts.join("; ")})`;
}

/**
 * One Work state, in words. The switch is exhaustive over the module's union:
 * a state that is added there fails to compile here until it is named — this is
 * the single place a state is put into words, and it never re-derives one.
 */
function describeState(key: string, reading: WorkStateReading, view: StatusView): string {
  switch (reading.state) {
    case "done":
      return "done (the ticket is closed — the factory archives the work)";
    case "done-fallback":
      return `done (PR #${reading.pr.number} merged without closing the issue — the factory closes it, then archives)`;
    case "rejected":
      return `rejected (PR #${reading.pr.number} was closed without merging — blocked with a comment pointing at the PR)`;
    case "feedback":
      return `feedback (a human commented on PR #${reading.pr.number} — a feedback round on the same branch and PR)`;
    case "repair":
      return (
        `repair (PR #${reading.pr.number} carries a confirmed impediment: ${describeRepairReasons(reading.trigger)} — ` +
        "one automatic round)"
      );
    case "repair-recovered":
      return `repair recovered (PR #${reading.pr.number} is clean again — the repair budget resets)`;
    case "repair-blocked":
      return (
        `repair blocked (PR #${reading.pr.number}: ${describeRepairReasons(reading.trigger)} — no automatic rounds left ` +
        `after ${reading.usedRounds}/${MAX_REPAIR_ROUNDS}; blocked and help asked)`
      );
    case "repair-fall-blocked":
      return (
        `repair blocked (attempt ${reading.attempt} stopped without publishing — blocked even with ` +
        `PR #${reading.pr.number} open)`
      );
    case "resumable":
      return "resumable (the human answered on the ticket — the work continues from its existing branch)";
    case "parked":
      return `parked (${describeParked(reading)})`;
    case "fall":
      return reading.decision === "release"
        ? `fall (attempt ${reading.attempt}: a written failure the factory did not rule yet — released to the pool)`
        : `fall (attempt ${reading.attempt}: a written failure the factory did not rule yet — blocked on the 2nd consecutive fall)`;
    case "interrupted":
      return `interrupted (attempt ${reading.attempt} has no outcome record of its own — no attempt consumed)`;
    case "stop-resume":
      return (
        `stop-resume (attempt ${reading.attempt}: last stop was the operator's requested stop — ` +
        "no attempt consumed and no recovery spent; it resumes on the next run)"
      );
    case "stop-unconfirmed":
      return (
        `stop-unconfirmed (attempt ${reading.attempt}: the requested stop could not be confirmed — ` +
        `${reading.because}; it will not relaunch until the previous worker is known to be gone)`
      );
    case "model-provider-failure": {
      const { modelProvider } = reading;
      const spend = `${modelProvider.consumed}/${view.modelProviderBudget.maxRetries} retries (waits ${renderWaits(view.modelProviderBudget.waitsMs)})`;
      // Awaiting is a help request — never a block.
      const outcome =
        modelProvider.decision === "awaiting-model-provider"
          ? "awaiting model provider — a help request, not a block"
          : "retrying after the model provider backoff";
      return (
        `model provider failure (attempt ${reading.attempt}: ${spend}; ` +
        `last model provider error: ${collapseWhitespace(reading.failure.message)} — ${outcome})`
      );
    }
    case "continuity-paused": {
      const pause = view.registry.continuityPauses.find((candidate) => candidate.key === key);
      // The record's own numbers: the pause's planned attempt against the one
      // the ledger evidences.
      const evidenced = pause?.lastAttempt ?? reading.attempt;
      return `continuity paused (${describePause(reading.pause, evidenced, reading.pause.sessionId)})`;
    }
    case "unreadable":
      return `unreadable (the ticket could not be read — ${reading.because}; never acted on)`;
    case "not-planned":
      return "not planned (the ticket was closed as not-planned — never acted on)";
    default: {
      const exhaustive: never = reading;
      return exhaustive;
    }
  }
}

/** Why a Work is parked: the fact that holds it, when its record has a word for it. */
function describeParked(reading: Extract<WorkStateReading, { state: "parked" }>): string {
  const reason =
    reading.because === "pr-open"
      ? "the human has the PR"
      : reading.because === "blocked-self-report"
        ? "the worker blocked itself"
        : "waiting for the human, or a released work the pool owns";
  return reading.helpRequested === true ? `${reason}; help was asked for` : reason;
}

/**
 * The interruption budget's answer for this Work: the recoveries already spent
 * and the configured backoff, or the pause that asks the operator for help. The
 * numbers are the module's own decision — status never counts a budget itself.
 */
function describeRecovery(decision: RecoveryDecision, budget: RecoveryBudget): string {
  if (decision.decision === "pause-help") {
    return (
      `${decision.consumed}/${budget.maxRecoveries} recoveries consumed — the budget is exhausted: ` +
      `the work pauses and the operator is asked (${decision.reason})`
    );
  }
  return (
    `${decision.consumed - 1}/${budget.maxRecoveries} recoveries consumed (waits ${renderWaits(budget.waitsMs)}) — ` +
    "the next interruption recovers on this budget"
  );
}

/** The confirmed impediments of a PR, as one clause. */
function describeRepairReasons(trigger: RepairTrigger): string {
  return trigger.reasons.join(", ");
}

/** The model provider's message as one status line: whitespace collapsed, never a new section. */
function collapseWhitespace(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

/**
 * One repair cycle's facts: the two ledgers, the attempt's publication, the
 * local work it preserved and the evidence the operator opens by hand (issue
 * paths always shown, workspace-relative, whatever their
 * presence). Appended to the Work's own line: a record fact, not a state.
 */
function describeRepair(entry: RepairViewEntry): string {
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
  return parts.join("; ");
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
