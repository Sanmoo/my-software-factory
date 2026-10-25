import type { Config, ModelProviderBudget, RecoveryBudget } from "../config.js";
import { workDirOfKey, type WorkspaceLayout } from "../layout.js";
import {
  scanRegistry,
  type AttemptWithoutOwnOutcome,
  type RegistryView,
} from "../pool/registry.js";
import { readLastAttempt } from "../work-record/attempts.js";
import type { PullRequestTracker, TicketSelection, TicketTracker } from "../tracker/expanded-port.js";
import { workOfKey } from "../pool/work-key.js";
import { openWorkState, type WorkStateReading } from "../work-state/state.js";
import {
  githubSelections,
  repositoryIdentityKey,
  ticketIdentityKey,
  workIdentity,
  workIdentityKey,
  type RepositoryIdentity,
  type TicketIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";
import { describeError } from "../format.js";
import {
  deriveTrackerState,
  type PoolEntry,
  type TrackerState,
  type UnbackedClaim,
  type UnmarkedReservation,
} from "./derive.js";
import {
  duplicateWorkers,
  probeLiveness,
  type DuplicateWorkers,
  type LivenessProbe,
  type LiveWorker,
} from "./liveness.js";

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
 * artifacts are the interface — including the interruption-recovery ledger,
 * which says whether the last stop consumed a recovery or a failure (issue
 * 123).
 *
 * Issue 100: the SAME single derivation returns the pool and the
 * reconciliation (unbacked claim, unmarked reservation) from one open-issues
 * read per repo.
 *
 * Issue 118: the liveness facts are read and interpreted ONCE, by the same
 * functions the operational cycle uses (probeLiveness, duplicateWorkers), so
 * status and the operation never disagree about the same Docker answer.
 */

/** A work a live worker is carrying right now: the container's facts + the attempt. */
export interface RunningWorker extends LiveWorker {
  /** The attempt the registry numbers on disk, or null when its dir is gone. */
  attempt: number | null;
}

/** An interrupted attempt as the status names it (issues 112/123): the
 *  registry's own fact, under the status vocabulary — the attempt with no
 *  record of its own, and the attempt the record on disk belongs to (history,
 *  never its result). */
export type OrphanedAttempt = AttemptWithoutOwnOutcome;

/** What the probe could say: the live workers, or that it could not tell. */
export type Liveness =
  | { state: "unknown" }
  | {
      state: "known";
      /** One row per container: two workers of one work are two rows. */
      running: RunningWorker[];
      /** The works carried by more than one container (issue 118). */
      duplicates: DuplicateWorkers[];
      orphaned: OrphanedAttempt[];
    };

/** What the status presents about a selected ticket: its title and who owns it. */
export interface JiraTicketFacts {
  title: string;
  assignees: string[];
}

/** One Jira candidate: the Work the ticket names, its title and its assignee(s).
 *  A candidate is NOT a reservation: nothing is claimed, commented or launched. */
export interface JiraCandidate extends JiraTicketFacts {
  work: WorkIdentity;
}

/** A ticket the configured selections promise to more than one destination: its
 *  destination is ambiguous, so it is held with the reason and is never
 *  presented as a candidate (issue 128; spec #92 story 8). */
export interface AmbiguousJiraTicket extends JiraTicketFacts {
  ticket: TicketIdentity;
  /** The destinations the conflicting readable selections name. */
  destinations: RepositoryIdentity[];
  /** An unreadable selection on this site names a further destination, so the
   *  conflict itself is not verified. */
  unverified: boolean;
}

/** One configured Jira selection and the read-only adapter that reads it. */
export interface JiraSelectionReader {
  selection: TicketSelection;
  tickets: TicketTracker;
}

/**
 * The GitHub adapter: it serves BOTH ports — the ticket facts and the PR facts —
 * through the one identity the factory verifies at boot. `msf status` reads the
 * Work state through it (ticket #204), so the reserved works are described in
 * the vocabulary the engine acts on, from the same facts.
 */
export type StatusGitHub = TicketTracker & PullRequestTracker;

/** One reserved Work with the state the module reads for it (ticket #204):
 *  what happened to it, and what the factory may do now. The key is the dir's
 *  own name — the identity anchor, never reconstructed from configuration. */
export interface ReservedWorkState {
  key: string;
  reading: WorkStateReading;
}

/** Where the status derivation reads from: the GitHub Issues tracker (always
 *  present — the factory verifies its GitHub identity at boot) and the Jira
 *  selections. */
export interface StatusSources {
  github: StatusGitHub;
  jira?: readonly JiraSelectionReader[];
}

/**
 * One selection's candidates, or that the selection could not be read (unknown
 * — never an empty selection). The candidates keep Jira's native Rank order.
 */
export type JiraSelectionView =
  | {
      selection: TicketSelection;
      state: "known";
      candidates: JiraCandidate[];
      /** Candidates removed because more than one destination promises them. */
      held: number;
      /** Candidates already listed by another selection for this same destination. */
      repeated: number;
      /** An unreadable selection on this site names a different destination, so
       *  an overlap with these candidates cannot be ruled out. */
      unverified: boolean;
    }
  | { selection: TicketSelection; state: "unknown"; reason: string };

export type KnownJiraSelectionView = Extract<JiraSelectionView, { state: "known" }>;

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** The configured Jira selections, read-only: candidates in native Rank order. */
  jira: JiraSelectionView[];
  /** Tickets more than one selection claims for a different destination: held. */
  jiraAmbiguous: AmbiguousJiraTicket[];
  /** A tracker mark with no reservation in this workspace. */
  unbackedClaims: UnbackedClaim[];
  /** A reservation on disk whose work carries no factory mark. */
  unmarkedReservations: UnmarkedReservation[];
  /** The local registry: attempts without an outcome / reserved-without-attempt / last outcomes / archived dones. */
  registry: RegistryView;
  /** Running and Orphaned, or unknown when Docker could not answer. */
  liveness: Liveness;
  /** The state of every reserved Work, as the module the engine acts on reads
   *  it (ticket #204) — the renderer names no state of its own. */
  reserved: ReservedWorkState[];
  /** Reserved dirs the state cannot be asked about: their registry key names no
   *  Work it may read (a Jira dir keeps its readable ticket key in the
   *  reservation record). They are reported as the registry facts they are; no
   *  state is invented for them. */
  unaddressedReservations: string[];
  /** The configured interruption budget, so the view can name what it costs. */
  recoveryBudget: RecoveryBudget;
  /** The configured model provider budget (issue 144). */
  modelProviderBudget: ModelProviderBudget;
}

