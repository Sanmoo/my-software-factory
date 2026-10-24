import type { WorkIdentity } from "../tracker/identity.js";
import {
  githubPullUrl,
  pullRequestIdentity,
  renderTicketIdentity,
  ticketUrl,
} from "../tracker/identity.js";

/**
 * The factory's boundary with the operator's desktop: the CLI on the host
 * delivers, never the worker or Pi, so the container gains no graphical
 * capability (issue 93).
 */
export interface WorkNotification {
  /** The Work's source and destination — never a synthesized GitHub issue. */
  work: WorkIdentity;
  kind: "review" | "help" | "intervention";
  /** The PR for review; the ticket for help or intervention. Null when the
   *  ticket's source exposes no presentation link (a Jira identity without
   *  one): the notice still names the ticket instead of inventing an address. */
  url: string | null;
}

/**
 * An occurrence OF THE FACTORY, not of a work (issue 118): Docker has not
 * answered for a while, so the factory suspended new launches. It names no
 * work — inventing one or commenting on every issue would be a lie.
 */
export interface FactoryNotification {
  kind: "factory-unavailable";
  /** How long the continuous unavailability had lasted when the notice was raised. */
  unavailableForMs: number;
}

export type Notification = WorkNotification | FactoryNotification;

export interface Notifier {
  /** Rejects when the host cannot deliver. Never retries or remembers. */
  notify(notification: Notification): Promise<void>;
}

export function reviewNotice(work: WorkIdentity, prNumber: number): WorkNotification {
  const pullRequest = pullRequestIdentity(work.destination, prNumber);
  return {
    work,
    kind: "review",
    url: githubPullUrl(pullRequest.site, pullRequest.repository.repo, pullRequest.number),
  };
}

export function helpNotice(work: WorkIdentity): WorkNotification {
  return { work, kind: "help", url: ticketUrl(work.ticket) ?? null };
}

/**
 * A worker of the work needs a human decision the factory will not make
 * (issue 118): duplicate containers of one work, or a survivor silent past the
 * idle limit. Nothing was ended, replaced or chosen — the notice says so.
 */
export function interventionNotice(work: WorkIdentity): WorkNotification {
  return { work, kind: "intervention", url: ticketUrl(work.ticket) ?? null };
}

/** The one notice of a liveness-unknown episode (issue 118). */
export function factoryUnavailableNotice(unavailableForMs: number): FactoryNotification {
  return { kind: "factory-unavailable", unavailableForMs };
}

/** A notice's identity for the operator's log — a work's, or the factory's own. */
export function describeNotification(notification: Notification): string {
  if (notification.kind === "factory-unavailable") return "factory (Docker unreachable)";
  return `${notification.kind} ${renderTicketIdentity(notification.work.ticket)}`;
}
