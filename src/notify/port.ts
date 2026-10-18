import type { IssueRef } from "../tracker/port.js";

/**
 * The notification port (issue 93): the factory's boundary with the
 * operator's desktop. The CLI on the HOST delivers; the worker container and
 * Pi never touch it — the separation of ADR-0001 is preserved.
 *
 * One occurrence, one notice: the loop decides WHAT deserves the operator's
 * attention and calls this port at the act. The port carries structured
 * facts only (work, reason, address) — enough to compose the notice, never
 * free agent prose, logs or local artifact paths.
 *
 * Delivery is punctual and best-effort: the port neither remembers nor
 * deduplicates nor retries. A rejection means the host could not deliver
 * (missing binary, no graphical session, send failure); the caller reports
 * it on the terminal and moves on.
 */

export type NotificationKind =
  /** A PR is open and waiting for the operator's review. */
  | "review"
  /** The work needs help on the issue (self-report, block, rejection). */
  | "help";

export interface WorkNotification {
  /** The work the notice is about. */
  ref: IssueRef;
  /** The brief reason the operator's attention is needed. */
  kind: NotificationKind;
  /** The GitHub address relevant to the action: the PR for review, the issue for help. */
  url: string;
}

export interface Notifier {
  /**
   * Deliver one notice. Rejects when the host cannot deliver — the caller
   * treats that as best-effort and never lets it change the work's outcome.
   */
  notify(notification: WorkNotification): Promise<void>;
}

/** The work's issue address — where the continuity context of help/blocks lives. */
function issueUrl(ref: IssueRef): string {
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

/** The work's PR address — what the operator reviews. */
function pullUrl(ref: IssueRef, prNumber: number): string {
  return `https://github.com/${ref.repo}/pull/${prNumber}`;
}

/** The structured review notice: the address is the PR the operator reviews. */
export function reviewNotice(ref: IssueRef, prNumber: number): WorkNotification {
  return { ref, kind: "review", url: pullUrl(ref, prNumber) };
}

/** The structured help notice: the address is the issue where continuity lives. */
export function helpNotice(ref: IssueRef): WorkNotification {
  return { ref, kind: "help", url: issueUrl(ref) };
}
