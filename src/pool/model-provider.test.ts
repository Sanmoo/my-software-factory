import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { ModelProviderFailure } from "../runtime/model-provider-error.js";
import {
  awaitingModelProvider,
  exhaustedModelProviderReason,
  modelProviderDecision,
  readModelProviderLedger,
  settleModelProviderFailure,
  MODEL_PROVIDER_FILENAME,
  type ModelProviderLedger,
} from "./model-provider.js";

/**
 * The model provider failure budget: an outage is not an
 * interruption of the agent, so it retries on its own finite, persisted
 * allowance with its own backoff — never spending the interruption budget.
 * The ledger is an artifact of the work (provedor.json), so a
 * restart continues the count instead of renewing it.
 */

const BUDGET = { maxRetries: 3, waitsMs: [15_000, 30_000, 60_000] } as const;
const NOW = () => new Date("2026-01-01T00:00:00Z");
const FAILURE: ModelProviderFailure = { message: "429: upstream unavailable", identity: "2026-01-01T00:00:00.000Z" };

describe("the model provider budget — its own retries, its own backoff", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-provider-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("three retries at 15/30/60 s, then awaiting model provider — never a fourth", async () => {
    const waits: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const failure = { ...FAILURE, identity: `2026-01-01T00:00:0${index}.000Z` };
      const settlement = await settleModelProviderFailure(dir, BUDGET, 1, failure, NOW);
      assert.equal(settlement.decision, "retry");
      if (settlement.decision === "retry") waits.push(settlement.waitMs);
    }
    assert.deepEqual(waits, [15_000, 30_000, 60_000], "the configured schedule, by index");

    const exhausted = await settleModelProviderFailure(dir, BUDGET, 1, { ...FAILURE, identity: "2026-01-01T00:00:09.000Z" }, NOW);
    assert.equal(exhausted.decision, "awaiting-model-provider");
    assert.match(exhausted.decision === "awaiting-model-provider" ? exhausted.reason : "", /provider budget is exhausted/);
    const ledger = await readModelProviderLedger(dir);
    assert.equal(ledger.consumed, 3, "an exhausted budget is never consumed further");
    assert.equal(ledger.last?.granted, false);
    assert.equal(ledger.last?.message, "429: upstream unavailable");
  });

  test("settling the same failure twice never spends two retries — a restart resumes where it stopped", async () => {
    const first = await settleModelProviderFailure(dir, BUDGET, 1, FAILURE, NOW);
    assert.equal(first.decision === "retry" && first.consumed, 1);

    const restarted = await settleModelProviderFailure(dir, BUDGET, 1, FAILURE, NOW);

    assert.equal(restarted.recorded, false, "the settlement is idempotent by the failure's identity");
    assert.equal(restarted.decision === "retry" && restarted.consumed, 1, "still the first retry, not a second");
    assert.equal((await readModelProviderLedger(dir)).consumed, 1);
  });

  test("a NEW failure of the same attempt is a new retry — the count advances", async () => {
    await settleModelProviderFailure(dir, BUDGET, 1, FAILURE, NOW);
    const second = await settleModelProviderFailure(dir, BUDGET, 1, { ...FAILURE, identity: "2026-01-01T00:00:05.000Z" }, NOW);

    assert.equal(second.decision === "retry" && second.consumed, 2);
    assert.equal((await readModelProviderLedger(dir)).consumed, 2);
  });

  test("the allowance is per attempt: a new attempt starts with a full model provider budget", async () => {
    await settleModelProviderFailure(dir, BUDGET, 1, FAILURE, NOW);
    const next = await settleModelProviderFailure(dir, BUDGET, 2, { ...FAILURE, identity: "2026-01-02T00:00:00.000Z" }, NOW);

    assert.equal(next.decision === "retry" && next.consumed, 1, "attempt 2 has its own allowance");
    const ledger = await readModelProviderLedger(dir);
    assert.deepEqual(ledger.events.map((event) => event.attempt), [1, 2], "the earlier retries stay as history");
  });

  test("raising the configured budget after exhaustion revives the work — the operator's lever", async () => {
    for (let index = 0; index < 3; index += 1) {
      await settleModelProviderFailure(dir, BUDGET, 1, { ...FAILURE, identity: `2026-01-01T00:00:0${index}.000Z` }, NOW);
    }
    const exhausted = await settleModelProviderFailure(dir, BUDGET, 1, { ...FAILURE, identity: "2026-01-01T00:00:09.000Z" }, NOW);
    assert.equal(exhausted.decision, "awaiting-model-provider");

    const raised = await settleModelProviderFailure(dir, { maxRetries: 4, waitsMs: [15_000] }, 1, { ...FAILURE, identity: "2026-01-01T00:00:09.000Z" }, NOW);

    assert.equal(raised.decision, "retry", "the operator raised the limit; the same failure gets its retry");
    assert.equal((await readModelProviderLedger(dir)).consumed, 4);
  });

  test("awaiting model provider is the settled, ungranted failure — never an interruption or a failure stop", async () => {
    const ledger: ModelProviderLedger = {
      attempt: 1,
      consumed: 2,
      events: [],
      last: { attempt: 1, failureIdentity: FAILURE.identity, message: FAILURE.message, granted: false, waitMs: null, helpRequested: false, at: NOW().toISOString() },
    };
    assert.equal(awaitingModelProvider(ledger, 1, { maxRetries: 2, waitsMs: [1] }), true);
    assert.equal(awaitingModelProvider(ledger, 2, { maxRetries: 2, waitsMs: [1] }), false, "another attempt is not awaiting");
    assert.equal(awaitingModelProvider({ ...ledger, last: { ...ledger.last!, granted: true, waitMs: 1 } }, 1, { maxRetries: 2, waitsMs: [1] }), false);
  });

  test("a sub-second wait keeps its milliseconds in the operator's words", () => {
    assert.match(exhaustedModelProviderReason({ maxRetries: 1, waitsMs: [250, 1_000] }), /waits 250ms\/1s/);
  });

  test("an absent or corrupt ledger is the honest initial state — never invented retries", async () => {
    const initial = { attempt: 1, consumed: 0, events: [], last: null };
    assert.deepEqual(await readModelProviderLedger(dir), initial);

    writeFileSync(join(dir, MODEL_PROVIDER_FILENAME), "{not json", "utf8");
    assert.deepEqual(await readModelProviderLedger(dir), initial);
  });

  test("the ledger is an artifact of the work, readable after the process is gone", async () => {
    await settleModelProviderFailure(dir, BUDGET, 1, FAILURE, NOW);
    const onDisk = JSON.parse(readFileSync(join(dir, MODEL_PROVIDER_FILENAME), "utf8"));
    assert.equal(onDisk.attempt, 1);
    assert.equal(onDisk.consumed, 1);
    assert.deepEqual(onDisk.events, [
      { index: 0, waitMs: 15_000, attempt: 1, at: NOW().toISOString(), message: FAILURE.message },
    ]);
    assert.equal(onDisk.last.granted, true);
  });

  test("a read-only decision never spends a retry", async () => {
    const decision = modelProviderDecision(await readModelProviderLedger(dir), BUDGET, 1, FAILURE);
    assert.equal(decision.decision === "retry" && decision.consumed, 1);
    assert.equal((await readModelProviderLedger(dir)).consumed, 0, "peeking never consumes");
  });
});
