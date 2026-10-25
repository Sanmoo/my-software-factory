import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PauseRecord } from "../work-record/continuity.js";
import { AGENT_MARKER, pauseMarker, type IssueComment } from "./port.js";
import {
  hasHumanCommentAfterLastMarker,
  humanCommentsAfterLastMarker,
  humanCommentsForPause,
} from "./speech.js";

/**
 * The tracker's own rule for "which comment is the human's answer" (ticket 04
 * Q6, amended in 18; issue 174). It moved out of the state derivation because
 * two domains ask it — the Work state (a blocked work resumes on an answer) and
 * the Continuity pause (a pause resumes on the answer to ITS request) — and the
 * marker, not the login, decides who spoke.
 */

let next = 0;
const said = (body: string): IssueComment => {
  next += 1;
  return {
    id: String(next),
    author: "bot-do-samuca", // the worker account speaks on both sides (a GitHub fact)
    body,
    createdAt: "2026-01-01T00:00:00Z",
  };
};

const factory = (body: string): IssueComment => said(`${AGENT_MARKER}\n${body}`);
const human = (body: string): IssueComment => said(body);

const PAUSE_ID = "6f1c9a2e-1c1f-4f6b-9a1b-2f0f0b7c1111";
const pause = (id?: string): PauseRecord =>
  ({ reason: "effect-ambiguous", attempt: 2, ...(id === undefined ? {} : { id }) }) as PauseRecord;

describe("speech, not login — the comments that are the human's answer", () => {
  test("only what comes AFTER the factory's last word counts, and the factory's own comments never do", () => {
    const comments = [human("before the request"), factory("blocked"), human("answer one"), factory("re-asserted"), human("answer two")];

    assert.deepEqual(
      humanCommentsAfterLastMarker(comments).map((comment) => comment.body),
      ["answer two"],
      "a previous answer is never consumed twice",
    );
    assert.equal(hasHumanCommentAfterLastMarker(comments), true);
  });

  test("with no factory comment at all, every human comment is an answer — and nothing is, when the factory spoke last", () => {
    assert.deepEqual(humanCommentsAfterLastMarker([human("hello")]).map((c) => c.body), ["hello"]);
    assert.deepEqual(humanCommentsAfterLastMarker([factory("the factory's last word")]), []);
    assert.equal(hasHumanCommentAfterLastMarker([factory("the factory's last word")]), false);
  });

  test("an answer belongs to the pause it answered: a later comment about the same pause never displaces it", () => {
    const comments = [
      factory("an earlier question"),
      human("an answer to the earlier question"),
      factory(`attempt 2 cannot be continued safely ${pauseMarker(PAUSE_ID)}`),
      human(`the answer to the pause ${PAUSE_ID}`),
      factory(`the cause changed ${pauseMarker(PAUSE_ID)}`),
    ];

    assert.deepEqual(
      humanCommentsForPause(comments, pause(PAUSE_ID)).map((comment) => comment.body),
      [`the answer to the pause ${PAUSE_ID}`],
      "the FIRST comment carrying the marker is the request; a re-assertion is not a new question",
    );
  });

  test("nothing to answer before the request lands, and an older answer is never consumed", () => {
    const answered = [factory("an earlier question"), human("an old answer")];

    assert.deepEqual(humanCommentsForPause(answered, pause(PAUSE_ID)), [], "the request is not on the tracker yet");
    assert.deepEqual(
      humanCommentsForPause([...answered, factory(`please help ${pauseMarker(PAUSE_ID)}`)], pause(PAUSE_ID)),
      [],
      "an answer given to an earlier question never answers this one",
    );
  });

  test("a pause recorded before the identity existed keeps the generic rule, so old pauses still resume", () => {
    const comments = [factory("attempt 2 cannot be continued safely"), human("resolved it by hand")];

    assert.deepEqual(humanCommentsForPause(comments, pause()).map((comment) => comment.body), ["resolved it by hand"]);
  });
});
