import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "./tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "./runtime/fake-runtime.js";
import { ensureWorkspace, workDir } from "./layout.js";
import { runOnce, type LoopDeps } from "./loop.js";
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
  readonly diffs = new Map<number, string>();
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

  async diffWork(ref: IssueRef): Promise<string> {
    return this.diffs.get(ref.number) ?? "";
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

  test("the launch request carries the worker material — issue, PR conversation, diff (ticket 17)", async () => {
    git.diffs.set(7, "diff --git a/x b/x\n+work");

    const { launched } = await runOnce(deps);

    const request = launched[0]?.request;
    assert.ok(request);
    assert.equal(request.material.issue.title, "issue #7");
    assert.equal(request.material.issue.body, "");
    assert.equal(request.material.diff, "diff --git a/x b/x\n+work");
    assert.equal(request.material.pr, undefined, "no PR exists at the first launch");
  });

  test("an empty pool never touches the git host", async () => {
    const emptyTracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    const { pool } = await runOnce({ ...deps, tracker: emptyTracker });

    assert.equal(pool.length, 0);
    assert.equal(git.prepared.length, 0);
    assert.equal(git.cleaned.length, 0);
  });
});
