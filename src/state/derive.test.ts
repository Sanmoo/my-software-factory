import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { derivePool, deriveReserved } from "./derive.js";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME } from "./outcome.js";

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

  test("the neutral read is filtered by the derivation: ready in, non-ready/claimed/PR-linked out", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: ["other"] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 3, labels: [DEFAULT_LABELS.ready, DEFAULT_LABELS.blocked] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 4, labels: [DEFAULT_LABELS.ready] });
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 4, state: "open" });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 5, labels: [DEFAULT_LABELS.ready] });
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 5, state: "closed" });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => entry.ref.number),
      [1, 5],
      "only the plain ready issue and the closed-PR issue are eligible",
    );
  });

  test("the pool derivation reads each repo's open issues once and never re-reads a candidate's issue", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: ["other"] });
    seedIssue(adapter, { repo: "Sanmoo/b", number: 3, labels: [DEFAULT_LABELS.ready] });

    const before = adapter.readCost();
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    const after = adapter.readCost();

    assert.equal(pool.length, 2);
    assert.equal(
      after.issueListings - before.issueListings,
      repos.length,
      "one neutral open-issues read per target repo",
    );
    assert.equal(after.issueReads - before.issueReads, 0, "eligibility never re-reads a candidate's issue");
  });
});

