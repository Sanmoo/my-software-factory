import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitWork, LocalWorkFacts, PreparedWork } from "../git/port.js";
import { DEFAULT_LABELS } from "../config.js";
import { githubRepository, githubTicket, type WorkIdentity } from "../tracker/identity.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import {
  readRepairCycle,
  writeRepairCycle,
  type RepairAttempt,
  type RepairCycle,
} from "../work-record/repair.js";
import { openRepairReconciler, type RepairWork } from "./reconcile.js";

/**
 * The Repair reconciliation through its interface (epic #198, ticket #207): the
 * module settles a repair attempt that wrote its facts on disk and no live
 * worker carries, persists the cycle and says the verdict — and asks git only
 * what it needs. Nothing here launches, blocks, archives or releases: the
 * derivation reads the cycle this module leaves behind.
 */

const REPO = "Sanmoo/my-tasks";
const OBSERVED = "a".repeat(40);
const PRODUCED = "b".repeat(40);

/** The git host as the reconciliation sees it: two reads, both observable. */
class ProbeGit implements GitWork {
  constructor(readonly reads: string[] = []) {}

  localWork: LocalWorkFacts | null = {
    headSha: PRODUCED,
    commits: 1,
    uncommitted: false,
    operationInProgress: null,
  };
  remoteHead: string | null = OBSERVED;
  /** The read that throws — git cannot answer, which is never "nothing there". */
  failLocal = false;
  failRemote = false;

  async inspectLocalWorkFor(work: WorkIdentity): Promise<LocalWorkFacts> {
    this.reads.push(`local:${work.ticket.key}`);
    if (this.failLocal) throw new Error("fake: git cannot inspect the work branch");
    if (this.localWork === null) throw new Error("fake: the branch is not there");
    return this.localWork;
  }

  async observeRemoteHeadFor(work: WorkIdentity): Promise<string | null> {
    this.reads.push(`remote:${work.ticket.key}`);
    if (this.failRemote) throw new Error("fake: git cannot read the remote");
    return this.remoteHead;
  }

  async prepareWorkFor(): Promise<PreparedWork> {
    throw new Error("the reconciliation prepares nothing");
  }

  async cleanupDoneWorkFor(): Promise<void> {}

  async diffWorkFor(): Promise<string> {
    return "";
  }
}

