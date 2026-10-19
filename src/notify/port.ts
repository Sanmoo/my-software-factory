import type { IssueRef } from "../tracker/port.js";

export type NotificationKind = "review" | "help";

/**
 * The factory's boundary with the operator's desktop: the CLI on the host
 * delivers, never the worker or Pi, so the container gains no graphical
 * capability (issue 93).
 */
export interface WorkNotification {
  ref: IssueRef;
  kind: NotificationKind;
  /** The PR for review; the issue for help. */
  url: string;
}

export interface Notifier {
  /** Rejects when the host cannot deliver. Never retries or remembers. */
  notify(notification: WorkNotification): Promise<void>;
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
