import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import type { IssueRef, RequiredCheckResult } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import {
  REPAIR_FILENAME,
  readRepairCycle,
  type RepairAttempt,
  type RepairCycle,
} from "../pool/repair.js";
import { scanRegistry } from "../pool/registry.js";
import { deriveStatus } from "../state/status.js";
import { renderStatus } from "../state/status-render.js";
import {
  appendJournalIntent,
  appendJournalResult,
  appendJournalStart,
  appendSessionLink,
  readPause,
} from "../runtime/continuity-artifacts.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import { githubWork, launchedNumber } from "./work-fixtures.js";

/**
 * e2e of issue 181: a repair round that never reached a worker is neither an
 * attempt nor a fall. It covers the continuity pause that prevents the launch,
 * the legacy ghost records written by an older factory version, a started round that
 * still falls, and the workspace move.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const OBSERVED = "2b45c0421fd9528df1d12032a942b60e1fff6518";
const PENDING_SESSION = "sess-never-started";

class ScenarioGitWork implements LegacyGitWork {
  /** The remote head the host observes; null = the branch is not there. */
  remoteHead: string | null = OBSERVED;
  /** The branch on disk; the default models "nothing new was produced". */
  localWork: LocalWorkFacts = {
    headSha: null,
    commits: 0,
    uncommitted: false,
    operationInProgress: null,
  };
  private count = 0;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
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
    return "";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return this.remoteHead;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return this.localWork.headSha === null
      ? { ...this.localWork, headSha: this.remoteHead }
      : this.localWork;
  }
}