describe("the Repair reconciliation — a settled attempt, through the module", () => {
  let root: string;
  let dir: string;
  let work: WorkIdentity;
  let target: RepairWork;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-repair-"));
    dir = join(root, "trabalhos", `${REPO}#1`);
    mkdirSync(dir, { recursive: true });
    work = { ticket: githubTicket(REPO, 1), destination: githubRepository(REPO) };
    target = { work, dir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function pendingAttempt(overrides: Partial<RepairAttempt> = {}): RepairAttempt {
    return {
      evidence: `${REPO}#1|${OBSERVED}|conflicts|`,
      attempt: 2,
      observedHeadSha: OBSERVED,
      remoteHeadSha: null,
      publication: "pending",
      localWork: null,
      ...overrides,
    };
  }

  function cycleWith(attempt: RepairAttempt | null, overrides: Partial<RepairCycle> = {}): RepairCycle {
    return {
      usedRounds: 1,
      lastEvidence: `${REPO}#1|${OBSERVED}|conflicts|`,
      consecutiveFalls: 0,
      attempt,
      ...overrides,
    };
  }

  /** The module as its callers receive it: git, the PR facts and the log. */
  function open(git: ProbeGit, tracker: FakeTrackerAdapter, operatorStopped = false) {
    const lines: string[] = [];
    return {
      lines,
      repair: openRepairReconciler({
        git,
        pullRequests: tracker,
        log: (line) => lines.push(line),
        cycle: { operatorStopped: async () => operatorStopped },
      }),
    };
  }

  function trackerWithIssue(): FakeTrackerAdapter {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.claimed] });
    return tracker;
  }

  test("an attempt that published is charged and settled, and the cycle says so on disk", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    git.remoteHead = PRODUCED; // the remote carries the commit this attempt produced
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.attempt?.publication, "published", "the attempt is settled, not left pending");
    assert.equal(cycle.consecutiveFalls, 0, "a delivery never counts a fall");
    assert.match(lines.join("\n"), /repair attempt 2 of Sanmoo\/my-tasks#1 confirmed published/);
    assert.deepEqual(git.reads, ["local:#1", "remote:#1"], "git is asked twice, once each");
  });

  test("an attempt that published nothing returns its round and counts one fall", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit(); // the remote is still where the attempt started
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.usedRounds, 0, "the charged round returns");
    assert.equal(cycle.consecutiveFalls, 1, "and the unpublished attempt is a fall");
    assert.equal(cycle.attempt?.publication, "not-published");
    assert.match(lines.join("\n"), /ended without publishing/);
    assert.match(lines.join("\n"), /local work preserved/, "the operator is told the work is still there");
  });

  test("a live worker owns its attempt: nothing is read, settled or written", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    const before = cycleWith(pendingAttempt());
    await writeRepairCycle(dir, before);
    const git = new ProbeGit();
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set([`${REPO}#1`]));

    assert.deepEqual(await readRepairCycle(dir), before, "a half-written branch is never read as a verdict");
    assert.deepEqual(git.reads, [], "and git is not asked at all");
    assert.deepEqual(lines, []);
  });

  test("a work that never ran a repair round costs nothing — no read, no write, no line", async () => {
    const git = new ProbeGit();
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    assert.deepEqual(git.reads, [], "no registry read or git inspection is paid per sweep");
    assert.deepEqual(lines, []);
  });

  test("an unreadable remote leaves the attempt pending: no round is charged or refunded", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    git.failRemote = true;
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.attempt?.publication, "pending", "uncertainty is never a verdict");
    assert.equal(cycle.usedRounds, 1, "the round stays charged while publication is unknown");
    assert.equal(cycle.consecutiveFalls, 0, "and no fall is invented");
    assert.match(lines.join("\n"), /reconciliation pending \(the remote head could not be read\)/);
  });

  test("an unreadable local work is pending too — never 'nothing there'", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    git.failLocal = true;
    const { repair } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.attempt?.publication, "pending");
    assert.equal(cycle.consecutiveFalls, 0);
  });

  test("the settlement is idempotent: a second sweep pays nothing and says nothing", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    git.remoteHead = PRODUCED;
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());
    const settled = await readRepairCycle(dir);
    const said = lines.length;
    await repair.reconcile([target], new Set());

    assert.deepEqual(await readRepairCycle(dir), settled, "a settled attempt is never charged again");
    assert.equal(lines.length, said, "and the operator is not told twice");
  });

  test("the requested stop owns the end: an attempt that has not written its outcome is not settled", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    const { repair, lines } = open(git, trackerWithIssue(), true);

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.attempt?.publication, "pending", "the same Repair is stopped, not finished");
    assert.equal(cycle.usedRounds, 1);
    assert.deepEqual(lines, []);
  });

  test("a legacy cycle is adopted from the registry gap and settled from the attempt's own artifacts", async () => {
    // A file written before the attempt existed: the gap between the ledger's
    // attempt and the last recorded outcome is what adopts it (issue 112), and
    // the artifacts decide whether a worker ever saw it (issue 181).
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(null));

    const git = new ProbeGit();
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.attempt?.attempt, 2, "the registry gap names the attempt");
    assert.equal(cycle.attempt?.observedHeadSha, OBSERVED, "and the evidence signature names its head");
    assert.equal(cycle.attempt?.publication, "not-published", "the artifacts back it: it is settled, not invented");
    assert.equal(cycle.usedRounds, 0);
    assert.equal(cycle.consecutiveFalls, 1);
    assert.match(lines.join("\n"), /repair attempt 2 of Sanmoo\/my-tasks#1 ended without publishing/);
  });

  test("an attempt with no runtime footprint at all is a ghost: the round returns unstarted", async () => {
    // A charge written before the attempt could be refused: no event log, an
    // intact journal with no session of it, no outcome record of its own.
    await writeRepairCycle(dir, cycleWith(pendingAttempt({ publication: "unknown" })));
    const git = new ProbeGit();
    const { repair, lines } = open(git, trackerWithIssue());

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    assert.equal(cycle.usedRounds, 0, "the round returns: the charge is refunded");
    assert.equal(cycle.consecutiveFalls, 0, "and no fall is counted for a worker that never ran");
    assert.equal(cycle.attempt, null, "the ghost attempt is gone");
    assert.deepEqual(git.reads, [], "and nothing is asked of git for a round no worker ever saw");
    assert.match(lines.join("\n"), /never reached the runtime — round returned, no fall/);
  });

  test("the module's other two readings are the git host's, and an unreadable git is not an answer", async () => {
    const git = new ProbeGit();
    const { repair } = open(git, trackerWithIssue());

    assert.deepEqual(await repair.observeRemote(work), { known: true, headSha: OBSERVED });
    assert.deepEqual(await repair.inspectLocalWork(work), git.localWork, "the local work is git's answer");

    git.failRemote = true;
    git.failLocal = true;
    assert.deepEqual(await repair.observeRemote(work), { known: false }, "an unreadable remote is uncertainty");
    assert.equal(await repair.inspectLocalWork(work), null, "an unreadable branch is unknown, never 'nothing there'");
  });

  test("the premise of the round is read through the PR port, never from the launch", async () => {
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await writeRepairCycle(dir, cycleWith(pendingAttempt()));
    const git = new ProbeGit();
    git.remoteHead = "c".repeat(40); // somebody else moved the remote
    const tracker = trackerWithIssue();
    tracker.seedPullRequest({ repo: REPO, number: 5 });
    // A mergeable PR whose required set is KNOWN and clean: the impediment the
    // round was launched for is gone, so the round returns without a fall.
    tracker.setPrRepairFacts({ repo: REPO, prNumber: 5, mergeState: "mergeable", requiredChecks: [] });
    // The Work's own association is what the round reads (the PR it opened).
    tracker.seedPullRequest({ repo: REPO, number: 1, state: "open" });
    tracker.setPrRepairFacts({ repo: REPO, prNumber: 1, mergeState: "mergeable", requiredChecks: [] });
    const { repair, lines } = open(git, tracker);

    await repair.reconcile([target], new Set());

    const cycle = await readRepairCycle(dir);
    // The PR was closed without merge while the round ran: the impediment is
    // gone, so the round returns with no fall counted — the verdict is the
    // premise's, read now (issue 149).
    assert.equal(cycle.usedRounds, 0);
    assert.equal(cycle.consecutiveFalls, 0);
    assert.match(lines.join("\n"), /the impediment it was launched for no longer exists/);
  });
});
