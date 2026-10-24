import type { Config, ModelProviderBudget, RecoveryBudget } from "../config.js";
import { workDirOfKey, type WorkspaceLayout } from "../layout.js";
import {
  readLastAttempt,
  scanRegistry,
  type AttemptWithoutOwnOutcome,
  type RegistryView,
} from "../pool/registry.js";
import type { OpenTicket, SiteTicketTracker, TicketSelection, TicketTracker } from "../tracker/expanded-port.js";
import {
  githubSelections,
  repositoryIdentityKey,
  ticketIdentityKey,
  workIdentity,
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
  /** An unreadable selection on this site names another destination, so this
   *  candidate's overlap with it cannot be ruled out. */
  unverified: boolean;
}

/** A ticket the configured selections promise to more than one destination: its
 *  destination is ambiguous, so it is held with the reason and is never
 *  presented as a candidate (spec #92 story 8; issue 129). */
export interface AmbiguousJiraTicket extends JiraTicketFacts {
  ticket: TicketIdentity;
  /** The destinations the conflicting readable selections name. */
  destinations: RepositoryIdentity[];
  /** An unreadable selection on this site names a further destination, so the
   *  conflict itself is not verified. */
  unverified: boolean;
}

/** One configured selection's read, kept for diagnosis: a site's ordered set is
 *  the candidates, while this says whether each selector contributed. */
export type JiraSelectionView =
  | { selection: TicketSelection; state: "known"; selected: number; held: number }
  | { selection: TicketSelection; state: "unknown"; reason: string };

/** One Jira site's candidates: ONE native Rank order across all its selections,
 *  never one queue per destination or per declared repository (issue 129). */
export type JiraSiteView =
  | {
      site: string;
      /** Every explicitly configured destination, sorted so declaration order
       *  never changes the report. */
      destinations: RepositoryIdentity[];
      state: "known";
      selections: JiraSelectionView[];
      candidates: JiraCandidate[];
      ambiguous: AmbiguousJiraTicket[];
    }
  | {
      site: string;
      destinations: RepositoryIdentity[];
      state: "unknown";
      reason: string;
      selections: JiraSelectionView[];
      candidates: JiraCandidate[];
      ambiguous: AmbiguousJiraTicket[];
    };

/** One configured Jira selection and the read-only adapter that reads it. */
export interface JiraSelectionReader {
  selection: TicketSelection;
  tickets: SiteTicketTracker;
}

/** Where the status derivation reads from: the GitHub Issues tracker (always
 *  present — the factory verifies its GitHub identity at boot) and the Jira
 *  selections. */
export interface StatusSources {
  github: TicketTracker;
  jira?: readonly JiraSelectionReader[];
}

export interface StatusView {
  /** The pool of eligibles, derived now — never a cache (status is stateless). */
  pool: PoolEntry[];
  /** The configured Jira sites, read-only: one native Rank order per site. */
  jira: JiraSiteView[];
  /** A tracker mark with no reservation in this workspace. */
  unbackedClaims: UnbackedClaim[];
  /** A reservation on disk whose work carries no factory mark. */
  unmarkedReservations: UnmarkedReservation[];
  /** The local registry: attempts without an outcome / reserved-without-attempt / last outcomes / archived dones. */
  registry: RegistryView;
  /** Running and Orphaned, or unknown when Docker could not answer. */
  liveness: Liveness;
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
  const reservations = new Set<string>([
    ...registry.attemptsWithoutOwnOutcome.map((entry) => entry.key),
    ...registry.reservedWithoutAttempt,
    ...registry.lastOutcome.map((entry) => entry.key),
  ]);
  const selections = githubSelections(config.repos);
  const state =
    selections.length === 0
      ? emptyTrackerState()
      : await deriveTrackerState(sources.github, selections, config.labels, reservations);
  return {
    pool: state.pool,
    jira: await readJiraSites(sources.jira ?? []),
    unbackedClaims: state.unbackedClaims,
    unmarkedReservations: state.unmarkedReservations,
    registry,
    liveness: await classifyLiveness(registry, layout, probe),
    recoveryBudget: config.recovery,
    modelProviderBudget: config.modelProvider,
  };
}

