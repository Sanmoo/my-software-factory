import type { PauseRecord } from "../work-record/continuity.js";
import { commentIsAgentSpeech, pauseMarkerId, type IssueComment } from "./port.js";

/**
 * Which comments are the HUMAN's answer — "speech, not login", decided by the
 * tracker port and nothing else: a provider that carries structured evidence
 * (a Jira comment property) is read from it, and without such evidence the
 * body marker decides.
 *
 * Two readers ask it — the Work state (a blocked work resumes on an answer) and
 * the Continuity pause (a pause resumes on one) — so the rule lives here, once,
 * instead of in whichever derivation module happened to be nearest. Comment
 * order is chronological, and the author may be the worker account: a comment is
 * the factory's by its marker, never by its login.
 */

/** The human replies that resume blocked work: every non-factory comment AFTER
 *  the last factory comment. */
export function humanCommentsAfterLastMarker(comments: IssueComment[]): IssueComment[] {
  let lastMarkerIndex = -1;
  for (const [index, comment] of comments.entries()) {
    if (commentIsAgentSpeech(comment)) lastMarkerIndex = index;
  }
  return comments.slice(lastMarkerIndex + 1).filter((comment) => !commentIsAgentSpeech(comment));
}

export function hasHumanCommentAfterLastMarker(comments: IssueComment[]): boolean {
  return humanCommentsAfterLastMarker(comments).length > 0;
}

/**
 * The human replies that answer ONE continuity pause: every
 * non-agent comment after the FIRST factory comment carrying that pause's
 * marker. A later factory comment about the same pause — a re-assertion or a
 * diagnostic for a changed cause — never displaces an answer already given.
 *
 * Before the request lands there is nothing to answer, and an answer given to
 * an earlier question is never consumed. A record written before the identity
 * existed keeps the generic rule, so old pauses still resume.
 */
export function humanCommentsForPause(comments: IssueComment[], pause: PauseRecord): IssueComment[] {
  if (pause.id === undefined) return humanCommentsAfterLastMarker(comments);
  const request = comments.findIndex((comment) => pauseMarkerId(comment.body) === pause.id);
  if (request < 0) return [];
  return comments.slice(request + 1).filter((comment) => !commentIsAgentSpeech(comment));
}
