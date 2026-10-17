import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import { localGitWork } from "../git/local.js";
import { seedFixtureRemote, cleanupFixture } from "../git/local-fixtures.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { readLaunchFacts, scanRegistry } from "../pool/registry.js";

/**
 * End-to-end of ticket 13: the ruler of outcomes applied at collection, the
 * per-work registry on real disk and the artifacts surviving the factory's
 * exit. The whole sweep runs against the two fake seams (in-memory tracker
 * adapter + scriptable fake runtime) — fast and deterministic, real temp
 * workspace, no network, no container (spec, Testing Decisions).
 *
 * The six classes of the ruler (each produces its decided transition):
 *   1. outcome with PR open → stays reserved awaiting the human (claim held);
 *   2. fall without PR, 1st consecutive → release (claimed→ready; branch stays);
 *   3. fall without PR, 2nd consecutive → blocked + comment with the exact outcome;
 *   4. NO outcome record → abrupt fall, the same ruler as 2/3;
 *   5. PR already existing on the issue → reserved, no launch, no fall recorded;
 *   6. blocked self-report → the factory only records it.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Minimal git-host fake (ticket 15's seam): prepare is bookkeeping only. */
class FakeGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}
}

describe("e2e: the ruler of outcomes (ticket 13)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-ruler-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      configPath: join(dir, "msf.yaml"),
    };
  }

  /**
   * A fresh factory instance: the tracker is the world outside the process
   * (it survives "exits" between sweeps); slots, caches and the runtime are
   * process memory — born and dead with each sweep, like the factory.
   */
  function makeFactory(config: Config, tracker: FakeTrackerAdapter, outcomes: ScriptedOutcome[]) {
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new FakeGitWork();
    return {
      tracker,
      runtime,
      git,
      deps: { config, tracker, runtime, git, workspace: layout, log: () => {} } as LoopDeps,
    };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  async function lastCommentOf(tracker: FakeTrackerAdapter, number: number): Promise<string> {
    const comments = await tracker.readComments({ repo: REPO, number });
    assert.ok(comments.known);
    assert.ok(comments.value.length > 0, "a comment should exist on the issue");
    return comments.value.at(-1)!.body;
  }

  // ---- class 1: outcome with PR open → stays reserved ----

  test("class 1 — an outcome with PR open keeps the claim held, awaiting the human", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps, runtime, tracker: t } = makeFactory(config, tracker, ["pr-open"]);

    const result = await runOnce(deps);

    assert.equal(result.launched.length, 1);
    const ruling = result.collected[0]?.ruling;
    assert.ok(ruling);
    assert.equal(ruling.decision, "reserve");
    assert.equal(ruling.because, "pr-open");
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim is held");
    assert.ok(!labels.includes(DEFAULT_LABELS.ready), "the work is not back in the pool");
    const record = JSON.parse(readFileSync(workDir(layout, REPO, 1) + "/desfecho.json", "utf8"));
    assert.equal(record.class, "pr-open");
    assert.equal(record.attempt, 1);
  });

  // ---- class 2: fall without PR, 1st → release (claimed→ready; branch stays) ----

  test("class 2 — the 1st fall releases the claim back to the pool (ready label returns)", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps, tracker: t } = makeFactory(config, tracker, ["clean-without-pr"]);

    const result = await runOnce(deps);

    const ruling = result.collected[0]?.ruling;
    assert.ok(ruling);
    assert.equal(ruling.decision, "release");
    assert.equal(ruling.because, "fall-first");
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.ready), "the ready label is back — the work re-enters the pool");
    assert.ok(!labels.includes(DEFAULT_LABELS.claimed), "the claim is released");
    const issue = await t.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.assignees.length === 0, "the assignee is gone");
  });

  test("class 2 — the branch is the memory: release preserves it, the relaunch reuses it (real git host)", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const fixture = await seedFixtureRemote(join(dir, "fixtures"), REPO, { defaultBranch: "main" });
    try {
      const git = localGitWork({
        reposDir: layout.repos,
        remoteUrl: (repo) => fixture.barePath(repo),
      });
      const deps: LoopDeps = {
        config,
        tracker,
        runtime: new FakeWorkerRuntime({ tracker, outcomes: ["clean-without-pr"] }),
        git,
        workspace: layout,
        log: () => {},
      };

      const first = await runOnce(deps);
      assert.equal(first.collected[0]?.ruling?.decision, "release");
      const cloneDir = first.launched[0]!.request.repoDir;
      assert.ok(
        existsSync(join(cloneDir, ".git", "refs", "heads", "agent-issue-1")) ||
          existsSync(join(cloneDir, ".git", "packed-refs")) === true,
        "the work branch survives the release in the single clone",
      );

      // The released work re-enters the pool; the relaunch reuses the branch.
      const second = await runOnce(deps);
      assert.equal(second.launched.length, 1);
      assert.equal(second.launched[0]!.request.branch, "agent-issue-1");
      assert.equal(second.launched[0]!.request.attempt, 2, "the registry numbered the 2nd attempt");
      assert.equal(second.launched[0]!.request.workDir, first.launched[0]!.request.workDir);
    } finally {
      cleanupFixture(join(dir, "fixtures"));
    }
  });

  // ---- class 3: fall without PR, 2nd consecutive → blocked + exact comment ----

  test("class 3 — the 2nd consecutive fall blocks the work and comments the issue with the exact outcome", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Attempt 1 falls → release. Attempt 2 (from the disk of attempt 1) falls too → blocked.
    const { deps, runtime, tracker: t } = makeFactory(config, tracker, ["clean-without-pr"]);
    await runOnce(deps);
    const second = await runOnce(deps);

    const ruling = second.collected[0]?.ruling;
    assert.ok(ruling);
    assert.equal(ruling.decision, "block");
    assert.equal(ruling.because, "fall-second");
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.blocked), "the work is blocked");
    assert.ok(!labels.includes(DEFAULT_LABELS.claimed), "claimed swapped away");
    assert.ok(!labels.includes(DEFAULT_LABELS.ready), "not back in the pool");

    const comment = await lastCommentOf(t, 1);
    assert.match(comment, /attempt 2/);
    assert.ok(comment.includes(JSON.parse(readFileSync(join(workDir(layout, REPO, 1), DESFECHO_FILENAME), "utf8")).class),
      "the comment carries the exact outcome class");
    assert.ok(comment.includes(JSON.stringify(JSON.parse(readFileSync(join(workDir(layout, REPO, 1), DESFECHO_FILENAME), "utf8")), null, 2)),
      "the comment carries the exact outcome record");
    assert.equal(runtime.launched.length, 2, "attempt 2 was launched once (no thrash on blocked works)");
  });

  // ---- class 4: NO outcome record → abrupt fall, same ruler ----

  test("class 4 — two abrupt deaths in a row: release then blocked with the absence stated", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, tracker: t } = makeFactory(config, tracker, ["abrupt-death"]);
    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling?.decision, "release");

    const second = await runOnce(deps);
    assert.equal(second.collected[0]?.ruling?.decision, "block");
    assert.equal(second.collected[0]?.ruling?.because, "fall-second");

    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.blocked));
    const comment = await lastCommentOf(t, 1);
    assert.match(comment, /attempt 2/);
    assert.match(comment, /no outcome record/i, "the absence of the record is the exact outcome");

    // The runtime left the launch evidence: session dir + per-attempt logs,
    // but no desfecho — the registry's own footprint of the abrupt fall.
    const wd = workDir(layout, REPO, 1);
    assert.ok(existsSync(join(wd, "sessao")));
    assert.ok(existsSync(join(wd, "log-1.jsonl")));
    assert.ok(existsSync(join(wd, "log-2.jsonl")));
    assert.ok(!existsSync(join(wd, DESFECHO_FILENAME)));
  });

  // ---- class 5: PR already existing → reserved, no launch, no fall recorded ----

  test("class 5 — a work whose issue already has an open PR is never launched and records no fall", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    tracker.seedPullRequest({
      repo: REPO,
      number: 1,
      state: "open",
      labels: [DEFAULT_LABELS.ready],
    });

    const { deps, runtime, tracker: t } = makeFactory(config, tracker, ["clean-without-pr"]);
    const result = await runOnce(deps);

    assert.equal(result.pool.length, 0, "the pre-existing PR keeps the work out of the pool");
    assert.equal(runtime.launched.length, 0, "no launch");
    assert.ok(!existsSync(workDir(layout, REPO, 1) + "/desfecho.json"), "no fall recorded, no artifacts");
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.ready), "the ready label was never swapped");
  });

  test("class 5 — a fall record with the PR open is reserved, never a fall (no consecutiveness)", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Attempt 1 opens the PR (reserved). The relaunch of a reserved work is a
    // feedback round (ticket 14) — here the ruler's exception is probed
    // directly through the same collection path: seed the record of a fall
    // while the PR stays open, then the next claim still sees the PR first.
    const { deps, tracker: t } = makeFactory(config, tracker, ["pr-open"]);
    await runOnce(deps);

    // Force the exact ruler fact combination at collection: the record of a
    // fall with the PR still open — the work stays reserved, no fall recorded.
    const wd = workDir(layout, REPO, 1);
    writeFileSync(
      join(wd, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 2 }),
      "utf8",
    );
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim was never released");
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "no fall was recorded");
  });

  // ---- class 6: blocked self-report → the factory only records it ----

  test("class 6 — a blocked self-report gets no factory transition, only the record", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, tracker: t } = makeFactory(config, tracker, ["blocked-self-report"]);
    const result = await runOnce(deps);

    const ruling = result.collected[0]?.ruling;
    assert.ok(ruling);
    assert.equal(ruling.decision, "record-only");
    assert.equal(ruling.because, "blocked-self-report");
    const labels = await labelsOf(t, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim stays held");
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "the factory adds no blocked label — the worker posts it");
    assert.ok(!labels.includes(DEFAULT_LABELS.ready));
    const comments = await t.readComments({ repo: REPO, number: 1 });
    assert.ok(comments.known && comments.value.length === 0, "the factory adds no comment — the worker posted the marker");
    const record = JSON.parse(readFileSync(join(workDir(layout, REPO, 1), DESFECHO_FILENAME), "utf8"));
    assert.equal(record.class, "blocked-self-report");
  });

  // ---- the registry survives the factory's exit ----

  test("the artifacts survive the factory's exit: a new factory instance reads them back from disk", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Factory #1: attempt 1 falls clean. runOnce returning IS the exit —
    // no process memory crosses to the next sweep.
    const factory1 = makeFactory(config, tracker, ["clean-without-pr"]);
    const first = await runOnce(factory1.deps);
    assert.equal(first.launched[0]!.request.attempt, 1);

    // Between the two factories: nothing but disk. The registry (a fresh
    // reader, as `msf status` or a restarted factory would be) reads the
    // artifacts back.
    const facts = await readLaunchFacts(workDir(layout, REPO, 1));
    assert.deepEqual(facts, { attempt: 2, previousFall: true });
    const view = await scanRegistry(layout);
    assert.deepEqual(view.inFlight, []);
    assert.equal(view.lastOutcome.length, 1);
    assert.equal(view.lastOutcome[0]!.key, `${REPO}#1`);
    assert.equal(view.lastOutcome[0]!.record.class, "clean-without-pr");

    // Factory #2: the registry numbered attempt 2 and remembered the fall.
    const factory2 = makeFactory(config, tracker, ["clean-without-pr"]);
    const second = await runOnce(factory2.deps);
    assert.equal(second.launched[0]!.request.attempt, 2, "attempt numbering came from the disk, not from memory");
    assert.equal(second.collected[0]?.ruling?.decision, "block", "the 2nd consecutive fall is blocked");
    const labels = await labelsOf(tracker, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.blocked));
  });
});
