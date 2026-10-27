import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
} from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { runForever, runOnce, type LoopDeps } from "../loop.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { LaunchPreconditionError, type WorkRequest } from "../runtime/port.js";
import { consumeRecovery, recordStopRequest } from "../pool/recovery.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import { deferred } from "../runtime/deferred.js";
import { deriveStatus } from "../state/status.js";
import { renderStatus } from "../state/status-render.js";
import { seedSession } from "./session-fixtures.js";
import { waitFor } from "./cli-harness.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import type { IssueRef } from "../tracker/port.js";

/**
 * A Launch refusal — the runtime proving no worker existed — refunds the
 * recovery grant the factory persisted before the launch. The work stays
 * reserved with its budget intact and the next tick relaunches the same
 * attempt; an ambiguous failure, one that may have left a worker behind, keeps
 * the grant consumed.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements LegacyGitWork {
  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: false,
      branchOnOrigin: true,
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

describe("e2e: a Launch refusal refunds the recovery the relaunch held", () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let tracker: FakeTrackerAdapter;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-launch-refusal-"));
    layout = ensureWorkspace(join(dir, "ws"));
    tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      jira: [],
      repos: [REPO],
      concurrency: 1,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      retro: { ...DEFAULT_RETRO },
      notifications: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function deps(runtime: FakeWorkerRuntime, cfg = config()): LoopDeps {
    return {
      config: cfg,
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(new FakeGitWork()),
      workspace: layout,
      log: (line) => logs.push(line),
      wait: async () => {},
    };
  }

  /** The durable footprint of an interrupted attempt 1: the claim was held and
   *  the attempt left its log and its own session, but no outcome record. */
  function interruptedAttempt1(): string {
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 1);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), "{}\n", "utf8");
    seedSession(target, { repo: REPO, number: 1 }, 1);
    return target;
  }

  function refusesBeforeWorker(
    message: string,
    refusals = 1,
  ): (request: WorkRequest, index: number) => Error | null {
    return (_request, index) => (index < refusals ? new LaunchPreconditionError(message) : null);
  }

  test("the refusal refunds the grant: the budget stays intact, the work reserved, and the next tick retries the same attempt", async () => {
    const target = interruptedAttempt1();
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: refusesBeforeWorker(
        "the worker image carries no readable agent inventory at /opt/msf/agent-inventory.json; rebuild it with npm run build:image",
      ),
    });

    const refused = await runOnce(deps(runtime)).then(
      () => null,
      (error: unknown) => error,
    );

    assert.ok(refused instanceof LaunchPreconditionError, "the environment's refusal surfaces, never swallowed");
    assert.match(refused.message, /agent-inventory\.json/, "and carries the operator's own reason");
    assert.equal(runtime.launched.length, 1, "the runtime was asked once and refused before any session");
    const afterRefusal = await readRecoveryLedger(target);
    assert.equal(afterRefusal.consumed, 0, "the granted recovery was refunded to the attempt's budget");
    assert.deepEqual(afterRefusal.events, [], "the refunded grant is not left as history");
    assert.equal(afterRefusal.attempt, 1, "the attempt keeps its number");
    assert.equal(afterRefusal.lastStop?.kind, "interruption", "the attempt is still the interrupted one");
    assert.equal(existsSync(join(target, "desfecho.json")), false, "no outcome was written: no attempt was consumed");
    assert.equal(
      readFileSync(join(target, "log-1.jsonl"), "utf8").includes("session-start"),
      false,
      "the refusal left no footprint: no session started, so no worker existed",
    );
    const issue = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.claimed), "the work stays reserved");
    assert.equal(
      logs.some((line) => line.includes("refused before any worker existed") && line.includes("agent inventory")),
      true,
      "the operator reads the environment's own reason",
    );
    assert.equal(logs.some((line) => line.includes("the recovery granted to this relaunch is refunded")), true);

    // `msf status` derives the same ledger: the budget is the real one after
    // the refund, and the work is still the interrupted attempt.
    const view = await deriveStatus({ github: tracker }, config(), layout, async () => []);
    assert.match(
      renderStatus(view),
      /#1 \(attempt 1 was interrupted — no outcome record on disk; 0\/3 recoveries consumed \(waits 0s\/0s\/0s\)/,
      "the operator sees the refund in the budget the ledger really holds",
    );

    // The next tick re-derives the work from disk and retries the SAME attempt.
    const retried = await runOnce(deps(runtime));
    assert.equal(retried.launched.length, 1, "the next tick launches again");
    assert.equal(retried.launched[0]?.request.attempt, 1, "the SAME attempt, no new one");
    assert.equal(retried.launched[0]?.request.branch, workBranchName(1), "the branch is preserved");
    const afterRetry = await readRecoveryLedger(target);
    assert.equal(afterRetry.consumed, 1, "the retry spent exactly the grant it used — the budget was not inflated");
    assert.equal(existsSync(join(target, "desfecho.json")), true, "the retried worker ended with its real outcome");
  });

  test("in the continuous run the refusal pauses nothing: the next tick relaunches the same attempt", async () => {
    const target = interruptedAttempt1();
    // The first launch is refused by the environment; the runtime answers the
    // second. A live factory must not stop on an environment refusal.
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: refusesBeforeWorker("Docker is unavailable (docker info failed)"),
    });
    const stop = new AbortController();
    const running = runForever(deps(runtime), { tickMs: 10, signal: stop.signal, cooperativeMs: 100 });

    await waitFor("the refusal to be refunded", () =>
      logs.some((line) => line.includes("the recovery granted to this relaunch is refunded")),
    );
    await waitFor("the next tick's relaunch", () => runtime.launched.length >= 2);
    stop.abort();
    await running;

    assert.equal(runtime.launched[0]?.attempt, 1, "the refused launch was attempt 1");
    assert.equal(runtime.launched[1]?.attempt, 1, "the next tick retried the SAME attempt, no new one");
    assert.equal((await readRecoveryLedger(target)).consumed, 1, "only the relaunch that ran spent a grant");
    assert.equal(existsSync(join(target, "desfecho.json")), true, "and the work reached its outcome");
  });

  test("an ambiguous failure — a worker may have been born — keeps the grant consumed", async () => {
    const target = interruptedAttempt1();
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: () =>
        new Error("docker run failed after the container was created (daemon did not answer)"),
    });

    await assert.rejects(runOnce(deps(runtime)), /docker run failed after the container was created/);

    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.consumed, 1, "the doubt keeps the consumption: the grant is never renewed from uncertainty");
    assert.equal(ledger.events.length, 1, "the grant stays as the work's history");
    assert.equal(ledger.lastStop?.kind, "interruption");
    assert.match(
      readFileSync(join(target, "log-1.jsonl"), "utf8"),
      /session-start/,
      "the launch wrote the footprint of a worker that may exist",
    );
    assert.equal(existsSync(join(target, "desfecho.json")), false, "and no outcome claims the attempt ended");
  });

  test("a failed launch that consumed the requested stop re-records it, so the stop keeps excusing the interruption", async () => {
    const target = interruptedAttempt1();
    // The operator's stop ended this attempt and the resume is launching: the
    // record is consumed before the worker starts.
    await recordStopRequest(target, 1);
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: (_request, index) =>
        index === 0 ? new Error("docker run failed after the container was created (daemon did not answer)") : null,
    });

    await assert.rejects(runOnce(deps(runtime)), /docker run failed after the container was created/);

    const ledger = await readRecoveryLedger(target);
    assert.equal(
      ledger.lastStop?.kind,
      "stop-requested",
      "the launch never carried the attempt out, so the stop stays what the work keeps",
    );
    assert.equal(ledger.lastStop?.attempt, 1);
    assert.equal(ledger.consumed, 0, "the requested stop is what excuses this attempt: no grant was spent");
    assert.equal(existsSync(join(target, "desfecho.json")), false, "and no outcome claims the attempt ended");

    // What the record is for: the next invocation resumes the attempt free of
    // charge instead of charging the interruption of a stop it never consumed.
    const resumed = await runOnce(deps(runtime));
    assert.equal(resumed.launched.length, 1);
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal((await readRecoveryLedger(target)).consumed, 0, "the resume spends nothing");
  });

  test("a grant persisted by a factory that died before its relaunch is never refunded by the next process", async () => {
    const target = interruptedAttempt1();
    // What a process killed between the grant and the relaunch leaves on disk.
    await consumeRecovery(target, config().recovery, 1);
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      // The next invocation's own launch is refused before any worker.
      rejectLaunch: refusesBeforeWorker("Docker is unavailable (docker info failed) — refusing to launch a worker."),
    });

    await assert.rejects(runOnce(deps(runtime)), /Docker is unavailable \(docker info failed\)/);

    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.consumed, 1, "the dead process's grant stays consumed — no refund can prove that worker never existed");
    assert.deepEqual(ledger.events.map((event) => event.index), [0], "the persisted grant remains as the work's history");

    // The budget continues from where the disk says, not from zero.
    const retried = await runOnce(deps(runtime));
    assert.equal(retried.launched.length, 1);
    assert.equal((await readRecoveryLedger(target)).consumed, 2, "the next grant continues the schedule instead of renewing it");
  });

  test("refunding the same refusal on repeated ticks never inflates the budget", async () => {
    const target = interruptedAttempt1();
    const cfg = config();
    // The work already spent two legitimate recoveries: the refund must return
    // exactly its own grant, never an earlier one.
    await consumeRecovery(target, cfg.recovery, 1);
    await consumeRecovery(target, cfg.recovery, 1);
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: refusesBeforeWorker("no model credentials for the worker", 2),
    });

    await assert.rejects(runOnce(deps(runtime, cfg)), /no model credentials for the worker/);
    assert.equal((await readRecoveryLedger(target)).consumed, 2, "the first refusal refunded only its own grant");
    await assert.rejects(runOnce(deps(runtime, cfg)), /no model credentials for the worker/);
    assert.equal((await readRecoveryLedger(target)).consumed, 2, "the retried refusal cannot refund a grant twice");

    const retried = await runOnce(deps(runtime, cfg));
    assert.equal(retried.launched.length, 1, "the work relaunches once the environment allows it");
    assert.equal((await readRecoveryLedger(target)).consumed, 3, "and spends exactly one more recovery");
  });

  test("a refused launch that held no grant refunds nothing and says so", async () => {
    // A first claim holds no Recovery grant: the refusal of its launch has no
    // recovery to return, and the note must not claim one was returned.
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: refusesBeforeWorker("no model credentials for the worker"),
    });

    await assert.rejects(runOnce(deps(runtime)), /no model credentials for the worker/);

    const target = workDir(layout, REPO, 2);
    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.consumed, 0, "nothing was consumed, so nothing could be refunded");
    assert.deepEqual(ledger.events, []);
    assert.equal(
      logs.some((line) => line.includes("no recovery was granted to this launch")),
      true,
      "the operator reads what the launch really held",
    );
    assert.equal(existsSync(join(target, "desfecho.json")), false, "no attempt was consumed");
    const issue = await tracker.readIssue({ repo: REPO, number: 2 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.claimed), "the claim keeps the work reserved");
  });

  test("a requested stop that cancels the admission first does not cost the grant of a launch that then proves no worker existed", async () => {
    const target = interruptedAttempt1();
    const entered = deferred();
    const refusal = deferred();
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      rejectLaunch: (_request, index) =>
        index === 0 ? new LaunchPreconditionError("Docker is unavailable (docker info failed)") : null,
    });
    // The precondition is still refusing when the operator's stop arrives (a
    // Docker that does not answer), so the stop settles the admission while the
    // launch is pending: it cannot know yet that no worker existed.
    runtime.hold = async () => {
      entered.resolve();
      await refusal.promise;
    };
    const stop = new AbortController();
    const running = runForever(deps(runtime), { tickMs: 10, signal: stop.signal, cooperativeMs: 10 });

    await entered.promise;
    stop.abort();
    await running;
    assert.equal((await readRecoveryLedger(target)).consumed, 1, "the stop cannot refund what a worker may be carrying");
    assert.equal((await readRecoveryLedger(target)).lastStop?.kind, "stop-requested");

    // The refusal lands after the stop settled the admission: the proof that no
    // worker existed still returns the grant — and the stop record stays.
    refusal.resolve();
    await waitFor("the refusal to be settled", () =>
      logs.some((line) => line.includes("the recovery granted to this relaunch is refunded")),
    );
    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.consumed, 0, "the proven refusal refunded the grant the stop had to keep");
    assert.deepEqual(ledger.events, [], "and left no consumed grant behind");
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the requested stop is still what the work keeps");
    assert.equal(existsSync(join(target, "desfecho.json")), false, "no attempt was consumed");

    // The next invocation resumes the attempt free of charge, with a budget
    // nothing has silently spent.
    delete runtime.hold;
    const resumed = await runOnce(deps(runtime));
    assert.equal(resumed.launched.length, 1);
    assert.equal(resumed.launched[0]?.request.attempt, 1, "the SAME attempt");
    assert.equal((await readRecoveryLedger(target)).consumed, 0, "the resume spent nothing, and nothing was inflated");
  });
});
