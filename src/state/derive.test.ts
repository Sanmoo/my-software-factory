import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { derivePool } from "./derive.js";
import { DEFAULT_LABELS } from "../config.js";

describe("derive — the pool of eligible works, stateless re-read", () => {
  let adapter: FakeTrackerAdapter;
  const repos = ["Sanmoo/a", "Sanmoo/b"];

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
  });

  test("an issue with the ready label and no blockers is eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => entry.ref),
      [{ repo: "Sanmoo/a", number: 1 }],
    );
  });

  test("an issue without the ready label is not in the pool", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: ["other"] });
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue with an open blocker is not eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2 }); // open blocker
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 2 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue whose blockers are all closed is eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, state: "closed" });
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 2 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.equal(pool.length, 1);
  });

  test("unknown blockers (unknown issue) never count as 'without impediment'", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 999 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue already claimed by the worker account is not in the pool", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot");

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("the pool is ordered by createdAt — eligible the longest first", async () => {
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 1,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-03T00:00:00Z",
    });
    seedIssue(adapter, {
      repo: "Sanmoo/b",
      number: 2,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-01T00:00:00Z",
    });
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 3,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-02T00:00:00Z",
    });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => entry.ref.number),
      [2, 3, 1],
    );
  });

  test("the pool spans all target repos of the config", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/b", number: 9, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/other", number: 5, labels: [DEFAULT_LABELS.ready] });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      new Set(pool.map((entry) => entry.ref.repo)),
      new Set(["Sanmoo/a", "Sanmoo/b"]),
    );
  });

  test("an empty tracker derives an empty pool", async () => {
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });
});
