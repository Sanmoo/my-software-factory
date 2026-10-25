import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LABELS, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET } from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { settleModelProviderFailure } from "../pool/model-provider.js";
import { workKeyOf } from "../pool/work-key.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { githubRepository, githubTicket, issueRefOfTicket } from "../tracker/identity.js";
import type { ExpandedPrFeedback, WorkPullRequest } from "../tracker/expanded-port.js";
import { notKnown, type Known, type PrRepairFacts } from "../tracker/port.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import { DESFECHO_FILENAME } from "../work-record/outcome.js";
import { RECOVERY_FILENAME, type RecoveryStop } from "../work-record/recovery.js";
import { openWorkState, type WorkRef, type WorkStateReading } from "./state.js";

/**
 * A tracker whose PR read cannot answer for the works named: the port's
 * `known: false`, which says nothing about whether a PR exists.
 */
class SilentPullRequestTracker extends FakeTrackerAdapter {
  constructor(private readonly silent: ReadonlySet<number>) {
    super({ workerAccount: "bot" });
  }

  override async readPullRequestFeedback(target: WorkPullRequest): Promise<Known<ExpandedPrFeedback>> {
    const ref = issueRefOfTicket(target.work.ticket);
    if (ref !== null && this.silent.has(ref.number)) return notKnown;
    return super.readPullRequestFeedback(target);
  }

  override async readPullRequestRepairFacts(target: WorkPullRequest): Promise<Known<PrRepairFacts>> {
    const ref = issueRefOfTicket(target.work.ticket);
    if (ref !== null && this.silent.has(ref.number)) return notKnown;
    return super.readPullRequestRepairFacts(target);
  }
}

/**
 * The Work state's SECOND reading, through the same interface as the first:
 * "what happened to the Attempt that just ended, and what may the factory do
 * now?". The caller hands the Work, its dir, the attempt and whether this
 * factory is stopping; the outcome record and its ownership, the ticket, the
 * PR, the requested-stop evidence, the turn's model provider failure and the
 * consecutiveness of the fall all stay behind the seam (a fake tracker and a
 * real work dir).
 *
 * The rulings pinned here are the ones the collection has always made — plus the
 * one fact that had no word in the collection vocabulary at all: a PR closed
 * without merge is `rejected`, and the collection blocks with it (epic #198's
 * one behaviour delta).
 */
