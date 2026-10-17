import assert from "node:assert/strict";
import { describe, test, beforeEach, after } from "node:test";

import type {
  IssueRef,
  TrackerPort,
} from "./port.js";
import { AGENT_MARKER } from "./port.js";

/**
 * The contract suite of the tracker port: the single behavior suite that
 * every adapter must satisfy (ticket 16). The fake (in-memory) runs it in
 * `npm test`, fully offline; the real GitHub adapter runs the same suite in
 * the credential-gated smoke (`npm run smoke:github`).
 *
 * A harness abstracts what adapters cannot share: how issues, PRs, blockers
 * and comments are seeded, and how everything is reverted afterwards. The
 * real harness journals every artifact it creates and deletes them all in
 * cleanup — nothing stays behind in the target repo.
 */

export interface ContractIssue {
  ref: IssueRef;
  /** ISO 8601 creation date, when the harness can know it. */
  createdAt?: string;
}

export interface ContractHarness {
  /** Human name of the adapter under test ("fake (in-memory)", "real (gh CLI)"). */
  readonly name: string;
  readonly repo: string;
  readonly workerAccount: string;
  readonly claimedLabel: string;

  /** The adapter under test (re-created by reset, when the harness supports it). */
  getAdapter(): TrackerPort;
  /** Per-test isolation: the fake starts empty; the real adapter is a no-op. */
  reset(): Promise<void>;
  /** Create an open issue (optionally with labels, optionally already closed). */
  createIssue(input: {
    title: string;
    labels?: string[];
    closed?: boolean;
  }): Promise<ContractIssue>;
  /** A ref that is guaranteed not to exist (for unknown-is-never-absent tests). */
  missingRef(): Promise<IssueRef>;
  /** Native dependency: `blocker` blocks `ref`. */
  addBlocker(ref: IssueRef, blocker: IssueRef): Promise<void>;
  /** Comment on an issue or on a PR's conversation (prNumber as ref.number). */
  addComment(ref: IssueRef, author: string, body: string): Promise<void>;
  /** Ensure a remote branch exists with one commit beyond the base. */
  ensureBranch(branch: string, baseBranch?: string): Promise<void>;
  /** Create a PR linked to the issue ("Closes #N"), returning its number. */
  createPullRequest(issue: IssueRef, input?: { headBranch?: string; baseBranch?: string }): Promise<number>;
  /** Whether the branch exists on the remote (real) or was pushed (fake). */
  branchExists(branch: string): Promise<boolean>;
  /** Full reversion of every artifact the harness created. */
  cleanup(): Promise<void>;
}

