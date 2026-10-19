import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef, RequiredCheckResult } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { readRepairCycle } from "../pool/repair.js";

/**
 * End-to-end of issue 107: an open PR with confirmed conflicts or a required
 * check concluded with failure/timeout reactivates the worker WITHOUT a human
 * comment. The same branch and the same PR; conflicts first (rebase against
 * the PR's current base), then the still-relevant check failures. Two
 * automatic rounds at most, then a block that asks for help. Unknown and
 * non-conclusive facts never trigger. The two fake seams + real temp
 * workspace, no network.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const PR_HEAD = "head-a";

class RepairGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];
  /** The remote head the host observes before a repair; null = nothing there. */
  remoteHead: string | null = null;
  private count = 0;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    this.count += 1;
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: this.count === 1,
      branchOnOrigin: true,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "diff --git a/x b/x\n+work";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return this.remoteHead;
  }
}

describe("e2e: automatic repair of conflicts and required-check failures (issue 107)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-repair-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency = 2): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(config: Config, outcomes: ScriptedOutcome[] = ["pr-open"]) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new RepairGitWork();
    const deps: LoopDeps = { config, tracker, runtime, git, workspace: layout, log: () => {} };
    return { tracker, runtime, git, deps };
  }

  async function openPrOf(tracker: FakeTrackerAdapter, number: number): Promise<number> {
    const feedback = await tracker.readPrFeedback({ repo: REPO, number });
    assert.ok(feedback.known && feedback.value.pr);
    return feedback.value.pr.number;
  }

  const failing = (name: string, conclusion: RequiredCheckResult["conclusion"]): RequiredCheckResult => ({
    name,
    status: "completed",
    conclusion,
  });

  /** Claim the issue and open the PR (attempt 1), then seed the repair facts. */
  async function seedOpenPr(
    tracker: FakeTrackerAdapter,
    runtime: FakeWorkerRuntime,
    git: RepairGitWork,
    deps: LoopDeps,
    number: number,
  ): Promise<number> {
    seedIssue(tracker, { repo: REPO, number, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await runOnce(deps);
    assert.equal(runtime.launched.length, 1, "attempt 1 opened the PR");
    return openPrOf(tracker, number);
  }

  // ---- the two triggers, each alone and together ----

  test("confirmed conflicts reactivate the worker with no human comment, same branch and same PR", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 1);

    // No human comment anywhere. The base advanced and now conflicts.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: PR_HEAD,
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = PR_HEAD;

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the confirmed conflict reactivated the worker");
    const request = sweep.launched[0]!.request;
    assert.equal(request.branch, workBranchName(1), "the SAME branch");
    assert.equal(await openPrOf(tracker, 1), pr, "the SAME PR");
    assert.ok(request.material.repair, "the repair context travels to the worker");
    assert.equal(request.material.repair.conflicting, true);
    assert.equal(request.material.repair.observedHeadSha, PR_HEAD, "the observed head is pinned for the lease");
    assert.deepEqual(request.material.repair.reasons, ["conflicts"]);
  });

  test("a required check that concluded failure or timeout reactivates the worker with its evidence", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 2);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-b",
      mergeState: "mergeable",
      requiredChecks: [
        failing("build", "failure"),
        failing("e2e", "timed_out"),
        { name: "lint", status: "completed", conclusion: "success" },
      ],
    });
    git.remoteHead = "head-b";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1);
    const repair = sweep.launched[0]!.request.material.repair;
    assert.ok(repair);
    assert.deepEqual(repair.reasons, ["required-checks"]);
    assert.deepEqual(
      repair.checks.map((check) => `${check.name}:${check.conclusion}`),
      ["build:failure", "e2e:timed_out"],
      "only the failing/timed-out required checks travel as evidence",
    );
  });

  test("conflicts and check failures are treated in ONE round, conflicts first", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 3);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-c",
      mergeState: "conflicting",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = "head-c";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "a single session, never one per impediment");
    const repair = sweep.launched[0]!.request.material.repair;
    assert.ok(repair);
    assert.deepEqual(repair.reasons, ["conflicts", "required-checks"]);
    assert.equal(repair.conflicting, true);
    assert.deepEqual(repair.checks.map((check) => check.name), ["build"]);
  });

  test("the repair rebases against the PR's CURRENT base, never the repository default", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 4);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-d",
      baseBranch: "release/next",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-d";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1);
    assert.equal(sweep.launched[0]!.request.baseBranch, "release/next", "the PR base is the rebase target");
    assert.equal(sweep.launched[0]!.request.material.repair?.baseBranch, "release/next");
  });

  // ---- the eligibility matrix: only confirmed conclusions trigger ----

  test("optional, pending, cancelled, skipped, unknown and clean facts never trigger", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 5);
    git.remoteHead = "head-e";

    const noTrigger = async (label: string, facts: Parameters<FakeTrackerAdapter["setPrRepairFacts"]>[0]) => {
      tracker.setPrRepairFacts(facts);
      const sweep = await runOnce(deps);
      assert.equal(sweep.launched.length, 0, `${label} must not reactivate the worker`);
    };

    await noTrigger("an unknown merge state", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "unknown",
      requiredChecks: [],
    });
    await noTrigger("an unknown required-check set", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "mergeable",
      requiredChecks: null,
    });
    await noTrigger("a pending required check", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "in_progress", conclusion: null }],
    });
    await noTrigger("a cancelled required check", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "completed", conclusion: "cancelled" }],
    });
    await noTrigger("a skipped required check", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "completed", conclusion: "skipped" }],
    });
    await noTrigger("all required checks approved (the blocking review pending)", {
      repo: REPO,
      prNumber: pr,
      headSha: "head-e",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "completed", conclusion: "success" }],
    });
  });

  // ---- no loops: the same evidence is consumed, a stale head is not acted on ----

  test("re-finding the same failure without new evidence never opens another session", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config, ["pr-open", "pr-open", "pr-open"]);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 6);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-f",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-f";

    const first = await runOnce(deps);
    assert.equal(first.launched.length, 1, "round 1");

    // Several ticks with the same facts (the worker did not push a new head).
    for (let tick = 0; tick < 3; tick += 1) {
      const again = await runOnce(deps);
      assert.equal(again.launched.length, 0, "the consumed evidence never rounds again");
    }
  });

  test("a repair round is skipped while the observed remote head no longer matches the facts", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 7);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-g",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    // A concurrent push moved the remote after the facts were read.
    git.remoteHead = "head-moved";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "stale evidence is not acted on");
    const cycle = await readRepairCycle(workDir(layout, REPO, 7));
    assert.equal(cycle.failedRounds, 0, "a skipped round never spends the budget");
  });

  // ---- the budget: two rounds, then block and ask for help ----

  test("two automatic rounds without recovery block the work and ask for help on the issue", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 8);

    const failOn = async (head: string) => {
      tracker.setPrRepairFacts({
        repo: REPO,
        prNumber: pr,
        headSha: head,
        mergeState: "mergeable",
        requiredChecks: [failing("build", "failure")],
      });
      git.remoteHead = head;
    };

    await failOn("head-1");
    assert.equal((await runOnce(deps)).launched.length, 1, "round 1");
    await failOn("head-2"); // new head → new evidence
    assert.equal((await runOnce(deps)).launched.length, 1, "round 2");
    assert.equal(
      (await readRepairCycle(workDir(layout, REPO, 8))).failedRounds,
      2,
      "a new commit/head never resets the cap",
    );

    await failOn("head-3"); // still failing: the cap is exhausted
    const third = await runOnce(deps);
    assert.equal(third.launched.length, 0, "the third round is not launched");
    const blocked = third.reserved.find((decision) => decision.ref.number === 8);
    assert.ok(blocked && blocked.state === "repair-blocked", "the derivation blocks it");
    const issue = await tracker.readIssue({ repo: REPO, number: 8 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the work is blocked");
    const comments = await tracker.readComments({ repo: REPO, number: 8 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /automatic repair stopped after 2 rounds/i, "the human sees why");
    assert.match(comments.value.at(-1)!.body, /PR #\d+/, "the comment points at the PR");
  });

  test("the repair budget persists across sweeps and factory restarts (disk, not process memory)", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 9);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-h",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-h";
    await runOnce(deps);

    // A fresh engine (a restart) reads the same budget from disk.
    const persisted = await readRepairCycle(workDir(layout, REPO, 9));
    assert.equal(persisted.failedRounds, 1);
    assert.ok(persisted.lastEvidence);

    // The rebuilt engine still sees the consumed evidence: no duplicate round.
    const rebuilt = await runOnce({ ...deps });
    assert.equal(rebuilt.launched.length, 0);
  });

  // ---- the two allowed resets ----

  test("confirmed recovery (no conflicts, all required checks approved) resets the budget", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 10);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-i",
      mergeState: "conflicting",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = "head-i";
    await runOnce(deps);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 10))).failedRounds, 1);

    // Recovery: no conflicts and every required check approved.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-i",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    const recovered = await runOnce(deps);
    assert.equal(recovered.launched.length, 0, "recovery launches nothing");
    assert.ok(
      recovered.reserved.some((decision) => decision.ref.number === 10 && decision.state === "repair-recovered"),
      "the derivation reports the confirmed recovery",
    );
    assert.equal((await readRepairCycle(workDir(layout, REPO, 10))).failedRounds, 0, "the cap resets");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 10))).lastEvidence, null);

    // A new failure after recovery opens a fresh cycle (round 1 again).
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-j",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-j";
    assert.equal((await runOnce(deps)).launched.length, 1, "a new cycle after recovery");
  });

  test("a human answer on the blocked issue resets the repair budget", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 11);

    const failOn = async (head: string) => {
      tracker.setPrRepairFacts({
        repo: REPO,
        prNumber: pr,
        headSha: head,
        mergeState: "conflicting",
        requiredChecks: [],
      });
      git.remoteHead = head;
    };
    await failOn("head-1");
    await runOnce(deps);
    await failOn("head-2");
    await runOnce(deps);
    await failOn("head-3");
    await runOnce(deps); // repair-blocked
    assert.ok((await tracker.readIssue({ repo: REPO, number: 11 })).known);

    // A human answer on the issue AFTER the agent's block marker.
    tracker.addComment({ repo: REPO, number: 11 }, "humano", "I authorized the release-flow change — proceed");

    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the resumable work is launched");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 11))).failedRounds, 0, "the human unblock renewed the cap");
  });

  // ---- precedences: Block, closed/merged PR ----

  test("an existing Block prevails over conflicts and check failures", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 12);

    // The work is blocked by a human decision; the PR also has a conflict.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-k",
      mergeState: "conflicting",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = "head-k";
    // Put the work in the blocked state through the existing transitions.
    await tracker.blockClaim({ repo: REPO, number: 12 }, DEFAULT_LABELS);

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "the Block stops the repair");
    const issue = await tracker.readIssue({ repo: REPO, number: 12 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked));
  });

  test("a PR closed without merge or already merged is never a repair candidate", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, git, deps, 13);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-l",
      mergeState: "conflicting",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = "head-l";

    // Merged: the fallback closes the issue — done, never a repair.
    tracker.closePr({ repo: REPO, prNumber: pr }, { merged: true });
    const merged = await runOnce(deps);
    assert.equal(merged.launched.length, 0, "a merged PR is done, not repaired");
    assert.ok(!merged.reserved.some((decision) => decision.state === "repair"));

    // Re-open the scenario on a fresh factory: a closed-without-merge PR is rejected/blocked.
    tracker.closeIssue({ repo: REPO, number: 13 }, "completed");
  });
});
