/**
 * The exclusive-acquisition experiment: two factories that both observed the
 * same Ticket free, then acquire simultaneously. The exploration is
 * exhaustive over the order of their write/verify/launch steps and over every
 * read projection the chosen model admits. The factories share no local state;
 * the tracker model is the only medium.
 *
 * Safety is the invariant "never more than one live Worker for this Ticket".
 * Progress is "at least one admitted interleaving starts one". A protocol that
 * never authorizes anybody is safe but useless; one that authorizes two is
 * unsafe even if one of them usually loses.
 */

import { FactoryInstance } from "./factory.js";
import type { TicketIdentity } from "./identity.js";
import type { ClaimProtocol } from "./protocols.js";
import { SimTracker, type CommentIdOrder, type ReadView } from "./tracker.js";
import { WorkerRegistry } from "./workers.js";

export function githubTicket(repo: string, number: number): TicketIdentity {
  return { provider: "github", site: "github.com", repo, number };
}

/** The fixture Ticket every scenario starts from. */
export const FIXTURE_TICKET = githubTicket("Sanmoo/fixture", 168);

export interface ReadProfile {
  readonly name: string;
  readonly summary: string;
  readonly idOrder: CommentIdOrder;
  readonly views: (applied: number) => readonly ReadView[];
}

function prefixes(applied: number): readonly ReadView[] {
  return Array.from({ length: applied + 1 }, (_, upto) => ({ kind: "prefix", upto }) as const);
}

function all(): readonly ReadView[] {
  return [{ kind: "all" }];
}

/** `all` plus every omission of one or two applied writes: a read that shows
 *  a later claim while hiding an earlier one. Nothing in the GitHub docs
 *  excludes it; the report names this as a sample, not the full power set. */
function holey(applied: number): readonly ReadView[] {
  const views: ReadView[] = [{ kind: "all" }];
  for (let first = 0; first < applied; first += 1) {
    views.push({ kind: "omit", indices: [first] });
    for (let second = first + 1; second < applied; second += 1) {
      views.push({ kind: "omit", indices: [first, second] });
    }
  }
  return views;
}

export const READ_PROFILES: readonly ReadProfile[] = [
  {
    name: "holey+unordered",
    summary: "up to two applied writes may be hidden; ids not documented as ordered",
    idOrder: "reverse",
    views: holey,
  },
  {
    name: "fresh+unordered",
    summary: "fresh reads, but ids not assigned in application order",
    idOrder: "reverse",
    views: all,
  },
  {
    name: "prefix+ordered",
    summary: "prefix reads (no holes) and ids assigned in application order",
    idOrder: "apply",
    views: prefixes,
  },
  {
    name: "linearizable",
    summary: "fresh reads and ids assigned in application order",
    idOrder: "apply",
    views: all,
  },
  {
    name: "holey+ordered",
    summary: "ids ordered, but a read may omit up to two already-applied writes",
    idOrder: "apply",
    views: holey,
  },
];

export type StepKind = "write" | "verify" | "launch";

interface Step {
  readonly instance: 0 | 1;
  readonly kind: StepKind;
}

interface VerifySlot {
  readonly position: number;
  /** Mutations applied before this verify, hence the possible read views. */
  readonly applied: number;
}

export interface ExploreResult {
  readonly protocol: string;
  readonly profile: string;
  readonly traces: number;
  readonly oneWorker: number;
  readonly zeroWorkers: number;
  readonly twoOrMore: number;
  readonly maxLive: number;
  readonly unsafeExample: readonly string[] | null;
  readonly oneWorkerExample: readonly string[] | null;
  readonly zeroWorkerExample: readonly string[] | null;
}

interface StepSequence {
  readonly steps: readonly Step[];
  readonly verifies: readonly VerifySlot[];
}

function stepSequences(mutationsPerClaim: number): readonly StepSequence[] {
  const sequences: StepSequence[] = [];
  const kinds: readonly StepKind[] = ["write", "verify", "launch"];

  const walk = (next: [number, number], steps: Step[]): void => {
    if (next[0] === 3 && next[1] === 3) {
      let writes = 0;
      const verifies: VerifySlot[] = [];
      steps.forEach((step, position) => {
        if (step.kind === "write") writes += 1;
        if (step.kind === "verify") {
          verifies.push({ position, applied: writes * mutationsPerClaim });
        }
      });
      sequences.push({ steps: [...steps], verifies });
      return;
    }
    for (const instance of [0, 1] as const) {
      const kind = kinds[next[instance]];
      if (kind === undefined) continue;
      next[instance] += 1;
      steps.push({ instance, kind });
      walk(next, steps);
      steps.pop();
      next[instance] -= 1;
    }
  };

  walk([0, 0], []);
  return sequences;
}

function cartesian(slots: readonly (readonly ReadView[])[]): readonly (readonly ReadView[])[] {
  if (slots.length === 0) return [[]];
  const rest = cartesian(slots.slice(1));
  const first = slots[0] ?? [];
  const out: ReadView[][] = [];
  for (const view of first) {
    for (const tail of rest) out.push([view, ...tail]);
  }
  return out;
}

