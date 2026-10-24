import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { githubWork } from "../e2e/work-fixtures.js";
import { ensureWorkspace, workDirOfKey, type WorkspaceLayout } from "../layout.js";
import { deferred } from "../runtime/deferred.js";
import type { LivenessObservation, LiveWorker } from "../state/liveness.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { consumeRecovery, readRecoveryLedger } from "./recovery.js";
import {
  OperatorStop,
  stopConfirmed,
  type StopInput,
  type StopLaunch,
} from "./stop.js";
import { workKeyOf } from "./work-key.js";

/**
 * The operator's stop, exercised through the module that owns the protocol
 * (issue #188): a fake liveness probe and an injected clock/wait make the
 * escalation, the confirmation and the cancelled admission's refund
 * deterministic without a sweep, a runtime or a real timer.
 */

const REPO = "Sanmoo/my-tasks";
const KEY = "Sanmoo/my-tasks#1";
const NOW = new Date("2026-02-03T04:05:06Z");

class FakeStopRuntime {
  readonly requested: string[] = [];
  readonly forced: string[] = [];
  onForce: (work: WorkIdentity) => Promise<void> = async () => {};

  requestStop(work: WorkIdentity): void {
    this.requested.push(workKeyOf(work));
  }

  async forceStop(work: WorkIdentity): Promise<void> {
    this.forced.push(workKeyOf(work));
    await this.onForce(work);
  }
}

const liveWorker = (): LiveWorker => ({ key: KEY, containerId: "container-1", ageMs: 1_000 });

