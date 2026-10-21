import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  consumeRecovery,
  exhaustedReason,
  peekRecovery,
  readRecoveryLedger,
  recordFailure,
  RECOVERY_FILENAME,
  recoveryDecision,
  type RecoveryLedger,
} from "./recovery.js";

/**
 * The interruption-recovery budget (issue 123): a finite allowance counted per
 * work, persisted so a restart continues it, scoped to the attempt, with the
 * configured backoff and a pause + help request when it runs out. The reference
 * behavior is `experiments/issue-111/src/recovery.ts`; this is the product
 * version, next to the other artifacts of the work.
 */

const POLICY = { maxRecoveries: 3, waitsMs: [1_000, 4_000, 16_000] } as const;
const NOW = () => new Date("2026-01-01T00:00:00Z");

describe("the recovery budget — finite, persisted, separate from the attempts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-recovery-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("three recoveries at 1/4/16 s, then a pause that names the configured value and backoff", async () => {
    const waits: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const decision = await consumeRecovery(dir, POLICY, 1, NOW);
      assert.equal(decision.decision, "recover");
      if (decision.decision === "recover") waits.push(decision.waitMs);
    }
    assert.deepEqual(waits, [1_000, 4_000, 16_000], "the fixed #111 schedule, by index");

    const exhausted = await consumeRecovery(dir, POLICY, 1, NOW);
    assert.equal(exhausted.decision, "pause-help");
    assert.match(
      exhausted.decision === "pause-help" ? exhausted.reason : "",
      /budget is exhausted: 3 automatic recoveries \(waits 1s\/4s\/16s\)/,
    );
    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.consumed, 3, "an exhausted budget is never consumed further");
    assert.deepEqual(ledger.lastStop, {
      kind: "interruption",
      attempt: 1,
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(ledger.lastFallAttempt, null, "an interruption is not a failure");
  });

  test("the count survives a new process: a restart continues the budget instead of renewing it", async () => {
    await consumeRecovery(dir, POLICY, 1, NOW);

    const restarted = await peekRecovery(dir, POLICY, 1);

    assert.equal(restarted.decision, "recover");
    assert.equal(restarted.decision === "recover" && restarted.consumed, 2, "the second recovery, not a fresh first");
    assert.equal(restarted.decision === "recover" && restarted.waitMs, 4_000, "the wait continues the schedule");
    assert.equal((await readRecoveryLedger(dir)).consumed, 1, "peeking never spends a recovery");
  });

  test("the allowance is per attempt, the events stay as the work's history", async () => {
    await consumeRecovery(dir, POLICY, 1, NOW);
    await consumeRecovery(dir, POLICY, 1, NOW);

    const nextAttempt = await consumeRecovery(dir, POLICY, 2, NOW);

    assert.equal(nextAttempt.decision === "recover" && nextAttempt.consumed, 1, "attempt 2 has its own allowance");
    const ledger = await readRecoveryLedger(dir);
    assert.deepEqual(ledger.lastStop, {
      kind: "interruption",
      attempt: 2,
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(
      ledger.events.map((event) => event.attempt),
      [1, 1, 2],
      "the recoveries of the earlier attempt are never erased from the work's ledger",
    );
  });

  test("a sub-second wait keeps its milliseconds in the operator's words — never a '0s'", () => {
    const budget = { maxRecoveries: 1, waitsMs: [250, 1_000] };
    assert.match(exhaustedReason(budget), /waits 250ms\/1s/);
  });

  test("a written failure consumes the attempt, records the stop, and the next attempt starts clean", async () => {
    await consumeRecovery(dir, POLICY, 1, NOW);
    await recordFailure(dir, 1, "clean-without-pr", NOW);

    const failed = await readRecoveryLedger(dir);
    assert.deepEqual(failed.lastStop, {
      kind: "failure",
      attempt: 1,
      at: "2026-01-01T00:00:00.000Z",
      outcome: "clean-without-pr",
    });
    assert.equal(failed.lastFallAttempt, 1, "the written failure is the consecutiveness fact");
    assert.equal(failed.consumed, 1, "the interrupted recoveries remain as history");

    const next = await peekRecovery(dir, POLICY, 2);
    assert.equal(next.decision === "recover" && next.consumed, 1, "a new attempt starts with a full budget");
  });

  test("an interruption of the next attempt never erases the previous written failure", async () => {
    await recordFailure(dir, 1, "clean-without-pr", NOW);
    await consumeRecovery(dir, POLICY, 2, NOW);

    const ledger = await readRecoveryLedger(dir);
    assert.equal(ledger.lastStop?.kind, "interruption");
    assert.equal(
      ledger.lastFallAttempt,
      1,
      "the fall ruler's consecutiveness fact survives the interruption of attempt 2",
    );
  });

  test("a shorter schedule repeats its last wait instead of inventing one", () => {
    const ledger: RecoveryLedger = {
      attempt: 1,
      consumed: 2,
      events: [],
      lastStop: null,
      lastFallAttempt: null,
    };
    const decision = recoveryDecision(ledger, { maxRecoveries: 3, waitsMs: [500] });
    assert.equal(decision.decision === "recover" && decision.waitMs, 500);
  });

  test("a legacy work dir with no ledger reads as the honest initial state", async () => {
    const ledger = await readRecoveryLedger(dir);
    assert.deepEqual(ledger, {
      attempt: 1,
      consumed: 0,
      events: [],
      lastStop: null,
      lastFallAttempt: null,
    });
    assert.equal((await peekRecovery(dir, POLICY, 1)).decision, "recover");
  });

  test("a corrupt ledger is the initial state too — never a crash, never invented recoveries", async () => {
    writeFileSync(join(dir, RECOVERY_FILENAME), "{not json", "utf8");
    const initial = {
      attempt: 1,
      consumed: 0,
      events: [],
      lastStop: null,
      lastFallAttempt: null,
    };
    assert.deepEqual(await readRecoveryLedger(dir), initial);

    writeFileSync(join(dir, RECOVERY_FILENAME), JSON.stringify({ attempt: "x", consumed: -2 }), "utf8");
    assert.deepEqual(await readRecoveryLedger(dir), initial);
  });

  test("the ledger is written as an artifact of the work, readable after the process is gone", async () => {
    await consumeRecovery(dir, POLICY, 1, NOW);
    const onDisk = JSON.parse(readFileSync(join(dir, RECOVERY_FILENAME), "utf8"));
    assert.equal(onDisk.attempt, 1);
    assert.equal(onDisk.consumed, 1);
    assert.deepEqual(onDisk.events, [
      { index: 0, waitMs: 1_000, attempt: 1, at: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.equal(onDisk.lastFallAttempt, null);
  });
});
