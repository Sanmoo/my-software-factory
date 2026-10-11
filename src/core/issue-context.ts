import type { IssueSnapshot, Known } from "../tracker/port.js";
import type { IssueContext } from "../runtime/runner.js";

// Size bounds for tracker text that reaches the agent (R07). Titles and bodies are untrusted and
// their size must not depend on the tracker; a cut text says how much was left out.
export const ISSUE_TITLE_LIMIT = 300;
export const ISSUE_BODY_LIMIT = 6000;

// A title is cut to fit its limit, ellipsis included.
function boundedTitle(title: string): string {
  return title.length <= ISSUE_TITLE_LIMIT ? title : `${title.slice(0, ISSUE_TITLE_LIMIT - 1)}…`;
}

// A body keeps its first ISSUE_BODY_LIMIT characters; the marker that says what was omitted follows them.
function boundedBody(body: Known<string>): Known<string> {
  if (!body.known || body.value.length <= ISSUE_BODY_LIMIT) return body;
  const omitted = body.value.length - ISSUE_BODY_LIMIT;
  return { known: true, value: `${body.value.slice(0, ISSUE_BODY_LIMIT)}\n[... corpo truncado: ${omitted} caracteres omitidos]` };
}

// The issue context of an implementation invocation, bounded. An unread body stays unknown.
export function issueContextOf(snapshot: IssueSnapshot): IssueContext {
  return {
    title: boundedTitle(snapshot.title),
    body: boundedBody(snapshot.body ?? { known: false, reason: "corpo não lido pelo tracker" }),
  };
}
