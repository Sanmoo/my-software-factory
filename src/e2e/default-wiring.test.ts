import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFrom, DEFAULT_LABELS } from "../config.js";
import { ensureWorkspace, workDir, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "../layout.js";
import { wireRunDeps } from "../cli.js";
import { runOnce } from "../loop.js";
import { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { seedSession } from "./session-fixtures.js";
import { localGitWork } from "../git/local.js";
import { cleanupFixture, seedFixtureRemote, type FixtureRemote } from "../git/local-fixtures.js";
import { readOutcomeRecord } from "../work-record/outcome.js";
import { RESERVATION_FILENAME, readReservation } from "../pool/reservation.js";
import { PR_ASSOCIATIONS_FILENAME, activePullRequest, readPrAssociations } from "../pool/pr-association.js";
import { FakeNotifier } from "../notify/fake-notifier.js";

/**
 * End-to-end of ticket 18: the full pipeline through the REAL cli wiring
 * path — config file → boot (wireRunDeps) → derive → claim → launch →
 * collect → ruler — over the two fake seams (the in-memory tracker adapter
 * and the scripted runtime, injected ONLY through wireRunDeps' test seams,
 * never through the binary), the REAL local git host against a local bare
 * fixture, a real temp workspace. No network, no container, no GitHub.
 *
 * Also proven here: boot reconciliation (ticket 21/14) — a fresh sweep
 * after a "restart" re-derives every reserved work from disk + tracker
 * alone, with no in-memory state; and the keyring boot check of the
 * default (real) wiring.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

describe("e2e: msf run through the real cli wiring (ticket 18)", () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let fixture: FixtureRemote;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-wiring-"));
    layout = ensureWorkspace(join(dir, "ws"));
    fixture = await seedFixtureRemote(dir, REPO, { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(dir);
    rmSync(join(dir, "ws"), { recursive: true, force: true });
    rmSync(join(dir, "msf.yaml"), { force: true });
  });

  /** The config comes from a REAL msf.yaml file — the config seam of the wiring. */
  function writeConfig(): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos:",
        `  - ${REPO}`,
        "concurrency: 1",
        `workspace: ${join(dir, "ws")}`,
        // The configured backoff, made instant for the suite: the schedule
        // itself is asserted where the recovery is exercised.
        "recovery:",
        "  waits-ms: [0, 0, 0]",
      ].join("\n"),
      "utf8",
    );
  }

  /** wireRunDeps with the two fake seams and the REAL local git host. */
  function wiredDeps(tracker: FakeTrackerAdapter, runtime: FakeWorkerRuntime) {
    return wireRunDeps(loadConfigFrom(dir), layout, {
      seams: {
        tickets: tracker,
        pullRequests: tracker,
        runtime,
        // The REAL git host code, offline: the clone URL points at the
        // local bare fixture — the same class the live run exercises.
        git: localGitWork({ reposDir: layout.repos, remoteUrl: () => fixture.barePath(REPO) }),
        notifier: new FakeNotifier(),
      },
    });
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  test("the full sweep: config → boot → claim → launch → collect → ruler, artifacts on real disk", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, title: "Add a greeting", body: "do it", createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });

    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    // The worker launched ONCE, on the work branch born from the clone's default.
    assert.equal(result.launched.length, 1);
    assert.equal(result.launched[0]!.outcome, "pr-open");
    assert.equal(result.launched[0]!.request.branch, "agent-issue-1");
    assert.equal(result.launched[0]!.request.attempt, 1);
    assert.ok(existsSync(join(layout.repos, "Sanmoo#my-tasks", ".git")), "the real git host cloned the target repo");

    // The reservation landed on the tracker BEFORE the launch and holds.
    assert.deepEqual(tracker.claimedOrder, [`${REPO}#1`]);
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);

    // The PR is open on the tracker, head = the work branch.
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(feedback.known && feedback.value.pr !== null && feedback.value.pr.state === "open");
    assert.equal(feedback.value.pr.headBranch, "agent-issue-1");

    // The artifact contract on REAL disk (ticket 13): the session dir, the
    // attempt log and the record the worker wrote — its absence would be an
    // interruption, its presence is the pr-open the ruler collected.
    const work = workDir(layout, REPO, 1);
    assert.ok(existsSync(join(work, "sessao")));
    assert.ok(existsSync(join(work, "log-1.jsonl")));
    const record = await readOutcomeRecord(work);
    assert.deepEqual(record, { class: "pr-open", attempt: 1, pr: { repo: REPO, number: 1, branch: "agent-issue-1" } });

    // The launch persists the Work's own facts and the PR association on the
    // same real path (issue 125): a restart reads them instead of the config.
    const reservation = readReservation(work);
    assert.equal(reservation.state, "persisted");
    if (reservation.state === "persisted") {
      assert.equal(reservation.record.ticket.provider, "github");
      assert.equal(reservation.record.ticket.stableId, "1");
      assert.equal(reservation.record.destination.repo, REPO);
      assert.equal(reservation.record.presentation.title, "Add a greeting");
    }
    const associations = readPrAssociations(work);
    assert.equal(associations.state, "persisted");
    assert.equal(associations.state === "persisted" ? activePullRequest(associations.record)?.number : null, 1);

    // The ruler: PR open → reserve (the claim is held, waiting for the human).
    assert.equal(result.collected.length, 1);
    assert.equal(result.collected[0]!.ruling.decision, "reserve");
  });

  test("a corrupt reservation record never blocks the claim and is never overwritten", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, title: "Add a greeting", createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });

    // A partial/old write on real disk: unreadable, surfaced by the registry,
    // never mistaken for absent and never replaced by the launch.
    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, RESERVATION_FILENAME), "{ truncated", "utf8");

    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    assert.equal(result.launched.length, 1, "the unknown record does not block the work");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);
    assert.equal(readFileSync(join(work, RESERVATION_FILENAME), "utf8"), "{ truncated", "the evidence stays for a human");
    const reservation = readReservation(work);
    assert.equal(reservation.state, "unreadable");
  });

  test("a corrupt PR association never aborts the collection's ruling", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, title: "Add a greeting", createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });

    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, PR_ASSOCIATIONS_FILENAME), "{ truncated", "utf8");

    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    // The PR opened and the ruler decided; the unreadable record is reported
    // but neither hides the PR nor skips the transition.
    assert.equal(result.collected.length, 1);
    assert.equal(result.collected[0]!.ruling.decision, "reserve");
    assert.equal(result.collected[0]!.prConfirmed, true);
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed], "the claim is held");
    assert.equal(readFileSync(join(work, PR_ASSOCIATIONS_FILENAME), "utf8"), "{ truncated");
  });

  test("boot reconciliation after a crash: the interruption recovers the SAME attempt — no attempt consumed, no fall", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    // The crash footprint (issue 123): a claimed work with an attempt log and
    // no record — the factory died on it. NOTHING is in memory: the fresh
    // sweep below is the restarted factory.
    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 1 })}\n`, "utf8");
    seedSession(work, { repo: REPO, number: 1 }, 1);

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    // The derivation read the crash as an INTERRUPTION and recovered the same
    // attempt (issue 123): the record that lands is attempt 1's, never a new
    // attempt number, and the work never left the claim.
    assert.equal(result.launched.length, 1);
    assert.equal(result.launched[0]!.request.attempt, 1, "the interrupted attempt keeps its number");
    const record = await readOutcomeRecord(workDir(layout, REPO, 1));
    assert.ok(record && record.attempt === 1 && record.class === "pr-open");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);
    assert.ok((await tracker.readPrFeedback({ repo: REPO, number: 1 })).known);
  });

  test("boot reconciliation after a crash: two interruptions do not block — the last attempt is recovered", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    // Two sessions started and died without a record: the old ruler blocked on
    // the 2nd consecutive drop; the interruption rule never does (issue 123).
    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 1 })}\n`, "utf8");
    writeFileSync(join(work, "log-2.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 2 })}\n`, "utf8");
    seedSession(work, { repo: REPO, number: 1 }, 1);
    seedSession(work, { repo: REPO, number: 1 }, 2);

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    assert.equal(result.launched.length, 1, "the interrupted attempt was recovered");
    assert.equal(result.launched[0]!.request.attempt, 2, "the last interrupted attempt keeps its number");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed], "the work is never blocked by an interruption");
  });

  test("boot reconciliation after a crash: the exhausted recovery budget pauses the work and asks for help", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-3.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 3 })}\n`, "utf8");
    writeFileSync(
      join(work, "recuperacao.json"),
      JSON.stringify({ attempt: 3, consumed: 3, events: [], lastStop: null }, null, 2),
      "utf8",
    );

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: [] });
    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    assert.equal(result.launched.length, 0, "no blind relaunch after the budget ran out");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.blocked]);
    const comments = await tracker.readComments({ repo: REPO, number: 1 });
    assert.ok(comments.known);
    const body = comments.value.at(-1)!.body;
    assert.match(body, /attempt 3 was interrupted and the recovery budget is exhausted/);
    assert.match(body, /3 automatic recoveries \(waits 0s\/0s\/0s\)/, "the configured value and backoff are named");
    assert.match(body, /no attempt was consumed/);
    assert.match(body, /log-3\.jsonl — present/);
  });

  test("boot reconciliation with a PR waiting for the human: a restart launches nothing and holds the claim", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps = await wiredDeps(tracker, runtime);

    await runOnce(deps); // the first sweep: claim, launch, PR open
    assert.equal(runtime.launched.length, 1);

    // The restart: a fresh derivation from disk + tracker alone. The PR is
    // open with the worker as the last voice — idle, parked, claim held.
    await runOnce(deps);
    assert.equal(runtime.launched.length, 1, "no relaunch while the ball is with the human");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);
  });

  test("boot reconciliation of a feedback round across a restart: same branch, same PR, worker closes the round", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps = await wiredDeps(tracker, runtime);

    await runOnce(deps); // first sweep opens the PR (attempt 1)

    // The human speaks on the PR — the restart must see it and run the
    // feedback round from disk + tracker alone.
    tracker.addPrComment({ repo: REPO, prNumber: 1 }, "samuel", "please rename the greeting");
    await runOnce(deps); // the restarted sweep

    // The SAME PR (never a new one), attempt 2, and the round was closed by
    // the worker's comment (the norma — the ball goes back to the human).
    assert.equal(runtime.launched.length, 2);
    assert.equal(runtime.launched[1]!.attempt, 2);
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(feedback.known && feedback.value.pr !== null && feedback.value.pr.number === 1);
    assert.ok(
      feedback.value.comments.some(
        (c) => c.author === "bot-do-samuca" && c.body.includes("addressed the feedback"),
      ),
    );
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);
  });

  test("a half-injected seam pair is refused — never a silent boot of the real adapter for the other half", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const half = /the ticket and PR seams must be supplied together/;
    // Either half alone would reach the real adapter (keyring + network) for
    // the missing side while the test believes it controls both.
    await assert.rejects(
      () => wireRunDeps(loadConfigFrom(dir), layout, { seams: { tickets: tracker } }),
      (error: unknown) => error instanceof Error && half.test(error.message),
    );
    await assert.rejects(
      () => wireRunDeps(loadConfigFrom(dir), layout, { seams: { pullRequests: tracker } }),
      (error: unknown) => error instanceof Error && half.test(error.message),
    );
  });

  test("the default wiring (no seams) demands the keyring credential at boot — clear failure, offline", async () => {
    writeConfig();
    // A config naming an account the machine's gh keyring has no token for:
    // the boot check of ticket 16, reached through the DEFAULT wiring —
    // proving the default path is the real GitHub adapter, not the fake.
    const config = loadConfigFrom(dir);
    const withAbsentAccount = { ...config, workerGhAccount: "msf-no-such-account" };
    await assert.rejects(
      () => wireRunDeps(withAbsentAccount, layout),
      (error: unknown) =>
        error instanceof Error && error.message.includes('no GitHub token in the gh keyring for account "msf-no-such-account"'),
    );
    // The failure is a factory-level refusal: the workspace subpaths were
    // created (ensureWorkspace), but no clone, no work dir, no launch.
    assert.ok(existsSync(join(layout.root, WORKSPACE_SUBPATHS.repos)));
    assert.ok(!existsSync(join(layout.repos, "Sanmoo#my-tasks")));
  });
});
