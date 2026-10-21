import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeTrackerAdapter } from "./fake-adapter.js";
import { runTrackerContractSuite, type ContractHarness } from "./contract.js";
import { legacyTrackerPort } from "./legacy-bridge.js";
import { AGENT_MARKER } from "./port.js";

/**
 * The fake adapter is the test mirror of the port (ticket 16): it satisfies
 * the same contract suite the real GitHub adapter must satisfy. The suite
 * lives in contract.ts; the harness below only seeds and asserts what the
 * fake makes cheap. Fake-specific behaviors (author attribution on seeded
 * comments, the push log) keep their own tests at the bottom.
 */

function makeHarness(): ContractHarness {
  let adapter = freshAdapter();
  let nextNumber = 1;
  let nextPrNumber = 1;
  const prByIssueNumber = new Map<number, number>();
  let missingNumber = 10_000;

  function freshAdapter(): FakeTrackerAdapter {
    return new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  }

  return {
    name: "fake (in-memory)",
    repo: "Sanmoo/fake-target",
    workerAccount: "bot-do-samuca",
    claimedLabel: "agent-claimed",
    getAdapter: () => legacyTrackerPort(adapter, adapter),
    readCost: () => adapter.readCost(),
    reset: async () => {
      adapter = freshAdapter();
      nextNumber = 1;
      nextPrNumber = 1;
      prByIssueNumber.clear();
    },
    async createIssue(input) {
      const number = nextNumber++;
      adapter.seedIssue({
        repo: "Sanmoo/fake-target",
        number,
        title: input.title,
        labels: input.labels ?? [],
        ...(input.closed ? { state: "closed" as const, stateReason: "completed" as const } : {}),
      });
      return { ref: { repo: "Sanmoo/fake-target", number }, createdAt: "2026-01-01T00:00:00Z" };
    },
    async missingRef() {
      return { repo: "Sanmoo/fake-target", number: missingNumber++ };
    },
    async addBlocker(ref, blocker) {
      adapter.addBlocker(ref, blocker);
    },
    async addComment(ref, author, body) {
      const prNumber = prByIssueNumber.get(ref.number);
      if (prNumber !== undefined) {
        adapter.addPrComment({ repo: ref.repo, prNumber }, author, body);
        return;
      }
      adapter.addComment(ref, author, body);
    },
    async ensureBranch() {
      // branches have no remote existence in the fake
    },
    async createPullRequest(issue, input) {
      const prNumber = nextPrNumber++;
      const { headBranch, baseBranch } = input ?? {};
      adapter.seedPullRequest({
        repo: issue.repo,
        number: issue.number,
        ...(headBranch === undefined ? {} : { headBranch }),
        ...(baseBranch === undefined ? {} : { baseBranch }),
      });
      // the fake numbers PRs from its own counter; read the number back
      const feedback = await adapter.readPrFeedback(issue);
      const created = feedback.known ? feedback.value.pr?.number : undefined;
      if (created === undefined) throw new Error("fake: PR did not link back to the issue");
      prByIssueNumber.set(issue.number, created);
      return created;
    },
    async branchExists(branch) {
      return adapter.pushedBranches.some((p) => p.branch === branch);
    },
    async defaultBranch() {
      return "main";
    },
    async closePullRequest(_issue, prNumber) {
      adapter.closePr({ repo: "Sanmoo/fake-target", prNumber }, { merged: false });
    },
    async cleanup() {
      // in-memory: nothing to revert
    },
    // The interruption rows: the fake can arm the real failure of one write
    // (issue 98) — the shared contract checks the surviving state with it.
    faults: () => ({
      failRemovingLabel: (label: string) => {
        adapter.failAt.add(`remove:${label}`);
      },
    }),
  };
}

runTrackerContractSuite(makeHarness());

// ---- fake-specific behaviors (not part of the shared contract) ----

test("fake keeps the author of seeded comments verbatim", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  adapter.seedIssue({ repo: "Sanmoo/a", number: 1 });
  adapter.addComment({ repo: "Sanmoo/a", number: 1 }, "samuca", "human feedback");

  const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
  assert.ok(comments.known);
  assert.equal(comments.value[0]?.author, "samuca");
});

test("fake records every pushed branch, in order", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-3" });
  await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-4" });
  assert.deepEqual(
    adapter.pushedBranches.map((p) => p.branch),
    ["agent-issue-3", "agent-issue-4"],
  );
});

test("fake comments never lose the agent marker prefix", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  adapter.seedIssue({ repo: "Sanmoo/a", number: 1 });
  await adapter.comment({ repo: "Sanmoo/a", number: 1 }, `${AGENT_MARKER} already marked`);
  const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
  assert.ok(comments.known);
  assert.equal(comments.value[0]?.body, `${AGENT_MARKER} already marked`);
});

test("fake claim swaps the ready label away (the reservation is the swap, ticket 12)", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  adapter.seedIssue({ repo: "Sanmoo/a", number: 1, labels: ["ready-for-agent", "triaged"] });
  await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca", "ready-for-agent");

  const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
  assert.ok(issue.known);
  assert.ok(!issue.value.labels.includes("ready-for-agent"), "ready label swapped away");
  assert.ok(issue.value.labels.includes("agent-claimed"));
  assert.ok(issue.value.labels.includes("triaged"), "unrelated labels are untouched");
});

test("fake claim writes the padlock first and removes the pool label last (issue 98)", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  adapter.seedIssue({ repo: "Sanmoo/a", number: 1, labels: ["ready-for-agent"] });

  const outcome = await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca", "ready-for-agent");

  // The fake's intent list IS its write order: the claim label lands first (the
  // padlock), the pool label leaves last.
  assert.deepEqual(outcome.performed, [
    "label+agent-claimed on Sanmoo/a#1",
    "assignee bot-do-samuca",
    "label-ready-for-agent on Sanmoo/a#1",
  ]);
});

test("fake claim: an absent ready label is tolerated, not an error", async () => {
  const adapter = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
  adapter.seedIssue({ repo: "Sanmoo/a", number: 1 });
  await assert.doesNotReject(
    adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca", "ready-for-agent"),
  );
  const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
  assert.ok(issue.known && issue.value.labels.includes("agent-claimed"));
});
