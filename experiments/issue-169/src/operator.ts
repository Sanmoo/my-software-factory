import type { JiraTicket } from "./identity.js";
import { CLAIM_PROPERTY_KEY, CLAIMED_LABEL, ticketIdentityKey } from "./identity.js";
import type { JiraCloud } from "./jira.js";
import type { WorkerRuntime } from "./workers.js";

/**
 * The operator's deliberate release/transfer. It is OUTSIDE the acquisition
 * protocol and it never interrupts anything remotely: it is refused while a
 * Worker is alive and it requires the operator's explicit confirmation that
 * the previous Worker ended.
 */
export interface ReleaseResult {
  released: boolean;
  reason: string;
}

export function releaseManually(input: {
  tracker: JiraCloud;
  runtime: WorkerRuntime;
  ticket: JiraTicket;
  confirmedWorkerEnd: boolean;
  actor: string;
}): ReleaseResult {
  const alive = input.runtime.aliveFor(ticketIdentityKey(input.ticket));
  if (alive.length > 0) {
    return {
      released: false,
      reason: `refused: ${alive.length} Worker(s) still alive; stop and confirm their end first`,
    };
  }
  if (!input.confirmedWorkerEnd) {
    return { released: false, reason: "refused: the operator did not confirm the previous Worker ended" };
  }
  const issueId = Number(input.ticket.stableId);
  input.tracker.deleteProperty({
    site: input.ticket.site,
    issueId,
    propertyKey: CLAIM_PROPERTY_KEY,
    actor: input.actor,
  });
  // A release removes the WHOLE Claim: the authority mark and the presentation
  // marks. Leaving the label/assignment behind would be read as a legacy claim
  // by every participant and would keep the Ticket unavailable.
  input.tracker.clearAssignee({ site: input.ticket.site, issueId, factory: input.actor });
  input.tracker.removeLabel({
    site: input.ticket.site,
    issueId,
    label: CLAIMED_LABEL,
    factory: input.actor,
  });
  return { released: true, reason: "released after the previous Worker's end was confirmed" };
}
