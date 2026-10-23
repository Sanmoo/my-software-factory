import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, runOnce, type LoopDeps, type StopOptions } from "../loop.js";
import { installShutdownSignals } from "../shutdown.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { deferred } from "../runtime/deferred.js";
import { type GitWork, type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef, Known, PrFeedback } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  loadConfigFrom,
  type Config,
  type RecoveryBudget,
} from "../config.js";
import { readRecoveryLedger, recordStopRequest, recordUnconfirmedStop } from "../pool/recovery.js";
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

/** "<repo>#<number>" — the same key the factory and the probe use. */
const workKeyOf = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

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

/**
 * A tracker whose first PR-feedback read waits for the test: the collection of
 * a finished worker can then be observed INSIDE the stop, the race the issue
 * asks to cover.
 */
class GatedTracker extends FakeTrackerAdapter {
  readonly collectionEntered = deferred();
  private target: { number: number; remaining: number } | null = null;
  private gate: Promise<void> | null = null;

  /** The work's SECOND feedback read (the collection's) blocks until release:
   *  the launch material already made the first read. */
  holdCollectionOf(number: number): () => void {
    this.target = { number, remaining: 2 };
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.target = null;
      release();
    };
  }

  override async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
    if (this.target !== null && this.target.number === ref.number) {
      this.target.remaining -= 1;
      if (this.target.remaining === 0) {
        this.collectionEntered.resolve();
        await this.gate;
      }
    }
    return super.readPrFeedback(ref);
  }
}