export function runTrackerContractSuite(harness: ContractHarness): void {
  const ready = "ready-for-agent";
  const other = "other-label";

  describe(`tracker port contract — ${harness.name}`, () => {
    beforeEach(async () => {
      await harness.reset();
    });

    after(async () => {
      await harness.cleanup();
    });

    test("1. listCandidates: open issues with the ready label, excluding closed ones and PRs", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "ready one", labels: [ready] });
      await harness.createIssue({ title: "wrong label", labels: [other] });
      await harness.createIssue({ title: "closed ready", labels: [ready], closed: true });
      const prIssue = await harness.createIssue({ title: "pr holder", labels: [ready] });
      await harness.createPullRequest(prIssue.ref, { headBranch: `agent-issue-${prIssue.ref.number}` });

      const candidates = await adapter.listCandidates(harness.repo, ready);
      const numbers = candidates.map((c) => c.ref.number);
      assert.ok(numbers.includes(a.ref.number), "the ready open issue is a candidate");
      assert.ok(!numbers.includes(prIssue.ref.number), "PRs are never candidates");
      assert.ok(!candidates.some((c) => c.title === "wrong label"), "other labels are excluded");
      assert.ok(!candidates.some((c) => c.title === "closed ready"), "closed issues are excluded");
    });

    test("1. listCandidates: candidates carry createdAt for age-based priority", async () => {
      const adapter = harness.getAdapter();
      const seeded = await harness.createIssue({ title: "aged candidate", labels: [ready] });

      const candidates = await adapter.listCandidates(harness.repo, ready);
      const candidate = candidates.find((c) => c.ref.number === seeded.ref.number);

      assert.ok(candidate, "seeded issue is a candidate");
      if (seeded.createdAt !== undefined) {
        assert.equal(candidate.createdAt, seeded.createdAt);
      } else {
        assert.ok(!Number.isNaN(Date.parse(candidate.createdAt)), "createdAt is a date");
      }
    });

    test("2. readIssue: full snapshot (title, state, labels, createdAt)", async () => {
      const adapter = harness.getAdapter();
      const seeded = await harness.createIssue({ title: "do the thing", labels: [ready] });

      const issue = await adapter.readIssue(seeded.ref);

      assert.ok(issue.known, "existing issue is known");
      assert.equal(issue.value.title, "do the thing");
      assert.equal(issue.value.state, "open");
      assert.deepEqual([...issue.value.labels].sort(), [ready]);
      assert.ok(!Number.isNaN(Date.parse(issue.value.createdAt)));
    });

    test("2. readIssue: missing issue is unknown, never absent-as-empty", async () => {
      const adapter = harness.getAdapter();
      const issue = await adapter.readIssue(await harness.missingRef());
      assert.ok(!issue.known);
    });

    test("3. readBlockers: native blocked_by with each blocker's terminal state", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "blocked one" });
      const b = await harness.createIssue({ title: "the blocker", closed: true });
      await harness.addBlocker(a.ref, b.ref);

      const blockers = await adapter.readBlockers(a.ref);

      assert.ok(blockers.known);
      assert.equal(blockers.value.length, 1);
      assert.equal(blockers.value[0]?.ref.number, b.ref.number);
      assert.equal(blockers.value[0]?.state, "closed");
    });

    test("3. readBlockers: no dependencies is known-empty, not unknown", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "no blockers" });
      const blockers = await adapter.readBlockers(a.ref);
      assert.ok(blockers.known);
      assert.deepEqual(blockers.value, []);
    });

    test("4. claim: adds the claimed label + assigns the worker account", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "to claim" });

      await adapter.claim(a.ref, harness.workerAccount);

      const issue = await adapter.readIssue(a.ref);
      assert.ok(issue.known);
      assert.ok(issue.value.labels.includes(harness.claimedLabel));
      assert.deepEqual(issue.value.assignees, [harness.workerAccount]);
    });

    test("5. releaseClaim: removes only the claim mark (label + assignee of the account)", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "to release", labels: [other] });

      await adapter.claim(a.ref, harness.workerAccount);
      await adapter.releaseClaim(a.ref, harness.workerAccount);

      const issue = await adapter.readIssue(a.ref);
      assert.ok(issue.known);
      assert.ok(!issue.value.labels.includes(harness.claimedLabel), "claim label removed");
      assert.deepEqual(issue.value.assignees, []);
      assert.ok(issue.value.labels.includes(other), "unrelated labels are untouched");
    });

    test("5. releaseClaim: removing an absent claim mark is tolerated, not an error", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "never claimed" });
      await assert.doesNotReject(adapter.releaseClaim(a.ref, harness.workerAccount));
    });

    test("6. markDone: closes the issue as completed", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "to done" });

      await adapter.markDone(a.ref);

      const issue = await adapter.readIssue(a.ref);
      assert.ok(issue.known);
      assert.equal(issue.value.state, "closed");
      assert.equal(issue.value.stateReason, "completed");
    });

    test("7. comment: posts on the issue carrying the invisible agent marker", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "commented one" });

      await adapter.comment(a.ref, "fell over");

      const comments = await adapter.readComments(a.ref);
      assert.ok(comments.known);
      const ours = comments.value.find((c) => c.body.includes("fell over"));
      assert.ok(ours, "the comment is readable back");
      assert.ok(ours.body.startsWith(AGENT_MARKER), "the port carries the agent marker");
    });

    test("8. readComments: reads back issue comments with author and body", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "human feedback target" });
      await harness.addComment(a.ref, "a-human", "human feedback");

      const comments = await adapter.readComments(a.ref);
      assert.ok(comments.known);
      const ours = comments.value.find((c) => c.body === "human feedback");
      assert.ok(ours, "the human comment is readable back");
      assert.ok(ours.author.length > 0, "the author is attributed");
    });

    test("9a. readPrFeedback: reads the PR conversation of the issue's work", async () => {
      const adapter = harness.getAdapter();
      const issue = await harness.createIssue({ title: "with a PR" });
      const prNumber = await harness.createPullRequest(issue.ref, {
        headBranch: `agent-issue-${issue.ref.number}`,
      });
      await harness.addComment({ repo: harness.repo, number: prNumber }, "a-human", "fix this");

      const feedback = await adapter.readPrFeedback(issue.ref);
      assert.ok(feedback.known);
      assert.equal(feedback.value.pr?.number, prNumber);
      assert.equal(feedback.value.pr?.state, "open");
      const conversation = feedback.value.comments.find((c) => c.body === "fix this");
      assert.ok(conversation, "PR conversation comment is readable back");
    });

    test("9a. readPrFeedback: no PR is known-null, not unknown", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "no pr yet" });
      const feedback = await adapter.readPrFeedback(a.ref);
      assert.ok(feedback.known);
      assert.equal(feedback.value.pr, null);
    });

    test("9b. openPr: creates an open PR linked to the issue's branch", async () => {
      const adapter = harness.getAdapter();
      const issue = await harness.createIssue({ title: "pr comes from the port" });
      const branch = `agent-issue-${issue.ref.number}`;
      await harness.ensureBranch(branch, "main");

      const pr = await adapter.openPr({
        repo: harness.repo,
        issueNumber: issue.ref.number,
        headBranch: branch,
        baseBranch: "main",
        title: `work #${issue.ref.number}`,
      });

      assert.equal(pr.state, "open");
      assert.equal(pr.headBranch, branch);
      const feedback = await adapter.readPrFeedback(issue.ref);
      assert.ok(feedback.known, "the opened PR is linked to the issue");
      assert.equal(feedback.value.pr?.number, pr.number);
    });

    test("9c. pushBranch: the branch lands on the remote", async () => {
      const adapter = harness.getAdapter();
      const branch = `agent-issue-push-${Date.now()}`;

      const outcome = await adapter.pushBranch({ repo: harness.repo, branch });

      assert.ok(outcome.performed.length > 0);
      assert.ok(await harness.branchExists(branch), "the pushed branch exists on the remote");
    });

    test("rank: GitHub has no native priority — the honest answer is known(null)", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "ranked?" });
      const rank = await adapter.rank(a.ref);
      assert.ok(rank.known);
      assert.equal(rank.value, null);
    });

    test("writes report intents performed; confirmation stays with the re-read", async () => {
      const adapter = harness.getAdapter();
      const a = await harness.createIssue({ title: "intent report" });
      const outcome = await adapter.claim(a.ref, harness.workerAccount);
      assert.ok(Array.isArray(outcome.performed));
      assert.ok(outcome.performed.length > 0);
    });
  });
}
