import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import type { IssueRef, RequiredCheckResult } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { REPAIR_FILENAME, readRepairCycle, type RepairCycle } from "../pool/repair.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { localGitWork } from "../git/local.js";
import { repoCloneDir } from "../git/port.js";
import { cleanupFixture, commitFileIn, seedFixtureRemote, type FixtureRemote } from "../git/local-fixtures.js";

const execFile = promisify(execFileCallback);

/**
 * End-to-end of issue 112: a Repair attempt that ends WITHOUT publishing must
 * not burn the round, must stay visible, and must be resumed automatically on
 * the same branch and PR while the remote is still where it was observed. The
 * two ledgers are covered here — the DELIVERED rounds (two before the block)
 * and the consecutive FALLS (two before the block, PR open or not) — plus the
 * three publication verdicts, the pending reconciliation, the concurrent change
 * and the preserved local work. Fake tracker + fake runtime, real temp
 * workspace, git behind the same fake GitWork port.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
/** The head the #100 incident observed: the PR's head and the remote's. */
const OBSERVED = "2b45c0421fd9528df1d12032a942b60e1fff6518";

class ScenarioGitWork implements GitWork {
  /** The remote head the host observes; null = the branch is not there. */
  remoteHead: string | null = OBSERVED;
  /** The work branch on disk; null = git cannot answer. */
  localWork: LocalWorkFacts | null = {
    headSha: null,
    commits: 0,
    uncommitted: false,
    operationInProgress: null,
  };
  /** The remote refuses to answer — publication is unverifiable. */
  remoteUnavailable = false;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: false,
      branchOnOrigin: true,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    if (this.remoteUnavailable) throw new Error("git ls-remote: the remote could not be read");
    return this.remoteHead;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    if (this.localWork === null) throw new Error("git rev-parse: the clone could not be read");
    return this.localWork;
  }
}