describe("e2e: requested stop, restart and resume (issue #146)", { timeout: 60_000 }, () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-requested-"));
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
      liveness: { ...DEFAULT_LIVENESS_POLICY },
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
    assert.deepEqual(result.shutdown?.unconfirmed, [], "with no worker, nothing is held");
    assert.equal(result.shutdown?.unreadBecause, null, "and the probe answered, so the stop is confirmed");
    assert.equal(existsSync(workDirOf()), false, "no reservation was created");
    const issue = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.ready), "the work stays in the pool");
  });

  test("repeated requested stops resume the same attempt beyond the recovery budget, spending nothing", async () => {
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
    assert.equal(ledger.consumed, 0, "the whole requested-stop cycle spent no recovery");
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
    assert.equal(next.launched[0]?.request.branch, workBranchName(1), "the branch is preserved, not recreated");
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
    assert.ok(existsSync(join(workDirOf(), "log-1.jsonl")), "the attempt's history survives the stop");
    const ledger = await ledgerOf();
    assert.equal(ledger.consumed, 0, "the cancelled relaunch's grant was returned");
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the work keeps the operator's stop, not the interruption");

    // The next invocation resumes the SAME attempt for free: the returned grant
    // is not charged again and the backoff is not paid a second time.
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the interrupted work resumes");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal(resumed.launched[0]?.request.branch, workBranchName(1), "the branch is preserved");
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
    // interruption, so the recovery budget applies — the requested stop gave
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

  test("a worker whose collection races the stop registers its real Outcome, not a stop", async () => {
    const config = makeConfig({ concurrency: 2 });
    const tracker = new GatedTracker({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [config.labels.ready] });
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: "2026-01-02T00:00:00Z", labels: [config.labels.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    runtime.hold = async (request) => {
      // #1 finishes on its own; #2 parks until the operator's stop.
      if (request.ref.number === 2) await runtime.whenStopRequested(request.ref);
    };
    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };

    const release = tracker.holdCollectionOf(1);
    const stop = new AbortController();
    const running = runOnce(deps, { signal: stop.signal, cooperativeMs: 2_000 });
    await waitFor("both workers to launch", () => runtime.launched.length === 2);
    await tracker.collectionEntered.promise; // #1 wrote its record; its collection is in flight
    stop.abort();
    release();
    const result = await running;

    assert.deepEqual(result.shutdown?.unconfirmed, [], "both ends were confirmed");
    const finished = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(finished.known && finished.value.pr !== null, "the finished worker's real PR was registered");
    const finishedLedger = await readRecoveryLedger(workDir(layout, REPO, 1));
    assert.equal(finishedLedger.lastStop, null, "the confirmed Outcome prevails: no stop record left on it");
    const stopped = await tracker.readPrFeedback({ repo: REPO, number: 2 });
    assert.ok(stopped.known && stopped.value.pr === null, "the stopped worker invented no PR");
    assert.equal((await readRecoveryLedger(workDir(layout, REPO, 2))).lastStop?.kind, "stop-requested");
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
      // Docker is the authority on a surviving worker (ADR 0002): the fake
      // hands its own live sessions to the cycle as the probe, so a forced
      // stop that cannot end the worker shows up exactly as it would in
      // production — the work is held, never relaunched over.
      probe: () => stuck.liveWorkers(),
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
    // The hold is said out loud. Which module says it depends on why the work
    // is still in flight — the survivor recognition (issue 118) when the probe
    // shows the container, the stop reconciliation when it does not — and both
    // name the work the operator has to look at.
    assert.ok(
      logs.some(
        (line) =>
          line.includes(workKey) &&
          (line.includes("NOT relaunching") || line.includes("recognizing surviving worker")),
      ),
      `the operator gets the diagnostic: ${logs.join("\n")}`,
    );

    // A later invocation whose probe proves the worker gone resumes the same
    // attempt, without spending the recovery budget.
    const healthy = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const resumed = await runOnce({ ...deps, runtime: healthy, probe: () => healthy.liveWorkers() });
    assert.equal(resumed.launched.length, 1, "the work resumes once the worker is gone");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal((await ledgerOf()).consumed, 0, "the resume spent no recovery");
  });

  test("a survivor left by an unconfirmed stop resumes for free once its end is confirmed", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    // The previous invocation stopped with a worker it could not confirm: the
    // stop is on the ledger and the container is still up.
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(join(workDirOf(), "log-1.jsonl"), "{}\n", "utf8");
    await recordUnconfirmedStop(workDirOf(), 1, "a worker of this work is still alive");
    const logs: string[] = [];
    let alive = true;
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => (alive ? [{ key: workKey, containerId: "container-1", ageMs: 1_000 }] : []),
      log: (line) => logs.push(line),
    };

    // The same running factory sees the survivor, then sees it gone: the end
    // is the operator's own stop, whoever observes it — one uninterrupted run.
    const stop = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: stop.signal });
    try {
      await waitFor("the survivor to be recognised", () =>
        logs.some((line) => line.includes("recognizing surviving worker")),
      );
      assert.equal(runtime.launched.length, 0, "the survivor keeps its work and its slot");

      alive = false;
      await waitFor("the resumed launch", () => runtime.launched.length === 1);
      assert.equal(runtime.launched[0]?.attempt, 1, "the SAME attempt — the stop did not cost a new one");
      const ledger = await ledgerOf();
      assert.equal(ledger.consumed, 0, "the requested stop spent no recovery, whichever process saw the end");
      assert.equal(ledger.lastStop, null, "the stop record was consumed by the resume");
    } finally {
      stop.abort();
      await running.catch(() => {});
    }
  });

  test("a requested stop ends the surviving worker of a previous run and records the stop on its attempt", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    // The previous factory process died leaving its worker running (issue 118):
    // the container is alive, the work is still claimed and its attempt left
    // its history on disk.
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(join(workDirOf(), "log-1.jsonl"), "{}\n", "utf8");
    const containers = new Set([workKey]);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const forcedByTheFake = runtime.forceStop.bind(runtime);
    runtime.forceStop = async (ref) => {
      // The real forced stop removes the container; the probe proves it.
      containers.delete(workKeyOf(ref));
      await forcedByTheFake(ref);
    };
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => [...containers].map((key) => ({ key, containerId: `container-${key}`, ageMs: 1_000 })),
      log: () => {},
    };

    const stop = new AbortController();
    stop.abort();
    const result = await runOnce(deps, { signal: stop.signal, cooperativeMs: 100 });

    assert.deepEqual(result.shutdown?.forced, [workKey], "the surviving worker is ended, not left behind");
    assert.deepEqual(result.shutdown?.unconfirmed, [], "and its end is confirmed");
    const ledger = await ledgerOf();
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the stop is recorded on the survivor's attempt");
    assert.equal(ledger.lastStop?.attempt, 1);

    // The next invocation resumes that attempt for free and finishes it.
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the work resumes");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.ok(existsSync(join(workDirOf(), "log-1.jsonl")), "the attempt's history survives the stop");
    assert.equal((await ledgerOf()).consumed, 0, "the requested stop spent no recovery");
    assert.ok(existsSync(join(workDirOf(), "desfecho.json")), "the resumed worker completed normally");
  });

  test("a surviving worker the factory cannot end keeps the stop unconfirmed and the work held", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(join(workDirOf(), "log-1.jsonl"), "{}\n", "utf8");
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"], forceUnconfirmed: true });
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => [{ key: workKey, containerId: "container-1", ageMs: 1_000 }],
      log: () => {},
    };

    const stop = new AbortController();
    stop.abort();
    const result = await runOnce(deps, { signal: stop.signal, cooperativeMs: 100 });

    assert.deepEqual(result.shutdown?.unconfirmed, [
      { key: workKey, because: "a worker of this work is still alive" },
    ], "the factory does not call a stop safe over a worker it could not end");
    const ledger = await ledgerOf();
    assert.equal(ledger.lastStop?.kind, "stop-unconfirmed");
    assert.equal(ledger.lastStop?.attempt, 1, "the hold lands on the attempt never relaunched over");

    const held = await runOnce(deps);
    assert.equal(held.launched.length, 0, "nothing is relaunched while the worker may be alive");
    assert.equal((await ledgerOf()).consumed, 0, "the hold spends no recovery");
  });

  test("a probe outage at the stop never declares a known survivor safe", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    writeFileSync(join(workDirOf(), "log-1.jsonl"), "{}\n", "utf8");
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    let dockerAnswers = true;
    const logs: string[] = [];
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => {
        if (!dockerAnswers) throw new Error("Cannot connect to the Docker daemon");
        return [{ key: workKey, containerId: "container-1", ageMs: 1_000 }];
      },
      log: (line) => logs.push(line),
    };

    // The factory recognised the surviving worker; then Docker stops answering
    // and the operator stops the factory.
    const stop = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: stop.signal, cooperativeMs: 100 });
    try {
      await waitFor("the survivor to be recognised", () =>
        logs.some((line) => line.includes("recognizing surviving worker")),
      );
      dockerAnswers = false;
      stop.abort();
      const report = await running;
      assert.deepEqual(
        report?.unconfirmed,
        [{ key: workKey, because: "the worker liveness could not be read (Cannot connect to the Docker daemon)" }],
        "a worker known to be alive is never declared stopped because the probe went silent",
      );
      const ledger = await ledgerOf();
      assert.equal(ledger.lastStop?.kind, "stop-unconfirmed", "the uncertainty is persisted on its attempt");
      assert.equal(ledger.lastStop?.attempt, 1);
    } finally {
      stop.abort();
      await running.catch(() => {});
    }
  });

  test("a survivor with only a bare reservation gets the stop recorded, so its resume spends nothing", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    // The claim landed, the worker container is alive, and it never wrote an
    // attempt log — the registry dir is all the evidence there is.
    await tracker.claim({ repo: REPO, number: 1 }, config.workerGhAccount, config.labels.ready);
    mkdirSync(workDirOf(), { recursive: true });
    const containers = new Set([workKey]);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const forcedByTheFake = runtime.forceStop.bind(runtime);
    runtime.forceStop = async (ref) => {
      containers.delete(workKeyOf(ref));
      await forcedByTheFake(ref);
    };
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => [...containers].map((key) => ({ key, containerId: `container-${key}`, ageMs: 1_000 })),
      log: () => {},
    };

    const stop = new AbortController();
    stop.abort();
    await runOnce(deps, { signal: stop.signal, cooperativeMs: 100 });
    const recorded = await ledgerOf();
    assert.equal(recorded.lastStop?.kind, "stop-requested", "the stop is recorded on the bare reservation");
    assert.equal(recorded.lastStop?.attempt, 1, "the attempt its first launch would carry");

    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the work resumes");
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME first attempt");
    assert.equal((await ledgerOf()).consumed, 0, "the requested stop charged no recovery");
  });

  test("a silent Docker leaves the stop unconfirmed even with no work to name", async () => {
    const config = makeConfig();
    const tracker = makeTracker(config);
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      probe: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
      log: () => {},
    };

    const stop = new AbortController();
    stop.abort();
    const result = await runOnce(deps, { signal: stop.signal, cooperativeMs: 100 });

    assert.equal(
      result.shutdown?.unreadBecause,
      "Cannot connect to the Docker daemon",
      "the factory never calls a stop safe while it cannot see the workers",
    );
    assert.deepEqual(result.shutdown?.unconfirmed, [], "nothing was known to be alive — nothing is named");
    assert.deepEqual(result.shutdown?.forced, []);
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
