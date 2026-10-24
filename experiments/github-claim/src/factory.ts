/**
 * One Factory installation. Its coordination state is only what a workspace
 * can hold: its reservations and its unresolved acquisition. It never reads
 * another installation's memory, and the only shared medium is the tracker
 * handed to each call.
 *
 * The acquisition contract keeps the spec's three outcomes distinct. Only
 * `authorized` may launch. `uncertain` neither launches, nor consumes an
 * Attempt, nor cleans a claim it cannot prove is its own.
 */

import { ticketKey, type ClaimRecord, type TicketIdentity } from "./identity.js";
import type {
  ClaimProtocol,
  Decision,
  Observation,
  ProtocolInput,
} from "./protocols.js";
import type { ReadView, SimTracker } from "./tracker.js";
import type { WorkerRecord, WorkerRegistry } from "./workers.js";

export type WriteStatus = "applied" | "lost" | "failed";

export interface WriteResult {
  readonly status: WriteStatus;
  readonly applied: number;
}

export interface WriteOptions {
  /** Apply this many writes and then lose the response; the rest never run.
   *  1..writes.length models a partial Claim as well as a full one. */
  readonly lostAfter?: number;
  /** Fail before the first write: nothing is applied. */
  readonly failBefore?: boolean;
}

/**
 * The ACQUISITION slice of a Reservation: ticket, destination, attempts,
 * state and claim. The workspace's full Reservation (source facts, outcomes,
 * PR associations) is outside this investigation; nothing in the dispute
 * reads those fields.
 */
export interface Reservation {
  readonly ticket: TicketIdentity;
  readonly destination: string;
  attempts: number;
  state: "acquiring" | "running" | "interrupted";
  claim: ClaimRecord | null;
}

export interface PersistedWorkspace {
  readonly factoryId: string;
  readonly actingAccount: string;
  readonly destination: string;
  readonly reservations: readonly Reservation[];
}

/** Distinguishes two process incarnations of the same installation. A
 *  restarted factory gets a new one, so a claim written by an earlier
 *  incarnation never matches a new acquisition's nonce — even if the workspace
 *  (and its sequence) was lost. Recovery keeps working because the persisted
 *  claim carries its original nonce. */
let nextIncarnation = 1;

export class FactoryInstance {
  private readonly reservations = new Map<string, Reservation>();
  private readonly pending = new Map<string, ClaimRecord>();
  private readonly decisions = new Map<string, Decision>();
  private readonly launchedClaims = new Set<string>();
  private readonly incarnation: string;
  private sequence = 0;

  constructor(
    readonly factoryId: string,
    readonly actingAccount: string,
    readonly destination: string,
    private readonly protocol: ClaimProtocol,
    incarnation?: string,
  ) {
    this.incarnation = incarnation ?? `inc-${nextIncarnation++}`;
  }

  attempts(ticket: TicketIdentity): number {
    return this.reservations.get(ticketKey(ticket))?.attempts ?? 0;
  }

  /**
   * The pre-write observation. An unresolved earlier acquisition is not
   * overwritten by a new one: the factory must verify or hold, never write a
   * second claim because the first answer was lost.
   */
  observe(tracker: SimTracker, ticket: TicketIdentity, view: ReadView = { kind: "all" }): Observation {
    const key = ticketKey(ticket);
    if (this.pending.has(key)) {
      return { decision: "uncertain", reason: "an earlier acquisition is still unresolved" };
    }
    const claim: ClaimRecord = {
      factoryId: this.factoryId,
      nonce: `${this.factoryId}:${this.incarnation}:${this.sequence + 1}`,
      ticket,
    };
    this.sequence += 1;
    const observation = this.protocol.observe(tracker.read(view), this.input(claim));
    if (observation.decision === "free") this.pending.set(key, claim);
    return observation;
  }