describe("work state — the read after an attempt", () => {
  let adapter: FakeTrackerAdapter;
  let root: string;
  let layout: WorkspaceLayout;

  const REPO = "Sanmoo/a";

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
    root = mkdtempSync(join(tmpdir(), "msf-after-attempt-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  interface ReadOptions {
    stopping?: boolean;
    unreadablePullRequests?: ReadonlySet<number>;
  }

  function moduleUnderTest(options: ReadOptions = {}) {
    const pullRequests =
      options.unreadablePullRequests === undefined
        ? adapter
        : new SilentPullRequestTracker(options.unreadablePullRequests);
    return openWorkState({
      tickets: adapter,
      pullRequests,
      workspace: layout,
      labels: DEFAULT_LABELS,
      workerAccount: "bot",
      recovery: DEFAULT_RECOVERY_BUDGET,
      modelProvider: DEFAULT_MODEL_PROVIDER_BUDGET,
      inFlight: new Set<string>(),
    });
  }

  /** The Work as the caller hands it: its identity and the reservation's dir. */
  function refOf(number: number): WorkRef {
    const dir = workDir(layout, REPO, number);
    mkdirSync(dir, { recursive: true });
    return {
      work: { ticket: githubTicket(REPO, number), destination: githubRepository(REPO) },
      dir,
    };
  }

  async function read(number: number, attempt: number, options: ReadOptions = {}): Promise<WorkStateReading> {
    return moduleUnderTest(options).afterAttempt({
      ...refOf(number),
      attempt,
      stopping: options.stopping === true,
    });
  }

  /** One part of the Work record as the factory persisted it. */
  function writeRecord(number: number, filename: string, value: unknown): void {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    writeFileSync(join(refOf(number).dir, filename), raw, "utf8");
  }

  /** The attempt's own written outcome — the record the ruler reads. */
  function writeOutcome(number: number, attempt: number, outcomeClass: string): void {
    writeRecord(number, DESFECHO_FILENAME, { class: outcomeClass, attempt });
  }

  /** The recovery part of the record: what ended the last attempt, and whether
   *  the previous one ended in a written failure. */
  function writeLedger(number: number, ledger: { lastStop?: RecoveryStop | null; lastFallAttempt?: number | null; consumed?: number }): void {
    writeRecord(number, RECOVERY_FILENAME, {
      attempt: 1,
      consumed: ledger.consumed ?? 0,
      events: [],
      lastStop: ledger.lastStop ?? null,
      lastFallAttempt: ledger.lastFallAttempt ?? null,
    });
  }

  /** The footprint of an attempt that started and wrote no outcome record. */
  function writeAttemptLog(number: number, attempt: number): void {
    writeFileSync(join(refOf(number).dir, `log-${attempt}.jsonl`), "{}\n", "utf8");
  }

  /** The attempt's stream line of a model provider failure, as the runtime records it. */
  function writeProviderError(number: number, attempt: number, at = 1_700_000_000_000): void {
    appendAttemptEvent(refOf(number).dir, attempt, {
      event: "agent-raw",
      iteration: 1,
      line: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "fake/model",
          stopReason: "error",
          errorMessage: "429: upstream unavailable",
          timestamp: at,
        },
      }),
    });
  }

  test("a ticket closed while the attempt ran is done — the terminal state, never a fall", async () => {
    seedIssue(adapter, { repo: REPO, number: 1, state: "closed", stateReason: "completed" });

    const reading = await read(1, 1);

    assert.equal(reading.state, "done");
    assert.equal(workKeyOf(reading.work), "Sanmoo/a#1", "the reading carries the Work — the caller assembles nothing");
    assert.equal(reading.dir, workDir(layout, REPO, 1), "and the dir the record was read from");
  });

  test("a PR merged while the attempt ran is done-fallback: the action closes the issue, then archives", async () => {
    seedIssue(adapter, { repo: REPO, number: 2, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 2, state: "closed", merged: true });

    const reading = await read(2, 1);

    assert.equal(reading.state, "done-fallback", "a merge is delivery, whatever the attempt wrote");
    if (reading.state !== "done-fallback") assert.fail("expected the merge fallback");
    assert.equal(reading.pr.number, 2, "the payload carries the PR the action points at");
    assert.match(reading.comment, /merged/i);
  });

  test("an open PR is parked because the PR is open: the work stays reserved for the human", async () => {
    seedIssue(adapter, { repo: REPO, number: 3, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 3, state: "open" });

    const reading = await read(3, 1);

    assert.equal(reading.state, "parked");
    assert.equal(reading.state === "parked" && reading.because, "pr-open", "parked says why: nothing else is decided");
  });

  test("a PR closed without merge is rejected — the fact the collection vocabulary had no word for", async () => {
    seedIssue(adapter, { repo: REPO, number: 4, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 4, state: "closed", merged: false });
    // The attempt wrote nothing at all: the closed PR is the fact, and it is a
    // Block — never an interruption, never a release back to the pool.

    const reading = await read(4, 1);

    assert.equal(reading.state, "rejected", "a closed PR is the same rejection this reading always named");
    if (reading.state !== "rejected") assert.fail("expected a rejection");
    assert.equal(reading.pr.number, 4, "the payload carries the PR the block points at");
    assert.match(reading.comment, /PR #4\b/);
    assert.match(reading.comment, /closed without merging/i);
    assert.equal("attempt" in reading, false, "a rejection is about the PR, not about the attempt's number");
  });

  test("a blocked self-report is only recorded: the factory has nothing to decide", async () => {
    seedIssue(adapter, { repo: REPO, number: 5, labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });

    const reading = await read(5, 1);

    assert.equal(reading.state, "parked");
    assert.equal(reading.state === "parked" && reading.because, "blocked-self-report");
  });

  test("a self-report whose label never landed is still only recorded — the record's own class speaks", async () => {
    seedIssue(adapter, { repo: REPO, number: 6, labels: [DEFAULT_LABELS.claimed] });
    writeOutcome(6, 1, "blocked-self-report");

    const reading = await read(6, 1);

    assert.equal(reading.state, "parked");
    assert.equal(reading.state === "parked" && reading.because, "blocked-self-report");
  });

  test("the worker's own report outranks the closed PR: the human sees what the worker said", async () => {
    seedIssue(adapter, { repo: REPO, number: 7, labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });
    adapter.seedPullRequest({ repo: REPO, number: 7, state: "closed", merged: false });

    const reading = await read(7, 1);

    assert.equal(reading.state, "parked", "a confirmed self-report is recorded, never re-ruled as a rejection");
    assert.equal(reading.state === "parked" && reading.because, "blocked-self-report");
  });

  test("an attempt that wrote no record is an interruption — never a fall, and no attempt consumed", async () => {
    seedIssue(adapter, { repo: REPO, number: 8, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(8, 1);

    const reading = await read(8, 1);

    assert.equal(reading.state, "interrupted", "absence is an interruption, never a failure (issue 123)");
    if (reading.state !== "interrupted") assert.fail("expected an interruption");
    assert.equal(reading.attempt, 1, "the attempt keeps its number");
    assert.equal(reading.recovery.decision, "recover", "the recovery budget answers it, not the fall ruler");
    assert.equal("decision" in reading, false, "the fall ruler's word is absent: this is not a fall");
    assert.equal("comment" in reading, false, "and nothing is written about it");
  });

  test("the operator's requested stop owns the end: the same attempt resumes and no recovery is spent", async () => {
    seedIssue(adapter, { repo: REPO, number: 9, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(9, 1);
    writeLedger(9, { lastStop: { kind: "stop-requested", attempt: 1, at: "2026-01-01T00:00:00Z" } });

    const reading = await read(9, 1);

    assert.equal(reading.state, "stop-resume", "the stop is not the attempt's failure");
    if (reading.state !== "stop-resume") assert.fail("expected the requested-stop resume");
    assert.equal(reading.attempt, 1, "the SAME attempt resumes — the stop consumes none");
    assert.equal(reading.because, "stop-recorded", "the evidence a previous invocation left on the attempt");
    assert.equal("recovery" in reading, false, "nothing is charged: there is no budget decision to make");
  });

  test("a stop this process is carrying out resumes on the next run: the reading spends nothing either", async () => {
    seedIssue(adapter, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(10, 1);

    const stopping = await read(10, 1, { stopping: true });

    assert.equal(stopping.state, "stop-resume");
    assert.equal(stopping.state === "stop-resume" && stopping.because, "stop-in-progress");
    assert.equal("recovery" in stopping, false, "the stop is never answered with the recovery budget");

    // The same facts without the stop in progress are an interruption: the
    // process-wide condition is the only thing that changed.
    const interrupted = await read(10, 1);
    assert.equal(interrupted.state, "interrupted");
  });

  test("a written outcome prevails over the stop: a fall is ruled, not resumed", async () => {
    seedIssue(adapter, { repo: REPO, number: 11, labels: [DEFAULT_LABELS.claimed] });
    writeOutcome(11, 1, "clean-without-pr");
    writeLedger(11, { lastStop: { kind: "stop-requested", attempt: 1, at: "2026-01-01T00:00:00Z" } });

    const stopping = await read(11, 1, { stopping: true });

    assert.equal(
      stopping.state,
      "fall",
      "the attempt ended with a verdict, so the stop's interpretation does not apply (issue #146)",
    );
  });

  test("an attempt whose stream ended in a model provider error retries on its own budget", async () => {
    seedIssue(adapter, { repo: REPO, number: 12, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(12, 1);
    writeProviderError(12, 1);

    const reading = await read(12, 1);

    assert.equal(reading.state, "model-provider-failure", "a provider error is not an interruption of the agent");
    if (reading.state !== "model-provider-failure") assert.fail("expected the provider failure");
    assert.equal(reading.attempt, 1);
    assert.equal(reading.failure.message, "429: upstream unavailable");
    assert.equal(reading.modelProvider.decision, "retry", "it retries on the provider's budget, never the recovery one");
    assert.equal(reading.modelProvider.decision === "retry" && reading.modelProvider.waitMs, 15_000);
    assert.equal("recovery" in reading, false, "the interruption budget is not consulted at all");
  });

  test("the exhausted provider budget awaits the operator — it is never read as a fall", async () => {
    seedIssue(adapter, { repo: REPO, number: 13, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(13, 1);
    writeProviderError(13, 1, 1_700_000_000_777);
    for (let index = 0; index <= DEFAULT_MODEL_PROVIDER_BUDGET.maxRetries; index += 1) {
      await settleModelProviderFailure(workDir(layout, REPO, 13), DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
        message: "429: upstream unavailable",
        identity: `2026-01-01T00:00:0${index}.000Z`,
      });
    }

    const reading = await read(13, 1);

    assert.equal(reading.state, "model-provider-failure");
    assert.equal(
      reading.state === "model-provider-failure" && reading.modelProvider.decision,
      "awaiting-model-provider",
      "the work waits for the operator; it is never blocked as a fall",
    );
  });

  describe("the fall ruler", () => {
    test("a first written failure releases: claimed→ready back, the branch stays", async () => {
      seedIssue(adapter, { repo: REPO, number: 20, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(20, 2);
      writeOutcome(20, 2, "clean-without-pr");

      const reading = await read(20, 2);

      assert.equal(reading.state, "fall");
      if (reading.state !== "fall") assert.fail("expected the fall ruler");
      assert.equal(reading.decision, "release", "the 1st consecutive failure releases");
      assert.equal(reading.attempt, 2);
      assert.equal("comment" in reading, false, "a release says nothing to the human");
    });

    test("a second consecutive fall blocks, carrying the attempt's diagnosis and its evidence", async () => {
      seedIssue(adapter, { repo: REPO, number: 21, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(21, 2);
      writeOutcome(21, 2, "clean-without-pr");
      writeLedger(21, {
        lastStop: { kind: "failure", attempt: 1, at: "2026-01-01T00:00:00Z", outcome: "clean-without-pr" },
        lastFallAttempt: 1,
      });

      const reading = await read(21, 2);

      assert.equal(reading.state, "fall");
      if (reading.state !== "fall") assert.fail("expected the fall ruler");
      assert.equal(reading.decision, "block", "the 2nd consecutive failure blocks");
      assert.equal(reading.attempt, 2);
      assert.match(reading.comment, /worker blocked after 2 consecutive falls \(attempt 2\)/);
      assert.match(reading.comment, /clean-without-pr/, "the human must SEE the outcome before deciding");
    });

    test("a fall two attempts back is history: consecutiveness is the PREVIOUS attempt's", async () => {
      seedIssue(adapter, { repo: REPO, number: 22, labels: [DEFAULT_LABELS.claimed] });
      writeOutcome(22, 4, "clean-without-pr");
      writeLedger(22, { lastFallAttempt: 2 });

      const reading = await read(22, 4);

      assert.equal(reading.state === "fall" && reading.decision, "release");
    });
  });

  describe("ownership: a record that belongs to another attempt is absent here", () => {
    test("the previous attempt's written failure is not this attempt's fall", async () => {
      seedIssue(adapter, { repo: REPO, number: 30, labels: [DEFAULT_LABELS.claimed] });
      writeOutcome(30, 1, "clean-without-pr");

      const reading = await read(30, 2);

      assert.equal(reading.state, "interrupted", "no verdict of its own: a crash never inherits the previous attempt's");
      assert.equal(reading.state === "interrupted" && reading.attempt, 2);
    });

    test("the previous attempt's self-report is not this attempt's self-report", async () => {
      seedIssue(adapter, { repo: REPO, number: 31, labels: [DEFAULT_LABELS.claimed] });
      writeOutcome(31, 1, "blocked-self-report");

      const reading = await read(31, 2);

      assert.equal(reading.state, "interrupted", "a label-less self-report of attempt 1 records nothing about attempt 2");
    });
  });

  describe("read-only: the reading decides and writes nothing", () => {
    /** Every file of the work dir, by name, with its bytes. */
    function snapshotDir(number: number): Map<string, string> {
      const dir = refOf(number).dir;
      return new Map(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]));
    }

    /** The tracker's own view of the work: what a write of a claim or a block would move. */
    async function snapshotTracker(number: number): Promise<unknown> {
      const ticket = await adapter.readTicket(githubTicket(REPO, number));
      const comments = await adapter.readTicketComments(githubTicket(REPO, number));
      return { ticket, comments };
    }

    test("an interruption consumes no attempt and records no failure", async () => {
      seedIssue(adapter, { repo: REPO, number: 32, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(32, 1);
      writeLedger(32, { consumed: 0 });
      const dirBefore = snapshotDir(32);
      const trackerBefore = await snapshotTracker(32);

      assert.equal((await read(32, 1)).state, "interrupted");

      assert.deepEqual(snapshotDir(32), dirBefore, "not one byte of the record changed: no failure, no recovery spent");
      assert.deepEqual(await snapshotTracker(32), trackerBefore, "and the tracker was not touched");
    });

    test("the stop evidence is read, never promoted: an unconfirmed stop stays unconfirmed on disk", async () => {
      seedIssue(adapter, { repo: REPO, number: 33, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(33, 1);
      writeLedger(33, {
        lastStop: {
          kind: "stop-unconfirmed",
          attempt: 1,
          at: "2026-01-01T00:00:00Z",
          because: "a worker was still alive when the stop was requested",
        },
      });
      const before = snapshotDir(33);

      const reading = await read(33, 1);

      assert.equal(reading.state, "stop-resume", "the stop a previous invocation could not confirm still owns the end");
      assert.deepEqual(snapshotDir(33), before, "promoting it is the loop's write, not a side effect of a reading");
    });
  });

  test("a PR read that fails never becomes a merge or a rejection", async () => {
    seedIssue(adapter, { repo: REPO, number: 40, labels: [DEFAULT_LABELS.claimed] });
    adapter.seedPullRequest({ repo: REPO, number: 40, state: "closed", merged: false });
    writeAttemptLog(40, 1);

    const reading = await read(40, 1, { unreadablePullRequests: new Set([40]) });

    assert.equal(reading.state, "interrupted", "with no PR fact to speak of, the attempt's own record answers");
  });

  describe("the priority of the arms is the collection ruler's, one for one", () => {
    test("a closed issue outranks every PR fact", async () => {
      seedIssue(adapter, { repo: REPO, number: 50, state: "closed", stateReason: "completed", labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });
      adapter.seedPullRequest({ repo: REPO, number: 50, state: "closed", merged: true });

      assert.equal((await read(50, 1)).state, "done", "the terminal fact is the issue, and it wins");
    });

    test("a merged PR outranks the self-report and the interruption", async () => {
      seedIssue(adapter, { repo: REPO, number: 51, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 51, state: "closed", merged: true });
      writeOutcome(51, 1, "blocked-self-report");

      assert.equal((await read(51, 1)).state, "done-fallback", "delivery is not re-ruled by what the attempt wrote");
    });

    test("an open PR outranks the self-report and never becomes a fall", async () => {
      seedIssue(adapter, { repo: REPO, number: 52, labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });
      adapter.seedPullRequest({ repo: REPO, number: 52, state: "open" });
      writeOutcome(52, 1, "clean-without-pr");

      const reading = await read(52, 1);

      assert.equal(reading.state, "parked", "the claim is held for the human, no fall recorded");
      assert.equal(reading.state === "parked" && reading.because, "pr-open");
    });

    test("the stop outranks an open PR: the operator's end is not a delivery to wait for", async () => {
      seedIssue(adapter, { repo: REPO, number: 53, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 53, state: "open" });
      writeAttemptLog(53, 1);

      assert.equal((await read(53, 1, { stopping: true })).state, "stop-resume");
    });

    test("an own record that claims a PR nobody can see still counts as a fall, as at collection", async () => {
      seedIssue(adapter, { repo: REPO, number: 54, labels: [DEFAULT_LABELS.claimed] });
      writeOutcome(54, 1, "pr-open");

      const reading = await read(54, 1);

      assert.equal(
        reading.state === "fall" && reading.decision,
        "release",
        "the record's class is a fact of the attempt, not a verdict: it never invents a PR",
      );
    });
  });
});
