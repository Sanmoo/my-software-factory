import type { IssueRef } from "../tracker/port.js";

/**
 * The factory's boundary with the operator's desktop: the CLI on the host
 * delivers, never the worker or Pi, so the container gains no graphical
 * capability (issue 93).
 */
export interface WorkNotification {
  ref: IssueRef;
  kind: "review" | "help" | "intervention";
  /** The PR for review; the issue for help or intervention. */
  url: string;
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

function issueUrl(ref: IssueRef): string {
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

function pullUrl(ref: IssueRef, prNumber: number): string {
  return `https://github.com/${ref.repo}/pull/${prNumber}`;
}

export function reviewNotice(ref: IssueRef, prNumber: number): WorkNotification {
  return { ref, kind: "review", url: pullUrl(ref, prNumber) };
}

export function helpNotice(ref: IssueRef): WorkNotification {
  return { ref, kind: "help", url: issueUrl(ref) };
}

/**
 * A worker of the work needs a human decision the factory will not make
 * (issue 118): duplicate containers of one work, or a survivor silent past the
 * idle limit. Nothing was ended, replaced or chosen — the notice says so.
 */
export function interventionNotice(ref: IssueRef): WorkNotification {
  return { ref, kind: "intervention", url: issueUrl(ref) };
}

/** The one notice of a liveness-unknown episode (issue 118). */
export function factoryUnavailableNotice(unavailableForMs: number): FactoryNotification {
  return { kind: "factory-unavailable", unavailableForMs };
}

/** A notice's identity for the operator's log — a work's, or the factory's own. */
export function describeNotification(notification: Notification): string {
  if (notification.kind === "factory-unavailable") return "factory (Docker unreachable)";
  return `${notification.kind} ${notification.ref.repo}#${notification.ref.number}`;
}
