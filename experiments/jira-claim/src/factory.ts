import {
  claimRecord,
  CLAIM_PROPERTY_KEY,
  parseClaim,
  ticketIdentityKey,
  type ClaimRecord,
  type Destination,
  type JiraTicket,
} from "./identity.js";
import {
  JiraCloud,
  JiraNetworkError,
  JiraRequestError,
  type JobStatus,
  type JsonValue,
  type SubmitFailures,
} from "./jira.js";
import type { WorkerHandle, WorkerRuntime } from "./workers.js";

/**
 * One factory installation: its own configuration, its own acting account and
 * its own workspace. Nothing is shared with another factory except the tracker
 * — every map below is per-instance state, and no map is ever consulted by
 * another instance.
 */

export type Observation =
  | { kind: "free" }
  | { kind: "own-claim"; record: ClaimRecord }
  | { kind: "claimed"; record: ClaimRecord }
  | { kind: "uncertain"; reason: string }
  | { kind: "legacy-claim"; marks: string[] };

export type AcquisitionOutcome =
  | { kind: "authorized"; record: ClaimRecord }
  | { kind: "unavailable"; reason: string }
  | { kind: "uncertain"; reason: string }
  | { kind: "not-acquired"; reason: string };

export interface PendingAcquisition {
  record: ClaimRecord;
  taskId: string | null;
  taskStatus: "UNKNOWN" | JobStatus;
  updated: number | null;
}

export interface Reservation {
  ticket: string;
  attempt: number;
  workerId: string | null;
  claim: ClaimRecord | null;
}

export interface FactoryConfig {
  id: string;
  accountId: string;
  destination: Destination;
  claimedLabel: string;
}

function updatedCount(result: JsonValue | null): number | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result["updated"];
  return typeof value === "number" ? value : null;
}

export class Factory {
  readonly id: string;
  readonly accountId: string;
  readonly destination: Destination;
  readonly claimedLabel: string;

  private readonly reservations = new Map<string, Reservation>();
  private readonly attemptsStarted = new Map<string, number>();
  private readonly pending = new Map<string, PendingAcquisition>();
  private readonly observations = new Map<string, Observation>();
  private readonly outcomes = new Map<string, AcquisitionOutcome>();
  private readonly presentationDone = new Set<string>();
  private nextPresentationFailure: { assignee?: boolean; label?: boolean } | null = null;
  private nonceSeq = 0;

  constructor(
    config: FactoryConfig,
    readonly ticket: JiraTicket,
    private readonly tracker: JiraCloud,
    private readonly runtime: WorkerRuntime,
  ) {
    this.id = config.id;
    this.accountId = config.accountId;
    this.destination = config.destination;
    this.claimedLabel = config.claimedLabel;
  }

  private key(): string {
    return ticketIdentityKey(this.ticket);
  }

  private issueId(): number {
    return Number(this.ticket.stableId);
  }

  /** What the tracker currently shows for this Ticket, read directly (no search). */
  observe(): Observation {
    const resolved = this.tracker.resolveIssue(this.ticket.site, this.issueId());
    if (resolved === null || String(resolved.issueId) !== this.ticket.stableId) {
      const observation: Observation = {
        kind: "uncertain",
        reason: "the ticket's stable id is not visible on the configured site",
      };
      this.observations.set(this.key(), observation);
      return observation;
    }
    let observation: Observation;
    try {
      const read = this.tracker.readProperty({
        site: this.ticket.site,
        issueId: this.issueId(),
        propertyKey: CLAIM_PROPERTY_KEY,
        factory: this.id,
        via: "search",
      });
      if (read.kind === "present") {
        const parsed = parseClaim(read.value, this.key());
        observation =
          parsed.kind === "malformed"
            ? { kind: "uncertain", reason: parsed.reason }
            : parsed.record.factory === this.id
              ? { kind: "own-claim", record: parsed.record }
              : { kind: "claimed", record: parsed.record };
      } else {
        const view = this.tracker.issueView(this.ticket.site, this.issueId());
        const marks: string[] = [];
        if (view.labels.includes(this.claimedLabel)) marks.push(`label ${this.claimedLabel}`);
        if (view.assignee === this.accountId) marks.push(`assignee ${this.accountId}`);
        observation = marks.length > 0 ? { kind: "legacy-claim", marks } : { kind: "free" };
      }
    } catch (error) {
      observation = {
        kind: "uncertain",
        reason: error instanceof Error ? `the read failed: ${error.message}` : "the read failed",
      };
    }
    this.observations.set(this.key(), observation);
    return observation;
  }

