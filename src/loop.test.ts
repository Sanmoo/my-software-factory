import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "./tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "./runtime/fake-runtime.js";
import { ensureWorkspace, workDir } from "./layout.js";
import { runOnce, SweepEngine, type LoopDeps } from "./loop.js";
import { workBranchName, type GitWork, type PreparedWork } from "./git/port.js";
import type { IssueRef } from "./tracker/port.js";

/**
 * The loop uses the git host as its launch seam (ticket 15): every launch
 * prepares the single clone + work branch first, and the runtime request
 * carries where the clone lives and what base the branch was born from —
 * the real runtime (ticket 17) consumes exactly this.
 */

class FakeGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];
  readonly cleaned: IssueRef[] = [];
  private count = 0;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    this.count += 1;
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: this.count === 1,
    };
  }

  async cleanupDoneWork(ref: IssueRef): Promise<void> {
    this.cleaned.push(ref);
  }
}

describe("loop wiring — the git host feeds every launch", () => {
  let root: string;
  let deps: LoopDeps;
  let git: FakeGitWork;
  let tracker: FakeTrackerAdapter;
  let runtime: FakeWorkerRuntime;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-loop-git-"));
    tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(tracker, { repo: "Sanmoo/a", number: 7, labels: ["ready-for-agent"], createdAt: "2026-01-01T00:00:00Z" });
    seedIssue(tracker, { repo: "Sanmoo/a", number: 8, labels: ["ready-for-agent"], createdAt: "2026-01-02T00:00:00Z" });
    git = new FakeGitWork();
    runtime = new FakeWorkerRuntime({ outcomes: ["pr-open", "pr-open"], tracker });
    deps = {
      config: {
        workerGhAccount: "bot",
        repos: ["Sanmoo/a"],
        concurrency: 2,
        workspace: root,
        labels: { ready: "ready-for-agent", claimed: "agent-claimed", blocked: "agent-blocked" },
        configPath: join(root, "msf.yaml"),
      },
      tracker,
      runtime,
      git,
      workspace: ensureWorkspace(root),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("each launch prepares the clone+branch first and hands the runtime the prepared facts", async () => {
    const { launched } = await runOnce(deps);

    assert.deepEqual(git.prepared.map((ref) => ref.number), [7, 8], "one prepare per launch");
    assert.equal(launched.length, 2);
    for (const result of launched) {
      const request = result.request;
      assert.equal(request.branch, workBranchName(request.ref.number));
      assert.equal(request.baseBranch, "main", "base revealed by the clone");
      assert.equal(request.repoDir, `/clones/${request.ref.repo.replaceAll("/", "#")}`);
      assert.equal(request.workDir, workDir(deps.workspace, request.ref.repo, request.ref.number));
    }
  });

  test("an empty pool never touches the git host", async () => {
    const emptyTracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    const { pool } = await runOnce({ ...deps, tracker: emptyTracker });

    assert.equal(pool.length, 0);
    assert.equal(git.prepared.length, 0);
    assert.equal(git.cleaned.length, 0);
  });

  test("the wait wakes by event: a worker's end resolves before the tick (ticket 14)", async () => {
    const engine = new SweepEngine(deps);
    await engine.deriveAndAct();

    // The tick is far away (60 s); the worker ends in microseconds — the
    // wake must come from the event, never from the clock.
    const wake = engine.waitForWake(60_000);
    const run = engine.fillSlots()[0]!;
    const event = await wake;

    assert.equal(event, "worker-end");
    await run;
  });
});
