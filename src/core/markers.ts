import type { IssueRef, TrackerKind, TrackerPort } from "../tracker/port.js";
import type { Observer } from "./observability.js";

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
// When observed, the attempt and its outcome are announced: the comment id and its size, never the
// whole body on the main log (issue #15, decision 23). Observing never posts a second time.
export async function postFactoryComment(
  tracker: TrackerPort,
  ref: IssueRef,
  body: string,
  observed?: { observer: Observer; job?: string; invocation?: string; reason: string },
): Promise<string> {
  const base = { ...(observed?.job === undefined ? {} : { job: observed.job }), ...(observed?.invocation === undefined ? {} : { invocation: observed.invocation }) };
  const fields = { issue: `${ref.tracker}:${ref.project}#${ref.id}`, origem: "orquestrador", operação: "comentar", motivo: observed?.reason };
  observed?.observer.emit({ kind: "issue-escrita-tentativa", text: "tentativa de alteração na issue", ...base, fields });
  try {
    const id = await tracker.postComment(ref, withFactoryMarker(ref.tracker, body));
    observed?.observer.emit({
      kind: "issue-alteração-confirmed", text: "alteração confirmada", ...base,
      fields: { ...fields, comentário: id, conteúdo: `${body.length} caracteres` },
    });
    return id;
  } catch (error) {
    observed?.observer.emit({
      kind: "issue-escrita-incerta", text: "resultado da alteração incerto", ...base,
      fields: { ...fields, erro: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