  observation(): Observation | undefined {
    return this.observations.get(this.key());
  }

  pendingAcquisition(): PendingAcquisition | undefined {
    return this.pending.get(this.key());
  }

  outcome(): AcquisitionOutcome | undefined {
    return this.outcomes.get(this.key());
  }

  reservation(): Reservation | undefined {
    return this.reservations.get(this.key());
  }

  attempts(): number {
    return this.attemptsStarted.get(this.key()) ?? 0;
  }

  aliveWorkers(): WorkerHandle[] {
    return this.runtime.aliveFor(this.key()).filter((worker) => worker.factory === this.id);
  }

  /**
   * Acquisition, step 1: only when the direct observation says the Ticket is
   * free. A valid foreign claim, a legacy mark or an unreadable property is
   * never written over and never cleared.
   */
  submitClaim(failures?: SubmitFailures): PendingAcquisition | null {
    const observation = this.observations.get(this.key()) ?? this.observe();
    if (observation.kind === "own-claim") {
      this.outcomes.set(this.key(), { kind: "authorized", record: observation.record });
      return null;
    }
    if (observation.kind === "claimed") {
      this.outcomes.set(this.key(), { kind: "unavailable", reason: `claimed by ${observation.record.factory}` });
      return null;
    }
    if (observation.kind === "legacy-claim") {
      this.outcomes.set(this.key(), {
        kind: "unavailable",
        reason: `a legacy claim mark exists without a readable claim (${observation.marks.join(", ")})`,
      });
      return null;
    }
    if (observation.kind === "uncertain") {
      this.outcomes.set(this.key(), { kind: "uncertain", reason: observation.reason });
      return null;
    }

    this.nonceSeq += 1;
    const record = claimRecord({
      factory: this.id,
      nonce: `${this.id}-${this.nonceSeq}`,
      ticket: this.ticket,
      account: this.accountId,
      destination: this.destination,
      createdAt: this.tracker.nowIso(),
    });
    const pending: PendingAcquisition = {
      record,
      taskId: null,
      taskStatus: "UNKNOWN",
      updated: null,
    };
    this.pending.set(this.key(), pending);
    try {
      const submitted = this.tracker.submitConditional({
        site: this.ticket.site,
        issueId: this.issueId(),
        propertyKey: CLAIM_PROPERTY_KEY,
        value: record,
        factory: this.id,
        ...(failures === undefined ? {} : { failures }),
      });
      pending.taskId = submitted.taskId;
    } catch (error) {
      if (error instanceof JiraNetworkError) {
        this.outcomes.set(this.key(), {
          kind: "uncertain",
          reason: "the acquisition request may have been applied; the response was lost",
        });
      } else if (error instanceof JiraRequestError && error.status === 0) {
        this.outcomes.set(this.key(), {
          kind: "not-acquired",
          reason: "the request never reached Jira; no claim can exist",
        });
      } else {
        this.outcomes.set(this.key(), {
          kind: "uncertain",
          reason: error instanceof Error ? error.message : "the acquisition request failed",
        });
      }
      return pending;
    }
    return pending;
  }

  /** Acquisition, step 2: wait for the asynchronous job to be COMPLETE or FAILED. */
  completeClaim(): PendingAcquisition | null {
    const pending = this.pending.get(this.key());
    if (pending === undefined) return null;
    if (pending.taskId === null) {
      this.outcomes.set(this.key(), {
        kind: "uncertain",
        reason: "the acquisition job is unknown (the response was lost)",
      });
      return pending;
    }
    const task = this.tracker.pollTask(pending.taskId, this.id);
    pending.taskStatus = task.status;
    pending.updated = updatedCount(task.result);
    if (task.status === "FAILED") {
      // "when errors occur, none are updated": a failed task is confirmed to
      // have written nothing, so a new acquisition may be attempted later.
      this.outcomes.set(this.key(), { kind: "not-acquired", reason: "the acquisition job failed; it updated nothing" });
    }
    return pending;
  }

