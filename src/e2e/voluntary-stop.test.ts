import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, runOnce, type LoopDeps, type StopOptions } from "../loop.js";
import { installShutdownSignals } from "../shutdown.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { type GitWork, type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, loadConfigFrom, type Config, type RecoveryBudget } from "../config.js";
import { readRecoveryLedger, recordStopRequest } from "../pool/recovery.js";
import { waitFor } from "./cli-harness.js";

/**
 * The operator's requested stop and the restart that follows (issue #146), at
 * the sweep's public seams: the signal closes admissions, the in-flight worker
 * is asked to stop (cooperatively, or forced at the deadline/second signal),
 * the end is confirmed, and the next invocation resumes the SAME attempt
 * without spending the recovery budget. A confirmed Outcome survives the
 * stop; an unconfirmed end holds the work instead of risking a duplicate
 * worker.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements GitWork {
  constructor(private readonly beforePrepare?: () => Promise<void>) {}

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    await this.beforePrepare?.();
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}
  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }
  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("e2e: requested stop, restart and resume (issue #146)", { timeout: 60_000 }, () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-voluntary-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<Config> = {}): Config {
    const recovery: RecoveryBudget = { maxRecoveries: 1, waitsMs: [1] };
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency: 1,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery,
      notifications: false,
      configPath: join(dir, "msf.yaml"),
      ...overrides,
    };
  }

  function makeTracker(config: Config): FakeTrackerAdapter {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [config.labels.ready] });
    return tracker;
  }

  const workKey = "Sanmoo/my-tasks#1";

  function workDirOf(): string {
    return workDir(layout, REPO, 1);
  }

  async function ledgerOf(): Promise<Awaited<ReturnType<typeof readRecoveryLedger>>> {
    return readRecoveryLedger(workDirOf());
  }

  test("a stop requested during the startup stops the very first admission and leaves the pool untouched", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    const stop = new AbortController();
    stop.abort();
    const result = await runOnce(deps, { signal: stop.signal, cooperativeMs: 100 });

    assert.deepEqual(result.launched, [], "a stop before the first admission launches nothing");
    assert.deepEqual(result.shutdown?.unconfirmed, [], "with no worker, the stop is trivially confirmed");
    assert.equal(existsSync(workDirOf()), false, "no reservation was created");
    const issue = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.ready), "the work stays in the pool");
  });

  test("repeated voluntary stops resume the same attempt beyond the recovery budget, spending nothing", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    runtime.hold = async (request) => {
      await runtime.whenStopRequested(request.ref);
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    // The configured budget is 1; the operator's stops repeat four times.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const stop = new AbortController();
      const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 2_000 });
      await waitFor(`cycle ${cycle + 1}: the worker to launch`, () => runtime.launched.length === cycle + 1);
      stop.abort();
      const result = await running;
      assert.deepEqual(result.shutdown?.unconfirmed, [], `cycle ${cycle + 1}: the stop was confirmed`);
      const ledger = await ledgerOf();
      assert.equal(ledger.lastStop?.kind, "stop-requested", `cycle ${cycle + 1}: the stop is persisted`);
      assert.equal(ledger.consumed, 0, `cycle ${cycle + 1}: no recovery was spent`);
    }

    assert.deepEqual(
      runtime.launched.map((request) => request.attempt),
      [1, 1, 1, 1],
      "every resume continued the SAME attempt",
    );

    // The final invocation is a normal run: the attempt continues and the
    // worker ends with its real outcome.
    delete runtime.hold;
    const final = await runOnce(deps);
    assert.equal(final.launched.length, 1);
    assert.equal(final.launched[0]?.request.attempt, 1, "the same attempt still");
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(feedback.known && feedback.value.pr !== null, "the real outcome was registered");
    const ledger = await ledgerOf();
    assert.equal(ledger.consumed, 0, "the whole voluntary cycle spent no recovery");
    assert.equal(ledger.lastStop, null, "the stop record was consumed by the resume");
  });

  test("a stop between the claim and the worker keeps the reservation, and the next run resumes it without spending a recovery", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const entered = deferred();
    const release = deferred();
    const git = new FakeGitWork(async () => {
      entered.resolve();
      await release.promise;
    });
    const deps: LoopDeps = { config, tracker, runtime, git, workspace: layout, log: () => {} };

    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 2_000 });
    await entered.promise;
    stop.abort();
    release.resolve();
    await running;

    assert.equal(runtime.launched.length, 0, "the worker never started");
    assert.ok(existsSync(workDirOf()), "the reservation stays reconcilable");
    const ledger = await ledgerOf();
    assert.equal(ledger.lastStop?.kind, "stop-requested");
    assert.equal(ledger.lastStop?.attempt, 1);

    const next = await runOnce(deps);
    assert.equal(next.launched.length, 1, "the next invocation resumes the reserved work");
    assert.equal(next.launched[0]?.request.attempt, 1, "the SAME attempt, no new one");
    assert.equal((await ledgerOf()).consumed, 0, "the resume spent no recovery");
    assert.ok(existsSync(join(workDirOf(), "desfecho.json")), "the resumed worker completed normally");
  });

  test("the cooperative window forces a worker that ignores the request, and the end is confirmed", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"], ignoreStop: true });
    runtime.hold = async () => {
      await new Promise<void>(() => {}); // never ends on its own
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    const stop = new AbortController();
    const started = Date.now();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 60 });
    await waitFor("the refusing worker to launch", () => runtime.launched.length === 1);
    stop.abort();
    const result = await running;

    assert.deepEqual(runtime.stopRequests, [workKey], "the cooperative request reached the worker");
    assert.deepEqual(result.shutdown?.forced, [workKey], "the deadline forced the remaining worker");
    assert.deepEqual(result.shutdown?.unconfirmed, [], "the forced end was confirmed");
    assert.ok(Date.now() - started < 10_000, "the window bounds the cooperative phase");
    assert.equal((await ledgerOf()).lastStop?.kind, "stop-requested");
  });

  test("a stop during the recovery backoff returns the grant and leaves the requested stop on record", async () => {
    const config = makeConfig({ recovery: { maxRecoveries: 2, waitsMs: [60_000] } });
    const tracker = makeTracker(config);
    // The claim was held and the attempt left its evidence but no outcome: an
    // interruption whose recovery the next derivation grants.
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(join(workDirOf(), "log-1.jsonl"), "{}\n", "utf8");

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const backoffEntered = deferred();
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      log: () => {},
      wait: async () => {
        backoffEntered.resolve();
        await new Promise<void>(() => {}); // the interrupted backoff never ends on its own
      },
    };

    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 200 });
    await backoffEntered.promise;
    assert.equal((await ledgerOf()).consumed, 1, "the recovery was granted before the backoff");
    assert.equal(runtime.launched.length, 0, "the relaunch waits the backoff");

    stop.abort();
    const result = await running;
    assert.deepEqual(result.shutdown?.forced, [], "no worker existed to force");
    assert.deepEqual(result.shutdown?.unconfirmed, [], "and none to confirm");
    const ledger = await ledgerOf();
    assert.equal(ledger.consumed, 0, "the cancelled relaunch's grant was returned");
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the work keeps the operator's stop, not the interruption");

    // The next invocation resumes the SAME attempt for free: the returned grant
    // is not charged again and the backoff is not paid a second time.
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the interrupted work resumes");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal((await ledgerOf()).consumed, 0, "the whole stop-and-resume cycle spent no recovery");
  });

  test("the free resume is consumed at launch: an unexpected interruption after it is charged as usual", async () => {
    const config = makeConfig({ recovery: { maxRecoveries: 1, waitsMs: [1] } });
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["abrupt-death", "abrupt-death", "pr-open"] });
    runtime.hold = async (request) => {
      await runtime.whenStopRequested(request.ref);
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    // The operator's stop ends attempt 1; the next invocation resumes it free.
    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 2_000 });
    await waitFor("the worker to launch", () => runtime.launched.length === 1);
    stop.abort();
    await running;
    delete runtime.hold;
    assert.equal((await ledgerOf()).consumed, 0, "the stop spent nothing");

    // The resumed session dies without a record: that is an unexpected
    // interruption, so the recovery budget applies — the voluntary stop gave
    // no free pass to the attempt itself.
    await runOnce(deps);
    const ledger = await ledgerOf();
    assert.equal(ledger.consumed, 1, "the interruption after the resume was charged");
    assert.equal(ledger.lastStop?.kind, "interruption");
    assert.deepEqual(
      runtime.launched.map((request) => request.attempt),
      [1, 1, 1],
      "the attempt kept its number through the stop and the recovery",
    );
    const issue = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.blocked), "the exhausted budget asks for help");
  });

  test("the cooperative window is shared: a hung worker does not extend the deadline of its peers", async () => {
    const config = makeConfig({ concurrency: 2 });
    const tracker = makeTracker(config);
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: "2026-01-02T00:00:00Z", labels: [config.labels.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open", "pr-open"], ignoreStop: true });
    runtime.hold = async (request) => {
      // #1 ends as soon as it is asked; #2 never ends on its own.
      if (request.ref.number === 2) await new Promise<void>(() => {});
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 200 });
    await waitFor("both workers to launch", () => runtime.launched.length === 2);
    const started = Date.now();
    stop.abort();
    const result = await running;
    const elapsed = Date.now() - started;

    assert.deepEqual(
      result.shutdown?.forced,
      ["Sanmoo/my-tasks#2"],
      "only the worker that held activity past the shared deadline was forced",
    );
    assert.deepEqual(result.shutdown?.unconfirmed, [], "both ends were confirmed");
    assert.ok(
      elapsed < 350,
      `the 200 ms window covered the whole run, not each worker (took ${elapsed} ms)`,
    );
  });

  test("a second signal escalates before the deadline, and the confirmation still runs", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"], ignoreStop: true });
    runtime.hold = async () => {
      await new Promise<void>(() => {});
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    const requested = new AbortController();
    const escalated = new AbortController();
    const started = Date.now();
    const running = runOnce(deps, {
      signal: requested.signal,
      escalate: escalated.signal,
      cooperativeMs: 60_000,
    });
    await waitFor("the refusing worker to launch", () => runtime.launched.length === 1);
    requested.abort();
    escalated.abort();
    const result = await running;

    assert.deepEqual(result.shutdown?.forced, [workKey], "the second signal forced the worker");
    assert.deepEqual(result.shutdown?.unconfirmed, [], "the end was still confirmed");
    assert.ok(Date.now() - started < 10_000, "the escalation does not wait the cooperative window");
  });

  test("an unconfirmed stop is persisted, holds the next invocation, and resumes once the worker is confirmed gone", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const logs: string[] = [];
    const stuck = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      ignoreStop: true,
      forceUnconfirmed: true,
    });
    stuck.hold = async () => {
      await new Promise<void>(() => {});
    };
    const deps: LoopDeps = {
      config,
      tracker,
      runtime: stuck,
      git: new FakeGitWork(),
      workspace: layout,
      log: (line) => logs.push(line),
    };

    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 40 });
    await waitFor("the stuck worker to launch", () => stuck.launched.length === 1);
    stop.abort();
    const result = await running;

    assert.equal(result.shutdown?.unconfirmed.length, 1, "the factory does not call the stop safe");
    assert.match(result.shutdown?.unconfirmed[0]?.because ?? "", /still alive/);
    const ledger = await ledgerOf();
    assert.equal(ledger.lastStop?.kind, "stop-unconfirmed");
    assert.equal(ledger.lastStop?.attempt, 1);

    // The next invocation sees a worker still alive: it does not relaunch the
    // work on top of it, and says why.
    const held = await runOnce(deps);
    assert.equal(held.launched.length, 0, "no duplicate worker is started");
    assert.equal(stuck.launched.length, 1, "the previous worker was not replaced");
    assert.ok(
      logs.some((line) => line.includes("NOT relaunching") && line.includes("still alive")),
      `the operator gets the diagnostic: ${logs.join("\n")}`,
    );

    // A later invocation whose probe proves the worker gone resumes the same
    // attempt, without spending the recovery budget.
    const healthy = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const resumed = await runOnce({ ...deps, runtime: healthy });
    assert.equal(resumed.launched.length, 1, "the work resumes once the worker is gone");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal((await ledgerOf()).consumed, 0, "the resume spent no recovery");
  });

  test("a confirmed Outcome during the stop prevails: the work is not resumed as if interrupted", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    // The claim landed, the attempt wrote its real outcome and the PR is open;
    // the requested stop was persisted on top of it (the race of a stop that
    // arrives while the collection runs).
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    const opened = await tracker.openPr({
      repo: REPO,
      issueNumber: 1,
      headBranch: workBranchName(1),
      baseBranch: "main",
      title: "the confirmed work",
    });
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(
      join(workDirOf(), "desfecho.json"),
      JSON.stringify({
        class: "pr-open",
        attempt: 1,
        pr: { repo: REPO, number: opened.number, branch: workBranchName(1) },
      }),
      "utf8",
    );
    await recordStopRequest(workDirOf(), 1);

    const result = await runOnce(deps);
    assert.equal(result.launched.length, 0, "a confirmed Outcome is never relaunched as interrupted");
    assert.ok(
      !result.reserved.some((decision) => decision.state === "stop-resume"),
      "the stop interpretation does not override the confirmed Outcome",
    );
  });

  test("the next invocation reads the configuration as it is now — no in-process reload", async () => {
    const configPath = join(dir, "msf.yaml");
    const writeConfig = (account: string): void => {
      writeFileSync(
        configPath,
        [
          `worker-gh-account: ${account}`,
          "worker-model: opencode-go/glm-5.3-flash",
          `repos: [${REPO}]`,
          `workspace: ${layout.root}`,
          "notifications: false",
        ].join("\n"),
        "utf8",
      );
    };

    writeConfig("first-bot");
    const firstConfig = loadConfigFrom(dir);
    const firstTracker = new FakeTrackerAdapter({ workerAccount: firstConfig.workerGhAccount });
    seedIssue(firstTracker, { repo: REPO, number: 1, createdAt: NOW, labels: [firstConfig.labels.ready] });
    const firstRuntime = new FakeWorkerRuntime({ tracker: firstTracker, outcomes: ["pr-open"] });
    await runOnce({
      config: firstConfig,
      tracker: firstTracker,
      runtime: firstRuntime,
      git: new FakeGitWork(),
      workspace: layout,
      log: () => {},
    });
    const firstIssue = await firstTracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(firstIssue.known && firstIssue.value.assignees.includes("first-bot"));

    // The operator edits the config, then starts the factory again.
    writeConfig("second-bot");
    const secondConfig = loadConfigFrom(dir);
    assert.equal(secondConfig.workerGhAccount, "second-bot");
    const secondTracker = new FakeTrackerAdapter({ workerAccount: secondConfig.workerGhAccount });
    seedIssue(secondTracker, {
      repo: REPO,
      number: 2,
      createdAt: "2026-01-02T00:00:00Z",
      labels: [secondConfig.labels.ready],
    });
    const secondRuntime = new FakeWorkerRuntime({ tracker: secondTracker, outcomes: ["pr-open"] });
    await runOnce({
      config: secondConfig,
      tracker: secondTracker,
      runtime: secondRuntime,
      git: new FakeGitWork(),
      workspace: layout,
      log: () => {},
    });
    const secondIssue = await secondTracker.readIssue({ repo: REPO, number: 2 });
    assert.ok(
      secondIssue.known && secondIssue.value.assignees.includes("second-bot"),
      "the new invocation used the updated configuration",
    );
  });

  test("SIGTERM and SIGINT both drive the same stop contract", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const config = makeConfig();
      const tracker = makeTracker(config);
      const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
      runtime.hold = async (request) => {
        await runtime.whenStopRequested(request.ref);
      };
      const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };
      const installed = installShutdownSignals();
      const stopOptions: StopOptions = {
        signal: installed.requested,
        escalate: installed.escalated,
        cooperativeMs: 2_000,
      };
      const running = runForever(deps, { tickMs: 10, ...stopOptions });
      try {
        await waitFor(`${signal}: the worker to launch`, () => runtime.launched.length === 1);
        process.emit(signal);
        const report = await running;
        assert.deepEqual(report?.unconfirmed, [], `${signal}: the stop was confirmed`);
        assert.deepEqual(runtime.stopRequests, [workKey], `${signal}: the worker was asked to stop`);
      } finally {
        installed.dispose();
        runtime.forceStop({ repo: REPO, number: 1 }).catch(() => {});
      }
    }
  });
});
