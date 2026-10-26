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
import type { OutcomeRecord } from "../work-record/outcome.js";
import { readRecoveryLedger, type RecoveryLedger, type RecoveryStop } from "../work-record/recovery.js";
import { consumeRecovery, recordUnconfirmedStop, refundRecovery } from "./recovery.js";
import {
  OperatorStop,
  operatorStopClaim,
  reconcileUnconfirmedStops,
  refundHeldGrant,
  stopConfirmed,
  type StopInput,
  type StopLaunch,
  type StopWorkRef,
} from "./stop.js";
import { workKeyOf } from "./work-key.js";

/**
 * The operator's stop, exercised through the module that owns the protocol: a
 * fake liveness probe and an injected clock/wait make the
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

describe("the operator's stop of this run ", () => {
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

describe("the next invocation's reconciliation of an unconfirmed stop ", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-stop-reconcile-"));
    layout = ensureWorkspace(join(root, "ws"));
    dir = workDirOfKey(layout, KEY);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const PERSISTED = "a worker of this work is still alive";

  async function persistedStop(): Promise<void> {
    await recordUnconfirmedStop(dir, 1, PERSISTED, () => NOW);
  }

  const works = (): StopWorkRef[] => [{ key: KEY, dir }];

  test("a worker confirmed gone resumes the attempt free of charge", async () => {
    await persistedStop();

    const verdicts = await reconcileUnconfirmedStops(
      works(),
      { state: "known", workers: [] },
      () => NOW,
    );

    assert.deepEqual(verdicts, [{ kind: "resume", key: KEY, attempt: 1 }]);
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the confirmed stop becomes the resume it was meant to be");
    assert.equal(ledger.lastStop?.attempt, 1);
    assert.equal(ledger.lastStop?.at, NOW.toISOString());
    assert.equal(ledger.consumed, 0, "the resume spends no recovery");
  });

  test("a worker still alive holds the work instead of relaunching over it", async () => {
    await persistedStop();

    const verdicts = await reconcileUnconfirmedStops(works(), {
      state: "known",
      workers: [liveWorker()],
    });

    assert.deepEqual(verdicts, [
      { kind: "hold", key: KEY, because: `${PERSISTED} — the previous stop (${PERSISTED}) stays unconfirmed` },
    ]);
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.lastStop?.kind, "stop-unconfirmed", "the hold never promotes the stop");
    assert.equal(ledger.consumed, 0);
  });

  test("an unreadable liveness is a hold, never a relaunch", async () => {
    await persistedStop();

    const verdicts = await reconcileUnconfirmedStops(works(), {
      state: "unknown",
      reason: "Cannot connect to the Docker daemon",
    });

    assert.deepEqual(verdicts, [
      {
        kind: "hold",
        key: KEY,
        because:
          `the worker liveness could not be read (Cannot connect to the Docker daemon) — ` +
          `the previous stop (${PERSISTED}) stays unconfirmed`,
      },
    ]);
    assert.equal((await readRecoveryLedger(dir)).lastStop?.kind, "stop-unconfirmed");
  });
});

describe("the operator-stop claim shared by the derivation and the launch path ", () => {
  const AT = NOW.toISOString();

  function ledger(lastStop: RecoveryStop | null): RecoveryLedger {
    return { attempt: lastStop?.attempt ?? 1, consumed: 0, events: [], lastStop, lastFallAttempt: null };
  }

  test("a stop of another attempt, another kind or none claims nothing", () => {
    assert.deepEqual(operatorStopClaim(ledger(null), { lastAttempt: 1 }), { kind: "none" });
    assert.deepEqual(
      operatorStopClaim(ledger({ kind: "interruption", attempt: 2, at: AT }), { lastAttempt: 2 }),
      { kind: "none" },
    );
    assert.deepEqual(
      operatorStopClaim(ledger({ kind: "failure", attempt: 2, at: AT, outcome: "clean-without-pr" }), {
        lastAttempt: 2,
      }),
      { kind: "none" },
    );
    assert.deepEqual(
      operatorStopClaim(ledger({ kind: "stop-requested", attempt: 1, at: AT }), { lastAttempt: 2 }),
      { kind: "none" },
    );
  });

  test("the launch path claims exactly its attempt and keeps the unconfirmed reason", () => {
    const requested = ledger({ kind: "stop-requested", attempt: 2, at: AT });
    assert.deepEqual(operatorStopClaim(requested, { lastAttempt: 2 }), { kind: "requested", attempt: 2 });
    assert.deepEqual(operatorStopClaim(requested, { lastAttempt: 1 }), { kind: "none" });
    assert.deepEqual(operatorStopClaim(requested, { lastAttempt: 3 }), { kind: "none" });
    const unconfirmed = ledger({ kind: "stop-unconfirmed", attempt: 2, at: AT, because: "still alive" });
    assert.deepEqual(operatorStopClaim(unconfirmed, { lastAttempt: 2 }), {
      kind: "unconfirmed",
      attempt: 2,
      because: "still alive",
    });
  });

  test("the derivation's tolerance accepts the attempt before a log numbers it", () => {
    const next = ledger({ kind: "stop-requested", attempt: 2, at: AT });
    assert.deepEqual(operatorStopClaim(next, { lastAttempt: 1, acceptNextAttempt: true }), {
      kind: "requested",
      attempt: 2,
    });
    assert.deepEqual(operatorStopClaim(next, { lastAttempt: 1 }), { kind: "none" });
    assert.deepEqual(
      operatorStopClaim(next, { lastAttempt: 0, acceptNextAttempt: true }),
      { kind: "none" },
      "a record that numbers nothing accepts only attempt 1",
    );
    assert.deepEqual(
      operatorStopClaim(ledger({ kind: "stop-requested", attempt: 1, at: AT }), {
        lastAttempt: 0,
        acceptNextAttempt: true,
      }),
      { kind: "requested", attempt: 1 },
    );
    assert.deepEqual(
      operatorStopClaim(ledger({ kind: "stop-requested", attempt: 3, at: AT }), {
        lastAttempt: 1,
        acceptNextAttempt: true,
      }),
      { kind: "none" },
      "the window closes after the next attempt",
    );
  });

  test("an attempt that wrote its own verdict is not resumed by a stop left over it", () => {
    const stop = ledger({ kind: "stop-requested", attempt: 2, at: AT });
    const written: OutcomeRecord = { class: "clean-without-pr", attempt: 2 };
    assert.deepEqual(operatorStopClaim(stop, { lastAttempt: 2, outcome: written }), { kind: "none" });
    const earlier: OutcomeRecord = { class: "clean-without-pr", attempt: 1 };
    assert.deepEqual(operatorStopClaim(stop, { lastAttempt: 2, outcome: earlier }), {
      kind: "requested",
      attempt: 2,
    });
  });
});

describe("returning the grant an admission still holds (issues #146 and #178)", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-stop-grant-"));
    layout = ensureWorkspace(join(root, "ws"));
    dir = workDirOfKey(layout, KEY);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const held = (recoveryIndex: number | null): StopLaunch => ({
    work: githubWork(REPO, 1),
    dir,
    attempt: 1,
    launched: false,
    recoveryIndex,
  });

  test("only the grant the admission names is returned, and only once", async () => {
    await consumeRecovery(dir, { maxRecoveries: 3, waitsMs: [1_000] }, 1);
    await consumeRecovery(dir, { maxRecoveries: 3, waitsMs: [1_000] }, 1);
    const launch = held(1);

    assert.equal(await refundHeldGrant(launch, 1), "refunded");
    assert.equal((await readRecoveryLedger(dir)).consumed, 1, "exactly its own grant, not the earlier one");
    assert.equal(launch.recoveryIndex, null, "the admission no longer names it");

    assert.equal(await refundHeldGrant(launch, 1), "none-held", "a second return has nothing to return");
    assert.equal((await readRecoveryLedger(dir)).consumed, 1, "and cannot inflate the budget");
  });

  test("an admission that names no grant returns none", async () => {
    assert.equal(await refundHeldGrant(held(null), 1), "none-held");
    assert.equal((await readRecoveryLedger(dir)).consumed, 0);
  });

  test("a grant the ledger no longer holds is gone, not refunded", async () => {
    await consumeRecovery(dir, { maxRecoveries: 3, waitsMs: [1_000] }, 1);
    // A previous caller already returned this grant (a requested stop, an
    // earlier refusal): the event is gone even though the admission still
    // names it.
    await refundRecovery(dir, 1, 0);

    assert.equal(await refundHeldGrant(held(0), 1), "gone-from-ledger");
    assert.equal((await readRecoveryLedger(dir)).consumed, 0, "nothing was consumed twice");
  });

  test("a ledger that moved past the attempt keeps the grant consumed", async () => {
    await consumeRecovery(dir, { maxRecoveries: 3, waitsMs: [1_000] }, 1);
    // The ledger now counts another attempt's recoveries: the grant of attempt 1
    // is history, so returning it would renew a budget nothing proved unused.
    await consumeRecovery(dir, { maxRecoveries: 3, waitsMs: [1_000] }, 2);
    const launch = held(0);

    assert.equal(await refundHeldGrant(launch, 1), "still-consumed");
    assert.equal((await readRecoveryLedger(dir)).consumed, 1, "the attempt's count is untouched");
  });
});
