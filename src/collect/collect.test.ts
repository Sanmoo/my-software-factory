import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
} from "../config.js";
import { githubWork } from "../e2e/work-fixtures.js";
import type { GitWork, LocalWorkFacts, PreparedWork } from "../git/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import type { Launchable } from "../launch/launch.js";
import type { Notification } from "../notify/port.js";
import { PR_ASSOCIATIONS_FILENAME } from "../pool/pr-association.js";
import { workKeyOf } from "../pool/work-key.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { githubRepository, githubTicket, type WorkIdentity } from "../tracker/identity.js";
import type { Labels } from "../config.js";
import type { TicketIdentity } from "../tracker/identity.js";
import type { WriteOutcome } from "../tracker/port.js";
import { PAUSE_FILENAME } from "../work-record/continuity.js";
import { DESFECHO_FILENAME } from "../work-record/outcome.js";
import { RECOVERY_FILENAME, readRecoveryLedger } from "../work-record/recovery.js";
import { openCollect, type CollectedEnd, type Collect, type CollectCycle } from "./collect.js";

/**
 * The collection at its own seam: one ended Attempt
 * collected through {@link Collect}, with FAKE ports and a REAL temporary work
 * dir — no factory, no launch, no container.
 *
 * Two things are observed, and only these: what the tracker was asked to WRITE,
 * in order (the probe below), and what the work dir holds afterwards (the work
 * record, the archive, the pause). What the cycle is asked for (the operational
 * class the verdict announces, whether this factory is stopping, which works it
 * holds) is a recording port, so a test can steer the one process-wide
 * condition and see what the verdict declared.
 *
 * Every verdict of the second reading is proven this way — done, the merge
 * fallback, the rejection, the parked PR and the self-report, the
 * interruption, the model provider retry, the requested-stop resume and both
 * members of the fall ruler.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

/** The git host as a collection sees it: only the done cleanup is its job. */
class FakeGit implements GitWork {
  readonly cleaned: string[] = [];

  async prepareWorkFor(work: WorkIdentity): Promise<PreparedWork> {
    throw new Error(`the collection never prepares a launch (${workKeyOf(work)})`);
  }

  async cleanupDoneWorkFor(work: WorkIdentity): Promise<void> {
    this.cleaned.push(workKeyOf(work));
  }

  async observeRemoteHeadFor(): Promise<string | null> {
    return null;
  }

  async diffWorkFor(): Promise<string> {
    return "";
  }

  async inspectLocalWorkFor(): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

/** The tracker with every WRITE recorded, in order: the proof of ordering, and
 *  of what a verdict did NOT do. */
class ProbeTracker extends FakeTrackerAdapter {
  readonly writes: string[] = [];

  override async markTicketDone(ticket: TicketIdentity): Promise<WriteOutcome> {
    this.writes.push("done");
    return super.markTicketDone(ticket);
  }

  override async commentOnTicket(ticket: TicketIdentity, body: string): Promise<WriteOutcome> {
    this.writes.push("comment");
    return super.commentOnTicket(ticket, body);
  }

  override async blockTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome> {
    this.writes.push("block");
    return super.blockTicketClaim(ticket, labels);
  }

  override async releaseTicketClaim(
    ticket: TicketIdentity,
    account: string,
    readyLabel?: string,
  ): Promise<WriteOutcome> {
    this.writes.push("release");
    return super.releaseTicketClaim(ticket, account, readyLabel);
  }

  override async claimTicket(
    ticket: TicketIdentity,
    account: string,
    readyLabel?: string,
  ): Promise<WriteOutcome> {
    this.writes.push("claim");
    return super.claimTicket(ticket, account, readyLabel);
  }

