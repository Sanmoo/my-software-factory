import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import {
  deriveReserved,
  deriveTrackerState,
  renderUnbackedClaim,
  renderUnmarkedReservation,
} from "./derive.js";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME, readOutcomeRecord } from "./outcome.js";

/** The pool-only view over the single derivation, for the tests of the pool's rules. */
const derivePool = async (
  port: FakeTrackerAdapter,
  repos: string[],
  labels = DEFAULT_LABELS,
) => (await deriveTrackerState(port, repos, labels)).pool;

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

describe("derive — the tracker↔workspace leftovers, from the same single read (issue 100)", () => {
  let adapter: FakeTrackerAdapter;
  const REPO = "Sanmoo/a";
  const repos = [REPO];
  const keys = (...numbers: number[]) => new Set(numbers.map((n) => `${REPO}#${n}`));

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
  });

  test("an open issue with the claim label and no reservation is an unbacked claim, with a copyable release command", async () => {
    seedIssue(adapter, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.claimed] });
    await adapter.claim({ repo: REPO, number: 1 }, "bot", DEFAULT_LABELS.ready);

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(state.pool, []);
    assert.equal(state.unbackedClaims.length, 1);
    assert.equal(state.unbackedClaims[0]?.ref.number, 1);
    assert.equal(
      state.unbackedClaims[0]?.command,
      `gh issue edit 1 --repo ${REPO} --add-label ${DEFAULT_LABELS.ready} --remove-label ${DEFAULT_LABELS.claimed} --remove-assignee bot`,
    );
    const line = renderUnbackedClaim(state.unbackedClaims[0]!);
    assert.match(line, /unbacked claim: Sanmoo\/a#1/);
    assert.match(line, /another factory or workspace may hold this claim/);
    assert.match(line, /gh issue edit 1/);
  });

  test("the release command drops every assignee, not only the worker's — an assigned work is never eligible", async () => {
    seedIssue(adapter, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    await adapter.claim({ repo: REPO, number: 10 }, "humano");

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS);

    assert.match(state.unbackedClaims[0]!.command, /--remove-assignee humano/);
  });

  test("the blocked label is a claim mark too — an unbacked block is reported like an unbacked claim", async () => {
    seedIssue(adapter, { repo: REPO, number: 2, labels: [DEFAULT_LABELS.blocked] });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS);

    assert.equal(state.unbackedClaims.length, 1);
    assert.match(state.unbackedClaims[0]!.command, /--remove-label agent-blocked/);
  });

  test("a claim with a reservation in this workspace is normal — never a leftover", async () => {
    seedIssue(adapter, { repo: REPO, number: 3, labels: [DEFAULT_LABELS.claimed] });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS, keys(3));

    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("a work this process is launching right now is never reported", async () => {
    seedIssue(adapter, { repo: REPO, number: 4, labels: [DEFAULT_LABELS.claimed] });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS, new Set(), keys(4));

    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("an unmarked reservation is reported as a fact, without a command", async () => {
    seedIssue(adapter, { repo: REPO, number: 5, labels: ["outra-etiqueta"] });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS, keys(5));

    assert.equal(state.unmarkedReservations.length, 1);
    assert.equal(state.unmarkedReservations[0]?.ref.number, 5);
    const line = renderUnmarkedReservation(state.unmarkedReservations[0]!);
    assert.match(line, /unmarked reservation: Sanmoo\/a#5/);
    assert.match(line, /no factory mark/);
    assert.doesNotMatch(line, /gh issue edit/, "the human decision has no safe command");
  });

  test("a released reservation (pool label back) is normal — never reported", async () => {
    seedIssue(adapter, { repo: REPO, number: 6, labels: [DEFAULT_LABELS.ready] });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS, keys(6));

    assert.deepEqual(state.unmarkedReservations, []);
    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.pool.map((entry) => entry.ref.number), [6]);
  });

  test("an unmarked reservation whose issue is closed is the done derivation's business, not a leftover", async () => {
    seedIssue(adapter, { repo: REPO, number: 7, state: "closed", stateReason: "completed" });

    const state = await deriveTrackerState(adapter, repos, DEFAULT_LABELS, keys(7));

    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("the leftovers come from the same single read per repo — no extra listing, no per-issue reread", async () => {
    seedIssue(adapter, { repo: REPO, number: 8, labels: [DEFAULT_LABELS.claimed] });
    seedIssue(adapter, { repo: REPO, number: 9, labels: [] });

    const before = adapter.readCost();
    const state = await deriveTrackerState(adapter, [REPO, "Sanmoo/b"], DEFAULT_LABELS, keys(9));
    const after = adapter.readCost();

    assert.equal(state.unbackedClaims.length, 1);
    assert.equal(state.unmarkedReservations.length, 1);
    assert.equal(after.issueListings - before.issueListings, 2, "one open-issues read per target repo");
    assert.equal(after.issueReads - before.issueReads, 0, "the leftovers never re-read a candidate's issue");
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
      assert.match(derived.comment, /no outcome record was written/);
      assert.match(
        derived.comment,
        /the record on disk belongs to attempt 1/,
        "the previous attempt's record is named as divergent, never as this fall's outcome (issue 103)",
      );
      assert.ok(
        !derived.comment.includes(JSON.stringify({ class: "clean-without-pr", attempt: 1 }, null, 2)),
        "the old record's JSON is not embedded",
      );
    });

    test("issue 103 — a real absence still shows all three locations, absent ones included", async () => {
      seedIssue(adapter, { repo: REPO, number: 25, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(25);
      writeFileSync(join(path, "log-1.jsonl"), '{}\n', "utf8");
      writeFileSync(join(path, "log-2.jsonl"), '{}\n', "utf8");

      const derived = await deriveFrom(path, 25);

      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "block");
      assert.match(derived.comment, /trabalhos\/Sanmoo\/a#25\/ — present/);
      assert.match(derived.comment, /trabalhos\/Sanmoo\/a#25\/log-2\.jsonl — present/);
      assert.match(derived.comment, /trabalhos\/Sanmoo\/a#25\/sessao\/sandcastle-2\.log — absent/);
      assert.ok(!derived.comment.includes(path), "no absolute host path is shown");
    });

    test("issue 103 — reproduces #91: attempt 3 fell with attempt 1's blocked-self-report on disk", async () => {
      seedIssue(adapter, { repo: REPO, number: 91, labels: [DEFAULT_LABELS.claimed] });
      const path = workDirFor(91);
      // The truth of #91: attempts 1-3 ran; only attempt 1 wrote a record (a
      // self-report the operator already answered); attempts 2 and 3 died
      // abruptly — attempt 3 with a partial sandcastle log.
      for (const attempt of [1, 2, 3]) {
        writeFileSync(join(path, `log-${attempt}.jsonl`), '{}\n', "utf8");
      }
      mkdirSync(join(path, "sessao"), { recursive: true });
      writeFileSync(join(path, "sessao", "sandcastle-3.log"), "the session ended mid-", "utf8");
      writeFileSync(
        join(path, DESFECHO_FILENAME),
        JSON.stringify({ class: "blocked-self-report", attempt: 1, paths: {} }),
        "utf8",
      );

      const derived = await deriveFrom(path, 91);

      assert.equal(derived.state, "fall");
      assert.equal(derived.decision, "block", "two consecutive falls with no tracker fact of higher priority");
      assert.match(derived.comment, /2 consecutive falls \(attempt 3\)/);
      assert.match(derived.comment, /abrupt fall: no outcome record was written/);
      assert.match(derived.comment, /the record on disk belongs to attempt 1/);
      assert.ok(
        !derived.comment.includes('"class": "blocked-self-report"'),
        "the answered attempt-1 self-report is not presented as attempt 3's outcome",
      );
      assert.match(derived.comment, /trabalhos\/Sanmoo\/a#91\/log-3\.jsonl — present/);
      assert.match(derived.comment, /trabalhos\/Sanmoo\/a#91\/sessao\/sandcastle-3\.log — present/);
      // History survives: the old record is still readable on disk.
      assert.deepEqual(await readOutcomeRecord(path), {
        class: "blocked-self-report",
        attempt: 1,
        paths: {},
      });
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
