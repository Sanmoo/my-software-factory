import assert from "node:assert/strict";
import { test } from "node:test";

import { projectCollectedRuling } from "./loop.js";
import { githubRepository, githubTicket, pullRequestIdentity } from "./tracker/identity.js";
import type { PullRequestRecord } from "./tracker/expanded-port.js";
import type { WorkStateReading } from "./work-state/state.js";

/**
 * `SweepResult.collected[].ruling` after ticket #202 (D5, epic #198).
 *
 * The engine decides in ONE vocabulary — the Work state the module answers with
 * — and the report keeps the shape the e2e suites have always asserted:
 * `decision` / `because`. That report is a PROJECTION of the decided state,
 * computed once where the result is built. This file pins the projection: for
 * every state the second reading can answer, the operator's word for it. What
 * it deliberately does NOT pin is that the engine reads it back — it never
 * does: no verdict, no action and no notice is taken from the ruling.
 */

const REPO = "Sanmoo/a";
const work = { ticket: githubTicket(REPO, 7), destination: githubRepository(REPO) };
const dir = `/ws/trabalhos/${REPO}#7`;

/** A PR closed without merge — the fact epic #198's one delta turns into a Block. */
const pr: PullRequestRecord = {
  number: 12,
  state: "closed",
  merged: false,
  headBranch: "msf/7",
  baseBranch: "main",
  author: "bot",
  identity: pullRequestIdentity(githubRepository(REPO), 12),
};

/** A reading without the Work it answers for: DISTRIBUTED over the union, so
 *  every literal below is checked against the arm it names. */
type WorkStateBody<T = WorkStateReading> = T extends unknown ? Omit<T, "work" | "dir"> : never;

const reading = (fields: WorkStateBody): WorkStateReading => ({ work, dir, ...fields }) as WorkStateReading;

test("the collection report names what the state already decided — one word per state", () => {
  const table: Array<[WorkStateReading, { decision: string; because: string }]> = [
    // The terminal state, by the ticket (ticket 14) and by the merge (issue 149).
    [reading({ state: "done", pr }), { decision: "done", because: "issue-closed" }],
    [
      reading({ state: "done-fallback", pr, comment: "the PR was merged without closing this issue" }),
      { decision: "done", because: "pr-merged" },
    ],
    // Parked: the human owns the PR, or the worker stopped itself (class 6).
    [reading({ state: "parked", because: "pr-open", pr }), { decision: "reserve", because: "pr-open" }],
    [
      reading({ state: "parked", because: "blocked-self-report", helpRequested: true, pr }),
      { decision: "record-only", because: "blocked-self-report" },
    ],
    // The fall ruler, applied exactly as at collection.
    [reading({ state: "fall", decision: "release", attempt: 1, pr }), { decision: "release", because: "fall-first" }],
    [
      reading({ state: "fall", decision: "block", attempt: 2, comment: "diagnosis", pr }),
      { decision: "block", because: "fall-second" },
    ],
    // No attempt consumed: the agent's interruption, a model provider failure
    // and the operator's own stop all leave the same attempt to continue.
    [reading({ state: "interrupted", attempt: 1, recovery: { decision: "recover", consumed: 1, waitMs: 1000 } as never, pr }),
      { decision: "interrupt", because: "no-outcome" }],
    [reading({ state: "model-provider-failure", attempt: 1, failure: {} as never, modelProvider: {} as never, pr }),
      { decision: "interrupt", because: "no-outcome" }],
    [reading({ state: "stop-resume", attempt: 1, because: "stop-in-progress", pr }),
      { decision: "interrupt", because: "no-outcome" }],
  ];

  for (const [state, expected] of table) {
    assert.deepEqual(projectCollectedRuling(state), expected, `${state.state}: the report names its decision`);
  }
});

test("a PR closed without merge is the Block the state declares — from both readings (D7, epic #198's delta)", () => {
  const rejection: WorkStateReading = reading({
    state: "rejected",
    pr,
    comment: "work rejected: PR #12 was closed without merging",
  });

  // The collection reports the Block the state already names; the `because`
  // names the FACT, never a fall the rejection did not write.
  assert.deepEqual(projectCollectedRuling(rejection), { decision: "block", because: "pr-closed-unmerged" });
});

test("the projection is total over the one vocabulary — no state is left unprojected", () => {
  // The states the read AFTER an attempt never answers still project (they
  // belong to the read before a launch): the collection calls the projection
  // with whatever the module answered, and a missing arm would be a hole in the
  // report rather than a compile error.
  const states: WorkStateReading[] = [
    reading({ state: "feedback", pr, createdAt: "2026-01-01T00:00:00Z" }),
    reading({ state: "resumable", pr, createdAt: "2026-01-01T00:00:00Z", issueReplies: [] }),
    reading({ state: "continuity-paused", attempt: 1, pause: { reason: "effect-ambiguous" } as never }),
    reading({ state: "stop-unconfirmed", attempt: 1, because: "the worker may be alive" }),
    reading({ state: "unreadable", because: "the tracker did not answer" }),
    reading({ state: "not-planned" }),
  ];

  for (const state of states) {
    const ruling = projectCollectedRuling(state);
    assert.equal(typeof ruling.decision, "string", `${state.state}: a decision is named`);
    assert.equal(typeof ruling.because, "string", `${state.state}: and why`);
  }
});
