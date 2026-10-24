
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, SweepEngine, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import type { IssueRef, RequiredCheckResult } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_RETRO,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { readRepairCycle } from "../work-record/repair.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import { githubTicketNumber } from "./work-fixtures.js";

/**
 * End-to-end of the repair rounds: an open PR with confirmed conflicts or a required
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

class RepairGitWork implements LegacyGitWork {
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

  /**
   * The branch on disk. Unset, it models the ordinary publish: whatever the
   * remote holds now is the commit the attempt produced (the fake's stand-in
   * for the worker's push — a test that leaves the remote where it was models
   * a round that published nothing, and a test that sets this field models a
   * divergent or unfinished local state).
   */
  localWork?: LocalWorkFacts;

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    if (this.localWork !== undefined) return this.localWork;
    return {
      headSha: this.remoteHead,
      commits: this.remoteHead === null ? 0 : 1,
      uncommitted: false,
      operationInProgress: null,
    };
  }
}

describe("e2e: automatic repair of conflicts and required-check failures", () => {
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
      jira: [],
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      retro: { ...DEFAULT_RETRO },
      notifications: true,
      workerAuthFile: null,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(config: Config, outcomes: ScriptedOutcome[] = ["pr-open"]) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new RepairGitWork();
    const deps: LoopDeps = { config, tickets: tracker, pullRequests: tracker, runtime, git: expandedGitWorkOf(git), workspace: layout, log: () => {} };
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
    const pr = await seedOpenPr(tracker, runtime, deps, 1);

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
    assert.equal(request.material.repair.reasons.includes("conflicts"), true);
    assert.equal(request.material.repair.observedHeadSha, PR_HEAD, "the observed head is pinned for the lease");
    assert.deepEqual(request.material.repair.reasons, ["conflicts"]);
  });

  test("a required check that concluded failure or timeout reactivates the worker with its evidence", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 2);

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
    const pr = await seedOpenPr(tracker, runtime, deps, 3);

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
    assert.equal(repair.reasons.includes("conflicts"), true);
    assert.deepEqual(repair.checks.map((check) => check.name), ["build"]);
  });

  test("a human PR comment coexists with a trigger in ONE round addressing both", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 30);
    // A human review comment AND a confirmed conflict arrive before the tick.
    tracker.addPrComment({ repo: REPO, prNumber: pr }, "humano", "please also rename the helper");
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-co",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-co";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "one session, never a feedback round plus a repair");
    const material = sweep.launched[0]!.request.material;
    assert.ok(material.repair, "the repair context is present");
    assert.ok(
      material.pr?.comments.some((comment) => comment.body === "please also rename the helper"),
      "the human comment still reaches the same session",
    );
  });

  test("the repair rebases against the PR's CURRENT base, never the repository default", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 4);

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
    const pr = await seedOpenPr(tracker, runtime, deps, 5);
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

  // ---- no loops: the fall ledger bounds the same evidence, a stale head is not acted on ----

  test("the same failure with no publication retries once, then blocks: never an infinite round", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config, ["pr-open", "pr-open", "pr-open", "pr-open"]);
    const pr = await seedOpenPr(tracker, runtime, deps, 6);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-f",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    // The remote stays at the observed head: the round below publishes nothing.
    git.remoteHead = "head-f";

    const first = await runOnce(deps);
    assert.equal(first.launched.length, 1, "round 1");

    // An attempt that fell before publishing returns its round and is taken
    // over with the SAME evidence — never a deadlock.
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the unpublished attempt is resumed with the same evidence");
    const afterResume = await readRepairCycle(workDir(layout, REPO, 6));
    assert.equal(afterResume.usedRounds, 1, "the fallen round returned, the resumed one is charged");
    assert.equal(afterResume.consecutiveFalls, 1, "the fall is counted once");
    assert.ok(resumed.launched[0]!.request.material.repair, "the round carries the repair context");

    // The resumed round publishes nothing either: the second consecutive fall
    // blocks the work instead of retrying forever.
    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0, "the second fall never opens a third session");
    const issue = await tracker.readIssue({ repo: REPO, number: 6 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the 2nd fall blocks");
    const comments = await tracker.readComments({ repo: REPO, number: 6 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /consecutive repair attempts ended without publishing/i);

    // Sweeps after the block change nothing (the human answers on the issue).
    for (let tick = 0; tick < 2; tick += 1) {
      assert.equal((await runOnce(deps)).launched.length, 0, "a blocked work is not re-derived into a round");
    }
  });

  test("a repair round is skipped while the observed remote head no longer matches the facts", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 7);

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
    assert.equal(cycle.usedRounds, 0, "a skipped round never spends the budget");
  });

  // ---- the budget: two rounds, then block and ask for help ----

  test("two automatic rounds without recovery block the work and ask for help on the issue", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 8);

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
      (await readRepairCycle(workDir(layout, REPO, 8))).usedRounds,
      2,
      "a new commit/head never resets the cap",
    );

    await failOn("head-3"); // still failing: the cap is exhausted
    const third = await runOnce(deps);
    assert.equal(third.launched.length, 0, "the third round is not launched");
    const blocked = third.reserved.find((decision) => githubTicketNumber(decision.work.ticket) === 8);
    assert.ok(blocked && blocked.state === "repair-blocked", "the derivation blocks it");
    const issue = await tracker.readIssue({ repo: REPO, number: 8 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the work is blocked");
    const comments = await tracker.readComments({ repo: REPO, number: 8 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /automatic repair stopped after 2 rounds/i, "the human sees why");
    assert.match(comments.value.at(-1)!.body, /PR #\d+/, "the comment points at the PR");
  });

  test("a partial correction advances the round but never renews the cap", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 32);

    const headWith = async (head: string, checks: RequiredCheckResult[]) => {
      tracker.setPrRepairFacts({
        repo: REPO,
        prNumber: pr,
        headSha: head,
        mergeState: "mergeable",
        requiredChecks: checks,
      });
      git.remoteHead = head;
    };

    await headWith("p1", [failing("a", "failure"), failing("b", "failure")]);
    assert.equal((await runOnce(deps)).launched.length, 1, "round 1");

    // One check fixed, the other still failing: new evidence, but no recovery.
    await headWith("p2", [
      { name: "a", status: "completed", conclusion: "success" },
      failing("b", "failure"),
    ]);
    assert.equal((await runOnce(deps)).launched.length, 1, "a partial fix is new evidence → round 2");
    assert.equal(
      (await readRepairCycle(workDir(layout, REPO, 32))).usedRounds,
      2,
      "a partial fix never resets the cap",
    );

    // Full recovery is the only reset (besides a human unblock).
    await headWith("p3", [
      { name: "a", status: "completed", conclusion: "success" },
      { name: "b", status: "completed", conclusion: "success" },
    ]);
    assert.equal((await runOnce(deps)).launched.length, 0);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 32))).usedRounds, 0, "full recovery resets");
  });

  test("after a repair publishes, the factory waits for the new head's required checks", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 33);

    // Round 1: a confirmed conflict reactivates the worker.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "c1",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "c1";
    assert.equal((await runOnce(deps)).launched.length, 1, "round 1");

    // The worker pushed a new head; its required checks are still running.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "c2",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "in_progress", conclusion: null }],
    });
    git.remoteHead = "c2";
    assert.equal((await runOnce(deps)).launched.length, 0, "pending CI never relaunches the worker");
    assert.equal(
      (await readRepairCycle(workDir(layout, REPO, 33))).usedRounds,
      1,
      "waiting for CI does not spend another round",
    );

    // The check concludes failing on that same new head: new evidence → round 2.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "c2",
      mergeState: "mergeable",
      requiredChecks: [failing("build", "failure")],
    });
    assert.equal((await runOnce(deps)).launched.length, 1, "the concluded failure reactivates");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 33))).usedRounds, 2);
  });

  test("the repair budget persists across sweeps and factory restarts (disk, not process memory)", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 9);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-h",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-h";
    await runOnce(deps);

    // The worker published: the remote (and the branch) now carry the produced
    // commit the round pushed. The tracker's facts are still read on the head
    // of the evidence, so the same signature comes back on the next sweep.
    git.remoteHead = "head-h-published";

    // A fresh engine (a restart) reads the same budget from disk.
    const persisted = await readRepairCycle(workDir(layout, REPO, 9));
    assert.equal(persisted.usedRounds, 1);
    assert.ok(persisted.lastEvidence);

    // The rebuilt engine still sees the consumed evidence: no duplicate round.
    const rebuilt = await runOnce({ ...deps });
    assert.equal(rebuilt.launched.length, 0);
    const settled = await readRepairCycle(workDir(layout, REPO, 9));
    assert.equal(settled.attempt?.publication, "published", "the round's publication is confirmed once");
    assert.equal(settled.usedRounds, 1, "a published round is charged exactly once");
  });

  // ---- the two allowed resets ----

  test("confirmed recovery (no conflicts, all required checks approved) resets the budget", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 10);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-i",
      mergeState: "conflicting",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = "head-i";
    await runOnce(deps);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 10))).usedRounds, 1);

    // The new head is clean: an old head's failures never linger here, and the
    // confirmed recovery (no conflicts, every required check approved) resets.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-i-fixed",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    git.remoteHead = "head-i-fixed";
    const recovered = await runOnce(deps);
    assert.equal(recovered.launched.length, 0, "recovery launches nothing");
    assert.ok(
      recovered.reserved.some((decision) => githubTicketNumber(decision.work.ticket) === 10 && decision.state === "repair-recovered"),
      "the derivation reports the confirmed recovery",
    );
    assert.equal((await readRepairCycle(workDir(layout, REPO, 10))).usedRounds, 0, "the cap resets");
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

  test("a mergeable PR with no required checks declared is a confirmed recovery", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 20);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-n",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-n";
    assert.equal((await runOnce(deps)).launched.length, 1, "round 1");

    // The conflict is gone and the repository declares no required check at
    // all: the empty set is a known set, so the recovery is confirmed.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-n-fixed",
      mergeState: "mergeable",
      requiredChecks: [],
    });
    git.remoteHead = "head-n-fixed";
    const recovered = await runOnce(deps);
    assert.equal(recovered.launched.length, 0, "recovery launches nothing");
    assert.ok(
      recovered.reserved.some((decision) => githubTicketNumber(decision.work.ticket) === 20 && decision.state === "repair-recovered"),
      "no required checks declared is a confirmed recovery, never unknown",
    );
    assert.equal((await readRepairCycle(workDir(layout, REPO, 20))).usedRounds, 0, "the round is returned");
  });

  test("a human answer on the blocked issue resets the repair budget", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 11);

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
    assert.equal((await readRepairCycle(workDir(layout, REPO, 11))).usedRounds, 0, "the human unblock renewed the cap");
  });

  // ---- precedences: Block, closed/merged PR ----

  test("an existing Block prevails over conflicts and check failures", async () => {
    const config = makeConfig();
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 12);

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
    const pr = await seedOpenPr(tracker, runtime, deps, 13);

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

  test("a repair already in flight is never relaunched by a concurrent tick", async () => {
    const config = makeConfig(1);
    const { tracker, runtime, git, deps } = makeFactory(config);
    const pr = await seedOpenPr(tracker, runtime, deps, 31);

    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-inflight",
      mergeState: "conflicting",
      requiredChecks: [],
    });
    git.remoteHead = "head-inflight";

    // Park the repair session mid-flight, then tick again on the same engine.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.hold = () => held;

    const engine = new SweepEngine(deps);
    await engine.deriveAndAct();
    const started = engine.fillSlots();
    assert.equal(started.length, 1, "the repair launched");

    // The in-flight work is excluded from the derivation: no duplicate session.
    await engine.deriveAndAct();
    assert.equal(engine.fillSlots().length, 0, "the same work is never launched twice");

    release();
    await Promise.all(started);
  });
});
