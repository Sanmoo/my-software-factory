import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "./tracker/fake-adapter.js";
import { FakeWorkerRuntime, launchOf } from "./runtime/fake-runtime.js";
import { DEFAULT_LIVENESS_POLICY, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RETRO } from "./config.js";
import { ensureWorkspace, workDir } from "./layout.js";
import { runOnce, SweepEngine, type LoopDeps } from "./loop.js";
import { workKeyOf } from "./pool/work-key.js";
import { workBranchName, type LocalWorkFacts, type PreparedWork } from "./git/port.js";
import type { IssueRef } from "./tracker/port.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./e2e/legacy-git.js";
import { githubWork, launchedNumber } from "./e2e/work-fixtures.js";

/**
 * The loop uses the git host as its launch seam: every launch
 * prepares the single clone + work branch first, and the runtime request
 * carries where the clone lives and what base the branch was born from —
 * the real runtime consumes exactly this.
 */

class FakeGitWork implements LegacyGitWork {
  readonly prepared: IssueRef[] = [];
  readonly cleaned: IssueRef[] = [];
  readonly diffs = new Map<number, string>();
  /** Prepare reports the branch as already prepared (a relaunch, not a claim). */
  branchReused = false;
  /** Prepare reports the work branch as present on origin (the worker published). */
  branchOnOrigin = false;
  private count = 0;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    this.count += 1;
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: !this.branchReused && this.count === 1,
      branchOnOrigin: this.branchOnOrigin,
    };
  }

  async cleanupDoneWork(ref: IssueRef): Promise<void> {
    this.cleaned.push(ref);
  }

  async diffWork(ref: IssueRef): Promise<string> {
    return this.diffs.get(ref.number) ?? "";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}


/** Poll until `condition` holds; the timeout names what was waited for. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for: " + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
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
        workerModel: "opencode-go/glm-5.3-flash",
        jira: [],
        repos: ["Sanmoo/a"],
        concurrency: 2,
        workspace: root,
        labels: { ready: "ready-for-agent", claimed: "agent-claimed", blocked: "agent-blocked" },
        recovery: { maxRecoveries: 3, waitsMs: [1, 1, 1] },
        modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
        liveness: { ...DEFAULT_LIVENESS_POLICY },
        retro: { ...DEFAULT_RETRO },
        notifications: true,
        workerAuthFile: null,
        configPath: join(root, "msf.yaml"),
      },
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(git),
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
      assert.equal(request.branch, workBranchName(launchedNumber(request)));
      assert.equal(request.baseBranch, "main", "base revealed by the clone");
      assert.equal(request.repoDir, `/clones/${request.work.destination.repo.replaceAll("/", "#")}`);
      assert.equal(request.workDir, workDir(deps.workspace, request.work.destination.repo, launchedNumber(request)));
    }
  });

  test("the launch request carries the worker material — issue, PR conversation, diff", async () => {
    git.diffs.set(7, "diff --git a/x b/x\n+work");

    const { launched } = await runOnce(deps);

    // Two launches run concurrently: the ORDER they reach the runtime is not
    // part of the contract, only which work each request carries.
    const request = launchOf(launched, githubWork("Sanmoo/a", 7))?.request;
    assert.ok(request, "the launch of issue #7 is among the launched");
    assert.equal(request.material.ticket.title, "issue #7");
    assert.equal(request.material.ticket.body, "");
    assert.equal(request.material.diff, "diff --git a/x b/x\n+work");
    assert.equal(request.material.pr, undefined, "no PR exists at the first launch");
  });

  test("a relaunch of a branch not on origin says so — the reuse has nothing to fast-forward", async () => {
    const logged: string[] = [];
    git.branchReused = true;
    git.branchOnOrigin = false;

    const { launched } = await runOnce({ ...deps, log: (line) => logged.push(line) });

    const notes = logged.filter((line) => line.includes("is not on origin yet"));
    assert.equal(notes.length, launched.length, "one note per launch — the fact, not a per-tick alarm");
    assert.match(notes[0]!, /agent-issue-7/, "the note names the branch");
    assert.match(notes[0]!, /nothing to fast-forward/, "and what the relaunch's fetch finds");
  });

  test("no note when the worker published the branch — the retomada fetches for real", async () => {
    const logged: string[] = [];
    git.branchReused = true;
    git.branchOnOrigin = true;

    await runOnce({ ...deps, log: (line) => logged.push(line) });

    assert.equal(
      logged.filter((line) => line.includes("is not on origin yet")).length,
      0,
      "a published branch never needs the note",
    );
  });

  test("no note on the claim that creates the branch — only the reused one is annotated", async () => {
    const logged: string[] = [];

    await runOnce({ ...deps, log: (line) => logged.push(line) });

    // The fake reports #7's branch as created now and #8's as reused — the
    // claim fetches nothing at all, so only the relaunch earns the note.
    const notes = logged.filter((line) => line.includes("is not on origin yet"));
    assert.equal(notes.length, 1, "the created branch says nothing; the reused one does");
    assert.match(notes[0]!, /agent-issue-8/);
  });

  test("an empty pool never touches the git host", async () => {
    const emptyTracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    const { pool } = await runOnce({ ...deps, tickets: emptyTracker, pullRequests: emptyTracker });

    assert.equal(pool.length, 0);
    assert.equal(git.prepared.length, 0);
    assert.equal(git.cleaned.length, 0);
  });

  test("the wait wakes by event: a worker's end resolves before the tick", async () => {
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
test("a collection that fails still frees the slot and refills admission", async () => {
    const failing = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(failing, { repo: "Sanmoo/a", number: 7, labels: ["ready-for-agent"], createdAt: "2026-01-01T00:00:00Z" });
    seedIssue(failing, { repo: "Sanmoo/a", number: 8, labels: ["ready-for-agent"], createdAt: "2026-01-02T00:00:00Z" });
    // #7 writes a first fall (clean without PR): its collection releases the
    // claim — the write this test makes fail. #8 collects normally.
    const runtime = new FakeWorkerRuntime({ outcomes: ["clean-without-pr", "pr-open"], tracker: failing });
    const engine = new SweepEngine({
      ...deps,
      config: { ...deps.config, concurrency: 1 },
      tickets: failing,
      pullRequests: failing,
      runtime,
    });
    await engine.deriveAndAct();

    // The failure lands in the collection, after the worker ran: the release's
    // label write. It is never swallowed — the caller sees it.
    failing.failAt.add("release:relabel");
    const started = engine.fillSlots();
    const [first] = await Promise.allSettled(started);
    assert.equal(first?.status, "rejected", "the failed collection reaches the caller");

    // The slot was released and admission refilled in the same cycle: the work
    // that was waiting goes out even though the first one never collected.
    await waitFor(() => runtime.launched.length === 2, "the refilled admission");
    assert.deepEqual(
      runtime.launched.map((request) => launchedNumber(request)),
      [7, 8],
      "the next work of the pool takes the freed slot",
    );
    await engine.awaitAllLaunched();
    assert.deepEqual(
      engine.collected.map((entry) => workKeyOf(entry.work)),
      ["Sanmoo/a#8"],
      "the work whose collection succeeded is the one the sweep reports",
    );
  });
});
