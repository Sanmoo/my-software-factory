import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import { FakeTrackerAdapter, seedIssue } from "./fake-adapter.js";
import { AGENT_MARKER } from "./port.js";

describe("fake tracker adapter — the 9 operations + rank", () => {
  let adapter: FakeTrackerAdapter;

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  });

  test("1. listCandidates: open issues with the ready label, excluding PRs", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: ["ready-for-agent"] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: ["other"] });
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 3,
      labels: ["ready-for-agent"],
      state: "closed",
    });
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 4, labels: ["ready-for-agent"] });

    const candidates = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");

    assert.deepEqual(
      candidates.map((c) => c.ref.number),
      [1],
    );
  });

  test("1. listCandidates: candidates carry createdAt for age-based priority", async () => {
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 7,
      labels: ["ready-for-agent"],
      createdAt: "2026-01-02T00:00:00Z",
    });

    const [candidate] = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");

    assert.equal(candidate?.createdAt, "2026-01-02T00:00:00Z");
  });

  test("2. readIssue: full snapshot (labels, assignees, state, createdAt, title)", async () => {
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 5,
      title: "do the thing",
      labels: ["ready-for-agent"],
      createdAt: "2026-01-01T10:00:00Z",
    });

    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 5 });

    assert.ok(issue.known);
    assert.equal(issue.value.title, "do the thing");
    assert.equal(issue.value.state, "open");
    assert.deepEqual(issue.value.labels, ["ready-for-agent"]);
    assert.equal(issue.value.createdAt, "2026-01-01T10:00:00Z");
  });

  test("2. readIssue: missing issue is unknown, never absent-as-empty", async () => {
    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 999 });
    assert.ok(!issue.known);
  });

  test("3. readBlockers: native blocked_by with each blocker's terminal state", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: ["ready-for-agent"] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, state: "closed" });
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 2 });

    const blockers = await adapter.readBlockers({ repo: "Sanmoo/a", number: 1 });

    assert.ok(blockers.known);
    assert.equal(blockers.value.length, 1);
    assert.equal(blockers.value[0]?.ref.number, 2);
    assert.equal(blockers.value[0]?.state, "closed");
  });

  test("3. readBlockers: no dependencies is known-empty, not unknown", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });
    const blockers = await adapter.readBlockers({ repo: "Sanmoo/a", number: 1 });
    assert.ok(blockers.known);
    assert.deepEqual(blockers.value, []);
  });

  test("4. claim: adds the claimed label + assigns the worker account", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });

    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");

    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(issue.known);
    assert.ok(issue.value.labels.includes("agent-claimed"));
    assert.deepEqual(issue.value.assignees, ["bot-do-samuca"]);
  });

  test("5. releaseClaim: removes only the claim mark (label + assignee of the account)", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: ["other"] });

    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    await adapter.releaseClaim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");

    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(issue.known);
    assert.ok(!issue.value.labels.includes("agent-claimed"));
    assert.deepEqual(issue.value.assignees, []);
    assert.ok(issue.value.labels.includes("other"), "unrelated labels are untouched");
  });

  test("5. releaseClaim: removing an absent claim mark is tolerated, not an error", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });
    await assert.doesNotReject(
      adapter.releaseClaim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca"),
    );
  });

  test("6. markDone: closes the issue as completed", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });

    await adapter.markDone({ repo: "Sanmoo/a", number: 1 });

    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(issue.known);
    assert.equal(issue.value.state, "closed");
    assert.equal(issue.value.stateReason, "completed");
  });

  test("7. comment: posts on the issue carrying the invisible agent marker", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });

    await adapter.comment({ repo: "Sanmoo/a", number: 1 }, "fell over");

    const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
    assert.ok(comments.known);
    assert.equal(comments.value.length, 1);
    assert.ok(comments.value[0]?.body.startsWith(AGENT_MARKER));
    assert.ok(comments.value[0]?.body.includes("fell over"));
  });

  test("8. readComments: reads back issue comments with author and body", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });
    adapter.addComment({ repo: "Sanmoo/a", number: 1 }, "samuca", "human feedback");

    const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
    assert.ok(comments.known);
    assert.equal(comments.value[0]?.author, "samuca");
    assert.equal(comments.value[0]?.body, "human feedback");
  });

  test("9a. readPrFeedback: reads the PR conversation of the issue's work", async () => {
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 3, headBranch: "agent-issue-3" });
    adapter.addPrComment({ repo: "Sanmoo/a", prNumber: 3 }, "samuca", "fix this");

    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 3 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.number, 3);
    assert.equal(feedback.value.pr?.state, "open");
    assert.equal(feedback.value.comments[0]?.author, "samuca");
  });

  test("9a. readPrFeedback: no PR is known-null, not unknown", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 3 });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 3 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr, null);
  });

  test("9b. openPr: creates an open PR linked to the issue's branch", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 3 });
    const pr = await adapter.openPr({
      repo: "Sanmoo/a",
      issueNumber: 3,
      headBranch: "agent-issue-3",
      baseBranch: "main",
      title: "fix #3",
    });

    assert.equal(pr.state, "open");
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 3 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.number, pr.number);
  });

  test("9c. pushBranch: records the branch push per repo", async () => {
    await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-3" });
    assert.deepEqual(adapter.pushedBranches, [{ repo: "Sanmoo/a", branch: "agent-issue-3" }]);
  });

  test("rank: GitHub has no native priority — the honest answer is known(null)", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });
    const rank = await adapter.rank({ repo: "Sanmoo/a", number: 1 });
    assert.ok(rank.known);
    assert.equal(rank.value, null);
  });

  test("writes report intents performed; confirmation stays with the re-read", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1 });
    const outcome = await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    assert.ok(Array.isArray(outcome.performed));
    assert.ok(outcome.performed.length > 0);
  });
});
