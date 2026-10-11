import type { IssueRef, TrackerKind, TrackerPort } from "../tracker/port.js";

// Factory markers (R10). The core adds the marker to every comment the factory publishes,
// once; adapters never add or strip it. A comment that carries the marker is never feedback.
export const GITHUB_MARKER = "<!-- msf:agent -->";
export const JIRA_MARKER = "[msf]";

// Memory fixtures answer to the GitHub form, as they do when reading feedback (see isFactoryComment).
export function withFactoryMarker(tracker: TrackerKind, body: string): string {
  if (tracker === "jira") {
    return body.startsWith(JIRA_MARKER) ? body : `${JIRA_MARKER} ${body}`;
  }
  return body.startsWith(GITHUB_MARKER) ? body : `${GITHUB_MARKER}\n${body}`;
}

// The one path by which the factory publishes a comment on an issue: the body is marked first.
export function postFactoryComment(tracker: TrackerPort, ref: IssueRef, body: string): Promise<string> {
  return tracker.postComment(ref, withFactoryMarker(ref.tracker, body));
}