function viewName(view: ReadView): string {
  if (view.kind === "all") return "all";
  if (view.kind === "prefix") return `prefix:${view.upto}`;
  return `omit:${view.indices.join(",")}`;
}

function label(instance: 0 | 1): string {
  return instance === 0 ? "A" : "B";
}

interface Executed {
  readonly started: number;
  readonly maxLive: number;
  readonly log: readonly string[];
}

function execute(
  protocol: ClaimProtocol,
  profile: ReadProfile,
  sequence: StepSequence,
  views: readonly ReadView[],
): Executed {
  const ticket = FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, {}, profile.idOrder);
  const workers = new WorkerRegistry();
  // A is chosen so a client-chosen label tie-break ("min-label") would give
  // the LATER writer a smaller key in at least one interleaving.
  const factories: readonly FactoryInstance[] = [
    new FactoryInstance("zeta", "acting-account", "Sanmoo/destination-a", protocol),
    new FactoryInstance("alpha", "acting-account", "Sanmoo/destination-b", protocol),
  ];
  const log: string[] = [];

  for (const instance of [0, 1] as const) {
    const factory = factories[instance];
    if (factory === undefined) throw new Error("missing fixture factory");
    const observation = factory.observe(tracker, ticket, { kind: "all" });
    log.push(`${label(instance)}.observe->${observation.decision}`);
    if (observation.decision !== "free") {
      throw new Error(`fixture precondition failed: ${label(instance)} did not observe a free ticket`);
    }
  }

  let viewIndex = 0;
  let started = 0;
  let maxLive = 0;
  for (const step of sequence.steps) {
    const factory = factories[step.instance];
    if (factory === undefined) throw new Error("missing fixture factory");
    if (step.kind === "write") {
      const result = factory.write(tracker, ticket);
      log.push(`${label(step.instance)}.write->${result.status}(${result.applied})`);
      continue;
    }
    if (step.kind === "verify") {
      const view = views[viewIndex];
      viewIndex += 1;
      if (view === undefined) throw new Error("missing read view for verify step");
      const decision = factory.verify(tracker, ticket, view);
      log.push(`${label(step.instance)}.verify(${viewName(view)})->${decision}`);
      continue;
    }
    const worker = factory.launch(workers, ticket);
    if (worker !== undefined) {
      started += 1;
      log.push(`${label(step.instance)}.launch->${worker.id}`);
    } else {
      log.push(`${label(step.instance)}.launch->(no authority)`);
    }
    maxLive = Math.max(maxLive, workers.maxLivePerTicket());
  }

  return { started, maxLive, log };
}

function mutationsPerClaim(protocol: ClaimProtocol): number {
  const ticket = FIXTURE_TICKET;
  return protocol.writes({
    ticket,
    claim: { factoryId: "fixture", nonce: "fixture:1", ticket },
    actingAccount: "acting-account",
    destination: "Sanmoo/fixture",
  }).length;
}

/** Exhaustive exploration for one protocol under one read/id model. */
export function explore(protocol: ClaimProtocol, profile: ReadProfile): ExploreResult {
  const sequences = stepSequences(mutationsPerClaim(protocol));
  let traces = 0;
  let oneWorker = 0;
  let zeroWorkers = 0;
  let twoOrMore = 0;
  let maxLive = 0;
  let unsafeExample: readonly string[] | null = null;
  let oneWorkerExample: readonly string[] | null = null;
  let zeroWorkerExample: readonly string[] | null = null;

  for (const sequence of sequences) {
    const slots = sequence.verifies.map((slot) => profile.views(slot.applied));
    for (const views of cartesian(slots)) {
      traces += 1;
      const executed = execute(protocol, profile, sequence, views);
      maxLive = Math.max(maxLive, executed.maxLive);
      if (executed.started === 0) {
        zeroWorkers += 1;
        zeroWorkerExample ??= executed.log;
      } else if (executed.started === 1) {
        oneWorker += 1;
        oneWorkerExample ??= executed.log;
      } else {
        twoOrMore += 1;
        unsafeExample ??= executed.log;
      }
    }
  }

  return {
    protocol: protocol.name,
    profile: profile.name,
    traces,
    oneWorker,
    zeroWorkers,
    twoOrMore,
    maxLive,
    unsafeExample,
    oneWorkerExample,
    zeroWorkerExample,
  };
}

export function exploreAll(protocols: readonly ClaimProtocol[]): readonly ExploreResult[] {
  const results: ExploreResult[] = [];
  for (const protocol of protocols) {
    for (const profile of READ_PROFILES) results.push(explore(protocol, profile));
  }
  return results;
}

/** Whether every admitted trace of this pair authorized at most one Worker. */
export function safe(result: ExploreResult): boolean {
  return result.maxLive <= 1 && result.twoOrMore === 0;
}

export function progress(result: ExploreResult): boolean {
  return result.oneWorker > 0;
}

/** Human-readable one-line matrix cell. */
export function verdict(result: ExploreResult): string {
  if (!safe(result)) return `UNSAFE (${result.twoOrMore}/${result.traces} traces start 2)`;
  if (result.oneWorker === 0) return `DEADLOCK (0/${result.traces} start any)`;
  return `safe (${result.oneWorker}/${result.traces} start one, ${result.zeroWorkers} start none)`;
}

