import type { IssueRef } from "../tracker/port.js";

/**
 * The factory's boundary with the operator's desktop. The CLI on the HOST
 * delivers; the worker and Pi never touch it (ADR-0001). One occurrence, one
 * notice; delivery is best-effort and the port never remembers or retries.
 */

export type NotificationKind = "review" | "help";

export interface WorkNotification {
  ref: IssueRef;
  /** The brief reason the operator's attention is needed. */
  kind: NotificationKind;
  /** The PR for review; the issue for help. */
  url: string;
}

export interface Notifier {
  /** Deliver one notice; rejects when the host cannot deliver. */
  notify(notification: WorkNotification): Promise<void>;
}

function issueUrl(ref: IssueRef): string {
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

function pullUrl(ref: IssueRef, prNumber: number): string {
  return `https://github.com/${ref.repo}/pull/${prNumber}`;
}

/** The review notice points at the PR the operator reviews. */
export function reviewNotice(ref: IssueRef, prNumber: number): WorkNotification {
  return { ref, kind: "review", url: pullUrl(ref, prNumber) };
}

/** The help notice points at the issue where continuity lives. */
export function helpNotice(ref: IssueRef): WorkNotification {
  return { ref, kind: "help", url: issueUrl(ref) };
}
