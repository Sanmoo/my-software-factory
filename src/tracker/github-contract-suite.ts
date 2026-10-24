import assert from "node:assert/strict";
import { describe, test, beforeEach, after } from "node:test";

import type { Labels } from "../config.js";
import type {
  IssueRef,
  ReadCost,
  TrackerPort,
} from "./port.js";
import type { TicketTracker } from "./expanded-port.js";
import { AGENT_MARKER } from "./port.js";

/**
 * The GitHub adapter's contract suite. The checks here are GitHub-specific by
 * construction: the fake (in-memory GitHub adapter) runs them in `npm test`,
 * fully offline, and the real GitHub adapter runs the same checks in the
 * credential-gated smoke.
 *
 * Rules that only GitHub can satisfy — no native Rank, completion by closing
 * an issue — live in `githubOnlyChecks` below. A Jira ticket adapter is never
 * asked to emulate them; the provider-neutral expanded contracts are exercised
 * in `expanded-contract.test.ts`.
 *
 * A harness abstracts what adapters cannot share: how issues, PRs, blockers
 * and comments are seeded, and how everything is reverted afterwards. The
 * real harness journals every artifact it creates and deletes them all in
 * cleanup — nothing stays behind in the target repo.
 */

export interface GitHubContractIssue {
  ref: IssueRef;
  /** ISO 8601 creation date, when the harness can know it. */
  createdAt?: string;
}

export interface GitHubContractHarness {
  /** Human name of the adapter under test ("fake (in-memory)", "real (gh CLI)"). */
  readonly name: string;
  readonly repo: string;
  readonly workerAccount: string;
  readonly claimedLabel: string;

  /** The adapter under test (re-created by reset, when the harness supports it).
   *  It serves the legacy port and the expanded ticket contract: the same
   *  adapter, never a second implementation. */
  getAdapter(): TrackerPort & TicketTracker;
  /** Per-test isolation: the fake starts empty; the real adapter is a no-op. */
  reset(): Promise<void>;
  /** Create an open issue (optionally with labels, optionally already closed). */
  createIssue(input: {
    title: string;
    labels?: string[];
    closed?: boolean;
  }): Promise<GitHubContractIssue>;
  /** A ref that is guaranteed not to exist (for unknown-is-never-absent tests). */
  missingRef(): Promise<IssueRef>;
  /** Native dependency: `blocker` blocks `ref`. */
  addBlocker(ref: IssueRef, blocker: IssueRef): Promise<void>;
  /** Comment on an issue or on a PR's conversation (prNumber as ref.number). */
  addComment(ref: IssueRef, author: string, body: string): Promise<void>;
  /** Ensure a remote branch exists with one commit beyond the base. */
  ensureBranch(branch: string, baseBranch?: string): Promise<void>;
  /** GitHub-only seeding: create a PR linked to the issue by the GitHub
   *  issue-closing syntax, returning its number. A non-GitHub adapter never
   *  implements this harness. */
  createPullRequest(issue: IssueRef, input?: { headBranch?: string; baseBranch?: string }): Promise<number>;
  /** Close a PR WITHOUT merging it (the rejection shape; reopenPr's opposite). */
  closePullRequest(issue: IssueRef, prNumber: number): Promise<void>;
  /** Whether the branch exists on the remote (real) or was pushed (fake). */
  branchExists(branch: string): Promise<boolean>;
  /** The PR base branch: the repo's default (the real harness resolves it,
   *  the in-memory harnesses know theirs). */
  defaultBranch(): Promise<string>;
  /** Full reversion of every artifact the harness created (idempotent). */
  cleanup(): Promise<void>;
  /** Optional fault injection: harnesses that control the adapter's seam can
   *  make ONE write fail with a REAL error — never the tolerated absent-label
   *  case. The live smoke harness cannot and omits it; its interruption checks
   *  are skipped. */
  faults?(): GitHubContractFaults;
  /** Optional read-cost surface: whole-repo listings and per-issue
   *  reads served since reset; a harness that cannot count omits it. */
  readCost?(): ReadCost;
}

export interface GitHubContractFaults {
  /** Make the NEXT removal of this label fail with a real error. */
  failRemovingLabel(label: string): void;
}

const ready = "ready-for-agent";
const other = "other-label";
const blocked = "agent-blocked";