describe("the operator's stop of this run (issue #188)", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-stop-"));
    layout = ensureWorkspace(join(root, "ws"));
    dir = workDirOfKey(layout, KEY);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function launch(overrides: Partial<StopLaunch> = {}): StopLaunch {
    return {
      work: githubWork(REPO, 1),
      dir,
      attempt: 1,
      launched: true,
      recoveryIndex: null,
      ...overrides,
    };
  }

  function facts(launches: readonly StopLaunch[], overrides: Partial<StopInput> = {}): StopInput {
    return {
      launches,
      survivors: () => [],
      isInFlight: () => true,
      settled: async () => {},
      ...overrides,
    };
  }

  function stopWith(
    runtime: FakeStopRuntime,
    probe: () => Promise<LivenessObservation>,
    wait: (ms: number) => Promise<void> = async () => {},
  ): OperatorStop {
    return new OperatorStop({
      workspace: layout,
      runtime,
      probe,
      log: () => {},
      wait,
      now: () => NOW,
    });
  }

  test("the end of the cooperative window forces the remaining worker and confirms its end", async () => {
    const runtime = new FakeStopRuntime();
    const live: LiveWorker[] = [liveWorker()];
    runtime.onForce = async () => {
      live.length = 0;
    };
    const stop = stopWith(runtime, async () => ({ state: "known", workers: [...live] }));

    const report = await stop.begin(facts([launch()]));

    assert.deepEqual(runtime.requested, [KEY], "the cooperative request reached the worker");
    assert.deepEqual(runtime.forced, [KEY], "the deadline forced what the request left");
    assert.deepEqual(report.forced, [KEY]);
    assert.deepEqual(report.unconfirmed, []);
    assert.equal(report.unreadBecause, null);
    assert.ok(stopConfirmed(report), "a forced worker confirmed gone is a safe stop");
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.lastStop?.kind, "stop-requested");
    assert.equal(ledger.lastStop?.attempt, 1);
    assert.equal(ledger.lastStop?.at, NOW.toISOString(), "the injected clock stamps the persisted evidence");
  });

  test("the second signal forces at once, without waiting the cooperative window", async () => {
    const runtime = new FakeStopRuntime();
    const live: LiveWorker[] = [liveWorker()];
    runtime.onForce = async () => {
      live.length = 0;
    };
    const entered = deferred();
    const stop = stopWith(
      runtime,
      async () => ({ state: "known", workers: [...live] }),
      () => {
        entered.resolve();
        return new Promise<void>(() => {}); // the window never ends on its own
      },
    );

    const running = stop.begin(facts([launch()]));
    await entered.promise;
    stop.escalate();
    const report = await running;

    assert.deepEqual(report.forced, [KEY], "the escalation forced the worker still inside the window");
    assert.deepEqual(report.unconfirmed, []);
    assert.ok(stopConfirmed(report));
  });

  test("a launch the cooperative window saw end is not forced again", async () => {
    const runtime = new FakeStopRuntime();
    let inFlight = true;
    const stop = stopWith(runtime, async () => ({ state: "known", workers: [] }));

    const report = await stop.begin(
      facts([launch()], {
        isInFlight: () => inFlight,
        settled: async () => {
          inFlight = false;
        },
      }),
    );

    assert.deepEqual(runtime.forced, [], "forcing a launch whose worker already ended only races it");
    assert.deepEqual(report.forced, []);
    assert.deepEqual(report.unconfirmed, []);
    assert.ok(stopConfirmed(report));
  });

  test("a worker that survives the forced stop keeps the stop unconfirmed and persists the hold", async () => {
    const runtime = new FakeStopRuntime();
    runtime.onForce = async () => {
      throw new Error("Docker stopped answering");
    };
    const stop = stopWith(runtime, async () => ({ state: "known", workers: [liveWorker()] }));

    const report = await stop.begin(facts([launch()]));

    assert.deepEqual(runtime.forced, [KEY], "the factory tried to force the worker");
    assert.deepEqual(report.forced, []);
    assert.deepEqual(report.unconfirmed, [
      { key: KEY, because: "a worker of this work is still alive" },
    ]);
    assert.equal(report.unreadBecause, null);
    assert.equal(stopConfirmed(report), false, "the factory never calls this stop safe");
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.lastStop?.kind, "stop-unconfirmed");
    assert.equal(ledger.lastStop?.attempt, 1);
    assert.equal(ledger.lastStop?.at, NOW.toISOString());
  });

  test("an unreadable liveness is never a safe stop, even with no worker to name", async () => {
    const runtime = new FakeStopRuntime();
    const stop = stopWith(runtime, async () => ({
      state: "unknown",
      reason: "Cannot connect to the Docker daemon",
    }));

    const report = await stop.begin(facts([]));

    assert.deepEqual(report.forced, []);
    assert.deepEqual(report.unconfirmed, []);
    assert.equal(report.unreadBecause, "Cannot connect to the Docker daemon");
    assert.equal(stopConfirmed(report), false);
  });

  test("a cancelled admission returns the recovery grant and records the requested stop", async () => {
    await consumeRecovery(dir, { maxRecoveries: 2, waitsMs: [10] }, 1);
    assert.equal((await readRecoveryLedger(dir)).consumed, 1, "the admission was granted a recovery");
    const runtime = new FakeStopRuntime();
    const stop = stopWith(runtime, async () => ({ state: "known", workers: [] }));

    const report = await stop.begin(facts([launch({ launched: false, recoveryIndex: 0 })]));

    assert.deepEqual(runtime.requested, [KEY], "a cancelled admission is still asked to stop");
    assert.deepEqual(report.unconfirmed, []);
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.consumed, 0, "the never-launched grant was returned");
    assert.equal(ledger.events.length, 0);
    assert.equal(ledger.lastStop?.kind, "stop-requested");
    assert.equal(ledger.lastStop?.attempt, 1);
  });

  test("the module settles a cancelled admission called from the launch path", async () => {
    await consumeRecovery(dir, { maxRecoveries: 2, waitsMs: [10] }, 1);
    const stop = stopWith(new FakeStopRuntime(), async () => ({ state: "known", workers: [] }));
    const entry = launch({ launched: false, recoveryIndex: 0 });

    assert.equal(await stop.cancelAdmission(entry, 1), true, "the grant was returned");
    assert.equal(entry.recoveryIndex, null, "a second call cannot return an earlier grant");
    assert.equal(await stop.cancelAdmission(entry, 1), false);
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.consumed, 0);
    assert.equal(ledger.lastStop?.kind, "stop-requested");
  });
});
