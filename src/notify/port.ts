import type { IssueRef } from "../tracker/port.js";

export type NotificationKind = "review" | "help";

/**
 * The factory's boundary with the operator's desktop, delivered by the CLI on
 * the host — never by the worker or Pi (docs/adr/0001-factory-owned-agent-resources.md).
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
