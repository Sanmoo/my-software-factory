import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runForever, type LoopDeps } from "../loop.js";
import { workKey } from "../state/derive.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { type GitWork, type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_PROVIDER_BUDGET,
  type Config,
} from "../config.js";
import { installGhShim, spawnCli } from "./cli-harness.js";

/**
 * End-to-end of ticket 14's continuous mode: `msf run` follows the fixed
 * tick forever, waking by event on a worker's end — a work that becomes
 * eligible (a human labels it) is picked up at the next tick WITHOUT a
 * restart, and ending the factory is a human act (Ctrl-C) that exits clean.
 * The two fake seams + real temp workspace; the tick is injected (the code
 * seam of the fixed 60 s tick) so the scenarios stay fast and deterministic.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const TICK_MS = 10;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: this.prepared.filter((r) => r.number === ref.number).length === 1,
      branchOnOrigin: false, // never pushed: the fakes launch, they do not publish
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "diff --git a/x b/x\n+work";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

describe("e2e: the continuous run — tick forever, wake by event, clean exit (ticket 14)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-run-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      provider: { ...DEFAULT_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(config: Config, outcomes: ScriptedOutcome[]) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new FakeGitWork();
    const deps: LoopDeps = { config, tracker, runtime, git, workspace: layout, log: () => {} };
    return { tracker, runtime, git, deps };
  }

  async function waitUntil(what: string, condition: () => Promise<boolean>): Promise<void> {
    // Generous on purpose: the same helper waits for in-process state and for
    // a spawned CLI's boot line, and a loaded machine delays a node start.
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  test("a work the human marks ready AFTER the boot is picked up at the next tick, no restart", async () => {
    const config = makeConfig(1);
    const { tracker, deps } = makeFactory(config, ["pr-open"]);

    // The factory boots on an empty pool and keeps sweeping on the tick.
    const controller = new AbortController();
    const running = runForever(deps, { tickMs: TICK_MS, signal: controller.signal });
    running.catch(() => {}); // guarded; the assertion below reads the state

    try {
      // Mid-flight, the human marks an issue ready on the tracker.
      seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

      // No restart: the very next tick claims and launches it.
      await waitUntil("the new eligible to be claimed and launched", async () => {
        const issue = await tracker.readIssue({ repo: REPO, number: 1 });
        return (
          issue.known &&
          issue.value.labels.includes(DEFAULT_LABELS.claimed) &&
          existsSync(workDir(layout, REPO, 1))
        );
      });

      // The claim came from the tick's derivation, not from the boot sweep
      // (the boot saw an empty pool).
      assert.deepEqual(tracker.claimedOrder, [workKey({ repo: REPO, number: 1 })]);
    } finally {
      controller.abort(); // every hold has a release path
      await running;
    }
  });

  test("a human comment on the PR becomes a feedback round at the next tick, in the continuous flow", async () => {
    const config = makeConfig(1);
    const { tracker, runtime, deps } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: TICK_MS, signal: controller.signal });
    running.catch(() => {});

    try {
      // Attempt 1 opens the PR and stays reserved — the round started at the
      // tick's derivation, not at the boot sweep (the boot saw an empty pool).
      await waitUntil("attempt 1 launched", () =>
        Promise.resolve(tracker.claimedOrder.length === 1),
      );
      await waitUntil("attempt 1's PR open", async () => {
        const fb = await tracker.readPrFeedback({ repo: REPO, number: 2 });
        return fb.known && fb.value.pr !== null;
      });

      // The human reviews; the NEXT tick derives the round and launches
      // attempt 2 on the same branch and the same PR.
      tracker.addPrComment({ repo: REPO, prNumber: 1 }, "humano", "please address this");
      await waitUntil("the feedback round (attempt 2) launched", () =>
        Promise.resolve(runtime.launched.length === 2),
      );
      assert.equal(runtime.launched[1]?.attempt, 2);
      assert.equal(runtime.launched[1]?.branch, workBranchName(2), "the SAME branch");
    } finally {
      controller.abort();
      await running;
    }

    // The SAME PR — no second PR; the worker ended the round commenting on it.
    const facts = await tracker.readPrFeedback({ repo: REPO, number: 2 });
    assert.ok(facts.known && facts.value.pr !== null && facts.value.pr.number === 1, "the SAME PR");
    const comments = await tracker.readComments({ repo: REPO, number: 2 });
    assert.ok(comments.known);
    assert.ok(
      comments.value.some((c) => c.author === "bot-do-samuca"),
      "the worker ended the round commenting on the PR",
    );
  });

  test("ending the factory is a human act: the abort exits clean, in-flight workers are reconciled by disk", async () => {
    const config = makeConfig(1);
    const { tracker, deps } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 3, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: TICK_MS, signal: controller.signal });

    await waitUntil("the worker launched", () =>
      Promise.resolve(tracker.claimedOrder.length === 1),
    );
    controller.abort();

    // runForever RESOLVES (no rejection, no hang): the clean exit.
    await running;

    // The factory is stateless between sweeps: the artifacts are on disk.
    assert.ok(existsSync(workDir(layout, REPO, 3)), "the work's artifacts survive the exit");
  });

  test("ticket 18 — a legit launch in flight is never released by a tick's derivation (zero footprint, held)", async () => {
    const config = makeConfig(1);
    const { tracker, deps, runtime } = makeFactory(config, ["pr-open"]);

    // Hold the worker before its first write: the claim is on the tracker and
    // the registry dir exists, but the footprint on disk is still zero —
    // exactly the window between the claim and the spawn.
    const hold = deferred();
    runtime.hold = () => hold.promise;

    seedIssue(tracker, { repo: REPO, number: 4, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: TICK_MS, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitUntil("claimed with the registry dir created", async () => {
        const issue = await tracker.readIssue({ repo: REPO, number: 4 });
        return (
          issue.known &&
          issue.value.labels.includes(DEFAULT_LABELS.claimed) &&
          existsSync(workDir(layout, REPO, 4))
        );
      });

      // Several ticks fire while the launch is in flight: the engine's
      // in-flight set holds the work — the derivation must not release it.
      await new Promise((resolve) => setTimeout(resolve, TICK_MS * 20));
      const issue = await tracker.readIssue({ repo: REPO, number: 4 });
      assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.claimed), "the claim was never released mid-launch");
      assert.ok(!issue.value.labels.includes(DEFAULT_LABELS.ready), "never devolved back to the pool mid-launch");
    } finally {
      hold.resolve(); // the launch proceeds: the worker opens the PR
      await waitUntil("the PR opened", async () => {
        const feedback = await tracker.readPrFeedback({ repo: REPO, number: 4 });
        return feedback.known && feedback.value.pr !== null;
      });
      controller.abort();
      await running;
    }
  });

  test("Ctrl-C on the spawned cli ends the process cleanly (exit 0)", async () => {
    // The tests-only fake runtime (ticket 18), an empty repo list and a shim
    // `gh` on PATH: the sweep boots hermetically (no keyring, no network) and
    // runs idle forever, so the signal behavior is proven without GitHub.
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
    const child = spawnCli(dir, ["run", "--runtime", "fake"], installGhShim(dir).env());

    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    await waitUntil("the boot sweep line", () => Promise.resolve(stdout.includes("sweeping forever")));

    // The exit listener is attached BEFORE the kill: node emits 'exit'
    // exactly once, and a late attach would miss it and hang forever.
    let code: number | null | undefined;
    child.on("exit", (c) => {
      code = c;
    });
    child.kill("SIGINT");
    // The handler is an idempotent abort — a resent signal still exits 0.
    // The resend covers a signal lost against a set of piped stdio startups
    // (a platform-level race, not a behavior the test pins down).
    const deadline = Date.now() + 1_000;
    while (code === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (code === undefined) child.kill("SIGINT");
    const finalCode = await new Promise<number | null>((resolve) => {
      if (code !== undefined) resolve(code);
      else child.on("exit", (c) => resolve(c));
    });

    assert.equal(finalCode, 0, `stdout: ${stdout}`);
    assert.match(stdout, /ended cleanly/i);
  });
});