describe("e2e: a repair round that never started is not a fall (issue 181)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-unstarted-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(target: WorkspaceLayout = layout): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency: 2,
      workspace: target.root,
      labels: { ...DEFAULT_LABELS },
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      workerAuthFile: null,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(
    target: WorkspaceLayout = layout,
    outcomes: ScriptedOutcome[] = ["pr-open"],
  ) {
    const config = makeConfig(target);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new ScenarioGitWork();
    const deps: LoopDeps = {
      config,
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(git),
      workspace: target,
      log: () => {},
    };
    return { tracker, runtime, git, deps, config };
  }

  const failing = (name: string, conclusion: RequiredCheckResult["conclusion"]): RequiredCheckResult => ({
    name,
    status: "completed",
    conclusion,
  });

  const signatureOf = (number: number, headSha: string): string =>
    `${REPO}#${number}|${headSha}|conflicts|`;

  /** The record an older factory version left behind: an attempt that no worker ever
   *  carried, settled as unpublished. */
  const ghostAttempt = (number: number, attempt: number): RepairAttempt => ({
    evidence: signatureOf(number, OBSERVED),
    attempt,
    observedHeadSha: OBSERVED,
    remoteHeadSha: null,
    publication: "not-published",
    localWork: { headSha: OBSERVED, commits: 1, uncommitted: false, operationInProgress: null },
  });

  /** A `reparo.json` as an older version wrote it. */
  function writeLegacyGhost(
    target: string,
    ghost: RepairAttempt,
    usedRounds: number,
    consecutiveFalls: number,
  ): RepairCycle {
    const cycle: RepairCycle = {
      usedRounds,
      lastEvidence: ghost.evidence,
      consecutiveFalls,
      attempt: ghost,
    };
    writeFileSync(join(target, REPAIR_FILENAME), `${JSON.stringify(cycle, null, 2)}\n`, "utf8");
    return cycle;
  }

  async function seedOpenPr(
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
      requiredChecks: [failing("build", "failure")],
    });
  }

  /** The doubt continuity refuses on: an interrupted call of the previous
   *  attempt that the real state cannot reconcile. The repair launch reaches
   *  `planContinuity` and pauses before any worker exists. */
  function seedPendingEffect(target: string): void {
    appendJournalStart(target, { attempt: 1, sessionId: PENDING_SESSION });
    appendJournalIntent(target, {
      attempt: 1,
      sessionId: PENDING_SESSION,
      callId: "call-never-started",
      tool: "bash",
      command: "curl -X POST https://example.com",
      safety: "unknown",
      actions: [],
      reason: "curl is not a proven-local command",
    });
  }

  /** A work whose repair launch is refused by continuity, with the PR facts
   *  still demanding the round. Returns the PR number and its work dir. */
  async function pausedRepairRound(number: number): Promise<{
    pr: number;
    target: string;
    deps: LoopDeps;
    tracker: FakeTrackerAdapter;
    runtime: FakeWorkerRuntime;
    git: ScenarioGitWork;
  }> {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, number);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;
    const target = workDir(layout, REPO, number);
    seedPendingEffect(target);
    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 0, "continuity refused the launch — no worker started");
    return { pr, target, deps, tracker, runtime, git };
  }

  test("a repair launch paused by continuity spends no round, counts no fall and never reaches the repair section", async () => {
    const { target, tracker, deps } = await pausedRepairRound(1);

    const cycle = await readRepairCycle(target);
    assert.equal(cycle.usedRounds, 0, "the round returns to the budget");
    assert.equal(cycle.consecutiveFalls, 0, "a round that never started is not a fall");
    assert.equal(cycle.attempt, null, "no attempt N is recorded without session evidence");
    assert.equal(readPause(target)?.attempt, 2, "the pause is the only explanation for the stopped work");

    const registry = await scanRegistry(layout);
    assert.equal(
      registry.repair.some((entry) => entry.key === `${REPO}#1`),
      false,
      "the status repair section does not list the round",
    );
    const view = await deriveStatus(tracker, deps.config, layout, async () => []);
    assert.match(
      renderStatus(view),
      /repair \(unpublished attempts, local work, pending reconciliation\): none/,
      "the rendered status section is empty",
    );
    assert.equal(
      (await tracker.readPrFeedback({ repo: REPO, number: 1 })).known,
      true,
      "the work keeps its open PR",
    );
  });

  test("after the pause the work continues and the real repair fall does not become a block", async () => {
    const { target, deps, tracker } = await pausedRepairRound(2);

    // The doubt is settled by its own evidence: the call ended, recorded in
    // the effect journal. The next cycle resolves the pause without a human.
    appendJournalResult(target, {
      attempt: 1,
      sessionId: PENDING_SESSION,
      callId: "call-never-started",
      ok: false,
    });
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the work continues after the pause");
    assert.equal(resumed.launched[0]!.request.attempt, 2, "the attempt the pause planned continues");

    // The PR still demands repair. This round really starts on the next sweep,
    // publishes nothing, and is therefore one fall — not the second one.
    const repair = await runOnce(deps);
    assert.equal(repair.launched.length, 1, "the persisting impediment opens a real round");
    assert.ok(repair.launched[0]!.request.material.repair, "it carries the repair context");

    const settled = await runOnce(deps);
    const cycle = await readRepairCycle(target);
    assert.equal(cycle.consecutiveFalls, 1, "only the round that really ran counts a fall");
    assert.notEqual(cycle.consecutiveFalls, 2, "the ghost round did not fill the fall ruler");
    const issue = await tracker.readIssue({ repo: REPO, number: 2 });
    assert.ok(issue.known);
    assert.equal(
      issue.value.labels.includes(DEFAULT_LABELS.blocked),
      false,
      "the repair score never becomes a block",
    );
    assert.equal(settled.launched.length, 1, "the one fall is resumable, not a block");
  });

  test("a round that started and really did not publish still counts a fall", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, 3);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const first = await runOnce(deps);
    assert.equal(first.launched.length, 1, "the repair round started");
    const target = workDir(layout, REPO, 3);
    const charged = await readRepairCycle(target);
    assert.equal(charged.usedRounds, 1, "the started round is charged");
    assert.equal(charged.attempt?.publication, "unknown");

    // Its own event log proves it reached a worker: the settlement must not
    // mistake it for a round that never started.
    const afterFall = await runOnce(deps);
    assert.equal(afterFall.launched.length, 1, "one fall is still resumable");
    const cycle = await readRepairCycle(target);
    assert.equal(cycle.consecutiveFalls, 1, "the started round counts its fall");
    assert.equal(cycle.usedRounds, 1, "the fallen round returns and the resumed one is charged");
  });

  test("a legacy ghost never refunds a round a real attempt had already consumed", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, 6);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const target = workDir(layout, REPO, 6);
    // One earlier, genuinely delivered round stays charged. The ghost's own
    // settlement already returned ITS round; healing it must not return the
    // delivered one a second time.
    writeLegacyGhost(target, ghostAttempt(6, 6), 1, 2);

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the persisting impediment opens the next round");
    const cycle = await readRepairCycle(target);
    assert.equal(cycle.usedRounds, 2, "the delivered round stays charged; only the ghost fell away");
    assert.equal(cycle.consecutiveFalls, 1, "the ghost's fall is withdrawn once");
  });

  test("a planned session association alone never proves the worker started", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, 7);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const target = workDir(layout, REPO, 7);
    writeLegacyGhost(target, ghostAttempt(7, 2), 0, 2);
    // Continuity recorded the session it PLANNED, then the launch died before
    // any worker: the association is not proof that an attempt started.
    appendSessionLink(target, {
      version: 1,
      work: githubWork(REPO, 7),
      attempt: 2,
      round: 1,
      sessionId: "sess-planned-only",
      at: NOW,
    });

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the planned-only session does not block the work");
    const cycle = await readRepairCycle(target);
    assert.equal(cycle.consecutiveFalls, 1, "the ghost's fall is withdrawn");
    assert.equal(cycle.usedRounds, 1, "only the real round is charged");
  });

  test("a legacy attempt without session evidence never blocks the next sweep", async () => {
    const { tracker, runtime, git, deps } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, 4);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const target = workDir(layout, REPO, 4);
    const legacy = writeLegacyGhost(target, ghostAttempt(4, 6), 0, 2);

    // A status read before any sweep reaches the same verdict and writes
    // nothing: the record is healed by the sweep, never by the order the
    // operator happens to read first.
    const before = await scanRegistry(layout);
    assert.deepEqual(
      before.repair.some((entry) => entry.key === `${REPO}#4`),
      false,
      "the status does not present a round whose attempt never reached a worker",
    );
    assert.deepEqual(await readRepairCycle(target), legacy, "the status read is read-only");

    const sweep = await runOnce(deps);
    assert.equal(sweep.launched.length, 1, "the ghost record no longer blocks the work");
    const cycle = await readRepairCycle(target);
    assert.equal(cycle.consecutiveFalls, 1, "the ghost record's fall is withdrawn");
    assert.equal(cycle.usedRounds, 1, "the real round is the only one charged");
    assert.equal(cycle.attempt?.attempt, 2, "the attempt number returns to the real ledger");
    const issue = await tracker.readIssue({ repo: REPO, number: 4 });
    assert.ok(issue.known);
    assert.equal(issue.value.labels.includes(DEFAULT_LABELS.blocked), false);
    assert.equal(
      launchedNumber(sweep.launched[0]!.request),
      4,
      "the launched round belongs to the work",
    );
  });

  test("moving the workspace before the sweep changes nothing — the verdict is read by name, never by mtime", async () => {
    const { tracker, runtime, git, deps, config } = makeFactory();
    const pr = await seedOpenPr(tracker, runtime, deps, 5);
    await conflictingOn(tracker, pr, OBSERVED);
    git.remoteHead = OBSERVED;

    const target = workDir(layout, REPO, 5);
    writeLegacyGhost(target, ghostAttempt(5, 7), 0, 2);

    // The operator's workspace moves (a new disk, a restored backup): the same
    // artifacts land elsewhere and a fresh invocation must reach the same
    // verdict. No timestamp is consulted — only the attempt's own file names.
    const movedRoot = join(dir, "moved");
    renameSync(layout.root, movedRoot);
    const moved = ensureWorkspace(movedRoot);
    const movedDeps: LoopDeps = {
      ...deps,
      config: { ...config, workspace: moved.root },
      workspace: moved,
    };
    const sweep = await runOnce(movedDeps);
    assert.equal(sweep.launched.length, 1, "the moved workspace is read the same way");
    const cycle = await readRepairCycle(workDir(moved, REPO, 5));
    assert.equal(cycle.consecutiveFalls, 1, "the ghost fall is withdrawn after the move too");
    assert.equal(cycle.attempt?.attempt, 2, "the real attempt ledger wins over the ghost number");
  });
});
