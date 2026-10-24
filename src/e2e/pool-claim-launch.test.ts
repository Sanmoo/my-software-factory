
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_RETRO,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import { launchedNumber } from "./work-fixtures.js";

/**
 * End-to-end of the pool, the claim and launch up to the outcome with PR.
 * The whole sweep runs against the two fake seams (in-memory tracker adapter
 * + scriptable fake runtime) — fast and deterministic, real temp workspace,
 * no network, no container.
 *
 * The five cases:
 *   1. 3 eligibles with y=2 — two claims by age; the third enters in the same
 *      cycle the moment a slot frees, with no barrier waiting for the slowest.
 *   2. An eligible with an open blocker stays out of the pool; with all
 *      closed it enters.
 *   3. The claim lands on the tracker before the launch — and the reservation
 *      on disk lands before the claim itself — while the engine's own in-flight
 *      set keeps its launches out of its own re-derivations. A second,
 *      stateless sweep reading a claim with ZERO attempt evidence cannot see
 *      the live launch: it treats the claim as an orphan and falls it — the
 *      honest disk truth, never a freeze.
 *   4. --once only exits after every launched worker ended, with the final
 *      tracker state correct (claimed with an open PR).
 *   5. A long work never blocks the other slots.
 */

const REPO = "Sanmoo/my-tasks";
const OLDEST = "2026-01-01T00:00:00Z";
const MIDDLE = "2026-01-02T00:00:00Z";
const NEWEST = "2026-01-03T00:00:00Z";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Minimal git-host fake: prepare is bookkeeping only. */
class FakeGitWork implements LegacyGitWork {
  readonly prepared: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false, // never pushed: the fakes launch, they do not publish
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

describe("e2e: pool, claim and launch up to the outcome with PR", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-pool-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number): Config {
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

  function makeDeps(config: Config): {
    deps: LoopDeps;
    tracker: FakeTrackerAdapter;
    runtime: FakeWorkerRuntime;
    git: FakeGitWork;
  } {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const git = new FakeGitWork();
    return {
      tracker,
      runtime,
      git,
      deps: { config, tickets: tracker, pullRequests: tracker, runtime, git: expandedGitWorkOf(git), workspace: layout, log: () => {} },
    };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  async function waitUntil(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  // ---- case 1 + 5: age order, same-cycle replenishment, no barrier ----

  test("3 eligibles with y=2: two claims by age; the third enters the same cycle a slot frees, without waiting for the slowest", async () => {
    const config = makeConfig(2);
    const { deps, tracker, runtime } = makeDeps(config);

    tracker.seedIssue({ repo: REPO, number: 1, createdAt: OLDEST, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 2, createdAt: MIDDLE, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 3, createdAt: NEWEST, labels: ["ready-for-agent"] });

    // Worker 1 is held (the slow work); worker 2 is held by a gate the test
    // controls; worker 3 runs free. Signals mark the act of each launch.
    const releaseSlow = deferred();
    const openGate2 = deferred();
    const launchedSlow = deferred();
    const launched2 = deferred();
    const launched3 = deferred();

    runtime.hold = async (request) => {
      if (launchedNumber(request) === 1) {
        launchedSlow.resolve();
        await releaseSlow.promise;
      } else if (launchedNumber(request) === 2) {
        launched2.resolve();
        await openGate2.promise;
      } else if (launchedNumber(request) === 3) {
        launched3.resolve();
      }
    };

    const sweep = runOnce(deps);
    try {
      await launched2.promise; // slots 1 and 2 taken, in age order

      // The gate frees worker 2: it ends, is collected at the act, and the
      // freed slot replenishes with #3 — all while worker 1 is still held.
      openGate2.resolve();
      await launched3.promise;

      // The fake records `runtime.launch` after the async material read, so its
      // array order is not deterministic; the claim order is deterministic and
      // the awaits above prove #3 launched without waiting for the slowest.
      assert.deepEqual(
        tracker.claimedOrder,
        [`${REPO}#1`, `${REPO}#2`, `${REPO}#3`],
        "claims follow the age order",
      );
      // #3 launched while the slowest worker is still in flight: the *claim*
      // order is the contract; the order the concurrent workers reach the
      // runtime is not.
      assert.deepEqual(
        runtime.launched.map((r) => launchedNumber(r)).sort((a, b) => a - b),
        [1, 2, 3],
        "#3 is launched without waiting for the slowest",
      );

      // Same cycle, no barrier: #2 already has its PR confirmed open and #3
      // is already claimed while worker 1 is still in flight.
      assert.ok(
        (await labelsOf(tracker, 3)).includes("agent-claimed"),
        "#3 claimed in the same cycle",
      );
      const feedback2 = await tracker.readPrFeedback({ repo: REPO, number: 2 });
      assert.ok(feedback2.known && feedback2.value.pr !== null, "#2 collected: PR open");

      // Releasing the slow work lets --once finish with everything collected.
      releaseSlow.resolve();
      const result = await sweep;
      assert.equal(result.collected.length, 3);
      assert.ok(result.collected.every((c) => c.prConfirmed), "every outcome confirmed its PR");
    } finally {
      // Every hold has a release path — a mid-test failure never leaves a
      // worker parked (the hold mechanism cannot hang by construction).
      openGate2.resolve();
      releaseSlow.resolve();
    }
  });

  test("a long work never blocks the other slots", async () => {
    const config = makeConfig(2);
    const { deps, tracker, runtime } = makeDeps(config);

    tracker.seedIssue({ repo: REPO, number: 1, createdAt: OLDEST, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 2, createdAt: MIDDLE, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 3, createdAt: NEWEST, labels: ["ready-for-agent"] });

    const releaseLong = deferred();
    const launchedLong = deferred();
    let longCollected = false;
    const launched3 = deferred();

    runtime.hold = async (request) => {
      if (launchedNumber(request) === 1) {
        launchedLong.resolve();
        await releaseLong.promise;
      } else if (launchedNumber(request) === 3) {
        launched3.resolve();
      }
    };

    // Mark when the long work's collection happened.
    const originalLaunch = runtime.launch.bind(runtime);
    runtime.launch = async (request) => {
      const result = await originalLaunch(request);
      if (launchedNumber(request) === 1) longCollected = true;
      return result;
    };

    const sweep = runOnce(deps);
    try {
      await launchedLong.promise;

      // While the long worker is parked, the other slot works through #2 and #3.
      await launched3.promise;
      await waitUntil("#3 collected", async () => {
        const feedback = await tracker.readPrFeedback({ repo: REPO, number: 3 });
        return feedback.known && feedback.value.pr !== null;
      });

      // #1 is still in flight (not yet collected) while #2 and #3 are done —
      // the long work blocked nothing.
      assert.ok(!longCollected, "the long work is still in flight");
      releaseLong.resolve();
      const result = await sweep;
      assert.equal(result.collected.length, 3);
    } finally {
      // Every hold has a release path — a mid-test failure never leaves a
      // worker parked (the hold mechanism cannot hang by construction).
      releaseLong.resolve();
    }
  });

  // ---- case 2: blockers gate the pool ----

  test("an eligible with an open blocker stays out of the pool; with all closed it enters", async () => {
    const config = makeConfig(2);
    const { deps, tracker, runtime } = makeDeps(config);

    tracker.seedIssue({ repo: REPO, number: 5, createdAt: OLDEST, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 6, state: "open" }); // the blocker
    tracker.addBlocker({ repo: REPO, number: 5 }, { repo: REPO, number: 6 });

    const blocked = await runOnce(deps);
    assert.equal(blocked.pool.length, 0, "open blocker keeps the work out of the pool");
    assert.equal(runtime.launched.length, 0);

    // The blocker closes: the next derivation lets the work in.
    tracker.seedIssue({ repo: REPO, number: 6, state: "closed", stateReason: "completed" });
    const free = await runOnce(deps);
    assert.equal(free.pool.length, 1);
    assert.deepEqual(
      free.launched.map((r) => launchedNumber(r.request)),
      [5],
    );
    assert.ok(free.collected[0]?.prConfirmed);
  });

  // ---- case 3: the claim swaps the label before the launch ----

  test("the claim swaps ready→claimed on the tracker before the launch — this sweep's in-flight set keeps its own launch out of its own re-derivations", async () => {
    const config = makeConfig(1);
    const { deps, tracker, runtime } = makeDeps(config);

    tracker.seedIssue({ repo: REPO, number: 1, createdAt: OLDEST, labels: ["ready-for-agent"] });

    const releaseWorker = deferred();
    const launchedWorker = deferred();
    runtime.hold = async () => {
      launchedWorker.resolve();
      await releaseWorker.promise;
    };

    const firstSweep = runOnce(deps);
    try {
      await launchedWorker.promise;

      // The swap happened before the launch: ready is gone, claimed is on, the
      // worker account is assigned — and the worker is still running.
      const labels = await labelsOf(tracker, 1);
      assert.ok(!labels.includes("ready-for-agent"), "ready label swapped away before the launch");
      assert.ok(labels.includes("agent-claimed"), "claimed label on before the launch");
      const issue = await tracker.readIssue({ repo: REPO, number: 1 });
      assert.ok(issue.known && issue.value.assignees.includes("bot-do-samuca"));

      // A second, stateless sweep derives the same tracker with an EMPTY
      // in-flight set: the claim has its reservation on disk but ZERO attempt
      // evidence — an interruption, recovered as the SAME attempt
      // with the claim re-asserted. The disk truth is honest: no session ever
      // started, and no attempt was consumed. The claim mark protects the pool
      // within one derivation, never across processes — a freeze would hold
      // the work forever.
      const secondRuntime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
      const secondSweep = await runOnce({
        config,
        tickets: tracker,
        pullRequests: tracker,
        runtime: secondRuntime,
        git: expandedGitWorkOf(new FakeGitWork()),
        workspace: layout,
        log: () => {},
        wait: async () => {},
      });
      const interrupted = secondSweep.reserved.find(
        (decision) => decision.work.ticket.provider === "github" && decision.work.ticket.number === 1,
      );
      assert.ok(
        interrupted && interrupted.state === "interrupted",
        "the stateless second sweep reads the claim with no attempt evidence as an interruption",
      );
      assert.equal(secondRuntime.launched.length, 1, "the second sweep recovers the interrupted claim");
      assert.equal(
        secondRuntime.launched[0]?.attempt,
        1,
        "the SAME attempt continues — zero evidence numbers attempt 1, and no attempt was consumed",
      );

      releaseWorker.resolve();
      await firstSweep;
    } finally {
      // Every hold has a release path — a mid-test failure never leaves a
      // worker parked (the hold mechanism cannot hang by construction).
      releaseWorker.resolve();
    }
  });

  // ---- case 4: --once waits for every launched worker ----

  test("--once only exits after every launched worker ended, with the final tracker state correct (claimed with PR)", async () => {
    const config = makeConfig(2);
    const { deps, tracker, runtime } = makeDeps(config);

    tracker.seedIssue({ repo: REPO, number: 1, createdAt: OLDEST, labels: ["ready-for-agent"] });
    tracker.seedIssue({ repo: REPO, number: 2, createdAt: MIDDLE, labels: ["ready-for-agent"] });

    let finished = 0;
    const originalLaunch = runtime.launch.bind(runtime);
    runtime.launch = async (request) => {
      const result = await originalLaunch(request);
      finished += 1;
      return result;
    };

    const result = await runOnce(deps);

    // runOnce returned only after both workers ended — and the sweep reports
    // every outcome collected.
    assert.equal(finished, 2);
    assert.equal(result.collected.length, 2);

    for (const number of [1, 2]) {
      const labels = await labelsOf(tracker, number);
      assert.ok(!labels.includes("ready-for-agent"), `#${number} no longer ready`);
      assert.ok(labels.includes("agent-claimed"), `#${number} stays reserved`);
      const feedback = await tracker.readPrFeedback({ repo: REPO, number });
      assert.ok(feedback.known && feedback.value.pr !== null, `#${number} has its open PR`);
      assert.equal(feedback.value.pr.state, "open");
      assert.equal(feedback.value.pr.author, "bot-do-samuca");

      // The outcome record exists on real disk under the workspace layout.
      const record = await import("../work-record/outcome.js").then((m) => m.readOutcomeRecord(workDirOf(number)));
      assert.ok(record, `#${number} wrote desfecho.json`);
      assert.equal(record.class, "pr-open");
    }
  });

  function workDirOf(number: number): string {
    return join(layout.works, `${REPO}#${number}`);
  }

  // ---- the idle edge stays clean ----

  test("an empty pool launches no worker and exits clean", async () => {
    const config = makeConfig(2);
    const { deps, runtime } = makeDeps(config);

    const result = await runOnce(deps);

    assert.deepEqual(result, {
      pool: [],
      reserved: [],
      reconciliation: { unbackedClaims: [], unmarkedReservations: [] },
      launched: [],
      collected: [],
      stop: null,
    });
    assert.equal(runtime.launched.length, 0);
  });
});
