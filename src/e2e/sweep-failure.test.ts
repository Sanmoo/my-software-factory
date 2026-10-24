import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef, Known, PrFeedback } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";

/**
 * A failed sweep (issue 158) at the continuous run's seam, with a real
 * workspace on disk: a tracker READ that GitHub does not answer — the shape of
 * the 503 that killed the factory on 2026-10-23 — ends the sweep, never the
 * factory. The failed sweep applies nothing (no launch from the stale pool, no
 * attempt, no write) and the next tick derives again; `--once` keeps failing
 * loud, because a single sweep has no next tick.
 */

const REPO = "Sanmoo/my-tasks";
const CREATED = "2026-01-01T00:00:00Z";
const ISSUE = 7;

/** Minimal git-host fake (ticket 15's seam): prepare is bookkeeping only. */
class FakeGitWork implements LegacyGitWork {
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

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

/** The fake tracker with an armable READ failure: the sweep's real path, never
 *  a write, and never the tolerated absent-issue case. */
class ArmedReadTracker extends FakeTrackerAdapter {
  /** Armed once; the failure is consumed by the next feedback read. */
  failNextFeedbackRead = false;
  feedbackReads = 0;

  override async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
    this.feedbackReads += 1;
    if (this.failNextFeedbackRead) {
      this.failNextFeedbackRead = false;
      const error = new Error(`gh api repos/${ref.repo}/pulls/1 exited 1: gh: HTTP 503`);
      throw Object.assign(error, { stderr: "gh: HTTP 503", exitCode: 1 });
    }
    return super.readPrFeedback(ref);
  }
}

/** Poll until `condition` holds; the timeout names what was waited for. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("e2e: a failed sweep never kills the continuous factory (issue 158)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-sweep-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
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
      notifications: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  /** A reserved work carrying the claim mark, its reservation on disk and no
   *  attempt yet — the derivation reads it as an interrupted attempt. */
  function makeDeps(config: Config, logs?: string[]): {
    deps: LoopDeps;
    tracker: ArmedReadTracker;
    runtime: FakeWorkerRuntime;
    reservation: string;
  } {
    const tracker = new ArmedReadTracker({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, {
      repo: REPO,
      number: ISSUE,
      labels: [DEFAULT_LABELS.claimed],
      createdAt: CREATED,
    });
    const reservation = workDir(layout, REPO, ISSUE);
    mkdirSync(reservation, { recursive: true });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    return {
      tracker,
      runtime,
      reservation,
      deps: {
        config,
        tickets: tracker,
        pullRequests: tracker,
        runtime,
        git: expandedGitWorkOf(new FakeGitWork()),
        workspace: layout,
        log: (message) => logs?.push(message),
        wait: async () => {},
      },
    };
  }

  test("a failed sweep is said out loud, acts on nothing, and the next tick derives again", async () => {
    const logs: string[] = [];
    const { deps, tracker, runtime, reservation } = makeDeps(makeConfig(), logs);
    tracker.failNextFeedbackRead = true;

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 300, signal: controller.signal });
    try {
      await waitFor(
        () => logs.some((line) => line.includes("sweep failed:")),
        "the failed sweep to be reported",
      );

      assert.ok(
        logs.some((line) => line.includes("gh: HTTP 503") && line.includes("retrying on the next tick")),
        `the failure and the retry are named in the operator's log; saw: ${logs.join(" | ")}`,
      );
      assert.equal(runtime.launched.length, 0, "a failed sweep launches nothing from the stale pool");
      assert.deepEqual(readdirSync(reservation), [], "a failed sweep writes no attempt artifact");
      const issue = await tracker.readIssue({ repo: REPO, number: ISSUE });
      assert.ok(issue.known);
      assert.deepEqual(issue.value.labels, [DEFAULT_LABELS.claimed], "the claim is untouched — no release, no block");

      await waitFor(
        () => runtime.launched.length === 1,
        "the next tick to derive again and recover the interrupted attempt",
      );
      assert.equal(runtime.launched[0]?.attempt, 1, "the SAME attempt continues — no fall was recorded");
    } finally {
      controller.abort();
      await running;
    }
    assert.ok(
      logs.some((line) => line.includes("factory ended cleanly")),
      "the factory survived the failed sweep and ended by the human's act",
    );
  });

  test("a failed sweep on a tick leaves the launched recovery alone and starts nothing new", async () => {
    const logs: string[] = [];
    const { deps, tracker, runtime } = makeDeps(makeConfig(), logs);

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 60, signal: controller.signal });
    try {
      await waitFor(() => runtime.launched.length === 1, "the boot sweep to launch the recovery");

      tracker.failNextFeedbackRead = true;
      await waitFor(
        () => logs.some((line) => line.includes("sweep failed:")),
        "a tick's sweep to fail",
      );
      assert.equal(runtime.launched.length, 1, "the failed tick launched nothing");
    } finally {
      controller.abort();
      await running;
    }
    assert.ok(
      logs.some((line) => line.includes("factory ended cleanly")),
      "the factory kept sweeping after a failed tick",
    );
  });

  test("`msf run --once` keeps failing loud: one sweep has no next tick to retry", async () => {
    const { deps, tracker, runtime } = makeDeps(makeConfig());
    tracker.failNextFeedbackRead = true;

    await assert.rejects(runOnce(deps), /gh: HTTP 503/);

    assert.equal(runtime.launched.length, 0, "the failed single sweep launched nothing");
  });
});