describe("e2e: a repair attempt that fell before publishing (issue 112)", () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-falls-"));
    layout = ensureWorkspace(join(dir, "ws"));
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(outcomes: ScriptedOutcome[] = ["pr-open", "pr-open", "pr-open"]) {
    const config = makeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new ScenarioGitWork();
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git,
      workspace: layout,
      log: (message) => logs.push(message),
    };
    return { tracker, runtime, git, deps };
  }

  const failing = (name: string, conclusion: RequiredCheckResult["conclusion"]): RequiredCheckResult => ({
    name,
    status: "completed",
    conclusion,
  });

  const signatureOf = (number: number, headSha: string): string =>
    `${REPO}#${number}|${headSha}|conflicts|`;

  /** The human's change landing BETWEEN the derivation and the launch: the fake
   *  host applies it at prepareWork, before the round re-reads the facts. */
  function changeFactsAtPrepare(git: ScenarioGitWork, apply: () => void): void {
    const prepare = git.prepareWork.bind(git);
    git.prepareWork = async (ref: IssueRef) => {
      apply();
      return prepare(ref);
    };
  }

  /** Attempt 1: the claim and the PR, written by the ordinary first round. */
  async function seedFirstAttempt(
    tracker: FakeTrackerAdapter,
    runtime: FakeWorkerRuntime,
    deps: LoopDeps,
    number: number,
  ): Promise<number> {
    seedIssue(tracker, { repo: REPO, number, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await runOnce(deps);
    assert.equal(runtime.launched.length, 1, "attempt 1 opened the PR");
    const feedback = await tracker.readPrFeedback({ repo: REPO, number });
    assert.ok(feedback.known && feedback.value.pr);
    return feedback.value.pr.number;
  }

  /** The durable state of the #100 incident: a charged round, the evidence it
   *  addressed, and a LATER attempt whose log exists but whose record does not.
   *  The record on disk is still attempt 1's. */
  function seedFallenLegacyRound(
    number: number,
    cycle: RepairCycle = { usedRounds: 1, lastEvidence: signatureOf(number, OBSERVED), consecutiveFalls: 0, attempt: null },
    attempt = 2,
  ): void {
    const target = workDir(layout, REPO, number);
    writeFileSync(join(target, REPAIR_FILENAME), `${JSON.stringify(cycle, null, 2)}\n`, "utf8");
    writeFileSync(
      join(target, `log-${attempt}.jsonl`),
      `${JSON.stringify({ event: "session-start", attempt })}\n`,
      "utf8",
    );
  }

  /** The impediment that persists: conflicts on the observed head. */
  async function conflictingOn(
    tracker: FakeTrackerAdapter,
    prNumber: number,
    headSha: string,
  ): Promise<void> {
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber,
      headSha,
      mergeState: "conflicting",
      requiredChecks: [],
    });
  }

  test("the #100 incident resumes automatically: the unpublished round returns, the same evidence resumes, nothing is charged twice", async () => {
    // Attempt 1 opens the PR; both repair attempts die abruptly, like the incident.
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "abrupt-death", "abrupt-death"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 100);

    // The incident's state on disk: budget charged, evidence consumed, an
    // attempt AFTER the record without one of its own, the local work
    // unpublished and the remote still at the observed head.
    seedFallenLegacyRound(100);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    git.localWork = {
      headSha: "2993399aaaa",
      commits: 2,
      uncommitted: false,
      operationInProgress: null,
    };

    // The very next sweep recovers — no human comment, no new evidence.
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the fallen attempt is resumed without human intervention");
    const request = resumed.launched[0]!.request;
    assert.equal(request.branch, workBranchName(100), "the SAME branch");
    assert.equal(request.ref.number, 100, "the SAME work, therefore the same PR");
    assert.equal(request.material.repair?.resuming, 2, "the round takes over the attempt that fell");
    assert.deepEqual(request.material.repair?.localWork, git.localWork, "the local work travels to the session");
    assert.equal(request.material.pr?.number, pr, "the SAME PR, never a new one");
    assert.equal(resumed.collected[0]?.prConfirmed, true, "the PR stayed open across the fall");

    const afterResume = await readRepairCycle(workDir(layout, REPO, 100));
    assert.equal(afterResume.usedRounds, 1, "the fallen round returned and the resumed round is charged once");
    assert.equal(afterResume.consecutiveFalls, 1, "the fall is counted once");
    assert.equal(afterResume.attempt?.attempt, 3, "the running round owns the cycle now");
    assert.equal(afterResume.attempt?.observedHeadSha, OBSERVED, "the lease is pinned to the observed head");

    // The resumed round publishes nothing either: the second consecutive fall
    // blocks the work, even with the PR open.
    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0, "the second fall never opens a third session");
    const afterFall = await readRepairCycle(workDir(layout, REPO, 100));
    assert.equal(afterFall.usedRounds, 0, "the unpublished round is not charged");
    assert.equal(afterFall.consecutiveFalls, 2, "two falls are counted, once each");

    const issue = await tracker.readIssue({ repo: REPO, number: 100 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked));
    const comments = await tracker.readComments({ repo: REPO, number: 100 });
    assert.ok(comments.known);
    const comment = comments.value.at(-1)!.body;
    assert.match(comment, /automatic repair stopped after 2 consecutive repair attempts/i, "the human sees why");
    assert.match(
      comment,
      /attempt 3 ended without an outcome record of its own \(the record on disk belongs to attempt 1\)/,
      "the fallen attempt and the divergent record are named",
    );
    assert.match(comment, /not published \(the remote does not carry the attempt's commit\)/);
    assert.match(comment, /local work preserved: 2 commits on the branch/, "the preserved work is named");
    assert.match(comment, /trabalhos\/Sanmoo\/my-tasks#100\/log-3\.jsonl — present/, "the evidence paths are named");
    assert.doesNotMatch(comment, /\/(home|tmp|root)\//, "no absolute path leaves the factory");

    // Repeated sweeps never charge, refund, count or launch again.
    for (let tick = 0; tick < 3; tick += 1) {
      assert.equal((await runOnce(deps)).launched.length, 0, "a blocked work stays parked");
    }
    const settled = await readRepairCycle(workDir(layout, REPO, 100));
    assert.equal(settled.usedRounds, 0, "no sweeps later: still not charged");
    assert.equal(settled.consecutiveFalls, 2, "no sweeps later: the same two falls");
  });

  test("a published attempt that fell before writing its outcome is charged exactly once", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 101);

    // The worker pushed and died before the record: the local branch and the
    // remote carry the same produced commit, the tracker's facts moved with it.
    const produced = "published999";
    const cycle: RepairCycle = {
      usedRounds: 1,
      lastEvidence: signatureOf(101, OBSERVED),
      consecutiveFalls: 0,
      attempt: {
        evidence: signatureOf(101, OBSERVED),
        attempt: 2,
        observedHeadSha: OBSERVED,
        remoteHeadSha: null,
        publication: "unknown",
        localWork: { headSha: produced, commits: 1, uncommitted: false, operationInProgress: null },
      },
    };
    seedFallenLegacyRound(101, cycle, 2);
    await conflictingOn(tracker, pr, OBSERVED);
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: produced,
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "in_progress", conclusion: null }],
    });
    git.remoteHead = produced;
    git.localWork = { headSha: produced, commits: 1, uncommitted: false, operationInProgress: null };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "a published round is never relaunched");

    const settled = await readRepairCycle(workDir(layout, REPO, 101));
    assert.equal(settled.attempt?.publication, "published");
    assert.equal(settled.usedRounds, 1, "the published round is charged");
    assert.equal(settled.consecutiveFalls, 0, "a delivered round breaks the fall streak");

    // The same verdict again on the next sweep: no second charge, no second refund.
    await runOnce(deps);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 101))).usedRounds, 1);
  });

  test("an unverifiable remote leaves the publication pending: no worker and no budget returned", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 102);
    seedFallenLegacyRound(102);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local102", commits: 1, uncommitted: false, operationInProgress: null };
    git.remoteUnavailable = true;

    for (let tick = 0; tick < 2; tick += 1) {
      const pending = await runOnce(deps);
      assert.equal(pending.launched.length, 0, "uncertain publication never launches");
      assert.ok(
        logs.some((line) => line.includes("reconciliation pending") && line.includes("no worker and no budget return")),
        "the uncertainty is exposed, not presumed",
      );
      const cycle = await readRepairCycle(workDir(layout, REPO, 102));
      assert.equal(cycle.usedRounds, 1, "the budget is not returned while publication is uncertain");
      assert.equal(cycle.attempt?.publication, "pending");
      assert.equal(cycle.consecutiveFalls, 0, "no fall is invented while publication is uncertain");
    }

    // The remote answers: the pending query is repeated and the attempt resumes.
    git.remoteUnavailable = false;
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "a transient unavailability needs no human");
    assert.equal(resumed.launched[0]!.request.material.repair?.resuming, 2);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 102))).usedRounds, 1);
  });

  test("a concurrent change on the remote is never taken for the attempt's publication", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 103);
    seedFallenLegacyRound(103);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local103", commits: 2, uncommitted: true, operationInProgress: null };
    git.remoteHead = "stranger999";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "nothing is published over a concurrent change");

    const issue = await tracker.readIssue({ repo: REPO, number: 103 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "a human is asked");
    const comments = await tracker.readComments({ repo: REPO, number: 103 });
    assert.ok(comments.known);
    const comment = comments.value.at(-1)!.body;
    assert.match(comment, /the remote branch moved to `stranger999`/, "the divergent head is named");
    assert.match(comment, /a concurrent change/, "the cause is stated");
    assert.match(comment, /local work preserved: 2 commits on the branch/, "the work is preserved and named");
    assert.match(comment, /nothing was pushed, reset or discarded/);

    const cycle = await readRepairCycle(workDir(layout, REPO, 103));
    assert.equal(cycle.attempt?.publication, "concurrent-change");
    assert.equal(cycle.usedRounds, 1, "the budget is neither returned nor renewed");
    assert.deepEqual(cycle.attempt?.localWork, git.localWork, "the local work is recorded, not touched");
  });

  test("a human answer on the issue still resumes the work and renews both ledgers", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 104);
    seedFallenLegacyRound(104);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local104", commits: 1, uncommitted: false, operationInProgress: null };
    await runOnce(deps); // resume 1
    await runOnce(deps); // 2nd fall → blocked
    assert.ok(
      (await tracker.readIssue({ repo: REPO, number: 104 })).known,
      "the work exists",
    );
    const blockedCycle = await readRepairCycle(workDir(layout, REPO, 104));
    assert.equal(blockedCycle.consecutiveFalls, 2);

    // The block listens to the issue: no human, no work.
    assert.equal((await runOnce(deps)).launched.length, 0);

    tracker.addComment({ repo: REPO, number: 104 }, "humano", "authorized — go ahead");
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the human answer resumes the same branch and PR");
    const renewed = await readRepairCycle(workDir(layout, REPO, 104));
    assert.equal(renewed.usedRounds, 0, "the human answer renews the round budget");
    assert.equal(renewed.consecutiveFalls, 0, "and the fall ledger");
    assert.equal(renewed.attempt, null);
  });

  test("confirmed recovery renews the budget and clears the falls", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 105);
    seedFallenLegacyRound(105);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local105", commits: 1, uncommitted: false, operationInProgress: null };
    await runOnce(deps); // resume: falls 1, round charged
    assert.equal((await readRepairCycle(workDir(layout, REPO, 105))).consecutiveFalls, 1);

    // The resumed round published its commit and the PR recovered on it: no
    // conflicts, every required check approved.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "local105",
      mergeState: "mergeable",
      requiredChecks: [failing("build", "success")],
    });
    git.remoteHead = "local105";
    const recovered = await runOnce(deps);
    assert.equal(recovered.launched.length, 0, "recovery launches nothing");
    assert.ok(
      recovered.reserved.some((decision) => decision.ref.number === 105 && decision.state === "repair-recovered"),
    );
    const cycle = await readRepairCycle(workDir(layout, REPO, 105));
    assert.equal(cycle.usedRounds, 0, "the budget resets");
    assert.equal(cycle.consecutiveFalls, 0, "the fall streak resets");
    assert.equal(cycle.attempt, null);
  });

  test("a fallen attempt never hijacks newer evidence: the new head gets its own round", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 117);
    // Attempt 2 fell on the OLD head and its round was returned.
    const cycle: RepairCycle = {
      usedRounds: 0,
      lastEvidence: signatureOf(117, OBSERVED),
      consecutiveFalls: 1,
      attempt: {
        evidence: signatureOf(117, OBSERVED),
        attempt: 2,
        observedHeadSha: OBSERVED,
        remoteHeadSha: OBSERVED,
        publication: "not-published",
        localWork: { headSha: "local117", commits: 1, uncommitted: false, operationInProgress: null },
      },
    };
    seedFallenLegacyRound(117, cycle, 2);
    // The PR recovered on a NEW head and conflicts again there: the evidence
    // the old attempt addressed is gone, so there is nothing to resume.
    const newHead = "bbbb2222cccc";
    await conflictingOn(tracker, pr, newHead);
    git.remoteHead = newHead;
    git.localWork = { headSha: "local117", commits: 1, uncommitted: false, operationInProgress: null };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the new evidence still gets its round");
    const repair = sweep.launched[0]!.request.material.repair;
    assert.ok(repair);
    assert.equal(repair.resuming, undefined, "the old attempt is NOT resumed for evidence it never addressed");
    assert.equal(repair.observedHeadSha, newHead, "the lease is pinned to the head the evidence was read on");
    assert.equal(sweep.launched[0]!.request.attempt, 3, "a new attempt, numbered after the fallen one");

    const issue = await tracker.readIssue({ repo: REPO, number: 117 });
    assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "no false help request");
    const after = await readRepairCycle(workDir(layout, REPO, 117));
    assert.equal(after.usedRounds, 1, "the new round is charged once");
    assert.equal(after.consecutiveFalls, 1, "and the earlier fall stays counted");
  });

  test("confirmed recovery clears the falls even when the fall's round was already refunded", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 118);
    // The fall returned its round: nothing is charged, one fall stands, and the
    // attempt record is settled on disk.
    const cycle: RepairCycle = {
      usedRounds: 0,
      lastEvidence: signatureOf(118, OBSERVED),
      consecutiveFalls: 1,
      attempt: {
        evidence: signatureOf(118, OBSERVED),
        attempt: 2,
        observedHeadSha: OBSERVED,
        remoteHeadSha: OBSERVED,
        publication: "not-published",
        localWork: { headSha: "local118", commits: 1, uncommitted: false, operationInProgress: null },
      },
    };
    seedFallenLegacyRound(118, cycle, 2);
    // The work recovered by another path: the PR is clean on its head and
    // every required check is approved — the confirmed recovery of story 25.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "recovered118",
      mergeState: "mergeable",
      requiredChecks: [failing("build", "success")],
    });
    git.remoteHead = "recovered118";

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "recovery launches nothing");
    assert.ok(
      sweep.reserved.some((decision) => decision.ref.number === 118 && decision.state === "repair-recovered"),
      "a refunded cycle still resets on confirmed recovery",
    );
    const after = await readRepairCycle(workDir(layout, REPO, 118));
    assert.equal(after.consecutiveFalls, 0, "the fall streak resets");
    assert.equal(after.usedRounds, 0);
    assert.equal(after.attempt, null, "the settled attempt leaves the ledger");
  });

  test("a round that ends clean without publishing never renews the budget either", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "clean-without-pr", "clean-without-pr"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 106);
    seedFallenLegacyRound(106);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };

    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the unpublished round resumes (nothing published)");
    assert.equal(resumed.collected[0]?.result.outcome, "clean-without-pr", "the session ended cleanly without a PR");

    // The PR stays open and conflicting: the normal end published nothing, so
    // the round returns and the work asks for help on the second fall.
    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0);
    const issue = await tracker.readIssue({ repo: REPO, number: 106 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked));
    const comments = await tracker.readComments({ repo: REPO, number: 106 });
    assert.ok(comments.known);
    assert.match(
      comments.value.at(-1)!.body,
      /attempt 3 ended normally \(its outcome record says "clean-without-pr"\) but nothing reached the remote/,
      "a normal end without publication is named as such — never invented as an ended-without-record",
    );
    assert.equal((await readRepairCycle(workDir(layout, REPO, 106))).usedRounds, 0, "the round was not charged");
  });

  test("a required-check repair round that fell is resumed with the check evidence intact", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 107);
    const head = "ci-head";
    const evidence = `${REPO}#107|${head}|no-conflicts|build:failure`;
    writeFileSync(
      join(workDir(layout, REPO, 107), REPAIR_FILENAME),
      `${JSON.stringify({ usedRounds: 1, lastEvidence: evidence })}\n`,
      "utf8",
    );
    writeFileSync(join(workDir(layout, REPO, 107), "log-2.jsonl"), "{}\n", "utf8");
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: head,
      mergeState: "mergeable",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = head;
    git.localWork = { headSha: "local107", commits: 1, uncommitted: false, operationInProgress: null };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the check-failure round resumes the same way");
    const repair = sweep.launched[0]!.request.material.repair;
    assert.ok(repair);
    assert.deepEqual(repair.reasons, ["required-checks"]);
    assert.deepEqual(repair.checks.map((check) => `${check.name}:${check.conclusion}`), ["build:failure"]);
    assert.equal(repair.observedHeadSha, head, "the lease stays pinned to the observed head");
    assert.equal(repair.resuming, 2);
  });

  test("a self-report of blocked is never bypassed by the automatic resumption", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "blocked-self-report", "pr-open"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 108);
    seedFallenLegacyRound(108);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local108", commits: 1, uncommitted: false, operationInProgress: null };

    assert.equal((await runOnce(deps)).launched.length, 1, "the unpublished attempt resumes");

    // The worker self-reports blocked on the issue: the factory only records it,
    // and the pending human decision is never worked around.
    for (let tick = 0; tick < 2; tick += 1) {
      assert.equal((await runOnce(deps)).launched.length, 0, "a self-reported block waits for the human");
    }
  });

  test("a pending publication blocks a feedback round too, not only a repair round", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 115);
    // The attempt's publication is unknown and the tracker's repair facts are
    // unreadable; a human PR comment is waiting. No worker may start while the
    // publication is uncertain (issue 112, story 21).
    writeFileSync(
      join(workDir(layout, REPO, 115), REPAIR_FILENAME),
      `${JSON.stringify({
        usedRounds: 1,
        lastEvidence: `${REPO}#115|${OBSERVED}|conflicts|`,
        consecutiveFalls: 0,
        attempt: {
          evidence: `${REPO}#115|${OBSERVED}|conflicts|`,
          attempt: 2,
          observedHeadSha: OBSERVED,
          remoteHeadSha: null,
          publication: "pending",
          localWork: { headSha: "local115", commits: 1, uncommitted: false, operationInProgress: null },
        },
      })}\n`,
      "utf8",
    );
    tracker.setPrRepairFacts({ repo: REPO, prNumber: pr, mergeState: "unknown", requiredChecks: null });
    tracker.addPrComment({ repo: REPO, prNumber: pr }, "humano", "please also check the docs");
    git.remoteUnavailable = true;

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "no feedback round starts while publication is unverified");
    assert.ok(
      !sweep.reserved.some((decision) => decision.state === "feedback"),
      "the derivation holds the work instead of handing it to a worker",
    );
    assert.equal((await readRepairCycle(workDir(layout, REPO, 115))).usedRounds, 1, "the budget stays held");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 115))).attempt?.publication, "pending");
  });

  test("an unreadable local state is pending, never a concurrent change in disguise", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 114);
    // The attempt is in flight from an earlier sweep; the host cannot answer.
    writeFileSync(
      join(workDir(layout, REPO, 114), REPAIR_FILENAME),
      `${JSON.stringify({
        usedRounds: 1,
        lastEvidence: `${REPO}#114|${OBSERVED}|conflicts|`,
        consecutiveFalls: 0,
        attempt: {
          evidence: `${REPO}#114|${OBSERVED}|conflicts|`,
          attempt: 2,
          observedHeadSha: OBSERVED,
          remoteHeadSha: null,
          publication: "unknown",
          localWork: { headSha: OBSERVED, commits: 0, uncommitted: false, operationInProgress: null },
        },
      })}\n`,
      "utf8",
    );
    await conflictingOn(tracker, pr, OBSERVED);
    // The remote moved, but the branch cannot be read: the truth is "unknown",
    // not "the attempt produced the new head" nor "a stranger did".
    git.remoteHead = "moved-but-unreadable";
    git.localWork = null;

    for (let tick = 0; tick < 2; tick += 1) {
      const sweep = await runOnce(deps);
      assert.equal(sweep.launched.length, 0, "an unreadable local state launches nothing");
      const cycle = await readRepairCycle(workDir(layout, REPO, 114));
      assert.equal(cycle.attempt?.publication, "pending", "the uncertainty is exposed");
      assert.equal(cycle.usedRounds, 1, "and the budget is not returned");
      const issue = await tracker.readIssue({ repo: REPO, number: 114 });
      assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "no help is asked on a guess");
    }
  });

  test("two falls block even when the tracker's current facts are not confirmed", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 110);
    // Two falls already settled; the PR's facts are NOT confirmed (unknown
    // mergeability): the open PR must not hide the fall.
    const cycle: RepairCycle = {
      usedRounds: 0,
      lastEvidence: `${REPO}#110|${OBSERVED}|conflicts|`,
      consecutiveFalls: 2,
      attempt: {
        evidence: `${REPO}#110|${OBSERVED}|conflicts|`,
        attempt: 2,
        observedHeadSha: OBSERVED,
        remoteHeadSha: OBSERVED,
        publication: "not-published",
        localWork: { headSha: "local110", commits: 1, uncommitted: false, operationInProgress: null },
      },
    };
    seedFallenLegacyRound(110, cycle, 2);
    tracker.setPrRepairFacts({ repo: REPO, prNumber: pr, mergeState: "unknown", requiredChecks: [] });
    git.remoteHead = OBSERVED;
    git.localWork = {
      headSha: "local110",
      commits: 1,
      uncommitted: false,
      operationInProgress: null,
    };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "an unconfirmed PR is not a reason to keep the work parked");
    const issue = await tracker.readIssue({ repo: REPO, number: 110 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the 2nd fall blocks anyway");
    const comments = await tracker.readComments({ repo: REPO, number: 110 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /2 consecutive repair attempts ended without publishing/);
  });

  test("an unverified publication is never erased by facts that look like recovery", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 111);
    // The attempt's publication is still unknown (the remote was unreadable on
    // the last sweep); the tracker now looks clean.
    writeFileSync(
      join(workDir(layout, REPO, 111), REPAIR_FILENAME),
      `${JSON.stringify({
        usedRounds: 1,
        lastEvidence: `${REPO}#111|${OBSERVED}|conflicts|`,
        consecutiveFalls: 0,
        attempt: {
          evidence: `${REPO}#111|${OBSERVED}|conflicts|`,
          attempt: 2,
          observedHeadSha: OBSERVED,
          remoteHeadSha: null,
          publication: "pending",
          localWork: { headSha: "local111", commits: 1, uncommitted: false, operationInProgress: null },
        },
      })}\n`,
      "utf8",
    );
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "clean-looking",
      mergeState: "mergeable",
      requiredChecks: [failing("build", "success")],
    });
    git.remoteUnavailable = true;

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0);
    assert.ok(
      !sweep.reserved.some((decision) => decision.state === "repair-recovered"),
      "recovery is not confirmed while the publication is unverified",
    );
    const cycle = await readRepairCycle(workDir(layout, REPO, 111));
    assert.equal(cycle.usedRounds, 1, "the charge is not silently renewed");
    assert.equal(cycle.attempt?.publication, "pending", "the attempt is not erased");
  });

  test("a human answer never outranks an unverified publication", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 119);
    // The work is blocked (a human decision is pending on the issue) and its
    // last repair attempt's publication is still unknown: the remote cannot be
    // read, so nobody can say whether the attempt already reached it.
    writeFileSync(
      join(workDir(layout, REPO, 119), REPAIR_FILENAME),
      `${JSON.stringify({
        usedRounds: 1,
        lastEvidence: `${REPO}#119|${OBSERVED}|conflicts|`,
        consecutiveFalls: 0,
        attempt: {
          evidence: `${REPO}#119|${OBSERVED}|conflicts|`,
          attempt: 2,
          observedHeadSha: OBSERVED,
          remoteHeadSha: null,
          publication: "pending",
          localWork: { headSha: "local119", commits: 1, uncommitted: false, operationInProgress: null },
        },
      })}\n`,
      "utf8",
    );
    await conflictingOn(tracker, pr, OBSERVED);
    await tracker.blockClaim({ repo: REPO, number: 119 }, DEFAULT_LABELS);
    tracker.addComment({ repo: REPO, number: 119 }, "humano", "authorized — go ahead");
    git.localWork = { headSha: "local119", commits: 1, uncommitted: false, operationInProgress: null };
    git.remoteUnavailable = true;

    const held = await runOnce(deps);
    assert.equal(held.launched.length, 0, "no worker starts while publication is unverified");
    const stillHeld = await readRepairCycle(workDir(layout, REPO, 119));
    assert.equal(stillHeld.usedRounds, 1, "the human answer does not renew a budget nobody settled");
    assert.equal(stillHeld.attempt?.publication, "pending", "the attempt is still there");

    // The remote answers: the answer on the issue applies from then on.
    git.remoteUnavailable = false;
    git.remoteHead = OBSERVED;
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "settled, the human answer resumes the work");
    const renewed = await readRepairCycle(workDir(layout, REPO, 119));
    assert.equal(renewed.usedRounds, 0, "the human reset now applies");
  });

  test("a remote that moved after the settlement is never overwritten by the resumption", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 112);
    seedFallenLegacyRound(112);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local112", commits: 2, uncommitted: false, operationInProgress: null };
    git.remoteHead = "stranger999";

    // The reconciliation settles the attempt as a concurrent change (the
    // remote is not the observed head nor the produced commit)...
    const first = await runOnce(deps);
    assert.equal(first.launched.length, 0, "nothing is launched over a concurrent change");
    // ...and the request for help follows from the same state.
    const second = await runOnce(deps);
    assert.equal(second.launched.length, 0);
    const comments = await tracker.readComments({ repo: REPO, number: 112 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /a concurrent change/);
    assert.equal((await readRepairCycle(workDir(layout, REPO, 112))).attempt?.publication, "concurrent-change");
  });

  test("a deleted remote branch is named as gone, never as a head the attempt did not produce", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 116);
    seedFallenLegacyRound(116);
    await conflictingOn(tracker, pr, OBSERVED);
    git.localWork = { headSha: "local116", commits: 1, uncommitted: false, operationInProgress: null };
    // The branch was deleted on the remote after the fall: absence, not a
    // concurrent head to compare against.
    git.remoteHead = null;

    const first = await runOnce(deps);
    assert.equal(first.launched.length, 0);
    // The reconciliation reads absence as "nothing published"; the launch guard
    // then refuses to recreate the branch the lease was pinned to.
    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0);
    const comments = await tracker.readComments({ repo: REPO, number: 116 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /the remote branch no longer exists/);
    assert.doesNotMatch(comments.value.at(-1)!.body, /moved to/);
  });

  test("a push to the work branch between the fall and the resumption blocks instead of publishing", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 113);
    // Already settled as NOT published (the remote was at the observed head).
    writeFileSync(
      join(workDir(layout, REPO, 113), REPAIR_FILENAME),
      `${JSON.stringify({
        usedRounds: 0,
        lastEvidence: `${REPO}#113|${OBSERVED}|conflicts|`,
        consecutiveFalls: 1,
        attempt: {
          evidence: `${REPO}#113|${OBSERVED}|conflicts|`,
          attempt: 2,
          observedHeadSha: OBSERVED,
          remoteHeadSha: OBSERVED,
          publication: "not-published",
          localWork: { headSha: "local113", commits: 2, uncommitted: false, operationInProgress: null },
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(join(workDir(layout, REPO, 113), "log-2.jsonl"), "{}\n", "utf8");
    await conflictingOn(tracker, pr, OBSERVED);
    // A collaborator pushed to the same branch AFTER the fall.
    git.remoteHead = "collaborator777";
    git.localWork = { headSha: "local113", commits: 2, uncommitted: false, operationInProgress: null };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "the local history is not published over the collaborator's push");
    assert.ok(
      logs.some(
        (line) =>
          line.includes("repair attempt 2 of") &&
          line.includes("the remote branch moved to") &&
          line.includes("nothing is published"),
      ),
      "the guard names the concurrent change",
    );
    assert.ok(
      runtime.launched.length === 1,
      "only the first attempt ever ran — the resumption never started",
    );

    // The next sweep asks the human for a reconciliation.
    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0);
    const issue = await tracker.readIssue({ repo: REPO, number: 113 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked));
  });

  // ---- issue 149: the impediment the round addressed may vanish mid-round ----

  test("a round that ends without publishing after the human resolved the conflict returns the round — no block, no help", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "clean-without-pr"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 120);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const round = await runOnce(deps);
    assert.equal(round.launched.length, 1, "the confirmed conflict opens a repair round");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 120))).usedRounds, 1, "the round is charged");
    const commentsBefore = await tracker.readComments({ repo: REPO, number: 120 });
    assert.ok(commentsBefore.known);

    // While the round ran, the operator resolved the conflict and pushed the
    // resolution: the PR is mergeable on a head the attempt never produced.
    const resolved = "effc1b3c";
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: resolved,
      mergeState: "mergeable",
      requiredChecks: [],
    });
    git.remoteHead = resolved;
    git.localWork = { headSha: OBSERVED, commits: 0, uncommitted: false, operationInProgress: null };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "the obsolete premise opens no worker");
    assert.ok(
      sweep.reserved.some((decision) => decision.ref.number === 120 && decision.state === "repair-recovered"),
      "the mergeable PR is a confirmed recovery",
    );
    assert.ok(
      logs.some((line) => line.includes("premise is obsolete") && line.includes("the round returns")),
      "the log names the obsolete premise and the returned round",
    );
    assert.ok(
      !logs.some((line) => line.includes("a human is asked")),
      "no help is asked for work that no longer needs it",
    );

    const issue = await tracker.readIssue({ repo: REPO, number: 120 });
    assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "the work is not blocked");
    const comments = await tracker.readComments({ repo: REPO, number: 120 });
    assert.ok(comments.known);
    assert.equal(comments.value.length, commentsBefore.value.length, "nothing is posted on the issue");

    const cycle = await readRepairCycle(workDir(layout, REPO, 120));
    assert.equal(cycle.usedRounds, 0, "the round is returned");
    assert.equal(cycle.consecutiveFalls, 0, "a vanished premise is not a fall");
  });

  test("a lease refused for a PR whose conflict was resolved returns the round instead of asking for help", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 121);
    // The fallen attempt is settled on disk: its round returned, one fall
    // counted, the remote still where it was observed.
    const cycle: RepairCycle = {
      usedRounds: 0,
      lastEvidence: signatureOf(121, OBSERVED),
      consecutiveFalls: 1,
      attempt: {
        evidence: signatureOf(121, OBSERVED),
        attempt: 2,
        observedHeadSha: OBSERVED,
        remoteHeadSha: OBSERVED,
        publication: "not-published",
        localWork: { headSha: "local121", commits: 1, uncommitted: false, operationInProgress: null },
      },
    };
    seedFallenLegacyRound(121, cycle, 2);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    git.localWork = { headSha: "local121", commits: 1, uncommitted: false, operationInProgress: null };

    // Between the derivation and the launch the operator pushes the resolution:
    // the remote moves and the PR becomes mergeable on the new head.
    const resolved = "7c9d0fe";
    changeFactsAtPrepare(git, () => {
      tracker.setPrRepairFacts({
        repo: REPO,
        prNumber: pr,
        headSha: resolved,
        mergeState: "mergeable",
        requiredChecks: [],
      });
      git.remoteHead = resolved;
    });

    const refused = await runOnce(deps);
    assert.equal(refused.launched.length, 0, "the round is not opened on a vanished impediment");
    assert.equal(runtime.launched.length, 1, "only attempt 1 ever ran — no repair session started");
    assert.ok(
      logs.some((line) => line.includes("not opened") && line.includes("premise is obsolete")),
      "the log names the obsolete premise instead of a concurrent change",
    );
    const settled = await readRepairCycle(workDir(layout, REPO, 121));
    assert.equal(
      settled.attempt?.publication,
      "not-published",
      "the settled attempt is not re-marked as a concurrent change",
    );
    const issue = await tracker.readIssue({ repo: REPO, number: 121 });
    assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "no help request");

    // The next sweep reads the mergeable PR and closes the repair cycle.
    const next = await runOnce(deps);
    assert.equal(next.launched.length, 0);
    assert.ok(
      next.reserved.some((decision) => decision.ref.number === 121 && decision.state === "repair-recovered"),
      "the mergeable PR is a confirmed recovery",
    );
    const after = await readRepairCycle(workDir(layout, REPO, 121));
    assert.equal(after.usedRounds, 0);
    assert.equal(after.consecutiveFalls, 0, "the vanished premise clears the fall streak");
  });

  test("a PR already merged before the round is due is done immediately — never a repair state", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 122);
    seedFallenLegacyRound(122);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    git.localWork = { headSha: "local122", commits: 1, uncommitted: false, operationInProgress: null };

    // The human merged the PR while the round was in flight.
    tracker.closePr({ repo: REPO, prNumber: pr }, { merged: true });

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "a merged PR opens no worker");
    assert.ok(
      sweep.reserved.some((decision) => decision.ref.number === 122 && decision.state === "done-fallback"),
      "the merged PR is delivery: done, not a repair state",
    );
    const issue = await tracker.readIssue({ repo: REPO, number: 122 });
    assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "no help request for delivered work");
    const comments = await tracker.readComments({ repo: REPO, number: 122 });
    assert.ok(comments.known);
    assert.ok(
      !comments.value.some((comment) => comment.body.includes("automatic repair stopped")),
      "no repair diagnosis is posted",
    );
  });

  test("a concurrent change whose impediment cannot be re-read is held — never a help request", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "clean-without-pr"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 123);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    await runOnce(deps); // the round is charged and ends without publishing

    // The operator pushes the resolution; GitHub has not computed the PR's
    // mergeability yet, so the premise cannot be confirmed either way.
    const resolved = "effc1b3c";
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: resolved,
      mergeState: "unknown",
      requiredChecks: [],
    });
    git.remoteHead = resolved;
    git.localWork = { headSha: OBSERVED, commits: 0, uncommitted: false, operationInProgress: null };

    const held = await runOnce(deps);
    assert.equal(held.launched.length, 0, "an unreadable premise opens no worker");
    assert.ok(
      !held.reserved.some((decision) => decision.state === "repair-fall-blocked"),
      "uncertainty is not turned into a block",
    );
    assert.ok(
      logs.some(
        (line) =>
          line.includes("reconciliation pending") &&
          line.includes("the impediment the round addressed could not be re-read"),
      ),
      "the log says what could not be re-read",
    );
    const heldCycle = await readRepairCycle(workDir(layout, REPO, 123));
    assert.equal(heldCycle.attempt?.publication, "pending", "the attempt is held, not settled");
    assert.equal(heldCycle.usedRounds, 1, "the round is neither returned nor renewed while uncertain");
    assert.equal(heldCycle.consecutiveFalls, 0, "no fall is invented");
    const issue = await tracker.readIssue({ repo: REPO, number: 123 });
    assert.ok(issue.known && !issue.value.labels.includes(DEFAULT_LABELS.blocked), "no help request");

    // The facts resolve: the impediment is gone and the round returns.
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: resolved,
      mergeState: "mergeable",
      requiredChecks: [],
    });
    const resolvedSweep = await runOnce(deps);
    assert.equal(resolvedSweep.launched.length, 0, "recovery launches nothing");
    assert.ok(
      resolvedSweep.reserved.some((decision) => decision.ref.number === 123 && decision.state === "repair-recovered"),
      "the mergeable PR is a confirmed recovery",
    );
    assert.ok(
      logs.some((line) => line.includes("premise is obsolete") && line.includes("the round returns")),
      "the log names the returned round",
    );
    const after = await readRepairCycle(workDir(layout, REPO, 123));
    assert.equal(after.usedRounds, 0, "the round is returned");
    assert.equal(after.consecutiveFalls, 0, "no fall was counted");
  });

  test("a mergeable PR whose required check still fails keeps the impediment — the round is not returned", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "clean-without-pr"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 124);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    await runOnce(deps);

    // The remote moved, but the required check concluded failing on the new
    // head: a real impediment, so the round is NOT returned.
    const moved = "fa11ed";
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: moved,
      mergeState: "mergeable",
      requiredChecks: [failing("build", "failure")],
    });
    git.remoteHead = moved;
    git.localWork = { headSha: OBSERVED, commits: 0, uncommitted: false, operationInProgress: null };

    const first = await runOnce(deps);
    assert.equal(first.launched.length, 0, "nothing is published over the concurrent change");
    const held = await readRepairCycle(workDir(layout, REPO, 124));
    assert.equal(held.attempt?.publication, "concurrent-change", "the moved head stays a human question");
    assert.equal(held.usedRounds, 1, "the round is not returned while the check still fails");

    const blocked = await runOnce(deps);
    assert.equal(blocked.launched.length, 0);
    const issue = await tracker.readIssue({ repo: REPO, number: 124 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the human is asked");
    const comments = await tracker.readComments({ repo: REPO, number: 124 });
    assert.ok(comments.known);
    assert.match(comments.value.at(-1)!.body, /a concurrent change/);
  });

  test("a fresh round follows the recalculated evidence to the current head", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "pr-open"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 125);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    // Between the derivation and the launch the head moved and still
    // conflicts: the evidence is recalculated and the round opens there.
    const recalculated = "c0ffee";
    changeFactsAtPrepare(git, () => {
      tracker.setPrRepairFacts({
        repo: REPO,
        prNumber: pr,
        headSha: recalculated,
        mergeState: "conflicting",
        requiredChecks: [],
      });
      git.remoteHead = recalculated;
    });

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the round opens on the current head");
    assert.equal(sweep.launched[0]!.request.material.repair?.observedHeadSha, recalculated, "the lease follows the head");
    assert.equal(sweep.launched[0]!.request.material.repair?.resuming, undefined, "a fresh round, not a resumption");
    assert.ok(
      logs.some((line) => line.includes("the evidence was recalculated on the current head")),
      "the log names the recalculated evidence",
    );
    const cycle = await readRepairCycle(workDir(layout, REPO, 125));
    assert.equal(cycle.usedRounds, 1, "the round is charged once");
    assert.equal(cycle.attempt?.observedHeadSha, recalculated, "the evidence on disk is the current one");
  });

  test("a PR merged while the round runs is done at collection — never a repair block", async () => {
    const { tracker, runtime, git, deps } = makeFactory(["pr-open", "clean-without-pr"]);
    const pr = await seedFirstAttempt(tracker, runtime, deps, 126);
    // A previous attempt wrote a failure: a second clean end without a PR
    // would be the 2nd consecutive fall — the help request of the incident.
    writeFileSync(
      join(workDir(layout, REPO, 126), DESFECHO_FILENAME),
      `${JSON.stringify({ class: "clean-without-pr", attempt: 2 })}\n`,
      "utf8",
    );
    writeFileSync(join(workDir(layout, REPO, 126), "log-2.jsonl"), "{}\n", "utf8");
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    // The human merges the PR while the repair round is in flight.
    runtime.hold = () => {
      tracker.closePr({ repo: REPO, prNumber: pr }, { merged: true });
    };

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the repair round ran");
    assert.equal(sweep.collected[0]?.ruling?.decision, "done", "a merged PR is delivery, not a fall");
    assert.equal(sweep.collected[0]?.ruling?.because, "pr-merged");

    const issue = await tracker.readIssue({ repo: REPO, number: 126 });
    assert.ok(issue.known && issue.value.state === "closed", "the factory closed the issue (done)");
    assert.ok(!issue.value.labels.includes(DEFAULT_LABELS.blocked), "no help request for delivered work");
    const comments = await tracker.readComments({ repo: REPO, number: 126 });
    assert.ok(comments.known);
    assert.ok(
      !comments.value.some((comment) => comment.body.includes("consecutive falls")),
      "no fall block is posted",
    );
    assert.match(comments.value.at(-1)!.body, /merged without closing/i, "the short fallback comment closes it");
    assert.ok(!existsSync(workDir(layout, REPO, 126)), "the artifacts were archived");
  });

  test("the forward path is untouched: a published round from the start behaves as before", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedFirstAttempt(tracker, runtime, deps, 109);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const round = await runOnce(deps);
    assert.equal(round.launched.length, 1, "round 1 launches");
    const cycle = await readRepairCycle(workDir(layout, REPO, 109));
    assert.equal(cycle.usedRounds, 1);
    assert.equal(cycle.attempt?.publication, "unknown", "the attempt is in flight, not yet settled");

    // The worker publishes a new head: the round is settled as published.
    git.remoteHead = "head-fixed";
    git.localWork = { headSha: "head-fixed", commits: 1, uncommitted: false, operationInProgress: null };
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: pr,
      headSha: "head-fixed",
      mergeState: "mergeable",
      requiredChecks: [{ name: "build", status: "in_progress", conclusion: null }],
    });
    const after = await runOnce(deps);
    assert.equal(after.launched.length, 0);
    const settled = await readRepairCycle(workDir(layout, REPO, 109));
    assert.equal(settled.attempt?.publication, "published");
    assert.equal(settled.usedRounds, 1, "the published round is charged, not doubled");
    const record = await readRepairCycle(workDir(layout, REPO, 109));
    assert.equal(record.attempt?.remoteHeadSha, "head-fixed");
  });
});