  /**
   * Acquisition, step 3: the only proof of authority. The stored value must be
   * a valid record for THIS ticket whose factory is this instance. A value
   * with my factory id but another nonce is still my claim: the nonce only
   * correlates responses, the factory id is the authority.
   */
  verifyClaim(): AcquisitionOutcome | null {
    let outcome: AcquisitionOutcome;
    let read: ReturnType<JiraCloud["readProperty"]>;
    try {
      read = this.tracker.readProperty({
        site: this.ticket.site,
        issueId: this.issueId(),
        propertyKey: CLAIM_PROPERTY_KEY,
        factory: this.id,
        via: "direct",
      });
    } catch (error) {
      outcome = {
        kind: "uncertain",
        reason: error instanceof Error ? `the verification read failed: ${error.message}` : "the verification read failed",
      };
      this.outcomes.set(this.key(), outcome);
      return outcome;
    }
    if (read.kind === "present") {
      const parsed = parseClaim(read.value, this.key());
      if (parsed.kind === "malformed") {
        outcome = { kind: "uncertain", reason: `the claim value is unreadable: ${parsed.reason}` };
      } else if (parsed.record.factory === this.id) {
        outcome = { kind: "authorized", record: parsed.record };
      } else {
        outcome = { kind: "unavailable", reason: `claimed by ${parsed.record.factory}` };
      }
    } else {
      const pending = this.pending.get(this.key());
      outcome =
        pending?.taskStatus === "FAILED"
          ? { kind: "not-acquired", reason: "the failed job wrote nothing and the property is absent" }
          : {
              kind: "uncertain",
              reason: "the property is absent (a stale read or a job that has not been applied); no authority",
            };
    }
    this.outcomes.set(this.key(), outcome);
    return outcome;
  }

  /** Inject a presentation failure (the harness's controlled partial Claim). */
  setPresentationFailure(failures: { assignee?: boolean; label?: boolean } | null): void {
    this.nextPresentationFailure = failures;
  }

  /** Presentation marks: assignment to the acting account and the claimed label. */
  presentClaim(failures?: { assignee?: boolean; label?: boolean }): boolean {
    const appliedFailures = failures ?? this.nextPresentationFailure ?? undefined;
    const outcome = this.outcomes.get(this.key());
    if (outcome?.kind !== "authorized") return false;
    if (this.presentationDone.has(this.key())) return true;
    try {
      this.tracker.setAssigneeBlind({
        site: this.ticket.site,
        issueId: this.issueId(),
        accountId: this.accountId,
        factory: this.id,
        ...(appliedFailures?.assignee === true ? { failure: true } : {}),
      });
      this.tracker.addLabelBlind({
        site: this.ticket.site,
        issueId: this.issueId(),
        label: this.claimedLabel,
        factory: this.id,
        ...(appliedFailures?.label === true ? { failure: true } : {}),
      });
    } catch {
      return false;
    }
    this.presentationDone.add(this.key());
    return true;
  }

  /**
   * Launch is reachable ONLY with a verified claim and completed presentation.
   * The first launch consumes the one Attempt; a recovery relaunches the same
   * Attempt.
   */
  launch(): WorkerHandle | null {
    const outcome = this.outcomes.get(this.key());
    if (outcome?.kind !== "authorized") return null;
    if (!this.presentClaim()) return null;
    if (this.aliveWorkers().length > 0) return null;

    const existing = this.reservations.get(this.key());
    if (existing !== undefined) {
      const worker = this.runtime.start({
        factory: this.id,
        ticket: this.key(),
        attempt: existing.attempt,
        at: this.tracker.now(),
      });
      existing.workerId = worker.id;
      return worker;
    }

    this.attemptsStarted.set(this.key(), 1);
    const reservation: Reservation = {
      ticket: this.key(),
      attempt: 1,
      workerId: null,
      claim: outcome.record,
    };
    this.reservations.set(this.key(), reservation);
    const worker = this.runtime.start({
      factory: this.id,
      ticket: this.key(),
      attempt: 1,
      at: this.tracker.now(),
    });
    reservation.workerId = worker.id;
    return worker;
  }

  /** The Worker died without an outcome: no Attempt is consumed, nothing is ended remotely. */
  interrupt(): void {
    const reservation = this.reservations.get(this.key());
    const worker = this.aliveWorkers()[0];
    if (worker !== undefined) this.runtime.end(worker.id);
    if (reservation !== undefined) reservation.workerId = null;
  }

  /** Local Recovery: re-verify the SAME claim and relaunch the SAME Attempt. */
  recover(): WorkerHandle | null {
    this.verifyClaim();
    return this.launch();
  }
}