describe("derive — the reserved states, the tick's full derivation (ticket 14)", () => {
  let adapter: FakeTrackerAdapter;
  const REPO = "Sanmoo/a";
  const ref = (number: number) => ({ repo: REPO, number });
  const entry = (number: number) => ({ ref: ref(number), dir: `/ws/trabalhos/${REPO}#${number}` });

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
  });

  async function deriveOne(number: number) {
    const [derived] = await deriveReserved(adapter, [entry(number)], DEFAULT_LABELS, "bot");
    assert.ok(derived, "the work was derived");
    return derived;
  }

  test("issue closed as completed → done (the terminal state; linkage or fallback both land here)", async () => {
    seedIssue(adapter, { repo: REPO, number: 1, state: "closed", stateReason: "completed" });
    const derived = await deriveOne(1);
    assert.equal(derived.state, "done");
  });

  test("issue closed as not-planned is NOT done — unknown terminal, never acted on", async () => {
    seedIssue(adapter, { repo: REPO, number: 2, state: "closed", stateReason: "not-planned" });
    const derived = await deriveOne(2);
    assert.equal(derived.state, "unknown");
    assert.equal(derived.because, "not-planned");
  });

  test("issue not found → unknown, never acted on", async () => {
    const derived = await deriveOne(3);
    assert.equal(derived.state, "unknown");
    assert.equal(derived.because, "issue-not-found");
  });

  test("PR merged but issue open → done-fallback: the sweep closes the issue with a short comment", async () => {
    seedIssue(adapter, { repo: REPO, number: 4, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 4, merged: true, state: "closed" });
    const derived = await deriveOne(4);
    assert.equal(derived.state, "done-fallback");
    assert.match(derived.comment, /merged/i);
  });

  test("PR closed without merge → rejected: blocked with a comment pointing at the PR", async () => {
    seedIssue(adapter, { repo: REPO, number: 5, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 5, state: "closed", merged: false });
    const derived = await deriveOne(5);
    assert.equal(derived.state, "rejected");
    assert.ok(derived.pr);
    assert.match(derived.comment, /#\d+/, "the comment points at the PR");
    assert.match(derived.comment, /closed without merging/i);
  });

  test("PR open, last PR comment by a human → feedback round (the ball is with the factory)", async () => {
    seedIssue(adapter, { repo: REPO, number: 6, labels: [DEFAULT_LABELS.claimed], createdAt: "2026-01-01T00:00:00Z" });
    adapter.seedPullRequest({ repo: REPO, number: 6, state: "open" });
    adapter.addPrComment({ repo: REPO, prNumber: 6 }, "humano", "please change this");
    const derived = await deriveOne(6);
    assert.equal(derived.state, "feedback");
    assert.equal(derived.createdAt, "2026-01-01T00:00:00Z");
  });

  test("PR open, last PR comment by the worker → idle (the worker addressed the round; ball with the human)", async () => {
    seedIssue(adapter, { repo: REPO, number: 7, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 7, state: "open" });
    adapter.addPrComment({ repo: REPO, prNumber: 7 }, "humano", "change this");
    adapter.addPrComment({ repo: REPO, prNumber: 7 }, "bot", "<!-- msf:agent --> addressed — see the new commits");
    const derived = await deriveOne(7);
    assert.equal(derived.state, "idle");
  });

  test("PR open, no comments at all → idle (the worker just opened it, awaiting the human)", async () => {
    seedIssue(adapter, { repo: REPO, number: 8, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 8, state: "open" });
    const derived = await deriveOne(8);
    assert.equal(derived.state, "idle");
  });

  test("same account: an unmarked PR comment is feedback, a marked one parks", async () => {
    seedIssue(adapter, { repo: REPO, number: 70, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 70, state: "open" });
    adapter.addPrComment({ repo: REPO, prNumber: 70 }, "bot", "please change this");
    assert.equal((await deriveOne(70)).state, "feedback");
    adapter.addPrComment({ repo: REPO, prNumber: 70 }, "bot", "<!-- msf:agent --> addressed");
    assert.equal((await deriveOne(70)).state, "idle");
  });

  test("a review comment counts as PR feedback: the last comment spans comments + reviews", async () => {
    seedIssue(adapter, { repo: REPO, number: 9, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 9, state: "open" });
    adapter.addReviewComment({ repo: REPO, prNumber: 9 }, "humano", "inline: fix this");
    const derived = await deriveOne(9);
    assert.equal(derived.state, "feedback");
  });

  test("blocked label + human comment AFTER the last marker → resumable (retomada)", async () => {
    seedIssue(adapter, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.blocked], createdAt: "2026-01-02T00:00:00Z" });
    adapter.comment(ref(10), "worker blocked after 2 consecutive falls (attempt 2) — …");
    adapter.addComment(ref(10), "humano", "try again, token X is now valid");
    const derived = await deriveOne(10);
    assert.equal(derived.state, "resumable");
    seedIssue(adapter, { repo: REPO, number: 71, labels: [DEFAULT_LABELS.blocked] });
    await adapter.comment(ref(71), "worker blocked");
    adapter.addComment(ref(71), "bot", "resume — same account, no marker");
    assert.equal((await deriveOne(71)).state, "resumable");
    assert.equal(derived.createdAt, "2026-01-02T00:00:00Z");
  });

  test("blocked label, no human comment after the marker → idle (waiting for the human)", async () => {
    seedIssue(adapter, { repo: REPO, number: 11, labels: [DEFAULT_LABELS.blocked] });
    adapter.comment(ref(11), "worker blocked…");
    const derived = await deriveOne(11);
    assert.equal(derived.state, "idle");
  });

  test("blocked label, human comment BEFORE the marker → idle (the answer predates the blocked round)", async () => {
    seedIssue(adapter, { repo: REPO, number: 12, labels: [DEFAULT_LABELS.blocked] });
    adapter.addComment(ref(12), "humano", "context: this needs the new key");
    adapter.comment(ref(12), "worker blocked…");
    const derived = await deriveOne(12);
    assert.equal(derived.state, "idle");
  });

  test("blocked label short-circuits: a rejected PR already pointed out stays parked (no re-rejection every tick)", async () => {
    seedIssue(adapter, { repo: REPO, number: 13, labels: [DEFAULT_LABELS.blocked] });
    adapter.seedPullRequest({ repo: REPO, number: 13, state: "closed", merged: false });
    adapter.comment(ref(13), "work rejected: PR #1 was closed without merging…");
    const derived = await deriveOne(13);
    assert.equal(derived.state, "idle");
  });

  test("a released work (ready label back, no PR) is idle here — the pool covers it, not the reserved states", async () => {
    seedIssue(adapter, { repo: REPO, number: 14, labels: [DEFAULT_LABELS.ready] });
    const derived = await deriveOne(14);
    assert.equal(derived.state, "idle");
  });

  describe("ticket 05 Q3 — the unreconciled fall (a factory death is an abrupt fall by definition)", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "msf-derive-fall-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function workDirFor(number: number): string {
      const path = join(dir, `a#${number}`);
      mkdirSync(path, { recursive: true });
      return path;
    }

    async function deriveFrom(path: string, number: number) {
      const [derived] = await deriveReserved(adapter, [{ ref: ref(number), dir: path }], DEFAULT_LABELS, "bot");
      assert.ok(derived);
      return derived;
    }

    test("claimed, zero attempt evidence, NOT in the engine's in-flight set → orphan: fall → release (ticket 18)", async () => {
      seedIssue(adapter, { repo: REPO, number: 19, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(19); // the dir exists; nothing was ever written inside

      const derived = await deriveFrom(path, 19);
      assert.equal(derived.state, "fall", "an orphan claim is an abrupt fall (story 22) — never held forever");
      assert.equal(derived.decision, "release", "zero evidence is honestly a 1st fall: release (branch preserved)");
    });

    test("claimed, zero attempt evidence, IN the engine's in-flight set → idle: a legit launch is held, never released", async () => {
      seedIssue(adapter, { repo: REPO, number: 24, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(24); // claimed, dir created, the worker not yet up — zero footprint so far

      const [derived] = await deriveReserved(
        adapter,
        [{ ref: ref(24), dir: path }],
        DEFAULT_LABELS,
        "bot",
        new Set([`${REPO}#24`]),
      );
      assert.ok(derived);
      assert.equal(derived.state, "idle", "this process holds the launch — no false release mid-flight");
    });

    test("claimed, no PR, no worker in flight, first crash → fall: release (the work re-enters the pool)", async () => {
      seedIssue(adapter, { repo: REPO, number: 20, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(20);
      writeFileSync(join(path, "log-1.jsonl"), '{}\n', "utf8"); // the crash footprint: an attempt started, no record

      const derived = await deriveFrom(path, 20);
      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "release");
    });

    test("claimed, no PR, two attempts without records → fall: blocked with the absence stated", async () => {
      seedIssue(adapter, { repo: REPO, number: 21, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(21);
      writeFileSync(join(path, "log-1.jsonl"), '{}\n', "utf8");
      writeFileSync(join(path, "log-2.jsonl"), '{}\n', "utf8");

      const derived = await deriveFrom(path, 21);
      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "block");
      assert.match(derived.comment, /attempt 2/);
      assert.match(derived.comment, /no outcome record/i);
    });

    test("claimed, no PR, a recorded clean fall followed by a crash → fall: blocked (2nd consecutive)", async () => {
      seedIssue(adapter, { repo: REPO, number: 22, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(22);
      writeFileSync(
        join(path, DESFECHO_FILENAME),
        JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
        "utf8",
      );
      writeFileSync(join(path, "log-2.jsonl"), '{}\n', "utf8"); // the crashed attempt 2

      const derived = await deriveFrom(path, 22);
      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "block");
      assert.match(derived.comment, /attempt 2/);
    });

    test("claimed, no PR, an attempt recorded pr-open… impossible here (a PR fact would have handled it) — a stale pr-open record with no PR heals as a 1st fall", async () => {
      seedIssue(adapter, { repo: REPO, number: 23, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(23);
      writeFileSync(
        join(path, DESFECHO_FILENAME),
        JSON.stringify({ class: "pr-open", attempt: 1, pr: { repo: REPO, number: 9, branch: "agent-issue-23" } }),
        "utf8",
      );
      writeFileSync(join(path, "log-2.jsonl"), '{}\n', "utf8");

      const derived = await deriveFrom(path, 23);
      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "release", "one abrupt attempt after a non-fall record: 1st fall, release");
    });
  });
});