/** No configured GitHub Issues repo means no GitHub Issues read. Fresh per
 *  derivation: the view hands its arrays to the caller. */
function emptyTrackerState(): TrackerState {
  return { pool: [], unbackedClaims: [], unmarkedReservations: [] };
}

/** The result of one selection's own read: its tickets, or why it is unknown. */
type SelectionRead =
  | { reader: JiraSelectionReader; state: "known"; tickets: OpenTicket[] }
  | { reader: JiraSelectionReader; state: "unknown"; reason: string };

/**
 * Every configured Jira site, grouped by site and read as ONE ordered set
 * (issue 129). Sites are sorted by name so the report never inherits the order
 * the repositories were declared in. The order inside a site comes only from
 * Jira's native Rank — never from the first-listed selector or a merged list of
 * independently ordered queues.
 */
async function readJiraSites(readers: readonly JiraSelectionReader[]): Promise<JiraSiteView[]> {
  const groups = new Map<string, JiraSelectionReader[]>();
  for (const reader of readers) {
    const site = reader.selection.source.site;
    const group = groups.get(site);
    if (group === undefined) groups.set(site, [reader]);
    else group.push(reader);
  }
  const sites = [...groups.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return Promise.all(sites.map((site) => readJiraSite(site, groups.get(site) ?? [])));
}

/** One site: its readable selections define the destinations, its one union
 *  query defines the order, and the readable membership routes each ticket. */
async function readJiraSite(site: string, readers: readonly JiraSelectionReader[]): Promise<JiraSiteView> {
  const destinations = distinctDestinations(readers.map((reader) => reader.selection.destination));
  const readings = await Promise.all(
    readers.map(async (reader): Promise<SelectionRead> => {
      try {
        return { reader, state: "known", tickets: await reader.tickets.listOpenTickets(reader.selection) };
      } catch (error) {
        return { reader, state: "unknown", reason: describeError(error) };
      }
    }),
  );
  const known = readings.filter((entry): entry is Extract<SelectionRead, { state: "known" }> => entry.state === "known");

  if (known.length === 0) {
    return {
      site,
      destinations,
      state: "unknown",
      reason: readings[0]?.state === "unknown" ? readings[0].reason : "no selection could be read",
      selections: readings.map((entry) => selectionViewOf(entry)),
      candidates: [],
      ambiguous: [],
    };
  }

  // One selection is already one complete native order. Several need Jira's
  // own union query: only the site can say how its selectors' tickets rank
  // against each other.
  let ordered: OpenTicket[];
  if (known.length === 1) {
    ordered = known[0]?.tickets ?? [];
  } else {
    const orderedRead = await readSiteOrder(known);
    if (orderedRead.state === "unknown") {
      return {
        site,
        destinations,
        state: "unknown",
        reason: orderedRead.reason,
        selections: readings.map((entry) => selectionViewOf(entry)),
        candidates: [],
        ambiguous: [],
      };
    }
    ordered = orderedRead.tickets;
  }

  const membership = ticketMemberships(known);
  const unknownDestinations = readings
    .filter((entry): entry is Extract<SelectionRead, { state: "unknown" }> => entry.state === "unknown")
    .map((entry) => entry.reader.selection.destination);
  const orderedKeys = new Set(ordered.map((ticket) => ticketIdentityKey(ticket.ticket)));
  if ([...membership.keys()].some((key) => !orderedKeys.has(key))) {
    // A selection returned a ticket the site's ordered read omitted: the two
    // reads disagree, so no reliable site order exists for that ticket.
    return {
      site,
      destinations,
      state: "unknown",
      reason: "the site's ordered result omitted a ticket a selection returned",
      selections: readings.map((entry) => selectionViewOf(entry)),
      candidates: [],
      ambiguous: [],
    };
  }

  const candidates: JiraCandidate[] = [];
  const ambiguous: AmbiguousJiraTicket[] = [];
  const heldKeys = new Set<string>();
  const seen = new Set<string>();
  for (const ticket of ordered) {
    const key = ticketIdentityKey(ticket.ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    const selected = membership.get(key);
    if (selected === undefined) continue;
    const destinationsForTicket = distinctDestinations([...selected.destinations.values()]);
    if (destinationsForTicket.length > 1) {
      heldKeys.add(key);
      ambiguous.push({
        ticket: ticket.ticket,
        title: ticket.title,
        assignees: ticket.assignees,
        destinations: destinationsForTicket,
        unverified: unknownSelectionConflicts(unknownDestinations, destinationsForTicket),
      });
      continue;
    }
    const destination = destinationsForTicket[0];
    if (destination === undefined) continue;
    candidates.push({
      work: workIdentity(ticket.ticket, destination),
      title: ticket.title,
      assignees: ticket.assignees,
      unverified: unknownSelectionConflicts(unknownDestinations, [destination]),
    });
  }

  return {
    site,
    destinations,
    state: "known",
    selections: readings.map((entry) => selectionViewOf(entry, heldKeys)),
    candidates,
    ambiguous,
  };
}

/** The site's union query, read only after its readable selections are known. */
async function readSiteOrder(
  known: readonly Extract<SelectionRead, { state: "known" }>[],
): Promise<{ state: "known"; tickets: OpenTicket[] } | { state: "unknown"; reason: string }> {
  const reader = known[0]?.reader;
  if (reader === undefined) return { state: "unknown", reason: "the site carries no readable selection" };
  try {
    return {
      state: "known",
      tickets: await reader.tickets.listSiteTickets(known.map((entry) => entry.reader.selection)),
    };
  } catch (error) {
    return { state: "unknown", reason: describeError(error) };
  }
}

interface TicketMembership {
  destinations: Map<string, RepositoryIdentity>;
}

/** Which readable selections select each ticket, by stable ticket identity. */
function ticketMemberships(
  known: readonly Extract<SelectionRead, { state: "known" }>[],
): Map<string, TicketMembership> {
  const memberships = new Map<string, TicketMembership>();
  for (const reading of known) {
    for (const ticket of reading.tickets) {
      const key = ticketIdentityKey(ticket.ticket);
      const entry = memberships.get(key) ?? { destinations: new Map<string, RepositoryIdentity>() };
      const destination = reading.reader.selection.destination;
      entry.destinations.set(repositoryIdentityKey(destination), destination);
      memberships.set(key, entry);
    }
  }
  return memberships;
}

/** One selection's report line: how many distinct tickets it selected, and how
 *  many of those are held as ambiguous. An unknown read keeps its reason. */
function selectionViewOf(reading: SelectionRead, heldKeys: ReadonlySet<string> = new Set()): JiraSelectionView {
  if (reading.state === "unknown") {
    return { selection: reading.reader.selection, state: "unknown", reason: reading.reason };
  }
  const keys = new Set(reading.tickets.map((ticket) => ticketIdentityKey(ticket.ticket)));
  return {
    selection: reading.reader.selection,
    state: "known",
    selected: keys.size,
    held: [...keys].filter((key) => heldKeys.has(key)).length,
  };
}

/** The configured destinations as one deterministic list: declaration order is
 *  never a routing fact. */
function distinctDestinations(destinations: readonly RepositoryIdentity[]): RepositoryIdentity[] {
  const byKey = new Map<string, RepositoryIdentity>();
  for (const destination of destinations) byKey.set(repositoryIdentityKey(destination), destination);
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, destination]) => destination);
}

/** Does an unreadable selection name a destination outside `known`? If so, an
 *  overlap with it cannot be ruled out (never an empty conflict list). */
function unknownSelectionConflicts(
  unknown: readonly RepositoryIdentity[],
  known: readonly RepositoryIdentity[],
): boolean {
  return unknown.some(
    (destination) =>
      !known.some(
        (candidate) => repositoryIdentityKey(candidate) === repositoryIdentityKey(destination),
      ),
  );
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
      attempt: await readLastAttempt(workDirOfKey(layout, worker.key)),
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
