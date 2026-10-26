import assert from "node:assert/strict";
import { test } from "node:test";

import { projectCollectedRuling, type CollectedRulingReport } from "./ruling.js";
import { githubRepository, githubTicket, pullRequestIdentity } from "../tracker/identity.js";
import type { PullRequestRecord } from "../tracker/expanded-port.js";
import type { AfterAttemptReading, WorkStateReading } from "../work-state/state.js";

/**
 * `SweepResult.collected[].ruling`.
 *
 * The engine decides in ONE vocabulary — the Work state the module answers with
 * — and the report keeps the shape the e2e suites have always asserted:
 * `decision` / `because`. That report is a PROJECTION of the decided state,
 * computed once where the result is built. This file pins the projection: for
 * every state the second reading can answer, the operator's word for it, and
 * — by the compiler — that it cannot be asked about the states the second
 * reading never answers (a failed read and a not-planned issue are NOT
 * interruptions; the projection used to invent that word for them). What it
 * deliberately does NOT pin is that the engine reads the report back — it never
 * does: no verdict, no action and no notice is taken from the ruling.
 */

const REPO = "Sanmoo/a";
const work = { ticket: githubTicket(REPO, 7), destination: githubRepository(REPO) };
const dir = `/ws/trabalhos/${REPO}#7`;

/** A PR closed without merge — the fact the state turns into a Block. */
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

/** The same literal, as the read after an Attempt types it. */
const collected = (fields: WorkStateBody<AfterAttemptReading>): AfterAttemptReading =>
  reading(fields) as AfterAttemptReading;

test("the collection report names what the state already decided — one word per state", () => {
  const table: Array<[AfterAttemptReading, CollectedRulingReport]> = [
    // The terminal state, by the ticket and by the merge.
    [collected({ state: "done", pr }), { decision: "done", because: "issue-closed" }],
    [
      collected({ state: "done-fallback", pr, comment: "the PR was merged without closing this issue" }),
      { decision: "done", because: "pr-merged" },
    ],
    // Parked: the human owns the PR, or the worker stopped itself (class 6).
    [collected({ state: "parked", because: "pr-open", pr }), { decision: "reserve", because: "pr-open" }],
    [
      collected({ state: "parked", because: "blocked-self-report", helpRequested: true, pr }),
      { decision: "record-only", because: "blocked-self-report" },
    ],
    // The fall ruler, applied exactly as at collection.
    [collected({ state: "fall", decision: "release", attempt: 1, pr }), { decision: "release", because: "fall-first" }],
    [
      collected({ state: "fall", decision: "block", attempt: 2, comment: "diagnosis", pr }),
      { decision: "block", because: "fall-second" },
    ],
    // No attempt consumed: the agent's interruption, a model provider failure
    // and the operator's own stop all leave the same attempt to continue.
    [
      collected({ state: "interrupted", attempt: 1, recovery: { decision: "recover", consumed: 1, waitMs: 1000 } as never, pr }),
      { decision: "interrupt", because: "no-outcome" },
    ],
    [
      collected({ state: "model-provider-failure", attempt: 1, failure: {} as never, modelProvider: {} as never, pr }),
      { decision: "interrupt", because: "no-outcome" },
    ],
    [collected({ state: "stop-resume", attempt: 1, because: "stop-in-progress", pr }), { decision: "interrupt", because: "no-outcome" }],
  ];

  for (const [state, expected] of table) {
    assert.deepEqual(projectCollectedRuling(state), expected, `${state.state}: the report names its decision`);
  }
});

test("a PR closed without merge is the Block the state declares — from both readings", () => {
  const rejection = collected({
    state: "rejected",
    pr,
    comment: "work rejected: PR #12 was closed without merging",
  });

  // The collection reports the Block the state already names; the `because`
  // names the FACT, never a fall the rejection did not write.
  assert.deepEqual(projectCollectedRuling(rejection), { decision: "block", because: "pr-closed-unmerged" });
});

test("every report word comes from the projection — no decision is carried in by a state", () => {
  const words = new Set(["reserve", "record-only", "release", "block", "interrupt", "done"]);
  for (const state of [
    collected({ state: "done", pr }),
    collected({ state: "parked", because: "pr-open", pr }),
    collected({ state: "fall", decision: "release", attempt: 1, pr }),
    collected({ state: "interrupted", attempt: 1, recovery: {} as never, pr }),
    collected({ state: "rejected", pr, comment: "closed" }),
  ] satisfies AfterAttemptReading[]) {
    const report = projectCollectedRuling(state);
    assert.equal(words.has(report.decision), true, `${state.state}: ${report.decision} is not the report's word`);
    assert.equal(typeof report.because, "string", `${state.state}: and why`);
  }
});

test("the impossible cases are not projected at all — the compiler refuses the question", () => {
  // The states of the read BEFORE a launch are facts a collection never
  // answers. They used to be projected as `interrupt/no-outcome`, which
  // contradicts facts.ts (a failed read never becomes an invented verdict) and
  // the GLOSSARY (an Interruption is an attempt with no outcome record). The
  // input type now excludes them, so the pin is the `@ts-expect-error`: if the
  // projection widens again, tsc fails on an unused directive.
  const askAboutTheUnanswerable = (): CollectedRulingReport => {
    // @ts-expect-error — a continuity pause belongs to the read before a launch, never to a collection
    return projectCollectedRuling(reading({ state: "continuity-paused", attempt: 1, pause: { reason: "effect-ambiguous" } as never }));
  };

  assert.equal(typeof askAboutTheUnanswerable, "function", "the case above is a compile-time pin");
});
