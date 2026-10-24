
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SweepEngine, runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import { githubTicketNumber } from "./work-fixtures.js";

/**
 * End-to-end of issue 100 at the sweep seam, with real disk: the tracker's
 * marks and the workspace's reservations disagree, and the sweep says so
 * (unbacked claim, unmarked reservation) once per appearance — without
 * deleting, moving or archiving anything, and without stopping the sweep.
 * The two fake seams + a real temp workspace; deterministic, no network.
 */

const REPO = "Sanmoo/a";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements LegacyGitWork {
  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

describe("e2e: the tracker↔workspace leftovers say so, with real disk (issue 100)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-leftovers-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      workerGhAccount: "bot",
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

  function makeFactory(tracker: FakeTrackerAdapter) {
    const logs: string[] = [];
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps: LoopDeps = {
      config: makeConfig(),
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(new FakeGitWork()),
      workspace: layout,
      log: (line) => logs.push(line),
    };
    return { tracker, runtime, deps, logs };
  }

  const leftoverLines = (logs: readonly string[]): string[] =>
    logs.filter((line) => line.includes("unbacked claim:") || line.includes("unmarked reservation:"));

  test("each leftover is reported once per appearance, nothing is touched, and the sweep continues", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);

    // An unbacked claim: the tracker marks it, the workspace never registered it.
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    await tracker.claim({ repo: REPO, number: 1 }, "bot", DEFAULT_LABELS.ready);
    // An unmarked reservation: the dir exists, the tracker carries no mark.
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [] });
    mkdirSync(workDir(layout, REPO, 2), { recursive: true });
    // A released reservation (reservation + pool label) — normal, never reported.
    seedIssue(tracker, { repo: REPO, number: 3, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 3), { recursive: true });
    // A parked reserved work (claim + reservation) — normal, never reported.
    seedIssue(tracker, { repo: REPO, number: 4, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 4 });
    mkdirSync(workDir(layout, REPO, 4), { recursive: true });

    const engine = new SweepEngine(deps);
    await engine.deriveAndAct();

    // The derivation returned both leftovers (the same single-read seam runOnce reports).
    assert.equal(engine.lastReconciliation.unbackedClaims.length, 1);
    assert.equal(engine.lastReconciliation.unmarkedReservations.length, 1);

    const first = leftoverLines(logs);
    assert.equal(first.length, 2, "exactly the two leftovers, once each");
    const claimLine = first.find((line) => line.includes("unbacked claim:"))!;
    assert.match(claimLine, /unbacked claim: Sanmoo\/a#1/);
    assert.match(claimLine, /another factory or workspace may hold this claim/);
    assert.match(
      claimLine,
      /gh issue edit 1 --repo Sanmoo\/a --add-label ready-for-agent --remove-label agent-claimed --remove-assignee bot/,
    );
    const reservationLine = first.find((line) => line.includes("unmarked reservation:"))!;
    assert.match(reservationLine, /unmarked reservation: Sanmoo\/a#2/);
    assert.doesNotMatch(reservationLine, /gh issue edit/, "the unmarked reservation carries the fact only");
    assert.ok(!logs.some((line) => line.includes("claim: Sanmoo/a#3")), "a released reservation is normal");
    assert.ok(!logs.some((line) => line.includes("claim: Sanmoo/a#4")), "a mark with a reservation is normal");

    // The report touched nothing: the dirs and the tracker mark survive.
    assert.ok(existsSync(workDir(layout, REPO, 2)), "the unmarked reservation's dir was not moved");
    assert.ok(existsSync(workDir(layout, REPO, 4)), "the parked work's dir was not moved");
    const claimed = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(claimed.known && claimed.value.labels.includes(DEFAULT_LABELS.claimed), "the mark survives");
    assert.ok(engine.lastPool.some((entry) => githubTicketNumber(entry.work.ticket) === 3), "the sweep continued normally");

    // The next tick with the same leftovers is silent.
    await engine.deriveAndAct();
    assert.equal(leftoverLines(logs).length, 2, "the same leftover is not repeated");

    // The leftover disappears: the human releases #1 back to the pool.
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();
    assert.equal(leftoverLines(logs).length, 2, "a resolved leftover is silent");

    // It reappears: the mark is back without a reservation.
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    await engine.deriveAndAct();

    const reappeared = leftoverLines(logs);
    assert.equal(reappeared.length, 3, "a leftover that disappears and reappears is reported again");
    assert.match(reappeared.at(-1)!, /unbacked claim: Sanmoo\/a#1/);
  });

  test("runOnce exposes the leftovers of the sweep — the single derivation returns pool and leftovers", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    const { deps } = makeFactory(tracker);
    seedIssue(tracker, { repo: REPO, number: 5, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });

    const result = await runOnce(deps);

    assert.equal(result.reconciliation.unbackedClaims.length, 1);
    assert.equal(githubTicketNumber(result.reconciliation.unbackedClaims[0]!.work.ticket), 5);
    assert.equal(result.reconciliation.unmarkedReservations.length, 0);
  });
});
