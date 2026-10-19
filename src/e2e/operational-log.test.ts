import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, SweepEngine, type LoopDeps } from "../loop.js";
import { workKey } from "../state/derive.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";

/**
 * Observed through the loop's log callback and the built CLI; `status` and the
 * workers' JSONL are separate contracts and stay untouched.
 */

const REPO = "Sanmoo/a";
const OTHER_REPO = "Sanmoo/b";
const NOW = "2026-01-01T00:00:00Z";
const STAMP = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] /;

/** The instant of an operational record; also asserts the UTC-with-Z shape. */
function instantOf(line: string): number {
  const match = STAMP.exec(line);
  assert.ok(match, `operational record must start with a UTC timestamp: ${line}`);
  return Date.parse(match[1]!);
}

function summaries(log: readonly string[]): string[] {
  return log.filter((line) => line.includes("derived pool:"));
}

async function waitUntil(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class FakeGitWork implements GitWork {
  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
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

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }
}

/** Counts the neutral open-issues listings, proving the factory keeps querying during silence. */
class CountingTracker extends FakeTrackerAdapter {
  listCalls = 0;

  override async listOpenIssues(repo: string) {
    this.listCalls += 1;
    return super.listOpenIssues(repo);
  }
}

describe("e2e: the operational log — initial state, change-only summaries, UTC stamps (issue 91)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-log-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(repos: string[] = [REPO]): Config {
    return {
      workerGhAccount: "bot",
      workerModel: "opencode-go/glm-5.3-flash",
      repos,
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(tracker: FakeTrackerAdapter, config: Config = makeConfig()) {
    const logs: string[] = [];
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    const deps: LoopDeps = {
      config,
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      log: (line) => logs.push(line),
    };
    return { tracker, runtime, deps, logs };
  }

  /** Parked reserved work in the registry: a claim with an open PR, worker last. */
  function seedParkedClaimed(tracker: FakeTrackerAdapter, ref: IssueRef): void {
    seedIssue(tracker, {
      repo: ref.repo,
      number: ref.number,
      createdAt: NOW,
      labels: [DEFAULT_LABELS.claimed],
    });
    tracker.seedPullRequest({ repo: ref.repo, number: ref.number });
    mkdirSync(workDir(layout, ref.repo, ref.number), { recursive: true });
  }

  /** Parked reserved work waiting on the issue channel: blocked, no answer yet. */
  function seedParkedBlocked(tracker: FakeTrackerAdapter, ref: IssueRef): void {
    seedIssue(tracker, {
      repo: ref.repo,
      number: ref.number,
      createdAt: NOW,
      labels: [DEFAULT_LABELS.blocked],
    });
    mkdirSync(workDir(layout, ref.repo, ref.number), { recursive: true });
  }

  test("the first observation is logged even when empty; unchanged ticks stay silent", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    const before = Date.now();
    await engine.deriveAndAct();
    const after = Date.now();

    assert.equal(summaries(logs).length, 1, "the initial state is always a record");
    assert.match(summaries(logs)[0]!, /0 eligible work\(s\), 0 reserved work\(s\)/);
    const instant = instantOf(summaries(logs)[0]!);
    assert.ok(instant >= before - 1_500 && instant <= after + 1_500, "the stamp is inside the observation");

    await engine.deriveAndAct();
    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1, "no heartbeat while nothing changed");
    assert.ok(tracker.listCalls >= 3, "the derivation keeps querying the tracker during silence");
  });

  test("a work entering the pool is logged once, by its full reference", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    const lines = summaries(logs);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /Sanmoo\/a#1 \(eligible\)/);

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 2, "the new state is logged once, not every tick");
  });

  test("empty → available → empty logs each transition (a returning state is not suppressed)", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [] });
    await engine.deriveAndAct();

    const lines = summaries(logs);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /0 eligible work\(s\)/);
    assert.match(lines[1]!, /Sanmoo\/a#1 \(eligible\)/);
    assert.match(lines[2]!, /0 eligible work\(s\)/);
  });

  test("title-only edits and ordering never produce a new summary", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    seedIssue(tracker, { repo: REPO, number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 2, title: "two", createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();
    const before = summaries(logs).length;

    // Titles change and the insertion order is reversed — neither is operational.
    seedIssue(tracker, { repo: REPO, number: 2, title: "two renamed", createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 1, title: "one renamed", createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    assert.equal(summaries(logs).length, before, "cosmetic edits stay silent");
  });

  test("a swap that keeps the counts equal is identified by the works involved", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [] });
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    const line = summaries(logs).at(-1)!;
    assert.match(line, /1 eligible work\(s\)/, "the count alone would say nothing changed");
    assert.match(line, /\+ Sanmoo\/a#2 \(eligible\)/, "the work that entered is named");
    assert.match(line, /- Sanmoo\/a#1 \(was eligible\)/, "the work that left is named too");
  });

  test("the same issue number in another repository is a different work", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker, makeConfig([REPO, OTHER_REPO]));
    const engine = new SweepEngine(deps);

    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [] });
    seedIssue(tracker, { repo: OTHER_REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await engine.deriveAndAct();

    const line = summaries(logs).at(-1)!;
    assert.match(line, /\+ Sanmoo\/b#7 \(eligible\)/, "the entering work keeps its repository");
    assert.match(line, /- Sanmoo\/a#7 \(was eligible\)/, "the leaving work is the other repository");
  });

  test("parked reserved works are part of the state: classification changes show with equal counts", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    seedParkedClaimed(tracker, { repo: REPO, number: 10 });
    seedParkedBlocked(tracker, { repo: REPO, number: 11 });
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    assert.match(summaries(logs).at(-1)!, /0 eligible work\(s\), 2 reserved work\(s\)/);
    assert.match(summaries(logs).at(-1)!, /Sanmoo\/a#10 \(reserved\)/);
    assert.match(summaries(logs).at(-1)!, /Sanmoo\/a#11 \(reserved\)/);

    // #10 receives a human review comment: feedback, counts unchanged.
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 10 });
    assert.ok(feedback.known && feedback.value.pr !== null);
    tracker.addPrComment({ repo: REPO, prNumber: feedback.value.pr.number }, "humano", "please change this");
    await engine.deriveAndAct();

    let line = summaries(logs).at(-1)!;
    assert.equal(summaries(logs).length, 2);
    assert.match(line, /2 reserved work\(s\)/, "the counts are still equal");
    assert.match(line, /~ Sanmoo\/a#10 \(reserved→feedback\)/, "both classes of the reclassified work are named");

    // #11 receives a human answer on the issue: retomada, counts unchanged.
    tracker.addComment({ repo: REPO, number: 11 }, "humano", "the blocker is fixed — try again");
    await engine.deriveAndAct();

    line = summaries(logs).at(-1)!;
    assert.equal(summaries(logs).length, 3);
    assert.match(line, /~ Sanmoo\/a#11 \(reserved→resumable\)/, "the retomada is a class change on a parked work");
  });

  test("a change fully explained by an action event does not produce a redundant summary", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1);

    // The claim is the event that moves the work out of the pool and reserves it.
    await Promise.all(engine.fillSlots());
    assert.ok(logs.some((line) => line.includes(`claiming ${workKey({ repo: REPO, number: 1 })}`)));

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1, "the claim already registered the change");
  });

  test("a terminal action removes the work without a redundant summary", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedParkedClaimed(tracker, { repo: REPO, number: 10 });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1);
    assert.match(summaries(logs)[0]!, /Sanmoo\/a#10 \(reserved\)/);

    // The human closes the issue: the done action explains the removal
    // completely, so no state summary repeats it — this tick or the next.
    tracker.closeIssue({ repo: REPO, number: 10 });
    await engine.deriveAndAct();

    const action = logs.find((line) => line.includes("Sanmoo/a#10: issue closed — done"));
    assert.ok(action, "the terminal action is an operational record");
    instantOf(action);
    assert.equal(summaries(logs).length, 1, "the action already registered the removal");

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1, "nothing changed again, so nothing is repeated");
  });

  test("an event about another transition does not hide a later change on the same work", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    assert.equal(summaries(logs).length, 1);

    // The claim/collection announces "#1 lands reserved"; the human's comment
    // then moves the work to feedback — a DIFFERENT transition on the same
    // work, which the reservation announcement must not swallow.
    await Promise.all(engine.fillSlots());
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(feedback.known && feedback.value.pr !== null);
    tracker.addPrComment({ repo: REPO, prNumber: feedback.value.pr.number }, "humano", "please adjust this");

    await engine.deriveAndAct();

    assert.equal(summaries(logs).length, 2, "the feedback change is not hidden by the claim announcement");
    assert.match(summaries(logs).at(-1)!, /Sanmoo\/a#1 \(eligible→feedback\)/);
  });

  test("a tick that mixes an announced change and a silent one names only the silent one", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedParkedClaimed(tracker, { repo: REPO, number: 10 });
    const { deps, logs } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct(); // #1 eligible, #10 reserved
    assert.equal(summaries(logs).length, 1);

    // Same tick: #1 is claimed (the action announces eligible→reserved) while
    // #10 receives a human review comment (reserved→feedback) with no action
    // line. The summary must carry only the change nothing explained.
    await Promise.all(engine.fillSlots());
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 10 });
    assert.ok(feedback.known && feedback.value.pr !== null);
    tracker.addPrComment({ repo: REPO, prNumber: feedback.value.pr.number }, "humano", "please change this");
    await engine.deriveAndAct();

    const line = summaries(logs).at(-1)!;
    assert.equal(summaries(logs).length, 2);
    assert.match(line, /~ Sanmoo\/a#10 \(reserved→feedback\)/, "the silent change is named");
    assert.doesNotMatch(line, /Sanmoo\/a#1(?!\d)/, "the announced change is not restated");
  });

  test("every fresh instance logs its own first observation (restart and independent runs)", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps, logs } = makeFactory(tracker);

    await new SweepEngine(deps).deriveAndAct();
    await new SweepEngine(deps).deriveAndAct();

    assert.equal(summaries(logs).length, 2, "no suppression memory survives a new execution");
  });

  test("the continuous run keeps querying in silence and picks up a work made available later", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    const { deps, logs } = makeFactory(tracker);
    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitUntil("several silent ticks", () => tracker.listCalls >= 4);
      assert.equal(summaries(logs).length, 1, "the idle factory emits no periodic summary");
      instantOf(summaries(logs)[0]!);

      seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
      await waitUntil("the new work claimed", () => tracker.claimedOrder.length === 1);

      const action = logs.find((line) => line.includes("claiming Sanmoo/a#1"));
      assert.ok(action, "the claim is an operational action");
      instantOf(action);
      assert.ok(summaries(logs).length >= 2, "the availability change is logged");
      assert.match(summaries(logs).at(-1)!, /Sanmoo\/a#1 \(eligible\)/);
    } finally {
      controller.abort();
      await running;
    }

    const ended = logs.find((line) => line.includes("factory ended cleanly"));
    assert.ok(ended, "the end is an operational record");
    instantOf(ended);
  });

  test("repeated identical errors are never deduplicated", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    // Two distinct works fail the same way: the suppression policy is about
    // state summaries, never a global string dedup of the operational log.
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const logs: string[] = [];
    const runtime = { launch: () => Promise.reject(new Error("boom")) };
    const deps: LoopDeps = {
      config: makeConfig(),
      tracker,
      runtime,
      git: new FakeGitWork(),
      workspace: layout,
      log: (line) => logs.push(line),
    };
    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitUntil(
        "two occurrences of the same error",
        () => logs.filter((line) => line.includes("launch failed: boom")).length >= 2,
      );
    } finally {
      controller.abort();
      await running;
    }

    const errors = logs.filter((line) => line.includes("launch failed: boom"));
    assert.ok(errors.length >= 2, "the same text keeps appearing on every occurrence");
    for (const line of errors) instantOf(line);
  });

  test("the workers' JSONL files keep their own contract — no operational stamp", async () => {
    const tracker = new CountingTracker({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    const { deps } = makeFactory(tracker);
    const engine = new SweepEngine(deps);

    await engine.deriveAndAct();
    await Promise.all(engine.fillSlots());

    const file = join(workDir(layout, REPO, 1), "log-1.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
    assert.ok(lines.length >= 2, "the runtime wrote its attempt log");
    for (const line of lines) {
      assert.doesNotMatch(line, STAMP, "the JSONL contract never gains the operational prefix");
      assert.doesNotThrow(() => JSON.parse(line), "the JSONL stays machine-readable");
    }
  });

  test("the CLI stamps start, summary and end; the status output stays untouched", () => {
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
    // The command boots through the REAL tracker's keyring read; a fake `gh`
    // keeps the check local (repos: [] keeps the pool listing offline too).
    const ghBin = join(dir, "bin");
    mkdirSync(ghBin, { recursive: true });
    const gh = join(ghBin, "gh");
    writeFileSync(gh, '#!/bin/sh\ncat >/dev/null\n[ "$1 $2 $3" = "auth token --user" ] && echo fake-token\n', "utf8");
    chmodSync(gh, 0o755);
    const env = { ...process.env, PATH: `${ghBin}:${process.env.PATH ?? ""}` };
    const cli = new URL("../cli.js", import.meta.url).pathname;
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };

    const before = Date.now();
    const started = run(["run", "--once", "--runtime", "fake"]);
    const after = Date.now();

    assert.equal(started.status, 0, started.stderr);
    const lines = started.stdout.split("\n").filter((line) => line.trim() !== "");
    const summary = lines.find((line) => line.includes("derived pool"));
    const done = lines.find((line) => line.includes("sweep done"));
    assert.ok(summary, started.stdout);
    assert.ok(done, started.stdout);
    for (const line of [summary!, done!]) {
      const instant = instantOf(line);
      assert.ok(instant >= before - 1_500 && instant <= after + 1_500, `stamp inside the run: ${line}`);
    }

    const status = run(["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /pool \(eligible\): none/, "the status output is the same contract");
    assert.doesNotMatch(status.stdout, STAMP, "status records never gain the operational stamp");
  });

  test("the CLI stamps its direct error records, including an unknown runtime", () => {
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
    const cli = new URL("../cli.js", import.meta.url).pathname;

    const before = Date.now();
    // The runtime name is rejected before any boot (no keyring read, no
    // network), so the direct CLI error is the only record to stamp.
    const result = spawnSync(process.execPath, [cli, "run", "--once", "--runtime", "bogus"], {
      cwd: dir,
      encoding: "utf8",
    });
    const after = Date.now();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown runtime "bogus"/);
    const instant = instantOf(result.stderr);
    assert.ok(instant >= before - 1_500 && instant <= after + 1_500, "the direct CLI error is stamped");
  });

  test("a fatal CLI failure is an operational record too — stamped UTC error", () => {
    // The requested account has no keyring token, so the boot fails locally
    // (no network): the message is a direct CLI record and carries the stamp.
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: msf-log-test-ghost-account",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${join(dir, "ws")}`,
      ].join("\n"),
      "utf8",
    );
    const cli = new URL("../cli.js", import.meta.url).pathname;

    const before = Date.now();
    const result = spawnSync(process.execPath, [cli, "run", "--once", "--runtime", "fake"], {
      cwd: dir,
      encoding: "utf8",
    });
    const after = Date.now();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no GitHub token in the gh keyring/);
    const instant = instantOf(result.stderr);
    assert.ok(instant >= before - 1_500 && instant <= after + 1_500, "the fatal error is stamped");
  });

});
