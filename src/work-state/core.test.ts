import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { DEFAULT_LABELS, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET } from "../config.js";
import type { PullRequestRecord, TicketSnapshot } from "../tracker/expanded-port.js";
import type { IssueComment, PrRepairFacts } from "../tracker/port.js";
import { emptyModelProviderLedger } from "../work-record/model-provider.js";
import { emptyLedger, type RecoveryLedger } from "../work-record/recovery.js";
import { EMPTY_REPAIR_CYCLE, type RepairCycle } from "../work-record/repair.js";
import type { OutcomeRecord } from "../work-record/outcome.js";
import type { WorkRecordSnapshot } from "../work-record/record.js";
import { githubRepository, githubTicket, pullRequestIdentity } from "../tracker/identity.js";
import { deriveBeforeLaunch, type DecisionPolicy } from "./core.js";
import type { Fact, PullRequestFact, WorkFacts } from "./facts.js";
import type { WorkRef } from "./state.js";

/**
 * The decision core's own seam: the ladder over literal facts, with no port,
 * no work dir and no clock. What it pins is the shape of the decisions — the
 * order of the arms and the tables — so a case that is awkward to arrange on
 * disk is still cheap to hold down here.
 */
const REPO = "Sanmoo/a";

const ref: WorkRef = {
  work: { ticket: githubTicket(REPO, 7), destination: githubRepository(REPO) },
  dir: `/ws/trabalhos/${REPO}#7`,
};

const policy: DecisionPolicy = {
  labels: DEFAULT_LABELS,
  recovery: DEFAULT_RECOVERY_BUDGET,
  modelProvider: DEFAULT_MODEL_PROVIDER_BUDGET,
  inFlight: new Set<string>(),
};

const issue = (overrides: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  ticket: ref.work.ticket,
  title: "a title",
  body: "",
  state: "open",
  stateReason: null,
  labels: [],
  assignees: [],
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const pullRequest = (overrides: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  identity: pullRequestIdentity(githubRepository(REPO), 7),
  number: 7,
  state: "open",
  merged: false,
  headBranch: "agent-issue-7",
  baseBranch: "main",
  author: "bot",
  ...overrides,
});

const record = (overrides: Partial<WorkRecordSnapshot> = {}): WorkRecordSnapshot => ({
  workDir: ref.dir,
  attempt: null,
  outcome: null,
  ownOutcome: null,
  pause: null,
  sessionLinks: { intact: true, links: [] },
  journal: { intact: true, sessions: [], intents: [], results: [], pending: [] },
  guardrail: null,
  recovery: emptyLedger(),
  modelProvider: emptyModelProviderLedger(),
  repair: EMPTY_REPAIR_CYCLE,
  attempts: [],
  ...overrides,
});

/** A fact source that fails loudly if the ladder reads something it must not ask for. */
function quiet<T>(name: string): () => Promise<T> {
  return async () => {
    throw new Error(`the ladder read ${name} where it must decide without it`);
  };
}

function facts(overrides: Partial<WorkFacts> = {}): WorkFacts {
  return {
    ticket: quiet("the ticket"),
    comments: async (): Promise<Fact<IssueComment[]>> => ({ reading: "known", value: [] }),
    pullRequest: async (): Promise<PullRequestFact> => ({ reading: "no-pull-request" }),
    repairFacts: quiet("the repair facts"),
    record: async (): Promise<Fact<WorkRecordSnapshot>> => ({ reading: "known", value: record() }),
    modelProviderFailure: async () => null,
    recovery: async () => ({ decision: "recover", waitMs: 1_000, consumed: 1 }),
    fallenAttemptComment: async () => "the fall comment",
    unpublishedRepairComment: async () => "the repair comment",
    ...overrides,
  };
}

const known = <T>(value: T): Fact<T> => ({ reading: "known", value });

