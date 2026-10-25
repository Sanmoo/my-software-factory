import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LABELS, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET } from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { settleModelProviderFailure } from "../pool/model-provider.js";
import { MAX_REPAIR_FALLS, MAX_REPAIR_ROUNDS, repairEvidenceSignature } from "../pool/repair.js";
import { workKeyOf } from "../pool/work-key.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { githubRepository, githubTicket, issueRefOfTicket } from "../tracker/identity.js";
import type { ExpandedPrFeedback, WorkPullRequest } from "../tracker/expanded-port.js";
import { notKnown, type Known, type PrRepairFacts } from "../tracker/port.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import { DESFECHO_FILENAME } from "../work-record/outcome.js";
import { PAUSE_FILENAME } from "../work-record/continuity.js";
import { REPAIR_FILENAME, type RepairPublication } from "../work-record/repair.js";
import { RECOVERY_FILENAME } from "../work-record/recovery.js";
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
 * The Work state's first reading, through the module's interface: the caller
 * hands the Work and its dir, the facts stay behind the seam (a fake tracker
 * and a real work dir), and the reading is the one vocabulary.
 */
describe("work state — the read before a launch", () => {
  let adapter: FakeTrackerAdapter;
  let root: string;
  let layout: WorkspaceLayout;

  const REPO = "Sanmoo/a";

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
    root = mkdtempSync(join(tmpdir(), "msf-work-state-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function moduleUnderTest(
    options: { inFlight?: ReadonlySet<string>; unreadablePullRequests?: ReadonlySet<number> } = {},
  ) {
    const pullRequests =
      options.unreadablePullRequests === undefined ? adapter : new SilentPullRequestTracker(options.unreadablePullRequests);
    return openWorkState({
      tickets: adapter,
      pullRequests,
      workspace: layout,
      labels: DEFAULT_LABELS,
      workerAccount: "bot",
      recovery: DEFAULT_RECOVERY_BUDGET,
      modelProvider: DEFAULT_MODEL_PROVIDER_BUDGET,
      inFlight: options.inFlight ?? new Set<string>(),
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

  async function read(number: number, inFlight?: ReadonlySet<string>): Promise<WorkStateReading> {
    return moduleUnderTest(inFlight === undefined ? {} : { inFlight }).beforeLaunch(refOf(number));
  }

  /** The repair cycle the factory persisted (reparo.json, the Work record's part). */
  function persistRepairCycle(
    number: number,
    cycle: { usedRounds: number; lastEvidence: string | null; consecutiveFalls: number; attempt: unknown },
  ): void {
    writeRecord(number, REPAIR_FILENAME, cycle);
  }

  /** One part of the Work record as the factory persisted it. */
  function writeRecord(number: number, filename: string, value: unknown): void {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    writeFileSync(join(refOf(number).dir, filename), raw, "utf8");
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

  /** One repair attempt the round put on disk, as the record holds it. */
  function repairAttemptOf(attempt: number, publication: RepairPublication) {
    return {
      evidence: evidenceOf(attempt),
      attempt,
      observedHeadSha: `observed-${attempt}`,
      remoteHeadSha: null,
      publication,
      localWork: null,
    };
  }

  /** The evidence signature of a seeded conflicting PR: a literal of the fixture. */
  function evidenceOf(number: number): string {
    return repairEvidenceSignature({
      workKey: `${REPO}#${number}`,
      headSha: `head-${number}`,
      reasons: ["conflicts"],
      failingChecks: [],
    });
  }

  test("a closed ticket is done — the terminal state, and the reading names the Work it answers for", async () => {
    seedIssue(adapter, { repo: REPO, number: 1, state: "closed", stateReason: "completed" });

    const reading = await read(1);

    assert.equal(reading.state, "done");
    assert.equal(workKeyOf(reading.work), "Sanmoo/a#1", "the reading carries the Work — the caller assembles nothing");
    assert.equal(reading.dir, workDir(layout, REPO, 1), "and the dir it read the record from");
  });

  test("an unreadable ticket is unreadable — a failed read is never 'not found', and invents no attempt", async () => {
    const reading = await read(3); // never seeded: the port answers known: false

    assert.equal(reading.state, "unreadable");
    assert.equal(reading.state === "unreadable" && typeof reading.because, "string");
    assert.equal("attempt" in reading, false, "no attempt is invented out of a failed read");
    assert.equal("recovery" in reading, false, "and no recovery is charged for it");
  });

  test("a ticket closed as not-planned is its own state — read fine, never acted on, never 'unreadable'", async () => {
    seedIssue(adapter, { repo: REPO, number: 2, state: "closed", stateReason: "not-planned" });

    const reading = await read(2);

    assert.equal(reading.state, "not-planned");
    assert.equal("because" in reading, false, "nothing failed to read here");
  });

  describe("the PR channel", () => {
    test("a merged PR with the issue open is done-fallback: the action closes the issue with a comment", async () => {
      seedIssue(adapter, { repo: REPO, number: 4, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 4, state: "closed", merged: true });

      const reading = await read(4);

      assert.equal(reading.state, "done-fallback");
      assert.equal(reading.state === "done-fallback" && reading.pr.number, 4, "the payload carries the PR");
      assert.match(reading.state === "done-fallback" ? reading.comment : "", /merged/i);
    });

    test("a PR closed without merge is rejected: the action blocks and points at the PR", async () => {
      seedIssue(adapter, { repo: REPO, number: 5, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 5, state: "closed", merged: false });

      const reading = await read(5);

      assert.equal(reading.state, "rejected");
      if (reading.state !== "rejected") assert.fail("expected a rejection");
      assert.equal(reading.pr.number, 5);
      assert.match(reading.comment, /PR #5\b/, "the comment points at the PR");
      assert.match(reading.comment, /closed without merging/i);
    });

    test("an open PR whose last comment is human is a feedback round on the same branch", async () => {
      seedIssue(adapter, { repo: REPO, number: 6, labels: [DEFAULT_LABELS.claimed], createdAt: "2026-01-01T00:00:00Z" });
      adapter.seedPullRequest({ repo: REPO, number: 6, state: "open" });
      adapter.addPrComment({ repo: REPO, prNumber: 6 }, "humano", "please change this");

      const reading = await read(6);

      assert.equal(reading.state, "feedback");
      if (reading.state !== "feedback") assert.fail("expected a feedback round");
      assert.equal(reading.pr.number, 6);
      assert.equal(reading.createdAt, "2026-01-01T00:00:00Z", "the round sorts by the ticket's creation age");
    });

    test("a review comment counts as PR feedback: the last comment spans conversation and reviews", async () => {
      seedIssue(adapter, { repo: REPO, number: 9, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 9, state: "open" });
      adapter.addReviewComment({ repo: REPO, prNumber: 9 }, "humano", "inline: fix this");

      assert.equal((await read(9)).state, "feedback");
    });

    test("an open PR the worker just opened is parked: the ball is with the human", async () => {
      seedIssue(adapter, { repo: REPO, number: 8, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 8, state: "open" });

      assert.equal((await read(8)).state, "parked");
    });

    test("speech, not login: the worker's own marked comment parks it, the same account's unmarked one is feedback", async () => {
      seedIssue(adapter, { repo: REPO, number: 70, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 70, state: "open" });
      adapter.addPrComment({ repo: REPO, prNumber: 70 }, "bot", "please change this");
      assert.equal((await read(70)).state, "feedback");

      adapter.addPrComment({ repo: REPO, prNumber: 70 }, "bot", "<!-- msf:agent --> addressed");
      assert.equal((await read(70)).state, "parked");
    });
  });

  describe("the repair channel (confirmed impediments of the open PR)", () => {
    test("conflicts with the base reactivate the worker in one round, on the same branch and PR", async () => {
      seedIssue(adapter, { repo: REPO, number: 20, labels: [DEFAULT_LABELS.claimed], createdAt: "2026-01-03T00:00:00Z" });
      adapter.seedPullRequest({ repo: REPO, number: 20, state: "open" });
      adapter.setPrRepairFacts({ repo: REPO, prNumber: 20, mergeState: "conflicting" });

      const reading = await read(20);

      assert.equal(reading.state, "repair");
      if (reading.state !== "repair") assert.fail("expected a repair round");
      assert.equal(reading.pr.number, 20);
      assert.equal(reading.createdAt, "2026-01-03T00:00:00Z");
      assert.deepEqual(reading.trigger.reasons, ["conflicts"], "the conflict with the base is the confirmed impediment");
      assert.equal(reading.resuming, null, "nothing unpublished to take over");
    });

    test("a required check concluded with failure is the other confirmed trigger, and names the failing check", async () => {
      seedIssue(adapter, { repo: REPO, number: 21, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 21, state: "open" });
      adapter.setPrRepairFacts({
        repo: REPO,
        prNumber: 21,
        requiredChecks: [{ name: "unit", status: "completed", conclusion: "failure" }],
      });

      const reading = await read(21);

      assert.equal(reading.state, "repair");
      if (reading.state !== "repair") assert.fail("expected a repair round");
      assert.deepEqual(reading.trigger.reasons, ["required-checks"]);
      assert.deepEqual(reading.trigger.failingChecks.map((check) => check.name), ["unit"]);
    });

    test("a check still running, or an unknown mergeability, confirms nothing: the work stays parked", async () => {
      seedIssue(adapter, { repo: REPO, number: 22, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 22, state: "open" });
      adapter.setPrRepairFacts({
        repo: REPO,
        prNumber: 22,
        requiredChecks: [{ name: "unit", status: "in_progress", conclusion: null }],
      });

      assert.equal((await read(22)).state, "parked");
    });

    test("the exhausted repair budget blocks with the reason on the issue", async () => {
      seedIssue(adapter, { repo: REPO, number: 23, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 23, state: "open" });
      adapter.setPrRepairFacts({ repo: REPO, prNumber: 23, mergeState: "conflicting" });
      persistRepairCycle(23, { usedRounds: MAX_REPAIR_ROUNDS, lastEvidence: null, consecutiveFalls: 0, attempt: null });

      const reading = await read(23);

      assert.equal(reading.state, "repair-blocked");
      if (reading.state !== "repair-blocked") assert.fail("expected a repair block");
      assert.equal(reading.usedRounds, MAX_REPAIR_ROUNDS);
      assert.match(reading.comment, /automatic repair stopped after 2 rounds/);
      assert.match(reading.comment, /conflict with the base/);
      assert.equal(reading.pr.number, 23);
    });

    test("re-finding the same evidence with rounds left spends no round: parked", async () => {
      seedIssue(adapter, { repo: REPO, number: 24, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 24, state: "open" });
      adapter.setPrRepairFacts({ repo: REPO, prNumber: 24, mergeState: "conflicting" });
      persistRepairCycle(24, {
        usedRounds: 1,
        lastEvidence: evidenceOf(24),
        consecutiveFalls: 0,
        attempt: null,
      });

      assert.equal((await read(24)).state, "parked");
    });

    test("a confirmed clean PR resets the repair budget, even after a fall returned its round", async () => {
      seedIssue(adapter, { repo: REPO, number: 25, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 25, state: "open" });
      persistRepairCycle(25, { usedRounds: 0, lastEvidence: "some-evidence", consecutiveFalls: 1, attempt: null });

      const reading = await read(25);

      assert.equal(reading.state, "repair-recovered", "no conflicts and an empty required set is a clean bill");
      assert.equal(reading.state === "repair-recovered" && reading.pr.number, 25);
    });

    test("two consecutive repair falls block the work even with the PR open — the fall is never hidden", async () => {
      seedIssue(adapter, { repo: REPO, number: 26, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 26, state: "open" });
      persistRepairCycle(26, {
        usedRounds: 1,
        lastEvidence: null,
        consecutiveFalls: MAX_REPAIR_FALLS,
        attempt: repairAttemptOf(3, "not-published"),
      });

      const reading = await read(26);

      assert.equal(reading.state, "repair-fall-blocked");
      if (reading.state !== "repair-fall-blocked") assert.fail("expected the repair fall block");
      assert.equal(reading.attempt, 3, "the attempt that fell is the one named");
      assert.equal(reading.pr.number, 26);
      assert.match(reading.comment, /automatic repair stopped after 2 consecutive repair attempts/);
      assert.match(reading.comment, /PR #26/);
    });

    test("a remote that moved to a commit the round did not produce blocks as well", async () => {
      seedIssue(adapter, { repo: REPO, number: 27, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 27, state: "open" });
      persistRepairCycle(27, {
        usedRounds: 1,
        lastEvidence: null,
        consecutiveFalls: 0,
        attempt: repairAttemptOf(2, "concurrent-change"),
      });

      const reading = await read(27);

      assert.equal(reading.state, "repair-fall-blocked");
      assert.equal(reading.state === "repair-fall-blocked" && reading.attempt, 2);
      assert.match(reading.state === "repair-fall-blocked" ? reading.comment : "", /concurrent change/);
    });

    test("an unpublished attempt whose evidence is still the current head is taken over, never redone", async () => {
      seedIssue(adapter, { repo: REPO, number: 28, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 28, state: "open" });
      adapter.setPrRepairFacts({ repo: REPO, prNumber: 28, mergeState: "conflicting" });
      const attempt = repairAttemptOf(1, "not-published");
      persistRepairCycle(28, {
        usedRounds: 0,
        lastEvidence: null,
        consecutiveFalls: 1,
        attempt: { ...attempt, evidence: evidenceOf(28) },
      });

      const reading = await read(28);

      assert.equal(reading.state, "repair");
      if (reading.state !== "repair") assert.fail("expected the take-over round");
      assert.equal(reading.resuming?.attempt, 1, "the round takes over the attempt it found, not a new one");
      assert.equal(reading.trigger.reasons.includes("conflicts"), true);
    });
  });

  describe("the claimed work with no PR — the record decides", () => {
    test("a claim with no worker and no evidence is an interruption of attempt 1, not a failure", async () => {
      seedIssue(adapter, { repo: REPO, number: 30, labels: [DEFAULT_LABELS.claimed] });

      const reading = await read(30);

      assert.equal(reading.state, "interrupted", "an orphan claim is an interruption, never a fall");
      if (reading.state !== "interrupted") assert.fail("expected an interruption");
      assert.equal(reading.attempt, 1, "no attempt evidence numbers attempt 1");
      assert.equal(reading.recovery.decision, "recover");
      assert.equal(reading.recovery.decision === "recover" && reading.recovery.waitMs, 1_000);
    });

    test("a claim this process launched is held, never recovered behind its back", async () => {
      seedIssue(adapter, { repo: REPO, number: 31, labels: [DEFAULT_LABELS.claimed] });

      assert.equal((await read(31, new Set([`${REPO}#31`]))).state, "parked");
    });

    test("a crash without an outcome record continues the SAME attempt", async () => {
      seedIssue(adapter, { repo: REPO, number: 32, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(32, 1);

      const reading = await read(32);

      assert.equal(reading.state, "interrupted");
      assert.equal(reading.state === "interrupted" && reading.attempt, 1);
    });

    test("a written failure the factory never ruled applies the collector's ruler: the 1st releases", async () => {
      seedIssue(adapter, { repo: REPO, number: 33, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(33, 2);
      writeRecord(33, DESFECHO_FILENAME, { class: "clean-without-pr", attempt: 2 });

      const reading = await read(33);

      assert.equal(reading.state, "fall");
      if (reading.state !== "fall") assert.fail("expected the fall ruler");
      assert.equal(reading.decision, "release", "the 1st failure releases");
      assert.equal(reading.attempt, 2);
    });

    test("the 2nd consecutive fall blocks, with the attempt's diagnosis on the issue", async () => {
      seedIssue(adapter, { repo: REPO, number: 34, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(34, 2);
      writeRecord(34, DESFECHO_FILENAME, { class: "clean-without-pr", attempt: 2 });
      writeRecord(34, RECOVERY_FILENAME, {
        attempt: 1,
        consumed: 0,
        events: [],
        lastStop: { kind: "failure", attempt: 1, at: "2026-01-01T00:00:00Z", outcome: "clean-without-pr" },
        lastFallAttempt: 1,
      });

      const reading = await read(34);

      assert.equal(reading.state, "fall");
      if (reading.state !== "fall") assert.fail("expected the fall ruler");
      assert.equal(reading.decision, "block");
      assert.equal(reading.attempt, 2);
      assert.match(reading.comment, /worker blocked after 2 consecutive falls \(attempt 2\)/);
    });

    test("the requested stop of this attempt resumes it, spending no recovery", async () => {
      seedIssue(adapter, { repo: REPO, number: 35, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(35, 2);
      writeRecord(35, RECOVERY_FILENAME, {
        attempt: 2,
        consumed: 0,
        events: [],
        lastStop: { kind: "stop-requested", attempt: 2, at: "2026-01-01T00:00:00Z" },
        lastFallAttempt: null,
      });

      const reading = await read(35);

      assert.equal(reading.state, "stop-resume", "a requested stop is a lifecycle condition, never a fall");
      assert.equal(reading.state === "stop-resume" && reading.attempt, 2);
    });

    test("a stop that could not be confirmed holds the work with its reason", async () => {
      seedIssue(adapter, { repo: REPO, number: 36, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(36, 1);
      writeRecord(36, RECOVERY_FILENAME, {
        attempt: 1,
        consumed: 0,
        events: [],
        lastStop: {
          kind: "stop-unconfirmed",
          attempt: 1,
          at: "2026-01-01T00:00:00Z",
          because: "the worker could not be probed",
        },
        lastFallAttempt: null,
      });

      const reading = await read(36);

      assert.equal(reading.state, "stop-unconfirmed");
      if (reading.state !== "stop-unconfirmed") assert.fail("expected the unconfirmed stop");
      assert.equal(reading.attempt, 1);
      assert.equal(reading.because, "the worker could not be probed");
    });

    test("a confirmed outcome prevails over a stop record left on top of it", async () => {
      seedIssue(adapter, { repo: REPO, number: 37, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(37, 1);
      writeRecord(37, DESFECHO_FILENAME, { class: "clean-without-pr", attempt: 1 });
      writeRecord(37, RECOVERY_FILENAME, {
        attempt: 1,
        consumed: 0,
        events: [],
        lastStop: { kind: "stop-requested", attempt: 1, at: "2026-01-01T00:00:00Z" },
        lastFallAttempt: null,
      });

      assert.equal((await read(37)).state, "fall", "the attempt really ended with a verdict");
    });

    test("a blocked self-report whose label never landed is reserved, never recovered", async () => {
      seedIssue(adapter, { repo: REPO, number: 38, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(38, 1);
      writeRecord(38, DESFECHO_FILENAME, { class: "blocked-self-report", attempt: 1 });

      assert.equal((await read(38)).state, "parked");
    });

    test("a pending reconciliation holds the claim: nothing is released while publication is unknown", async () => {
      seedIssue(adapter, { repo: REPO, number: 39, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(39, 1);
      persistRepairCycle(39, {
        usedRounds: 1,
        lastEvidence: null,
        consecutiveFalls: 0,
        attempt: repairAttemptOf(1, "pending"),
      });

      assert.equal((await read(39)).state, "parked");
    });

    test("an interrupted attempt whose recovery budget ran out pauses and asks the operator", async () => {
      seedIssue(adapter, { repo: REPO, number: 40, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(40, 3);
      writeRecord(40, RECOVERY_FILENAME, {
        attempt: 3,
        consumed: DEFAULT_RECOVERY_BUDGET.maxRecoveries,
        events: [],
        lastStop: null,
        lastFallAttempt: null,
      });

      const reading = await read(40);

      assert.equal(reading.state, "interrupted", "it is still an interruption — the budget only stops the relaunch");
      assert.equal(reading.state === "interrupted" && reading.recovery.decision, "pause-help");
    });

    test("a persisted pause holds the work and names the attempt it waits for", async () => {
      seedIssue(adapter, { repo: REPO, number: 41, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(41, 1);
      writeRecord(41, PAUSE_FILENAME, {
        version: 1,
        work: { ticket: githubTicket(REPO, 41), destination: githubRepository(REPO) },
        attempt: 1,
        reason: "effect-ambiguous",
        detail: "an interrupted external effect is ambiguous",
        at: "2026-01-01T00:00:00.000Z",
        announced: true,
      });

      const reading = await read(41);

      assert.equal(reading.state, "continuity-paused");
      if (reading.state !== "continuity-paused") assert.fail("expected the continuity pause");
      assert.equal(reading.attempt, 1);
      assert.equal(reading.pause.reason, "effect-ambiguous");
    });

    test("a pause record that cannot be read is a doubt, never absence: no recovery is charged for it", async () => {
      seedIssue(adapter, { repo: REPO, number: 42, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(42, 1);
      writeRecord(42, PAUSE_FILENAME, "not a pause at all");

      const reading = await read(42);

      assert.equal(
        reading.state,
        "continuity-paused",
        "returning interrupted would let the work fall back to a recovery the record forbade",
      );
      assert.equal(reading.state === "continuity-paused" && reading.pause.reason, "record-unreadable");
    });

    test("an attempt whose stream ended in a model provider error retries on its own budget", async () => {
      seedIssue(adapter, { repo: REPO, number: 43, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(43, 1);
      writeProviderError(43, 1);

      const reading = await read(43);

      assert.equal(reading.state, "model-provider-failure", "a provider error is not an interruption of the agent");
      if (reading.state !== "model-provider-failure") assert.fail("expected the provider failure");
      assert.equal(reading.attempt, 1);
      assert.equal(reading.failure.message, "429: upstream unavailable");
      assert.equal(reading.modelProvider.decision, "retry");
      assert.equal(reading.modelProvider.decision === "retry" && reading.modelProvider.waitMs, 15_000);
    });

    test("the exhausted provider budget awaits the operator, and a human answer resumes the work", async () => {
      seedIssue(adapter, { repo: REPO, number: 44, labels: [DEFAULT_LABELS.claimed] });
      writeAttemptLog(44, 1);
      writeProviderError(44, 1, 1_700_000_000_777);
      for (let index = 0; index <= DEFAULT_MODEL_PROVIDER_BUDGET.maxRetries; index += 1) {
        await settleModelProviderFailure(workDir(layout, REPO, 44), DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
          message: "429: upstream unavailable",
          identity: `2026-01-01T00:00:0${index}.000Z`,
        });
      }

      const waiting = await read(44);
      assert.equal(waiting.state, "model-provider-failure");
      assert.equal(
        waiting.state === "model-provider-failure" && waiting.modelProvider.decision,
        "awaiting-model-provider",
        "never a block: the work waits for the operator",
      );

      adapter.addComment({ repo: REPO, number: 44 }, "operator", "the model provider is back — go on");
      const resumed = await read(44);
      assert.equal(resumed.state, "resumable", "the help request is a channel");
      assert.deepEqual(
        resumed.state === "resumable" && resumed.issueReplies.map((comment) => comment.body),
        ["the model provider is back — go on"],
      );
    });
    test("a Work whose record the factory cannot read holds: no recovery is invented out of a failed read", async () => {
      seedIssue(adapter, { repo: REPO, number: 45, labels: [DEFAULT_LABELS.claimed] });
      // A dir that cannot be read as a record at all: a file where the work dir
      // should be. The read fails, and a failed read is not an empty record.
      const dir = join(layout.works, `${REPO}#45`);
      mkdirSync(join(layout.works, REPO), { recursive: true });
      writeFileSync(dir, "", "utf8");

      const reading = await moduleUnderTest().beforeLaunch({
        work: { ticket: githubTicket(REPO, 45), destination: githubRepository(REPO) },
        dir,
      });

      assert.equal(reading.state, "parked", "the factory holds instead of charging a recovery on facts nobody read");
    });

    test("a PR read that fails never becomes a merge or a rejection", async () => {
      seedIssue(adapter, { repo: REPO, number: 46, labels: [DEFAULT_LABELS.claimed] });
      adapter.seedPullRequest({ repo: REPO, number: 46, state: "closed", merged: true });
      writeAttemptLog(46, 1);

      const reading = await moduleUnderTest({ unreadablePullRequests: new Set([46]) }).beforeLaunch(refOf(46));

      assert.equal(
        reading.state,
        "interrupted",
        "with no PR fact to speak of, the record answers — the failure is never read as 'no PR, so done'",
      );
      assert.equal(reading.state === "interrupted" && reading.attempt, 1);
    });
  });

  describe("the blocked channel (the ticket's rescue)", () => {
    test("a human answer after the last marker is resumable, carrying the replies as context", async () => {
      seedIssue(adapter, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.blocked], createdAt: "2026-01-02T00:00:00Z" });
      await adapter.comment({ repo: REPO, number: 10 }, "worker blocked after 2 consecutive falls (attempt 2)");
      adapter.addComment({ repo: REPO, number: 10 }, "humano", "try again, the token is valid now");

      const reading = await read(10);

      assert.equal(reading.state, "resumable");
      if (reading.state !== "resumable") assert.fail("expected the retomada");
      assert.equal(reading.pr, null, "no PR is known, and none is invented");
      assert.equal(reading.createdAt, "2026-01-02T00:00:00Z");
      assert.deepEqual(reading.issueReplies.map((comment) => comment.body), ["try again, the token is valid now"]);
    });

    test("an answer posted BEFORE the marker is not an answer: the work stays parked", async () => {
      seedIssue(adapter, { repo: REPO, number: 12, labels: [DEFAULT_LABELS.blocked] });
      adapter.addComment({ repo: REPO, number: 12 }, "humano", "context: this needs the new key");
      await adapter.comment({ repo: REPO, number: 12 }, "worker blocked…");

      assert.equal((await read(12)).state, "parked");
    });

    test("a released work nobody claims is parked here — the pool owns it, not this reading", async () => {
      seedIssue(adapter, { repo: REPO, number: 14, labels: [DEFAULT_LABELS.ready] });

      assert.equal((await read(14)).state, "parked");
    });
  });
});