describe("e2e: the resumption over REAL git preserves the work (issue 112)", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let reposDir: string;
  let remote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-e2e-falls-git-"));
    layout = ensureWorkspace(join(root, "ws"));
    reposDir = join(root, "repos");
    mkdirSync(reposDir, { recursive: true });
    remote = await seedFixtureRemote(root, REPO, { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(root);
    rmSync(root, { recursive: true, force: true });
  });

  test("commits, uncommitted changes and an interrupted rebase are inspected, carried to the worker and left untouched", async () => {
    const config: Config = {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency: 1,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      configPath: join(root, "msf.yaml"),
    };
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open", "pr-open"] });
    const git = localGitWork({ reposDir, remoteUrl: () => remote.barePath(REPO) });
    const deps: LoopDeps = { config, tracker, runtime, git, workspace: layout, log: () => {} };

    // Attempt 1: the claim, the branch born from main, the PR — and the push
    // that puts the branch on the remote (publication of attempt 1).
    seedIssue(tracker, { repo: REPO, number: 100, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await runOnce(deps);
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 100 });
    assert.ok(feedback.known && feedback.value.pr);
    const cloneDir = repoCloneDir(reposDir, REPO);
    await execFile("git", ["push", "-q", "origin", workBranchName(100)], { cwd: cloneDir });
    const observed = (await execFile("git", ["rev-parse", workBranchName(100)], { cwd: cloneDir })).stdout.trim();

    // The fallen repair attempt's work, in Sandcastle's worktree: two commits,
    // an uncommitted file and an interrupted rebase.
    const worktreeDir = join(cloneDir, ".sandcastle", "worktrees", workBranchName(100));
    await execFile("git", ["worktree", "add", "-q", worktreeDir, workBranchName(100)], { cwd: cloneDir });
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: worktreeDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: worktreeDir });
    await commitFileIn(worktreeDir, "file.txt", "the work\n", "resolve the conflict");
    await commitFileIn(worktreeDir, "extra.txt", "more work\n", "follow the issue");
    writeFileSync(join(worktreeDir, "unfinished.txt"), "half done\n", "utf8");
    await remote.commitFile("main", "file.txt", "the base moved\n", "advance base");
    await execFile("git", ["fetch", "-q", "origin"], { cwd: worktreeDir });
    await assert.rejects(execFile("git", ["rebase", "origin/main"], { cwd: worktreeDir }));
    const produced = (await execFile("git", ["rev-parse", workBranchName(100)], { cwd: cloneDir })).stdout.trim();
    assert.notEqual(produced, observed);

    // The incident's durable state: the round charged, the fall on disk.
    writeFileSync(
      join(workDir(layout, REPO, 100), REPAIR_FILENAME),
      `${JSON.stringify({ usedRounds: 1, lastEvidence: `${REPO}#100|${observed}|conflicts|` })}\n`,
      "utf8",
    );
    writeFileSync(join(workDir(layout, REPO, 100), "log-2.jsonl"), "{}\n", "utf8");
    tracker.setPrRepairFacts({
      repo: REPO,
      prNumber: feedback.value.pr.number,
      headSha: observed,
      mergeState: "conflicting",
      requiredChecks: [],
    });

    const sweep = await runOnce(deps);

    // The resumption: same branch, same PR, the local work carried as facts.
    assert.equal(sweep.launched.length, 1, "the unpublished attempt is resumed");
    const request = sweep.launched[0]!.request;
    assert.equal(request.branch, workBranchName(100));
    assert.equal(request.material.pr?.number, feedback.value.pr.number, "the same PR");
    assert.equal(request.material.repair?.resuming, 2);
    assert.equal(request.material.repair?.observedHeadSha, observed, "the lease stays at the observed head");
    assert.deepEqual(request.material.repair?.localWork, {
      headSha: produced,
      commits: 2,
      uncommitted: true,
      operationInProgress: "rebase",
    });

    // Nothing was rewritten or reset: the commits, the dirty files and the
    // interrupted rebase are all still there for the worker to continue.
    const afterTip = (await execFile("git", ["rev-parse", workBranchName(100)], { cwd: cloneDir })).stdout.trim();
    assert.equal(afterTip, produced, "the fall's commits are preserved");
    assert.ok(existsSync(join(worktreeDir, "unfinished.txt")), "the uncommitted file is preserved");
    const status = await execFile("git", ["status", "--porcelain"], { cwd: worktreeDir });
    assert.match(status.stdout, /UU file\.txt|unfinished\.txt/, "the worktree still carries the unfinished work");
    const gitDir = (await execFile("git", ["rev-parse", "--git-dir"], { cwd: worktreeDir })).stdout.trim();
    assert.ok(existsSync(resolve(worktreeDir, gitDir, "rebase-merge")), "the rebase is still in progress");
    const remoteAfter = await execFile("git", ["ls-remote", "--heads", "origin", workBranchName(100)], {
      cwd: cloneDir,
    });
    assert.match(remoteAfter.stdout, new RegExp(observed), "nothing was pushed over the observed head");
    assert.equal((await readRepairCycle(workDir(layout, REPO, 100))).usedRounds, 1, "the fallen round returned");
  });
});
