import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";

/**
 * The interruption matrix of the claim swap (issue 98) at the sweep seam, with
 * a real workspace on disk: a claim failing at ANY write must leave a state the
 * NEXT sweep heals. The failure is never swallowed — it reaches the caller as a
 * failed launch and the factory keeps sweeping.
 */

const REPO = "Sanmoo/my-tasks";
const CREATED = "2026-01-01T00:00:00Z";

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
}

describe("e2e: an interrupted claim leaves a state the next sweep heals (issue 98)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-claim-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency = 1): Config {
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

  function makeDeps(config: Config, logs?: string[]): {
    deps: LoopDeps;
    tracker: FakeTrackerAdapter;
    runtime: FakeWorkerRuntime;
  } {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 7, labels: [DEFAULT_LABELS.ready], createdAt: CREATED });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    return {
      tracker,
      runtime,
      deps: { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: (m) => logs?.push(m) },
    };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known);
    return [...issue.value.labels].sort();
  }

  async function assigneesOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known);
    return issue.value.assignees;
  }

  test("a claim that fails at the label write leaves the reservation on disk and the work in the pool", async () => {
    const { deps, tracker, runtime } = makeDeps(makeConfig());
    const reservation = workDir(layout, REPO, 7);
    assert.equal(existsSync(reservation), false, "no reservation before any claim");

    tracker.failAt.add("claim:label");
    await assert.rejects(runOnce(deps), /injected failure at claim:label/);

    // The reservation came first: the tracker write failed and the dir is there.
    assert.ok(existsSync(reservation), "the reservation exists even though the tracker write failed");
    assert.deepEqual(await labelsOf(tracker, 7), [DEFAULT_LABELS.ready], "the work is still in the pool");
    assert.equal(runtime.launched.length, 0, "no worker was launched");

    // The failure was a real one, never the absent-label case: the next sweep
    // retries the claim and reuses the reservation already on disk.
    const { launched } = await runOnce(deps);
    assert.equal(launched.length, 1, "the next sweep claims and launches");
    assert.equal(launched[0]?.request.workDir, reservation, "the same reservation is reused");
    assert.deepEqual(await labelsOf(tracker, 7), [DEFAULT_LABELS.claimed]);
    assert.deepEqual(await assigneesOf(tracker, 7), [deps.config.workerGhAccount]);
  });

  test("a claim that fails at the assignee write keeps the claim mark with its reservation — the orphan rule releases it", async () => {
    const { deps, tracker } = makeDeps(makeConfig());
    const reservation = workDir(layout, REPO, 7);

    tracker.failAt.add("claim:assignee");
    await assert.rejects(runOnce(deps), /injected failure at claim:assignee/);

    assert.ok(existsSync(reservation), "the reservation is on disk");
    assert.deepEqual(
      await labelsOf(tracker, 7),
      [DEFAULT_LABELS.claimed, DEFAULT_LABELS.ready].sort(),
      "the claim mark landed (the padlock) and the pool label is still there",
    );
    assert.deepEqual(await assigneesOf(tracker, 7), [], "the assignee never landed");

    // The derivation sees a claimed work with a reservation and no session
    // evidence: the orphan rule releases it on the 1st fall — and the pool of
    // the same sweep already sees it back, so it is claimed and launched again
    // in one tick (the release is a tracker write, the re-claim follows it).
    const second = await runOnce(deps);
    assert.equal(second.reserved[0]?.state, "fall", "the interrupted claim is derived as a fall");
    assert.equal(second.launched.length, 1, "the released work is re-claimed and launched in the same sweep");
    assert.equal(second.launched[0]?.request.workDir, reservation, "the reservation is reused, never duplicated");
    assert.deepEqual(await labelsOf(tracker, 7), [DEFAULT_LABELS.claimed], "the padlock is back on");
    assert.deepEqual(await assigneesOf(tracker, 7), [deps.config.workerGhAccount]);
  });

  test("a claim that fails removing the pool label keeps claim + pool label — the next sweeps release and re-claim", async () => {
    const { deps, tracker } = makeDeps(makeConfig());
    const reservation = workDir(layout, REPO, 7);

    tracker.failAt.add(`remove:${DEFAULT_LABELS.ready}`);
    await assert.rejects(runOnce(deps), /injected failure at remove:ready-for-agent/);

    assert.ok(existsSync(reservation), "the reservation is on disk");
    assert.deepEqual(
      await labelsOf(tracker, 7),
      [DEFAULT_LABELS.claimed, DEFAULT_LABELS.ready].sort(),
      "the claim mark is on before the pool label leaves",
    );
    assert.deepEqual(await assigneesOf(tracker, 7), [deps.config.workerGhAccount], "the assignee landed");

    // One tick heals it: the derivation releases the interrupted claim (the
    // padlock leaves last) and the same sweep's pool re-claims and launches it.
    const second = await runOnce(deps);
    assert.equal(second.reserved[0]?.state, "fall");
    assert.equal(second.launched.length, 1, "released and re-claimed in the same sweep");
    assert.equal(second.launched[0]?.request.workDir, reservation, "the reservation is reused");
    assert.deepEqual(await labelsOf(tracker, 7), [DEFAULT_LABELS.claimed]);
  });

  test("a claim that completes leaves the pool label gone, the claim mark on and the work launched", async () => {
    const { deps, tracker, runtime } = makeDeps(makeConfig());

    const { launched } = await runOnce(deps);

    assert.equal(launched.length, 1);
    assert.deepEqual(await labelsOf(tracker, 7), [DEFAULT_LABELS.claimed], "only the padlock stays");
    assert.deepEqual(await assigneesOf(tracker, 7), [deps.config.workerGhAccount]);
    assert.ok(existsSync(workDir(layout, REPO, 7)), "the reservation is on disk");
    assert.equal(runtime.launched.length, 1);
  });

  test("a failed claim never kills the factory: the failure is said out loud and the next tick retries", async () => {
    const logs: string[] = [];
    const { deps, tracker, runtime } = makeDeps(makeConfig(), logs);
    const controller = new AbortController();

    tracker.failAt.add("claim:label");
    const running = runForever(deps, { tickMs: 20, signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (runtime.launched.length === 0) {
      if (Date.now() > deadline) throw new Error("the factory never retried the interrupted claim");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await running;

    assert.ok(
      logs.some((line) => line.includes("launch failed:") && line.includes("injected failure at claim:label")),
      "the failed write is reported, never swallowed",
    );
    assert.equal(runtime.launched.length, 1, "the next tick retried the claim and launched");
    assert.ok(
      logs.some((line) => line.includes("factory ended cleanly")),
      "the factory survived the failure and ended by the human's act",
    );
  });
});
