import type { WorkRequest } from "../runtime/port.js";
import {
  githubRepository,
  githubTicket,
  workIdentity,
  type TicketIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";

/**
 * TEST SUPPORT for the GitHub-only e2e suites: the Work a seeded issue names,
 * and the issue number a launched request carries. A non-GitHub ticket is a
 * test bug here — those suites exercise the GitHub composition.
 */
export function githubWork(repo: string, number: number): WorkIdentity {
  return workIdentity(githubTicket(repo, number), githubRepository(repo));
}

/** The GitHub issue number of a ticket, or null for another provider — the
 *  presentation the GitHub-only e2e suites identify seeded works by. */
export function githubTicketNumber(ticket: TicketIdentity): number | null {
  return ticket.provider === "github" ? ticket.number : null;
}

/** The GitHub repository a ticket belongs to, or null for another provider. */
export function githubTicketRepo(ticket: TicketIdentity): string | null {
  return ticket.provider === "github" ? ticket.repo : null;
}

/** The GitHub issue number of one launched request. */
export function launchedNumber(request: WorkRequest): number {
  const ticket = request.work.ticket;
  if (ticket.provider !== "github") throw new Error(`not a GitHub request: ${ticket.provider}`);
  return ticket.number;
}
