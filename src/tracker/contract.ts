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
 * `npm test`, fully offline; the real GitHub adapter runs the same checks in
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
  /** Close a PR WITHOUT merging it (the rejection shape; reopenPr's opposite). */
  closePullRequest(issue: IssueRef, prNumber: number): Promise<void>;
  /** Whether the branch exists on the remote (real) or was pushed (fake). */
  branchExists(branch: string): Promise<boolean>;
  /** Full reversion of every artifact the harness created (idempotent). */
  cleanup(): Promise<void>;
}

const ready = "ready-for-agent";
const other = "other-label";
const blocked = "agent-blocked";

/** The checks, in port order. Each check is self-contained: it seeds what it needs. */
export function contractChecks(harness: ContractHarness): { name: string; run: () => Promise<void> }[] {
  const adapter = () => harness.getAdapter();
  return [
    {
      name: "1. listCandidates: open issues with the ready label, excluding closed ones",
      run: async () => {
        const a = await harness.createIssue({ title: `ready one ${harness.name}`, labels: [ready] });
        await harness.createIssue({ title: `wrong label ${harness.name}`, labels: [other] });
        await harness.createIssue({ title: `closed ready ${harness.name}`, labels: [ready], closed: true });

        const candidates = await adapter().listCandidates(harness.repo, ready);
        const numbers = candidates.map((c) => c.ref.number);
        assert.ok(numbers.includes(a.ref.number), "the ready open issue is a candidate");
        assert.ok(!candidates.some((c) => c.title === `wrong label ${harness.name}`), "other labels are excluded");
        assert.ok(!candidates.some((c) => c.title === `closed ready ${harness.name}`), "closed issues are excluded");
        // PRs themselves never appear: the REST issue listing only lists issues (the
        // v1 REST adapter filtered the pull_request key of the same endpoint).
        // An issue WITH a linked PR is still a listing item — the factory
        // excludes it later through the derived PR-open state (tickets 12/14).
      },
    },
    {
      name: "1. listCandidates: candidates carry createdAt for age-based priority",
      run: async () => {
        const seeded = await harness.createIssue({ title: `aged candidate ${harness.name}`, labels: [ready] });
        const candidates = await adapter().listCandidates(harness.repo, ready);
        const candidate = candidates.find((c) => c.ref.number === seeded.ref.number);
        assert.ok(candidate, "seeded issue is a candidate");
        if (seeded.createdAt !== undefined) {
          assert.equal(candidate.createdAt, seeded.createdAt);
        } else {
          assert.ok(!Number.isNaN(Date.parse(candidate.createdAt)), "createdAt is a date");
        }
      },
    },
    {
      name: "1. listCandidates: a JUST-created issue is a candidate on the first call — no settle",
      run: async () => {
        // The dialect proof (ticket 16 smoke fix): on real GitHub the old
        // label-filtered listing lagged minutes behind a fresh label (search
        // index); the unfiltered open-issues listing is immediate. The
        // candidates read that follows the create must therefore need no
        // bounded wait at all — one call, the issue is right there.
        const seeded = await harness.createIssue({ title: `just labeled ${harness.name}`, labels: [ready] });
        const candidates = await adapter().listCandidates(harness.repo, ready);
        const candidate = candidates.find((c) => c.ref.number === seeded.ref.number);
        assert.ok(candidate, "a just-created ready-labeled issue is returned by the FIRST candidates call (no settle needed)");
      },
    },
    {
      name: "2. readIssue: full snapshot (title, state, labels, createdAt)",
      run: async () => {
        const seeded = await harness.createIssue({ title: `do the thing ${harness.name}`, labels: [ready] });
        const issue = await adapter().readIssue(seeded.ref);
        assert.ok(issue.known, "existing issue is known");
        assert.equal(issue.value.title, `do the thing ${harness.name}`);
        assert.equal(issue.value.state, "open");
        assert.deepEqual([...issue.value.labels].sort(), [ready]);
        assert.ok(!Number.isNaN(Date.parse(issue.value.createdAt)));
      },
    },
    {
      name: "2. readIssue: missing issue is unknown, never absent-as-empty",
      run: async () => {
        const issue = await adapter().readIssue(await harness.missingRef());
        assert.ok(!issue.known);
      },
    },
    {
      name: "3. readBlockers: native blocked_by with each blocker's terminal state",
      run: async () => {
        const a = await harness.createIssue({ title: `blocked one ${harness.name}` });
        const b = await harness.createIssue({ title: `the blocker ${harness.name}`, closed: true });
        await harness.addBlocker(a.ref, b.ref);
        const blockers = await adapter().readBlockers(a.ref);
        assert.ok(blockers.known);
        assert.equal(blockers.value.length, 1);
        assert.equal(blockers.value[0]?.ref.number, b.ref.number);
        assert.equal(blockers.value[0]?.state, "closed");
      },
    },
    {
      name: "3. readBlockers: no dependencies is known-empty, not unknown",
      run: async () => {
        const a = await harness.createIssue({ title: `no blockers ${harness.name}` });
        const blockers = await adapter().readBlockers(a.ref);
        assert.ok(blockers.known);
        assert.deepEqual(blockers.value, []);
      },
    },
    {
      name: "4. claim: adds the claimed label + assigns the worker account",
      run: async () => {
        const a = await harness.createIssue({ title: `to claim ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(harness.claimedLabel));
        assert.deepEqual(issue.value.assignees, [harness.workerAccount]);
      },
    },
    {
      name: "4. claim: swaps the ready label away (the reservation is the swap)",
      run: async () => {
        const a = await harness.createIssue({ title: `to swap ${harness.name}`, labels: [ready, other] });
        await adapter().claim(a.ref, harness.workerAccount, ready);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(!issue.value.labels.includes(ready), "the ready label is swapped away");
        assert.ok(issue.value.labels.includes(harness.claimedLabel));
        assert.ok(issue.value.labels.includes(other), "unrelated labels are untouched");
      },
    },
    {
      name: "4. claim: an absent ready label is tolerated, not an error",
      run: async () => {
        const a = await harness.createIssue({ title: `no ready label ${harness.name}` });
        await assert.doesNotReject(adapter().claim(a.ref, harness.workerAccount, ready));
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(harness.claimedLabel));
      },
    },
    {
      name: "5. releaseClaim: removes only the claim mark (label + assignee of the account)",
      run: async () => {
        const a = await harness.createIssue({ title: `to release ${harness.name}`, labels: [other] });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().releaseClaim(a.ref, harness.workerAccount);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(!issue.value.labels.includes(harness.claimedLabel), "claim label removed");
        assert.deepEqual(issue.value.assignees, []);
        assert.ok(issue.value.labels.includes(other), "unrelated labels are untouched");
      },
    },
    {
      name: "5. releaseClaim: removing an absent claim mark is tolerated, not an error",
      run: async () => {
        const a = await harness.createIssue({ title: `never claimed ${harness.name}` });
        await assert.doesNotReject(adapter().releaseClaim(a.ref, harness.workerAccount));
      },
    },
    {
      name: "5. releaseClaim with a ready label swaps claimed→ready (the work re-enters the pool)",
      run: async () => {
        const a = await harness.createIssue({ title: `released to pool ${harness.name}`, labels: [other] });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().releaseClaim(a.ref, harness.workerAccount, ready);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(ready), "the ready label is back");
        assert.ok(!issue.value.labels.includes(harness.claimedLabel), "the claim is gone");
        assert.deepEqual(issue.value.assignees, [], "the assignee is gone");
        assert.ok(issue.value.labels.includes(other), "unrelated labels are untouched");
      },
    },
    {
      name: "5c. resumeClaim: swaps blocked→claimed (the retomada's swap, ticket 14)",
      run: async () => {
        const a = await harness.createIssue({ title: `to resume ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().blockClaim(a.ref, harness.claimedLabel, blocked);

        const outcome = await adapter().resumeClaim(a.ref, blocked, harness.claimedLabel);

        assert.ok(outcome.performed.length > 0);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(!issue.value.labels.includes(blocked), "the blocked label swapped away");
        assert.ok(issue.value.labels.includes(harness.claimedLabel), "the claim is held again");
        assert.deepEqual(issue.value.assignees, [harness.workerAccount], "the assignee stays");
      },
    },
    {
      name: "5c. resumeClaim: a blocked label already gone is tolerated, not an error",
      run: async () => {
        const a = await harness.createIssue({ title: `resume without blocked ${harness.name}` });
        await assert.doesNotReject(adapter().resumeClaim(a.ref, blocked, harness.claimedLabel));
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known && issue.value.labels.includes(harness.claimedLabel));
      },
    },
    {
      name: "5b. blockClaim: swaps claimed→blocked, the claim held until the terminal state",
      run: async () => {
        const a = await harness.createIssue({ title: `to block ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().blockClaim(a.ref, harness.claimedLabel, blocked);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(!issue.value.labels.includes(harness.claimedLabel), "claimed swapped away");
        assert.ok(issue.value.labels.includes(blocked), "the blocked label on");
        assert.deepEqual(issue.value.assignees, [harness.workerAccount], "the claim stays held");
      },
    },
    {
      name: "5b. blockClaim: an absent claimed label is tolerated, not an error",
      run: async () => {
        const a = await harness.createIssue({ title: `never claimed, blocked ${harness.name}` });
        await assert.doesNotReject(adapter().blockClaim(a.ref, harness.claimedLabel, blocked));
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(blocked), "the blocked label lands anyway");
      },
    },
    {
      name: "6. markDone: closes the issue as completed",
      run: async () => {
        const a = await harness.createIssue({ title: `to done ${harness.name}` });
        await adapter().markDone(a.ref);
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.equal(issue.value.state, "closed");
        assert.equal(issue.value.stateReason, "completed");
      },
    },
    {
      name: "7. comment: posts on the issue carrying the invisible agent marker",
      run: async () => {
        const a = await harness.createIssue({ title: `commented one ${harness.name}` });
        await adapter().comment(a.ref, "fell over");
        const comments = await adapter().readComments(a.ref);
        assert.ok(comments.known);
        const ours = comments.value.find((c) => c.body.includes("fell over"));
        assert.ok(ours, "the comment is readable back");
        assert.ok(ours.body.startsWith(AGENT_MARKER), "the port carries the agent marker");
      },
    },
    {
      name: "8. readComments: reads back issue comments with author and body",
      run: async () => {
        const a = await harness.createIssue({ title: `human feedback target ${harness.name}` });
        await harness.addComment(a.ref, "a-human", "human feedback");
        const comments = await adapter().readComments(a.ref);
        assert.ok(comments.known);
        const ours = comments.value.find((c) => c.body === "human feedback");
        assert.ok(ours, "the human comment is readable back");
        assert.ok(ours.author.length > 0, "the author is attributed");
      },
    },
    {
      name: "9a. readPrFeedback: reads the PR conversation of the issue's work",
      run: async () => {
        const issue = await harness.createIssue({ title: `with a PR ${harness.name}` });
        const prNumber = await harness.createPullRequest(issue.ref, {
          headBranch: `agent-issue-${issue.ref.number}`,
        });
        await harness.addComment({ repo: harness.repo, number: prNumber }, "a-human", "fix this");
        const feedback = await adapter().readPrFeedback(issue.ref);
        assert.ok(feedback.known);
        assert.equal(feedback.value.pr?.number, prNumber);
        assert.equal(feedback.value.pr?.state, "open");
        const conversation = feedback.value.comments.find((c) => c.body === "fix this");
        assert.ok(conversation, "PR conversation comment is readable back");
      },
    },
    {
      name: "9a. readPrFeedback: no PR is known-null, not unknown",
      run: async () => {
        const a = await harness.createIssue({ title: `no pr yet ${harness.name}` });
        const feedback = await adapter().readPrFeedback(a.ref);
        assert.ok(feedback.known);
        assert.equal(feedback.value.pr, null);
      },
    },
    {
      name: "9b. openPr: creates an open PR linked to the issue's branch",
      run: async () => {
        const issue = await harness.createIssue({ title: `pr comes from the port ${harness.name}` });
        const branch = `agent-issue-${issue.ref.number}`;
        await harness.ensureBranch(branch, "main");
        const pr = await adapter().openPr({
          repo: harness.repo,
          issueNumber: issue.ref.number,
          headBranch: branch,
          baseBranch: "main",
          title: `work #${issue.ref.number}`,
        });
        assert.equal(pr.state, "open");
        assert.equal(pr.headBranch, branch);
        const feedback = await adapter().readPrFeedback(issue.ref);
        assert.ok(feedback.known, "the opened PR is linked to the issue");
        assert.equal(feedback.value.pr?.number, pr.number);
      },
    },
    {
      name: "9c. pushBranch: the branch lands on the remote",
      run: async () => {
        const branch = `agent-issue-push-${Date.now()}`;
        const outcome = await adapter().pushBranch({ repo: harness.repo, branch });
        assert.ok(outcome.performed.length > 0);
        assert.ok(await harness.branchExists(branch), "the pushed branch exists on the remote");
      },
    },
    {
      name: "9d. reopenPr: the SAME PR back to open (the rejection's retomada, ticket 14)",
      run: async () => {
        const issue = await harness.createIssue({ title: `rejected work ${harness.name}` });
        const branch = `agent-issue-${issue.ref.number}`;
        await harness.ensureBranch(branch, "main");
        const prNumber = await harness.createPullRequest(issue.ref, { headBranch: branch });
        await harness.closePullRequest(issue.ref, prNumber);

        const outcome = await adapter().reopenPr(issue.ref);

        assert.ok(outcome.performed.length > 0);
        const feedback = await adapter().readPrFeedback(issue.ref);
        assert.ok(feedback.known && feedback.value.pr);
        assert.equal(feedback.value.pr.number, prNumber, "the SAME PR, never a new one");
        assert.equal(feedback.value.pr.state, "open");
      },
    },
    {
      name: "9d. reopenPr: no PR linked is tolerated, not an error",
      run: async () => {
        const a = await harness.createIssue({ title: `no pr to reopen ${harness.name}` });
        const outcome = await adapter().reopenPr(a.ref);
        assert.ok(Array.isArray(outcome.performed));
      },
    },
    {
      name: "rank: GitHub has no native priority — the honest answer is known(null)",
      run: async () => {
        const a = await harness.createIssue({ title: `ranked? ${harness.name}` });
        const rank = await adapter().rank(a.ref);
        assert.ok(rank.known);
        assert.equal(rank.value, null);
      },
    },
    {
      name: "writes report intents performed; confirmation stays with the re-read",
      run: async () => {
        const a = await harness.createIssue({ title: `intent report ${harness.name}` });
        const outcome = await adapter().claim(a.ref, harness.workerAccount);
        assert.ok(Array.isArray(outcome.performed));
        assert.ok(outcome.performed.length > 0);
      },
    },
  ];
}

/** Run all checks sequentially against one harness — the smoke's path. */
export async function runContractChecks(harness: ContractHarness): Promise<void> {
  await harness.reset();
  for (const check of contractChecks(harness)) {
    await check.run();
    console.log(`  ✔ ${check.name}`);
  }
}

/** Run all checks as a node:test suite — the `npm test` path (the fake). */
export function runTrackerContractSuite(harness: ContractHarness): void {
  describe(`tracker port contract — ${harness.name}`, () => {
    beforeEach(async () => {
      await harness.reset();
    });
    after(async () => {
      await harness.cleanup();
    });
    for (const check of contractChecks(harness)) {
      test(check.name, async () => {
        await check.run();
      });
    }
  });
}