/** The checks, in port order. Each check is self-contained: it seeds what it needs. */
function githubContractChecks(harness: GitHubContractHarness): { name: string; run: () => Promise<void> }[] {
  const adapter = () => harness.getAdapter();
  /** The bundled 3-label vocabulary the multi-label transitions take (the
   *  harness's claimed label + this suite's ready/blocked constants). */
  const labels: Labels = { ready, claimed: harness.claimedLabel, blocked };
  return [
    {
      name: "1. listOpenIssues: every open issue with its labels — closed out, PRs never listed",
      run: async () => {
        const open = await harness.createIssue({ title: `open one ${harness.name}`, labels: [ready, other] });
        const unlabeled = await harness.createIssue({ title: `open two ${harness.name}` });
        await harness.createIssue({ title: `closed one ${harness.name}`, labels: [ready], closed: true });
        // a linked PR is still an issue in the listing — the derivation decides
        await harness.createPullRequest(open.ref);

        const issues = await adapter().listOpenIssues(harness.repo);
        const numbers = issues.map((issue) => issue.ref.number);
        assert.ok(numbers.includes(open.ref.number), "the open labeled issue is listed");
        assert.ok(
          numbers.includes(unlabeled.ref.number),
          "the neutral read filters NO label — every open issue is listed",
        );
        assert.ok(!issues.some((issue) => issue.title === `closed one ${harness.name}`), "closed issues are excluded");
        assert.equal(issues.length, 2, "only the two open issues — the PR itself is never an issue item");
        const first = issues.find((issue) => issue.ref.number === open.ref.number);
        assert.ok(first);
        assert.deepEqual([...first.labels].sort(), [other, ready].sort(), "ALL labels travel, not just the ready one");
      },
    },
    {
      name: "1. listOpenIssues: ref, title and createdAt for age-based priority",
      run: async () => {
        const seeded = await harness.createIssue({ title: `aged issue ${harness.name}`, labels: [ready] });
        const issues = await adapter().listOpenIssues(harness.repo);
        const issue = issues.find((i) => i.ref.number === seeded.ref.number);
        assert.ok(issue, "seeded issue is in the read");
        assert.equal(issue.title, `aged issue ${harness.name}`);
        assert.deepEqual(issue.ref, seeded.ref);
        if (seeded.createdAt !== undefined) {
          assert.equal(issue.createdAt, seeded.createdAt);
        } else {
          assert.ok(!Number.isNaN(Date.parse(issue.createdAt)), "createdAt is a date");
        }
      },
    },
    {
      name: "1. listOpenIssues: a JUST-created issue appears on the first call — no settle",
      run: async () => {
        // The dialect proof: on real GitHub the old
        // label-filtered listing lagged minutes behind a fresh label (search
        // index); the unfiltered open-issues listing is immediate. The read
        // that follows the create must therefore need no bounded wait at all
        // — one call, the issue is right there.
        const seeded = await harness.createIssue({ title: `just labeled ${harness.name}`, labels: [ready] });
        const issues = await adapter().listOpenIssues(harness.repo);
        assert.ok(
          issues.some((issue) => issue.ref.number === seeded.ref.number),
          "a just-created issue is in the FIRST read (no settle needed)",
        );
      },
    },
    {
      name: "1. listOpenIssues: the open-PR linkage is resolved per issue — hasOpenPr, not a filtered listing",
      run: async () => {
        // The derivation owns the rule; the adapter only resolves the
        // linkage (structurally in the fake, from the open PRs in the real one).
        const withPr = await harness.createIssue({ title: `has a PR ${harness.name}`, labels: [ready] });
        const withoutPr = await harness.createIssue({ title: `no PR ${harness.name}`, labels: [ready] });
        await harness.createPullRequest(withPr.ref);
        const issues = await adapter().listOpenIssues(harness.repo);
        const linked = issues.find((i) => i.ref.number === withPr.ref.number);
        const unlinked = issues.find((i) => i.ref.number === withoutPr.ref.number);
        assert.ok(linked && unlinked, "both issues are listed");
        assert.equal(linked.hasOpenPr, true, "the issue linked by an OPEN PR is still listed, flagged");
        assert.equal(unlinked.hasOpenPr, false, "the PR-less issue is not flagged");
      },
    },
    {
      name: "1. listOpenIssues: ONE whole-repo read — one issues listing + at most one open-PRs listing, no per-issue reread",
      run: async () => {
        const readCost = harness.readCost?.bind(harness);
        if (!readCost) return; // a harness that cannot count cannot pin the cost
        const before = readCost();
        await harness.createIssue({ title: `cost one ${harness.name}`, labels: [ready] });
        await harness.createIssue({ title: `cost two ${harness.name}`, labels: [other] });

        await adapter().listOpenIssues(harness.repo);

        const after = readCost();
        const delta = {
          issueListings: after.issueListings - before.issueListings,
          pullListings: after.pullListings - before.pullListings,
          issueReads: after.issueReads - before.issueReads,
        };
        assert.equal(delta.issueListings, 1, "one whole-repo issues listing serves the read");
        assert.ok(delta.pullListings <= 1, "at most one open-PRs listing (the linkage), never one per issue");
        assert.equal(delta.issueReads, 0, "no per-issue snapshot read — labels and linkage come from the listings");
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
      name: "5c. resumeClaim: swaps blocked→claimed (the retomada's swap)",
      run: async () => {
        const a = await harness.createIssue({ title: `to resume ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().blockClaim(a.ref, labels);

        const outcome = await adapter().resumeClaim(a.ref, labels);

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
        await assert.doesNotReject(adapter().resumeClaim(a.ref, labels));
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known && issue.value.labels.includes(harness.claimedLabel));
      },
    },
    {
      name: "5b. blockClaim: swaps claimed→blocked, the claim held until the terminal state",
      run: async () => {
        const a = await harness.createIssue({ title: `to block ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().blockClaim(a.ref, labels);
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
        await assert.doesNotReject(adapter().blockClaim(a.ref, labels));
        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(blocked), "the blocked label lands anyway");
      },
    },
    {
      name: "4. claim: a pool-label removal that fails for a REAL reason is never swallowed",
      run: async () => {
        // The padlock must land BEFORE the pool label leaves, so a
        // failure here leaves the work claimed with its reservation — where the
        // next derivation releases it — instead of invisible.
        const faults = harness.faults?.();
        if (!faults) return; // the live harness cannot inject; the offline ones can
        const a = await harness.createIssue({ title: `interrupted claim ${harness.name}`, labels: [ready] });
        faults.failRemovingLabel(ready);

        await assert.rejects(
          adapter().claim(a.ref, harness.workerAccount, ready),
          "a real failure of the pool-label removal must propagate, never be discarded",
        );

        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(harness.claimedLabel), "the claim mark landed before the pool label left");
        assert.deepEqual(issue.value.assignees, [harness.workerAccount]);
        assert.ok(issue.value.labels.includes(ready), "the failed removal left the pool label — the work is never orphaned");
      },
    },
    {
      name: "5. releaseClaim: an interrupted release keeps the claim mark — the padlock leaves last",
      run: async () => {
        const faults = harness.faults?.();
        if (!faults) return;
        const a = await harness.createIssue({ title: `interrupted release ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        faults.failRemovingLabel(harness.claimedLabel);

        await assert.rejects(adapter().releaseClaim(a.ref, harness.workerAccount, ready));

        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(ready), "the pool label came back first");
        assert.ok(issue.value.labels.includes(harness.claimedLabel), "the claim mark is still there — the work stays claimable-owned, never unclaimable");
      },
    },
    {
      name: "5b. blockClaim: an interrupted block keeps the claim mark — the padlock leaves last",
      run: async () => {
        const faults = harness.faults?.();
        if (!faults) return;
        const a = await harness.createIssue({ title: `interrupted block ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        faults.failRemovingLabel(labels.claimed);

        await assert.rejects(adapter().blockClaim(a.ref, labels));

        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(blocked), "the blocked label landed first");
        assert.ok(issue.value.labels.includes(harness.claimedLabel), "the claim mark is still there");
      },
    },
    {
      name: "5c. resumeClaim: an interrupted resume keeps the blocked mark — the new claim lands first",
      run: async () => {
        const faults = harness.faults?.();
        if (!faults) return;
        const a = await harness.createIssue({ title: `interrupted resume ${harness.name}` });
        await adapter().claim(a.ref, harness.workerAccount);
        await adapter().blockClaim(a.ref, labels);
        faults.failRemovingLabel(blocked);

        await assert.rejects(adapter().resumeClaim(a.ref, labels));

        const issue = await adapter().readIssue(a.ref);
        assert.ok(issue.known);
        assert.ok(issue.value.labels.includes(harness.claimedLabel), "the claim is held again before the blocked mark left");
        assert.ok(issue.value.labels.includes(blocked), "the blocked mark is still there — the retomada is retried, not lost");
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
      name: "9d. reopenPr: the SAME PR back to open (the rejection's retomada)",
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

/** The GitHub-ONLY rules: completion by closing the issue, and no native Rank.
 *  They are never part of the provider-neutral contract a Jira adapter runs. */
function githubOnlyChecks(harness: GitHubContractHarness): { name: string; run: () => Promise<void> }[] {
  const adapter = () => harness.getAdapter();
  return [
    {
      name: "GitHub: markDone closes the issue as completed",
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
      name: "GitHub: no native priority — the honest answer is known(null)",
      run: async () => {
        const a = await harness.createIssue({ title: `ranked? ${harness.name}` });
        const rank = await adapter().rank(a.ref);
        assert.ok(rank.known);
        assert.equal(rank.value, null);
      },
    },
  ];
}

/** Run all checks as a node:test suite — the `npm test` path (the fake). */
export function runGitHubContractSuite(harness: GitHubContractHarness): void {
  describe(`tracker port contract — ${harness.name}`, () => {
    beforeEach(async () => {
      await harness.reset();
    });
    after(async () => {
      await harness.cleanup();
    });
    for (const check of githubContractChecks(harness)) {
      test(check.name, async () => {
        await check.run();
      });
    }
  });
}

/** The GitHub-only rules as their own suite, beside the provider-neutral one. */
export function runGitHubOnlySuite(harness: GitHubContractHarness): void {
  describe(`GitHub-only rules — ${harness.name}`, () => {
    beforeEach(async () => {
      await harness.reset();
    });
    after(async () => {
      await harness.cleanup();
    });
    for (const check of githubOnlyChecks(harness)) {
      test(check.name, async () => {
        await check.run();
      });
    }
  });
}