  /** The blind writes of the claim, in protocol order. */
  write(tracker: SimTracker, ticket: TicketIdentity, options: WriteOptions = {}): WriteResult {
    const claim = this.pending.get(ticketKey(ticket));
    if (claim === undefined) throw new Error(`${this.factoryId}: no pending acquisition to write`);
    if (options.failBefore === true) return { status: "failed", applied: 0 };

    const plan = this.protocol.writes(this.input(claim));
    const limit = options.lostAfter === undefined ? plan.length : Math.min(options.lostAfter, plan.length);
    let applied = 0;
    for (const mutation of plan.slice(0, limit)) {
      tracker.apply(mutation);
      applied += 1;
    }
    return { status: options.lostAfter === undefined ? "applied" : "lost", applied };
  }

  /**
   * The verification read's decision. On `authorized` the reservation exists
   * BEFORE any launch, so a Claim is never unbacked in this workspace by
   * construction — but a Claim may still exist with no reservation HERE
   * because another workspace holds it.
   */
  verify(tracker: SimTracker, ticket: TicketIdentity, view: ReadView = { kind: "all" }): Decision {
    const key = ticketKey(ticket);
    const claim = this.pending.get(key);
    if (claim === undefined) return this.decisions.get(key) ?? "uncertain";

    const decision = this.protocol.decide(tracker.read(view), this.input(claim));
    this.decisions.set(key, decision);
    if (decision === "authorized") {
      const existing = this.reservations.get(key);
      if (existing === undefined) {
        this.reservations.set(key, {
          ticket,
          destination: this.destination,
          attempts: 0,
          state: "acquiring",
          claim,
        });
      } else {
        existing.claim = claim;
        existing.state = "acquiring";
      }
    }
    return decision;
  }

  /**
   * Start a Worker only under confirmed exclusive authority. A recovery
   * relaunch keeps the interrupted attempt's number and spends no new Attempt.
   */
  launch(
    workers: WorkerRegistry,
    ticket: TicketIdentity,
    options: { readonly recovering?: boolean } = {},
  ): WorkerRecord | undefined {
    const key = ticketKey(ticket);
    if (this.decisions.get(key) !== "authorized") return undefined;
    const witness = this.reservations.get(key)?.claim;
    // One authorization launches one Worker: a second call for the same claim
    // is not a second attempt. A new acquisition carries a new claim.
    if (witness !== undefined && witness !== null && this.launchedClaims.has(witness.nonce)) {
      return undefined;
    }

    let reservation = this.reservations.get(key);
    if (reservation === undefined) {
      reservation = {
        ticket,
        destination: this.destination,
        attempts: 0,
        state: "acquiring",
        claim: null,
      };
      this.reservations.set(key, reservation);
    }

    if (options.recovering === true) {
      if (reservation.attempts < 1) throw new Error(`${this.factoryId}: no attempt to recover`);
    } else {
      reservation.attempts += 1;
    }
    reservation.state = "running";
    if (witness !== undefined && witness !== null) this.launchedClaims.add(witness.nonce);
    this.pending.delete(key);
    return workers.start(ticket, this.factoryId, reservation.attempts);
  }

  markInterrupted(ticket: TicketIdentity): void {
    const reservation = this.reservations.get(ticketKey(ticket));
    if (reservation !== undefined) reservation.state = "interrupted";
  }

  /** The workspace's own persisted state — the only thing a restart carries. */
  persist(): PersistedWorkspace {
    return {
      factoryId: this.factoryId,
      actingAccount: this.actingAccount,
      destination: this.destination,
      reservations: [...this.reservations.values()].map((reservation) => ({ ...reservation })),
    };
  }

  /** Restart from the workspace's own records. An interrupted reservation
   *  keeps its claim pending so Recovery can verify ITS claim, not guess at
   *  another factory's. */
  static restore(persisted: PersistedWorkspace, protocol: ClaimProtocol): FactoryInstance {
    const factory = new FactoryInstance(
      persisted.factoryId,
      persisted.actingAccount,
      persisted.destination,
      protocol,
    );
    for (const reservation of persisted.reservations) {
      factory.reservations.set(ticketKey(reservation.ticket), { ...reservation });
      if (reservation.state === "interrupted" && reservation.claim !== null) {
        factory.pending.set(ticketKey(reservation.ticket), reservation.claim);
      }
    }
    return factory;
  }

  private input(claim: ClaimRecord): ProtocolInput {
    return {
      ticket: claim.ticket,
      claim,
      actingAccount: this.actingAccount,
      destination: this.destination,
    };
  }
}