/**
 * The status derivation. The probe is the seam tests replace: the caller passes
 * the real read-only Docker probe over this workspace, and only a test passes
 * another one — never a CLI flag.
 */
export async function deriveStatus(
  sources: StatusSources,
  config: Config,
  layout: WorkspaceLayout,
  probe: LivenessProbe,
): Promise<StatusView> {
  const registry = await scanRegistry(layout);
  // The reservations this workspace holds: every dir still under trabalhos/.
  // The same list answers the pool's "is this issue already reserved" and the
  // Work state's "what is this Work's state now" — one read of the disk.
  const reservedKeys = [
    ...registry.attemptsWithoutOwnOutcome.map((entry) => entry.key),
    ...registry.reservedWithoutAttempt,
    ...registry.lastOutcome.map((entry) => entry.key),
  ];
  const reservations = new Set<string>(reservedKeys);
  const selections = githubSelections(config.repos);
  const tracker =
    selections.length === 0
      ? emptyTrackerState()
      : await deriveTrackerState(sources.github, selections, config.labels, reservations);
  const jira = holdAmbiguousTickets(await readJiraCandidates(sources.jira ?? []));
  // The liveness answer comes FIRST: what a live worker carries is in flight,
  // and the Work state is asked with that set — the very reading the engine
  // acts on. The probe stays exactly what it was (ADR 0002): a read.
  const liveness = await classifyLiveness(registry, layout, probe);
  const reserved = await readReservedStates(sources.github, config, layout, liveness, reservedKeys);
  return {
    pool: tracker.pool,
    jira: jira.selections,
    jiraAmbiguous: jira.ambiguous,
    unbackedClaims: tracker.unbackedClaims,
    unmarkedReservations: tracker.unmarkedReservations,
    registry,
    liveness,
    reserved: reserved.reserved,
    unaddressedReservations: reserved.unaddressedReservations,
    recoveryBudget: config.recovery,
    modelProviderBudget: config.modelProvider,
  };
}

