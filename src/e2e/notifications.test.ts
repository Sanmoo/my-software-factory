import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { runForever, runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "../runtime/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";

/**
 * End-to-end of issue 93: local desktop notices when a NEW occurrence needs
 * human continuity — always through the public sweep (runOnce / runForever)
 * with the existing fake tracker + runtime, a real temp workspace and the one
 * extra replaceable seam: a recording notifier. No desktop, no network.
 *
 * The notice is a structured fact (work, reason, address) — never agent
 * prose. Review points at the PR; help/block points at the issue where the
 * continuity context lives. Help wins over review when a session both leaves
 * a PR open and asks for help, without changing the ruler's state decision.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const TICK_MS = 5;

class FakeGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.split("/").join("#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }
}

/** A worker that opens the PR AND posts the structured help request (blocked label + marker). */
class PrAndHelpRuntime implements WorkerRuntime {
  private readonly inner: FakeWorkerRuntime;

  constructor(private readonly tracker: FakeTrackerAdapter) {
    this.inner = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    const result = await this.inner.launch(request);
    await this.tracker.blockClaim(request.ref, { ...DEFAULT_LABELS });
    await this.tracker.comment(request.ref, "help: the API contract needs a human decision");
    return result;
  }
}

describe("e2e: local notices for occurrences that need the human (issue 93)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-notify-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number, notifications = true): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      notifications,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(config: Config, outcomes: ScriptedOutcome[]) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new FakeGitWork();
    const notifier = new FakeNotifier();
    const log: string[] = [];
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git,
      workspace: layout,
      notifier,
      log: (message) => log.push(message),
    };
    return { tracker, runtime, git, notifier, log, deps };
  }

  function makeDeps(
    config: Config,
    tracker: FakeTrackerAdapter,
    runtime: WorkerRuntime,
    notifier: FakeNotifier,
    log: string[] = [],
  ): LoopDeps {
    return {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      notifier,
      log: (message) => log.push(message),
    };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known);
    return issue.value.labels;
  }

  const issueAddress = (number: number): string => `https://github.com/${REPO}/issues/${number}`;
  const prAddress = (number: number): string => `https://github.com/${REPO}/pull/${number}`;

  async function waitUntil(what: string, condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  // ---- review: the initial execution and every later feedback round ----

  test("the initial execution that leaves the PR open sends exactly one review notice with the PR address", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, {
      repo: REPO,
      number: 1,
      body: "TOP-SECRET free agent prose that must never ride the notice",
      createdAt: NOW,
      labels: [DEFAULT_LABELS.ready],
    });

    await runOnce(deps);

    assert.equal(notifier.notifications.length, 1);
    const [notice] = notifier.notifications;
    assert.ok(notice);
    assert.deepEqual(notice, {
      ref: { repo: REPO, number: 1 },
      kind: "review",
      url: prAddress(1),
    });
    assert.ok(
      !JSON.stringify(notice).includes("TOP-SECRET"),
      "the agent's free text never leaks into the notice",
    );
  });

  test("a feedback round with the PR still open is a NEW occurrence — one more review notice; repeated sweeps stay silent", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open", "pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    assert.equal(notifier.notifications.length, 1, "the initial execution notified");

    tracker.addPrComment({ repo: REPO, prNumber: 1 }, "humano", "please rename it");
    await runOnce(deps);
    assert.equal(notifier.notifications.length, 2, "the feedback round is a new occurrence");
    assert.equal(notifier.notifications[1]?.kind, "review");
    assert.equal(notifier.notifications[1]?.url, prAddress(1), "the SAME PR");

    // Nothing new: the ball is with the human — no reminders.
    await runOnce(deps);
    await runOnce(deps);
    assert.equal(notifier.notifications.length, 2, "waiting human action is silent");
  });

  // ---- help: self-report, second fall, rejection, recovery blocks ----

  test("a blocked self-report sends one help notice pointing at the issue", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["blocked-self-report"]);
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const result = await runOnce(deps);

    assert.equal(result.collected[0]?.ruling.decision, "record-only");
    assert.equal(notifier.notifications.length, 1);
    assert.deepEqual(notifier.notifications[0], {
      ref: { repo: REPO, number: 2 },
      kind: "help",
      url: issueAddress(2),
    });
  });

  test("the first fall retries silently; the second consecutive clean fall asks for help", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["clean-without-pr", "clean-without-pr"]);
    seedIssue(tracker, { repo: REPO, number: 3, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling.decision, "release");
    assert.equal(notifier.notifications.length, 0, "an automatic retry is not an operator action yet");

    const second = await runOnce(deps);
    assert.equal(second.collected[0]?.ruling.decision, "block");
    assert.equal(notifier.notifications.length, 1);
    assert.equal(notifier.notifications[0]?.kind, "help");
    assert.equal(notifier.notifications[0]?.url, issueAddress(3));
    assert.ok((await labelsOf(tracker, 3)).includes(DEFAULT_LABELS.blocked));
  });

  test("two abrupt deaths follow the same ruler: the second one asks for help", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["abrupt-death", "abrupt-death"]);
    seedIssue(tracker, { repo: REPO, number: 4, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    assert.equal(notifier.notifications.length, 0, "the first abrupt fall is released for a retry");

    const second = await runOnce(deps);
    assert.equal(second.collected[0]?.ruling.decision, "block");
    assert.equal(notifier.notifications.length, 1);
    assert.equal(notifier.notifications[0]?.kind, "help");
    assert.equal(notifier.notifications[0]?.url, issueAddress(4));
  });

  test("a stale blocked-self-report record from a previous attempt does not re-notify on a recordless resume", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["blocked-self-report", "abrupt-death"]);
    seedIssue(tracker, { repo: REPO, number: 17, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Attempt 1 writes the blocked-self-report record — one help notice.
    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling.decision, "record-only");
    assert.equal(notifier.notifications.length, 1);

    // The worker also posted the blocked label; the human answers after the
    // marker, so the next sweep resumes on the same branch.
    await tracker.blockClaim({ repo: REPO, number: 17 }, { ...DEFAULT_LABELS });
    tracker.addComment({ repo: REPO, number: 17 }, "humano", "try again");

    // Attempt 2 dies abruptly (no new record). desfecho.json still holds the
    // attempt-1 self-report; it must not be read as a help request NOW —
    // a first fall after a resume is scheduled for automatic retry (silent).
    const resumed = await runOnce(deps);
    assert.equal(resumed.launched.length, 1, "the resume ran");
    assert.equal(notifier.notifications.length, 1, "the stale record does not re-notify help");
  });

  test("a PR closed without merge blocks the factory's work and sends one help notice — never a repeat", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 5, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    assert.equal(notifier.notifications.length, 1, "the initial review notice");

    tracker.closePr({ repo: REPO, prNumber: 1 }, { merged: false });
    await runOnce(deps);
    assert.equal(notifier.notifications.length, 2, "the rejection is a new occurrence");
    assert.equal(notifier.notifications[1]?.kind, "help");
    assert.equal(notifier.notifications[1]?.url, issueAddress(5));

    await runOnce(deps);
    assert.equal(notifier.notifications.length, 2, "the handled rejection is not re-presented");
  });

  test("a restart that APPLIES a new block during recovery notifies — an unreconciled 2nd fall is not invisible", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 6, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    // The crash footprint: attempt 1 recorded a clean fall, attempt 2 died
    // abruptly (log, no record) — the restart sees a 2nd consecutive fall.
    const work = workDir(layout, REPO, 6);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 1 })}\n`, "utf8");
    writeFileSync(
      join(work, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }, null, 2),
      "utf8",
    );
    writeFileSync(join(work, "log-2.jsonl"), `${JSON.stringify({ event: "session-start", attempt: 2 })}\n`, "utf8");

    const notifier = new FakeNotifier();
    const deps = makeDeps(config, tracker, new FakeWorkerRuntime({ tracker, outcomes: [] }), notifier);
    const result = await runOnce(deps);

    assert.equal(result.launched.length, 0, "a blocked work launches nothing");
    assert.ok((await labelsOf(tracker, 6)).includes(DEFAULT_LABELS.blocked));
    assert.equal(notifier.notifications.length, 1);
    assert.deepEqual(notifier.notifications[0], {
      ref: { repo: REPO, number: 6 },
      kind: "help",
      url: issueAddress(6),
    });
  });

  // ---- concurrent facts: PR open + help in the same session ----

  test("PR open AND a help request in the same session: exactly one help notice, the state keeps the PR precedence", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const notifier = new FakeNotifier();
    const runtime = new PrAndHelpRuntime(tracker);
    const deps = makeDeps(config, tracker, runtime, notifier);

    const result = await runOnce(deps);

    // The ruler's state decision is unchanged: the open PR reserves the work.
    assert.equal(result.collected[0]?.ruling.decision, "reserve");
    assert.equal(result.collected[0]?.prConfirmed, true);
    // But the message is help, pointing at the issue — a block is not a mere review.
    assert.equal(notifier.notifications.length, 1, "one notice, never two for the same occurrence");
    assert.equal(notifier.notifications[0]?.kind, "help");
    assert.equal(notifier.notifications[0]?.url, issueAddress(7));
  });

  // ---- intentional silence ----

  test("a retomada the human initiated does not re-notify a review — only initial execution / feedback do", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, [
      "clean-without-pr",
      "clean-without-pr",
      "pr-open",
    ]);
    seedIssue(tracker, { repo: REPO, number: 16, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps); // 1st fall — retried silently
    await runOnce(deps); // 2nd consecutive fall — blocked, help notice
    assert.equal(notifier.notifications.length, 1);
    assert.equal(notifier.notifications[0]?.kind, "help");

    // The human answers the issue; the retomada reopens the flow and leaves
    // the PR open. The operator already initiated it: no extra review notice.
    tracker.addComment({ repo: REPO, number: 16 }, "humano", "go ahead and open the PR");
    const resumed = await runOnce(deps);

    assert.equal(resumed.collected[0]?.ruling.decision, "reserve", "the PR reserves the work");
    assert.equal(notifier.notifications.length, 1, "a retomada is not a new review trigger");
  });

  test("done/archiving is silent — completion without pending action is not a call", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 8, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    assert.equal(notifier.notifications.length, 1);

    tracker.closeIssue({ repo: REPO, number: 8 }, "completed");
    await runOnce(deps);

    assert.equal(notifier.notifications.length, 1, "a concluded work does not notify");
    assert.ok(!existsSync(workDir(layout, REPO, 8)), "the work was archived");
  });

  test("an empty sweep is silent", async () => {
    const config = makeConfig(2);
    const { notifier, deps } = makeFactory(config, ["pr-open"]);

    const result = await runOnce(deps);

    assert.equal(result.pool.length, 0);
    assert.equal(notifier.notifications.length, 0);
  });

  test("a pre-existing PR is not a new trigger — the factory launches nothing and stays silent", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 9, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    tracker.seedPullRequest({ repo: REPO, number: 9, state: "open", labels: [DEFAULT_LABELS.ready] });

    const result = await runOnce(deps);

    assert.equal(result.launched.length, 0);
    assert.equal(notifier.notifications.length, 0);
  });

  test("a pre-existing block is not re-presented on restart", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 10, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });
    mkdirSync(workDir(layout, REPO, 10), { recursive: true });

    await runOnce(deps);

    assert.equal(notifier.notifications.length, 0);
  });

  // ---- concurrency ----

  test("parallel works get individual notices, each identified by its own repository and issue", async () => {
    const config = makeConfig(2);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 11, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 12, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);

    assert.equal(notifier.notifications.length, 2, "one notice per work — never an aggregate");
    const byRef = new Map(notifier.notifications.map((notice) => [`${notice.ref.repo}#${notice.ref.number}`, notice]));
    assert.equal(byRef.size, 2);
    const first = byRef.get(`${REPO}#11`);
    const second = byRef.get(`${REPO}#12`);
    assert.ok(first && second);
    assert.equal(first.kind, "review");
    assert.equal(second.kind, "review");
    assert.notEqual(first.url, second.url, "each points at its own PR");
  });

  // ---- configuration + delivery failures ----

  test("notifications: false runs the factory silently, and the work's outcome is untouched", async () => {
    const config = makeConfig(1, false);
    const { tracker, notifier, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 13, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const result = await runOnce(deps);

    assert.equal(notifier.notifications.length, 0);
    assert.equal(result.collected[0]?.ruling.decision, "reserve", "the state decision is unchanged");
    assert.ok((await labelsOf(tracker, 13)).includes(DEFAULT_LABELS.claimed));
  });

  test("a delivery failure warns on the terminal and never changes the outcome or fails the sweep", async () => {
    const config = makeConfig(1);
    const { tracker, notifier, log, deps } = makeFactory(config, ["pr-open"]);
    notifier.failWith = new Error("notify-send: no graphical session");
    seedIssue(tracker, { repo: REPO, number: 14, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const result = await runOnce(deps);

    assert.equal(notifier.notifications.length, 0, "nothing was delivered");
    assert.equal(result.collected[0]?.ruling.decision, "reserve", "the outcome is preserved");
    assert.ok((await labelsOf(tracker, 14)).includes(DEFAULT_LABELS.claimed));
    assert.ok(
      log.some((line) => line.includes("local notification failed") && line.includes("Sanmoo/my-tasks#14")),
      `the terminal reports the unavailable delivery; log: ${log.join(" | ")}`,
    );
  });

  // ---- continuous mode parity ----

  test("continuous mode applies the same policy: the initial PR and the later feedback round both notify", async () => {
    const config = makeConfig(1);
    const { tracker, runtime, notifier, deps } = makeFactory(config, ["pr-open", "pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 15, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: TICK_MS, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitUntil("the initial review notice", () => notifier.notifications.length === 1);
      assert.equal(notifier.notifications[0]?.kind, "review");

      tracker.addPrComment({ repo: REPO, prNumber: 1 }, "humano", "please adjust");
      await waitUntil("the feedback round notice", () => notifier.notifications.length === 2);
      assert.equal(runtime.launched.length, 2, "the feedback round ran");
      assert.equal(notifier.notifications[1]?.kind, "review");
      assert.equal(notifier.notifications[1]?.url, notifier.notifications[0]?.url, "same PR, new occurrence");
    } finally {
      controller.abort();
      await running;
    }
  });

  // ---- status has no notification effects ----

  test("msf status is a read-only query: it never invokes the desktop notifier", () => {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${join(dir, "ws")}`,
      ].join("\n"),
      "utf8",
    );
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(gh, '#!/bin/sh\ncat >/dev/null\n[ "$1 $2 $3" = "auth token --user" ] && echo fake-token\n', "utf8");
    chmodSync(gh, 0o755);
    const marker = join(dir, "notified");
    const notifySend = join(bin, "notify-send");
    writeFileSync(notifySend, `#!/bin/sh\ntouch "${marker}"\n`, "utf8");
    chmodSync(notifySend, 0o755);

    const cli = new URL("../cli.js", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "status"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(!existsSync(marker), "status must not deliver any notification");
  });
});