describe("the decision core — the ladder over literal facts", () => {
  test("an unreadable ticket ends the ladder: no other fact is asked, no verdict is invented", async () => {
    const reading = await deriveBeforeLaunch(
      ref,
      facts({ ticket: async () => ({ reading: "unreadable", because: "the tracker did not answer for it" }) }),
      policy,
    );

    assert.deepEqual(reading, {
      work: ref.work,
      dir: ref.dir,
      state: "unreadable",
      because: "the tracker did not answer for it",
    });
  });

  test("a closed ticket is done, and one closed as not-planned is its own state", async () => {
    const done = await deriveBeforeLaunch(ref, facts({ ticket: async () => known(issue({ state: "closed", stateReason: "completed" })) }), policy);
    const notPlanned = await deriveBeforeLaunch(
      ref,
      facts({ ticket: async () => known(issue({ state: "closed", stateReason: "not-planned" })) }),
      policy,
    );

    assert.equal(done.state, "done");
    assert.equal(notPlanned.state, "not-planned");
  });

  test("a record the factory cannot read holds the work instead of charging a recovery", async () => {
    const reading = await deriveBeforeLaunch(
      ref,
      facts({
        ticket: async () => known(issue({ labels: [DEFAULT_LABELS.claimed] })),
        record: async () => ({ reading: "unreadable", because: "the Work record could not be read (boom)" }),
        // A recovery read here would be an invented verdict: `quiet` proves it is not asked.
        recovery: quiet("the recovery ledger"),
      }),
      policy,
    );

    assert.equal(reading.state, "parked");
  });

  test("a written failure releases on the 1st fall and blocks on the 2nd consecutive one", async () => {
    const failed: OutcomeRecord = { class: "clean-without-pr", attempt: 3 };
    const ledger: RecoveryLedger = { ...emptyLedger(), attempt: 2, lastFallAttempt: 2 };
    const reproach = (recovery: RecoveryLedger) =>
      deriveBeforeLaunch(
        ref,
        facts({
          ticket: async () => known(issue({ labels: [DEFAULT_LABELS.claimed] })),
          record: async () => known(record({ attempt: 3, outcome: failed, ownOutcome: failed, recovery })),
        }),
        policy,
      );

    const first = await reproach(emptyLedger());
    const second = await reproach(ledger);

    assert.equal(first.state, "fall");
    assert.equal(first.state === "fall" && first.decision, "release", "the 1st fall releases");
    assert.equal(first.state === "fall" && first.attempt, 3);
    assert.equal(second.state, "fall");
    assert.equal(second.state === "fall" && second.decision, "block", "the 2nd consecutive fall blocks");
    assert.equal(second.state === "fall" && second.decision === "block" && second.comment, "the fall comment");
  });

  test("a claim with no evidence is attempt 1, and the recovery budget — not the fall ruler — answers it", async () => {
    const reading = await deriveBeforeLaunch(
      ref,
      facts({ ticket: async () => known(issue({ labels: [DEFAULT_LABELS.claimed] })) }),
      policy,
    );

    assert.equal(reading.state, "interrupted");
    assert.deepEqual(reading.state === "interrupted" && reading.recovery, {
      decision: "recover",
      waitMs: 1_000,
      consumed: 1,
    });
    assert.equal(reading.state === "interrupted" && reading.attempt, 1);
  });

  test("the blocked channel resumes on a human answer and parks without one", async () => {
    const answer: IssueComment = { id: "1", author: "humano", body: "go on", createdAt: "2026-01-01T00:00:00Z" };
    const marker: IssueComment = { id: "2", author: "bot", body: "<!-- msf:agent --> blocked", createdAt: "2026-01-01T00:00:01Z" };
    const blockedTicket = async () => known(issue({ labels: [DEFAULT_LABELS.blocked] }));

    const answered = await deriveBeforeLaunch(
      ref,
      facts({ ticket: blockedTicket, comments: async () => known([marker, answer]) }),
      policy,
    );
    const silent = await deriveBeforeLaunch(ref, facts({ ticket: blockedTicket, comments: async () => known([answer, marker]) }), policy);

    assert.equal(answered.state, "resumable");
    assert.deepEqual(answered.state === "resumable" && answered.issueReplies.map((comment) => comment.body), ["go on"]);
    assert.equal(silent.state, "parked", "an answer posted before the marker answers nothing");
  });

  test("a confirmed trigger opens a round; the same unrecovered evidence with a spent cap blocks", async () => {
    const repairFacts: PrRepairFacts = {
      headSha: "head-7",
      baseBranch: "main",
      baseSha: "base-7",
      mergeState: "conflicting",
      requiredChecks: [],
    };
    const openPullRequest = async (): Promise<PullRequestFact> => ({
      reading: "with-pull-request",
      pr: pullRequest(),
      feedback: { pr: pullRequest(), comments: [], reviews: [] },
    });
    const round = (cycle: RepairCycle, current: PrRepairFacts = repairFacts) =>
      deriveBeforeLaunch(
        ref,
        facts({ ticket: async () => known(issue({ labels: [DEFAULT_LABELS.claimed] })), pullRequest: openPullRequest, repairFacts: async () => known(current), record: async () => known(record({ repair: cycle })) }),
        policy,
      );

    const first = await round(EMPTY_REPAIR_CYCLE);

    assert.equal(first.state, "repair");
    assert.deepEqual(first.state === "repair" && first.trigger.reasons, ["conflicts"]);

    const spent = await round({ ...EMPTY_REPAIR_CYCLE, usedRounds: 2, lastEvidence: null });
    assert.equal(spent.state, "repair-blocked");

    const clean: PrRepairFacts = { ...repairFacts, mergeState: "mergeable", requiredChecks: [] };
    const recovered = await round({ ...EMPTY_REPAIR_CYCLE, usedRounds: 1 }, clean);
    assert.equal(recovered.state, "repair-recovered");
  });
});