/**
 * The state of every reserved Work, read by the module the engine acts on
 * (ticket #204). This is the ONE reading status makes of "what happened to this
 * Work, and what may the factory do now": the renderer names no state of its
 * own, and cannot describe a world the engine is not acting on.
 *
 * Nothing here writes — a reading claims nothing, comments nothing, blocks
 * nothing and archives nothing (ADR 0002) — and nothing here ensures the
 * workspace: an absent work dir is an empty record, not a creation.
 *
 * A work a live worker carries is skipped, exactly as the tick skips it: the
 * running/duplicate sections already own it, and the module is opened with the
 * same in-flight set the engine uses (a running worker is its own state).
 */
async function readReservedStates(
  github: StatusGitHub,
  config: Config,
  layout: WorkspaceLayout,
  liveness: Liveness,
  keys: readonly string[],
): Promise<{ reserved: ReservedWorkState[]; unaddressedReservations: string[] }> {
  const carried = new Set(liveness.state === "known" ? liveness.running.map((worker) => worker.key) : []);
  const workState = openWorkState({
    tickets: github,
    pullRequests: github,
    workspace: layout,
    labels: config.labels,
    workerAccount: config.workerGhAccount,
    recovery: config.recovery,
    modelProvider: config.modelProvider,
    inFlight: carried,
  });
  const addressable: Array<{ key: string; work: WorkIdentity }> = [];
  const unaddressedReservations: string[] = [];
  for (const key of keys) {
    if (carried.has(key)) continue;
    const work = workOfKey(key);
    // A dir key that names no Work honestly (another provider's dir: its
    // readable ticket key lives in the reservation record, not in the key) is
    // never handed to the state as a guess.
    if (work === null) unaddressedReservations.push(key);
    else addressable.push({ key, work });
  }
  const reserved = await Promise.all(
    addressable.map(async (entry): Promise<ReservedWorkState> => ({
      key: entry.key,
      reading: await workState.beforeLaunch({ work: entry.work, dir: workDirOfKey(layout, entry.key) }),
    })),
  );
  return { reserved, unaddressedReservations };
}

/** No configured GitHub Issues repo means no GitHub Issues read. Fresh per
 *  derivation: the view hands its arrays to the caller. */
function emptyTrackerState(): TrackerState {
  return { pool: [], unbackedClaims: [], unmarkedReservations: [] };
}

/**
 * Every Jira selection read independently (issue 128): one unavailable read is
 * UNKNOWN, never an empty list, and says nothing about the healthy ones.
 */
async function readJiraCandidates(readers: readonly JiraSelectionReader[]): Promise<JiraSelectionView[]> {
  return Promise.all(
    readers.map(async (reader): Promise<JiraSelectionView> => {
      try {
        const listed = await reader.tickets.listOpenTickets(reader.selection);
        return {
          selection: reader.selection,
          state: "known",
          candidates: listed.map((entry) => ({
            work: workIdentity(entry.ticket, reader.selection.destination),
            title: entry.title,
            assignees: entry.assignees,
          })),
          held: 0,
          repeated: 0,
          unverified: false,
        };
      } catch (error) {
        return { selection: reader.selection, state: "unknown", reason: describeError(error) };
      }
    }),
  );
}

/** The read selections plus the tickets they agree cannot be given a destination. */
interface JiraHold {
  selections: JiraSelectionView[];
  ambiguous: AmbiguousJiraTicket[];
}