  override async resumeTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome> {
    this.writes.push("resume");
    return super.resumeTicketClaim(ticket, labels);
  }
}

describe("collect — an attempt's end, and the verdict applied", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let tracker: ProbeTracker;
  let git: FakeGit;
  let log: string[];
  let notices: Notification[];
  /** The classes the verdicts announced, in order (`null` = the work leaves). */
  let announced: Array<{ key: string; resulting: string | null }>;
  /** The works this process holds — what the second reading is opened with. */
  let inFlight: Set<string>;
  let stopping: boolean;
  let collection: Collect;
  let config: Config;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-collect-"));
    layout = ensureWorkspace(join(root, "ws"));
    tracker = new ProbeTracker({ workerAccount: "bot" });
    git = new FakeGit();
    log = [];
    notices = [];
    announced = [];
    inFlight = new Set();
    stopping = false;
    config = {
      workerGhAccount: "bot",
      workerModel: "opencode-go/glm-5.3-flash",
      jira: [],
      repos: [REPO],
      concurrency: 1,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      retro: { ...DEFAULT_RETRO },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      workerAuthFile: null,
      configPath: join(root, "msf.yaml"),
    };
    const cycle: CollectCycle = {
      announce: (work, resulting) => announced.push({ key: workKeyOf(work), resulting }),
      stopping: () => stopping,
      inFlight: () => inFlight,
    };
    collection = openCollect({
      config,
      tickets: tracker,
      pullRequests: tracker,
      git,
      workspace: layout,
      log: (line) => log.push(line),
      notifier: { notify: async (notification) => void notices.push(notification) },
      cycle,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---- the world the tests steer ----

  /** The reservation's dir as it is — never created by an assertion. */
  function dirOf(number: number): string {
    return workDir(layout, REPO, number);
  }

  /** The Work as the caller hands it, with its reservation's dir created. */
  function refOf(number: number): { work: WorkIdentity; dir: string } {
    const dir = dirOf(number);
    mkdirSync(dir, { recursive: true });
    return { work: githubWork(REPO, number), dir };
  }

  /** The launch the engine decided — the collection only consumes it. */
  function launchableOf(number: number, kind: Launchable["kind"] = "claim"): Launchable {
    const { work, dir } = refOf(number);
    return { work, dir, kind, createdAt: NOW, pr: null };
  }

  /** Collect the end of an attempt of `number` and hand back what it decided. */
  async function collect(
    number: number,
    attempt = 1,
    origin: "collected" | "survivor" = "collected",
    kind: Launchable["kind"] = "claim",
  ): Promise<CollectedEnd> {
    const launchable = launchableOf(number, kind);
    return collection.attemptEnd(launchable, { dir: launchable.dir, attempt, origin });
  }

  function writeRecord(number: number, filename: string, value: unknown): void {
    writeFileSync(join(refOf(number).dir, filename), JSON.stringify(value), "utf8");
  }

  /** The attempt's own written outcome — what the ruler reads. */
  function writeOutcome(number: number, attempt: number, outcomeClass: string): void {
    writeRecord(number, DESFECHO_FILENAME, { class: outcomeClass, attempt });
  }

  /** The recovery part of the record: what ended the last attempt. */
  function writeLedger(
    number: number,
    ledger: { lastStop?: unknown; lastFallAttempt?: number | null; consumed?: number },
  ): void {
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

  /** A continuity pause persisted by an earlier attempt of this work. */
  function writePauseFile(number: number, attempt: number): void {
    const { work, dir } = refOf(number);
    writeFileSync(
      join(dir, PAUSE_FILENAME),
      JSON.stringify({ version: 1, work, attempt, reason: "effect-ambiguous", detail: "the effect is unresolved", at: NOW }),
      "utf8",
    );
  }

  async function labelsOf(number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  async function commentsOf(number: number): Promise<string[]> {
    const comments = await tracker.readComments({ repo: REPO, number });
    assert.ok(comments.known);
    return comments.value.map((comment) => comment.body);
  }

  // ---- done: the terminal state, reached while the claim was held ----

  test("done — the issue closed while the attempt ran: the artifacts are archived, nothing is released", async () => {
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, state: "closed", stateReason: "completed" });
    writeAttemptLog(1, 1);

    const end = await collect(1, 1);

    assert.deepEqual(end.ruling, { decision: "done", because: "issue-closed" });
    assert.equal(end.next, null, "a done work needs nothing more");
    assert.equal(end.prConfirmed, false);
    assert.equal(existsSync(dirOf(1)), false, "the work dir left trabalhos/");
    assert.ok(
      readdirSync(join(layout.archive, "Sanmoo")).some((entry) => entry.startsWith("my-tasks#1-")),
      "and landed under arquivo/, dated",
    );
    assert.deepEqual(git.cleaned, [`${REPO}#1`], "the branches were cleaned");
    assert.deepEqual(tracker.writes, [], "no tracker write: nothing is released or recorded");
    assert.deepEqual(announced, [{ key: `${REPO}#1`, resulting: null }], "the work leaves the observed state");
    assert.deepEqual(log, [`collected ${REPO}#1: issue closed — done; artifacts archived, branches cleaned`]);
    assert.deepEqual(notices, []);
  });

  // ---- done-fallback: a merge that did not close the issue ----

  test("done-fallback — a PR merged mid-round: the issue is closed with the fallback comment, then archived", async () => {
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 2, state: "closed", merged: true });
    writeAttemptLog(2, 1);

    const end = await collect(2, 1);

    assert.deepEqual(end.ruling, { decision: "done", because: "pr-merged" });
    assert.equal(end.prConfirmed, false, "a merged PR is closed: the report's PR fact is its own");
    assert.deepEqual(tracker.writes, ["done", "comment"], "the issue is closed, then the comment");
    assert.match((await commentsOf(2))[0]!, /merged/i, "the fallback comment says why the factory closed it");
    const issue = await tracker.readIssue({ repo: REPO, number: 2 });
    assert.ok(issue.known && issue.value.state === "closed");
    assert.equal(existsSync(dirOf(2)), false, "archived after the tracker write");
    assert.deepEqual(git.cleaned, [`${REPO}#2`]);
    assert.deepEqual(announced, [{ key: `${REPO}#2`, resulting: null }]);
    assert.deepEqual(notices, [], "a done notifies nobody");
  });

  // ---- rejected: a PR closed without merge ----

  test("rejected — a PR closed without merge blocks with the PR pointed out and holds the claim", async () => {
    seedIssue(tracker, { repo: REPO, number: 3, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 3, state: "closed", merged: false });
    writeAttemptLog(3, 1);

    const end = await collect(3, 1);

    assert.deepEqual(end.ruling, { decision: "block", because: "pr-closed-unmerged" });
    assert.equal(end.next, null);
    assert.deepEqual(tracker.writes, ["block", "comment"], "blocked, then told why");
    assert.ok((await labelsOf(3)).includes(DEFAULT_LABELS.blocked), "the claim was held as a Block");
    assert.ok(!(await labelsOf(3)).includes(DEFAULT_LABELS.ready), "the work never returns to the pool");
    assert.match((await commentsOf(3))[0]!, /PR #3\b/, "the comment points at the PR");
    assert.equal(
      existsSync(join(dirOf(3), PR_ASSOCIATIONS_FILENAME)),
      true,
      "the PR association is persisted beside the Work",
    );
    assert.equal(
      existsSync(join(dirOf(3), RECOVERY_FILENAME)),
      false,
      "a closed PR is not a written failure: no fall is recorded",
    );
    assert.deepEqual(announced, [{ key: `${REPO}#3`, resulting: "reserved" }]);
    assert.deepEqual(
      notices.map((notice) => notice.kind),
      ["help"],
      "a block IS the occurrence: the help notice goes out once",
    );
  });

  // ---- parked: the human owns the PR ----

  test("parked — an open PR keeps the claim and asks for the review, once", async () => {
    seedIssue(tracker, { repo: REPO, number: 4, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 4, state: "open" });
    writeAttemptLog(4, 1);

    const end = await collect(4, 1);

    assert.deepEqual(end.ruling, { decision: "reserve", because: "pr-open" });
    assert.equal(end.prConfirmed, true, "the PR was confirmed open through the port");
    assert.deepEqual(tracker.writes, [], "nothing is consumed and no fall is recorded");
    assert.ok((await labelsOf(4)).includes(DEFAULT_LABELS.claimed), "the claim is held");
    assert.deepEqual(announced, [{ key: `${REPO}#4`, resulting: "reserved" }]);
    assert.deepEqual(notices.map((notice) => notice.kind), ["review"]);
    assert.deepEqual(log, [`collected ${REPO}#4: PR open — stays reserved, waiting for the human`]);
  });

  test("parked — a survivor's end reviews its open PR too: this process never launched it", async () => {
    seedIssue(tracker, { repo: REPO, number: 5, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 5, state: "open" });

    const end = await collect(5, 1, "survivor", "recover");

    assert.deepEqual(end.ruling, { decision: "reserve", because: "pr-open" });
    assert.deepEqual(notices.map((notice) => notice.kind), ["review"], "the operator hears about it anyway");
    assert.deepEqual(log, [`survivor ${REPO}#5: PR open — stays reserved, waiting for the human`]);
  });

  // ---- parked: the worker reported itself blocked (class 6) ----

  test("self-report — the factory only RECORDS the outcome: nothing is consumed and nobody is asked twice", async () => {
    seedIssue(tracker, { repo: REPO, number: 6, createdAt: NOW, labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });
    writeAttemptLog(6, 1);

    const end = await collect(6, 1);

    assert.deepEqual(end.ruling, { decision: "record-only", because: "blocked-self-report" });
    assert.deepEqual(tracker.writes, [], "nothing is blocked, released or commented");
    assert.ok((await labelsOf(6)).includes(DEFAULT_LABELS.blocked), "the label the worker put there stays");
    assert.deepEqual(announced, [{ key: `${REPO}#6`, resulting: "reserved" }]);
    assert.deepEqual(notices.map((notice) => notice.kind), ["help"]);
    assert.deepEqual(log, [`collected ${REPO}#6: blocked self-report — the factory only records the outcome`]);
  });

  test("help wins over review — a self-report beside an open PR asks for help, and the PR still reserves the work", async () => {
    seedIssue(tracker, { repo: REPO, number: 16, createdAt: NOW, labels: [DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked] });
    tracker.seedPullRequest({ repo: REPO, number: 16, state: "open" });
    writeAttemptLog(16, 1);

    const end = await collect(16, 1);

    assert.deepEqual(end.ruling, { decision: "reserve", because: "pr-open" }, "the state decision is untouched");
    assert.equal(end.prConfirmed, true);
    assert.deepEqual(notices.map((notice) => notice.kind), ["help"], "help outranks the review of the PR");
    assert.deepEqual(tracker.writes, [], "nothing is consumed either way");
  });

  // ---- interrupted: no record, not a failure, the SAME attempt continues ----

  test("interrupted — no outcome record: the same attempt continues, nothing is consumed, the pause survives", async () => {
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(7, 1);
    writePauseFile(7, 1);

    const end = await collect(7, 1);

    assert.deepEqual(end.ruling, { decision: "interrupt", because: "no-outcome" });
    assert.equal(end.next?.kind, "recover", "the recovery of the same attempt");
    assert.equal(end.next?.attempt, 1, "the attempt keeps its number — it is never consumed");
    assert.deepEqual(end.next?.work, githubWork(REPO, 7));
    assert.deepEqual(tracker.writes, [], "an interruption writes nothing on the tracker");
    assert.equal(
      existsSync(join(dirOf(7), RECOVERY_FILENAME)),
      false,
      "the fall ruler never applies: no failure is recorded",
    );
    assert.equal(
      existsSync(join(dirOf(7), PAUSE_FILENAME)),
      true,
      "the pause that keeps the work out of later rounds is NOT cleared by an end that wrote no verdict",
    );
    assert.deepEqual(announced, [{ key: `${REPO}#7`, resulting: "reserved" }]);
    assert.deepEqual(notices, [], "an interruption is absorbed by its budget, never announced");
    assert.deepEqual(log, [
      `collected ${REPO}#7: interrupted (no outcome record) — not a failure; attempt 1 keeps its number ` +
        "and the recovery budget answers it",
    ]);
  });

  // ---- the model provider failure: its own budget, never the fall ruler ----

  test("provider retry — a turn that ended in a provider error retries the SAME attempt on its own budget", async () => {
    seedIssue(tracker, { repo: REPO, number: 8, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(8, 1);
    writeFileSync(
      join(refOf(8).dir, "log-1.jsonl"),
      JSON.stringify({
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
            timestamp: 1_700_000_000_000,
          },
        }),
      }) + "\n",
      "utf8",
    );

    const end = await collect(8, 1);

    assert.deepEqual(end.ruling, { decision: "interrupt", because: "no-outcome" });
    assert.equal(end.next?.kind, "model-provider-retry", "the provider's budget retries, never the recovery one");
    assert.equal(end.next?.attempt, 1, "the SAME attempt");
    assert.deepEqual(tracker.writes, [], "a provider outage is not a tracked fact");
    assert.equal(
      existsSync(join(dirOf(8), RECOVERY_FILENAME)),
      false,
      "no failure is recorded: the provider error is not a fall",
    );
    assert.deepEqual(notices, []);
  });

  // ---- the operator's requested stop (ADR 0008) ----

  test("stop resume — the recorded stop owns the end: the same attempt resumes spending no recovery", async () => {
    seedIssue(tracker, { repo: REPO, number: 9, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(9, 1);
    writeLedger(9, { lastStop: { kind: "stop-requested", attempt: 1, at: NOW } });

    const end = await collect(9, 1);

    assert.deepEqual(end.ruling, { decision: "interrupt", because: "no-outcome" });
    assert.equal(end.next?.kind, "recover");
    assert.equal(end.next?.attempt, 1);
    assert.equal(end.next?.requestedStop, true, "the stop is spent by the launch that resumes it, not here");
    assert.deepEqual(tracker.writes, []);
    const ledger = await readRecoveryLedger(dirOf(9));
    assert.equal(
      ledger.lastStop?.kind,
      "stop-requested",
      "the evidence survives the collection: only the launch that resumes it consumes the stop",
    );
    assert.match(log[0]!, /the operator's requested stop owns that end — it resumes now, spending no recovery/);
  });

  test("stop resume — a stop this process is carrying out relaunches nothing: the next run resumes", async () => {
    seedIssue(tracker, { repo: REPO, number: 10, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(10, 1);
    stopping = true;

    const end = await collect(10, 1);

    assert.deepEqual(end.ruling, { decision: "interrupt", because: "no-outcome" });
    assert.equal(end.next, null, "the factory is winding down: it launches nothing of its own");
    assert.deepEqual(tracker.writes, []);
    assert.deepEqual(log, [
      `collected ${REPO}#10: attempt 1 ended without an outcome record while the factory stops — ` +
        "no recovery is spent and the next run resumes the same attempt",
    ]);
  });

  // ---- the fall ruler: the 1st releases, the 2nd blocks ----

  test("fall, first — the claim goes back to the pool and the written failure is persisted", async () => {
    seedIssue(tracker, { repo: REPO, number: 11, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(11, 1);
    writeOutcome(11, 1, "clean-without-pr");
    writePauseFile(11, 1);

    const end = await collect(11, 1);

    assert.deepEqual(end.ruling, { decision: "release", because: "fall-first" });
    assert.equal(end.next, null, "a released work re-enters the pool; it is not relaunched from here");
    assert.deepEqual(tracker.writes, ["release"], "one write pair: claimed→ready back");
    assert.ok((await labelsOf(11)).includes(DEFAULT_LABELS.ready), "the work re-enters the pool");
    assert.ok(!(await labelsOf(11)).includes(DEFAULT_LABELS.claimed), "the claim is released");
    const ledger = await readRecoveryLedger(dirOf(11));
    assert.equal(ledger.lastStop?.kind, "failure", "the written failure is the last stop of the record");
    assert.equal(ledger.lastFallAttempt, 1, "and it is the fall the 2nd one will be consecutive to");
    assert.equal(
      existsSync(join(dirOf(11), `${PAUSE_FILENAME}.resolved`)),
      true,
      "a settled attempt makes its old pause history",
    );
    // The released fall lands ELIGIBLE, not the class its state declares: the
    // action says so, where it acts (ADR-0010).
    assert.deepEqual(announced, [{ key: `${REPO}#11`, resulting: "eligible" }]);
    assert.deepEqual(notices, [], "a release with no PR asks nothing of the operator");
  });

  test("fall, second — the work is blocked with the attempt's diagnosis, and help is asked once", async () => {
    seedIssue(tracker, { repo: REPO, number: 12, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(12, 2);
    writeOutcome(12, 2, "clean-without-pr");
    writeLedger(12, {
      lastStop: { kind: "failure", attempt: 1, at: NOW, outcome: "clean-without-pr" },
      lastFallAttempt: 1,
    });

    const end = await collect(12, 2);

    assert.deepEqual(end.ruling, { decision: "block", because: "fall-second" });
    assert.equal(end.next, null);
    assert.deepEqual(tracker.writes, ["block", "comment"], "the block, then the diagnosis");
    assert.ok((await labelsOf(12)).includes(DEFAULT_LABELS.blocked));
    assert.ok(!(await labelsOf(12)).includes(DEFAULT_LABELS.claimed), "the claimed label swapped away");
    assert.match((await commentsOf(12))[0]!, /attempt 2/);
    assert.match((await commentsOf(12))[0]!, /clean-without-pr/, "the human must SEE why it fell");
    assert.deepEqual(announced, [{ key: `${REPO}#12`, resulting: "reserved" }]);
    assert.deepEqual(notices.map((notice) => notice.kind), ["help"], "a block is the occurrence, once");
  });

  // ---- a repair round: settled by its own reconciliation, never relaunched here ----

  test("a repair attempt that wrote no record is left to its reconciliation ", async () => {
    seedIssue(tracker, { repo: REPO, number: 13, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    writeAttemptLog(13, 1);

    const end = await collect(13, 1, "collected", "repair");

    assert.equal(end.next, null, "the repair reconciliation settles the publication before another round");
    assert.match(log[0]!, /the repair attempt wrote no outcome record/);
    assert.deepEqual(tracker.writes, []);
  });

  // ---- the writes that stay the caller's, and the failures that must not be swallowed ----

  test("a failing tracker write is never swallowed: the caller owns the slot and the failure", async () => {
    seedIssue(tracker, { repo: REPO, number: 14, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 14, state: "closed", merged: false });
    tracker.failAt.add("block:label");

    await assert.rejects(collect(14, 1), "the failure reaches the caller");
    assert.deepEqual(announced, [], "a verdict that failed to apply announces nothing");
    assert.deepEqual(notices, [], "and asks nothing of the operator");
  });

  test("a PR association that cannot be persisted is logged and never sinks the verdict", async () => {
    seedIssue(tracker, { repo: REPO, number: 15, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 15, state: "closed", merged: false });
    const dir = refOf(15).dir;
    // A Work whose DESTINATION is another repository: the PR the ticket's read
    // found belongs to Sanmoo/my-tasks, so the association cannot be persisted
    // beside this Work. That write is best-effort; the Block is not.
    const work: WorkIdentity = {
      ticket: githubTicket(REPO, 15),
      destination: githubRepository("Sanmoo/elsewhere"),
    };

    const end = await collection.attemptEnd(
      { work, dir, kind: "claim", createdAt: NOW, pr: null },
      { dir, attempt: 1, origin: "collected" },
    );

    assert.deepEqual(end.ruling, { decision: "block", because: "pr-closed-unmerged" });
    assert.ok(
      log.some((line) => line.includes("PR association of Sanmoo/elsewhere#15 was not persisted")),
      "the failure is said out loud and the verdict stands",
    );
    assert.deepEqual(tracker.writes, ["block", "comment"], "the Block was applied anyway");
  });
});
