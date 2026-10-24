/**
 * The operator's manual path, kept deliberately OUTSIDE the protocol.
 *
 * Releasing or transferring a Claim is a human act with one precondition: the
 * previous Worker must have stopped, and that fact must be confirmed. Editing
 * the tracker is not a remote interruption — this module never touches a live
 * Worker, and `confirmStop` refuses while the harness witnesses one alive.
 *
 * In a real installation the confirmation is the operator's own (the Worker's
 * container is gone, the process ended). The harness's registry is only the
 * experiment's observable stand-in for that confirmation.
 */

import { CLAIM_LABEL_PREFIX, PADLOCK_LABEL, parseClaim, sameTicket, type TicketIdentity } from "./identity.js";
import type { SimTracker } from "./tracker.js";
import type { WorkerRegistry } from "./workers.js";

export class OperatorReleaseRefused extends Error {
  constructor(reason: string) {
    super(`manual release refused: ${reason}`);
    this.name = "OperatorReleaseRefused";
  }
}

export interface StopConfirmation {
  readonly ticket: TicketIdentity;
  readonly confirmedWorkerEnded: true;
}

/** The operator confirms the previous Worker ended — never an inference from
 *  the tracker, a timeout or another factory's silence. */
export function confirmStop(workers: WorkerRegistry, ticket: TicketIdentity): StopConfirmation {
  const live = workers.liveFor(ticket);
  if (live.length > 0) {
    throw new OperatorReleaseRefused(
      `${live.length} live worker(s) still carry this ticket; stop and confirm them first`,
    );
  }
  return { ticket, confirmedWorkerEnded: true };
}

/**
 * Remove the reservation marks AFTER the confirmation: the claim records, the
 * padlock/unique labels and the Acting account's assignment — a Claim in the
 * glossary's sense is mark + assignment. It resolves a deadlocked pair of
 * claims; it never removes a marker it cannot read (a malformed claim needs a
 * human in the tracker's UI).
 */
export function releaseClaim(
  tracker: SimTracker,
  workers: WorkerRegistry,
  ticket: TicketIdentity,
  confirmation: StopConfirmation,
  actingAccount: string,
): void {
  if (!confirmation.confirmedWorkerEnded || !sameTicket(confirmation.ticket, ticket)) {
    throw new OperatorReleaseRefused("the confirmation does not cover this ticket");
  }
  if (workers.liveFor(ticket).length > 0) {
    throw new OperatorReleaseRefused("a live worker still carries this ticket");
  }

  const snapshot = tracker.snapshot();
  for (const comment of snapshot.comments) {
    const parsed = parseClaim(comment.body);
    if (parsed.kind === "malformed") {
      throw new OperatorReleaseRefused(
        `comment ${comment.id} carries an unreadable claim marker; release it by hand`,
      );
    }
    if (parsed.kind === "valid" && sameTicket(parsed.record.ticket, ticket)) {
      tracker.apply({ kind: "delete-comment", commentId: comment.id });
    }
  }
  for (const label of snapshot.labels) {
    if (label === PADLOCK_LABEL || label.startsWith(CLAIM_LABEL_PREFIX)) {
      tracker.apply({ kind: "remove-label", label });
    }
  }
  if (snapshot.assignees.includes(actingAccount)) {
    tracker.apply({ kind: "remove-assignee", login: actingAccount });
  }
}