/**
 * A ticket two readable selections promise to different destinations has no
 * explicit destination (spec #92 story 8): it is held with the reason instead
 * of being listed once per selection — the operator resolves the overlap in
 * the selections. The same Work selected by several selections is listed once.
 * An UNKNOWN sibling naming a different destination may hide a conflict; the
 * readable selection still lists, and says the overlap is unverified.
 */
function holdAmbiguousTickets(views: JiraSelectionView[]): JiraHold {
  interface SelectedTicket {
    ticket: TicketIdentity;
    facts: JiraTicketFacts;
    destinations: Map<string, RepositoryIdentity>;
  }
  const selected = new Map<string, SelectedTicket>();
  for (const view of views) {
    if (view.state !== "known") continue;
    for (const candidate of view.candidates) {
      const key = ticketIdentityKey(candidate.work.ticket);
      const entry = selected.get(key) ?? {
        ticket: candidate.work.ticket,
        facts: { title: candidate.title, assignees: candidate.assignees },
        destinations: new Map<string, RepositoryIdentity>(),
      };
      entry.destinations.set(repositoryIdentityKey(candidate.work.destination), candidate.work.destination);
      selected.set(key, entry);
    }
  }

  const heldKeys = new Set<string>();
  const ambiguous: AmbiguousJiraTicket[] = [];
  for (const [key, entry] of selected) {
    if (entry.destinations.size < 2) continue;
    heldKeys.add(key);
    const destinations = [...entry.destinations.values()];
    ambiguous.push({
      ticket: entry.ticket,
      ...entry.facts,
      destinations,
      unverified: unknownSelectionConflicts(views, entry.ticket.site, destinations),
    });
  }

  // The same Work (ticket + destination) selected by several selections is one
  // candidate, so it is listed once.
  const listed = new Set<string>();
  const selections = views.map((view): JiraSelectionView => {
    if (view.state !== "known") return view;
    const candidates: JiraCandidate[] = [];
    let held = 0;
    let repeated = 0;
    for (const candidate of view.candidates) {
      if (heldKeys.has(ticketIdentityKey(candidate.work.ticket))) {
        held += 1;
      } else if (listed.has(workIdentityKey(candidate.work))) {
        repeated += 1;
      } else {
        listed.add(workIdentityKey(candidate.work));
        candidates.push(candidate);
      }
    }
    return {
      ...view,
      candidates,
      held,
      repeated,
      unverified: unknownSelectionConflicts(views, view.selection.source.site, [view.selection.destination]),
    };
  });
  return { selections, ambiguous };
}

/** Does an unreadable selection on `site` name a destination outside `known`?
 *  If so, a conflict with it may exist and cannot be verified. */
function unknownSelectionConflicts(
  views: readonly JiraSelectionView[],
  site: string,
  known: readonly RepositoryIdentity[],
): boolean {
  return views.some(
    (view) =>
      view.state === "unknown" &&
      view.selection.source.site === site &&
      !known.some(
        (destination) => repositoryIdentityKey(destination) === repositoryIdentityKey(view.selection.destination),
      ),
  );
}

/** The attempt the Work record numbers on disk, or null when nothing does. */
async function recordAttempt(workDir: string): Promise<number | null> {
  return readLastAttempt(workDir);
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
  const observation = await probeLiveness(probe);
  if (observation.state === "unknown") return { state: "unknown" };

  const running = await Promise.all(
    observation.workers.map(async (worker) => ({
      ...worker,
      attempt: await recordAttempt(workDirOfKey(layout, worker.key)),
    })),
  );
  const carried = new Set(running.map((worker) => worker.key));
  const paused = new Set(registry.continuityPauses.map((entry) => entry.key));
  return {
    state: "known",
    running,
    duplicates: duplicateWorkers(observation.workers),
    // A work whose attempt waits for the operator is not "orphaned, awaiting
    // the factory's next reconciliation" (issue 119): it has its own section.
    orphaned: registry.attemptsWithoutOwnOutcome.filter((entry) => !carried.has(entry.key) && !paused.has(entry.key)),
  };
}
