import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFrom, DEFAULT_LABELS } from "../config.js";
import { ensureWorkspace, workDir, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "../layout.js";
import { wireRunDeps } from "../cli.js";
import { runOnce } from "../loop.js";
import { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { localGitWork } from "../git/local.js";
import { cleanupFixture, seedFixtureRemote, type FixtureRemote } from "../git/local-fixtures.js";
import { readOutcomeRecord } from "../state/outcome.js";
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
      ].join("\n"),
      "utf8",
    );
  }

  /** wireRunDeps with the two fake seams and the REAL local git host. */
  function wiredDeps(tracker: FakeTrackerAdapter, runtime: FakeWorkerRuntime) {
    return wireRunDeps(loadConfigFrom(dir), layout, {
      seams: {
        tracker,
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
    // attempt log and the record the worker wrote — absence would be the
    // abrupt-fall class, its presence is the pr-open the ruler collected.
    const work = workDir(layout, REPO, 1);
    assert.ok(existsSync(join(work, "sessao")));
    assert.ok(existsSync(join(work, "log-1.jsonl")));
    const record = await readOutcomeRecord(work);
    assert.deepEqual(record, { class: "pr-open", attempt: 1, pr: { repo: REPO, number: 1, branch: "agent-issue-1" } });

    // The ruler: PR open → reserve (the claim is held, waiting for the human).
    assert.equal(result.collected.length, 1);
    assert.equal(result.collected[0]!.ruling.decision, "reserve");
  });

  test("boot reconciliation after a crash: the reserved work is re-derived from disk + tracker — 1st fall releases and relaunches as attempt 2", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    // The crash footprint (ticket 05 Q3): a claimed work with an attempt
    // log and no record — the factory died on it. NOTHING is in memory:
    // the fresh sweep below is the restarted factory.
    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 1 })}\n`, "utf8");

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    // The derivation ruled the unreconciled fall (release) — and the pool
    // picked the released work back up in the same sweep, numbered from the
    // registry's crash footprint: attempt 2, never a re-run of attempt 1.
    assert.equal(result.launched.length, 1);
    assert.equal(result.launched[0]!.request.attempt, 2);
    const record = await readOutcomeRecord(workDir(layout, REPO, 1));
    assert.ok(record && record.attempt === 2 && record.class === "pr-open");
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.claimed]);
    assert.ok((await tracker.readPrFeedback({ repo: REPO, number: 1 })).known);
  });

  test("boot reconciliation after a crash: the 2nd consecutive fall blocks with the exact outcome on the issue", async () => {
    writeConfig();
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    tracker.seedIssue({ repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    // The crash footprint of TWO attempts: attempt 1 recorded a clean end
    // without a PR (a fall), attempt 2 died abruptly (log, no record).
    const work = workDir(layout, REPO, 1);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 1 })}\n`, "utf8");
    writeFileSync(
      join(work, "desfecho.json"),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }, null, 2),
      "utf8",
    );
    writeFileSync(join(work, "log-2.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 2 })}\n`, "utf8");

    const runtime = new FakeWorkerRuntime({ tracker, outcomes: [] });
    const deps = await wiredDeps(tracker, runtime);
    const result = await runOnce(deps);

    // The valve (ticket 05 Q3): blocked + the exact outcome on the issue,
    // and NOTHING launched — a blocked work listens to the issue channel.
    assert.equal(result.launched.length, 0);
    assert.deepEqual(await labelsOf(tracker, 1), [DEFAULT_LABELS.blocked]);
    const comments = await tracker.readComments({ repo: REPO, number: 1 });
    assert.ok(comments.known && comments.value.some((c) => c.body.includes("attempt 2")));
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
