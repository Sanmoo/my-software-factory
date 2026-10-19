import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForever, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { installGhShim, runCli, spawnCli, waitFor, type GhShim } from "./cli-harness.js";

/**
 * End-to-end of issue #90's shutdown contract: Ctrl-C stops new admissions and
 * slot replenishment, the admitted workers still finish and their results are
 * registered, and the run's exclusivity holds until the process (the whole
 * `run`) is over — a contender is refused while a pending worker concludes and
 * is admitted only after the process exits. The loop effects are driven
 * through the existing fake tracker/runtime/git seams, synchronized on worker
 * events; one short bounded wait confirms ticks pass without admitting.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements GitWork {
  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("e2e: Ctrl-C shutdown — no new admissions, in-flight workers conclude (issue #90)", { timeout: 60_000 }, () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let children: ChildProcess[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-shutdown-"));
    layout = ensureWorkspace(join(dir, "ws"));
    children = [];
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  test("the loop stops replenishing, the pending worker concludes and is registered, and the loop resolves only after it", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, {
      repo: REPO,
      number: 2,
      createdAt: "2026-01-02T00:00:00Z",
      labels: [DEFAULT_LABELS.ready],
    });

    // Worker #1 parks mid-flight; #2 would be the replenishment the moment the
    // slot frees — exactly the admission Ctrl-C must suppress.
    const release = deferred();
    runtime.hold = async (request) => {
      if (request.ref.number === 1) await release.promise;
    };

    const deps: LoopDeps = { config, tracker, runtime, git: new FakeGitWork(), workspace: layout, log: () => {} };
    const controller = new AbortController();
    let settled = false;
    const running = runForever(deps, { tickMs: 10, signal: controller.signal }).then(() => {
      settled = true;
    });

    try {
      await waitFor("worker #1 to launch", () => runtime.launched.length === 1);

      controller.abort();
      // A bounded observation: several ticks would have replenished the slot
      // by now if Ctrl-C had not closed admissions.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(settled, false, "the loop is still up while the admitted worker runs");
      assert.deepEqual(
        runtime.launched.map((r) => r.ref.number),
        [1],
        "no replenishment and no new admission while the worker is pending",
      );

      release.resolve();
      await running;

      assert.equal(settled, true);
      assert.deepEqual(
        runtime.launched.map((r) => r.ref.number),
        [1],
        "the freed slot admits nothing after Ctrl-C",
      );

      // The in-flight worker's result was collected and registered before the
      // loop returned: its PR is open on the tracker.
      const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
      assert.ok(feedback.known && feedback.value.pr !== null, "the pending work's result is registered");
      assert.ok(existsSync(join(layout.works, "Sanmoo", "my-tasks#1", "desfecho.json")));

      // #2 was never claimed — it stays in the pool for the next run.
      const issue2 = await tracker.readIssue({ repo: REPO, number: 2 });
      assert.ok(issue2.known && issue2.value.labels.includes(DEFAULT_LABELS.ready));
    } finally {
      release.resolve();
      controller.abort();
      await running.catch(() => {});
    }
  });

  test("an admission past the reservation but before its worker starts launches nothing after Ctrl-C", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Park the admission inside git.prepareWork — after the reservation (the
    // claim and the registry dir) and before runtime.launch.
    const entered = deferred();
    const release = deferred();
    const git: GitWork = {
      prepareWork: async (ref) => {
        entered.resolve();
        await release.promise;
        return {
          repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
          branch: workBranchName(ref.number),
          baseBranch: "main",
          branchCreated: true,
        };
      },
      cleanupDoneWork: async () => {},
      diffWork: async () => "",
    };

    const deps: LoopDeps = { config, tracker, runtime, git, workspace: layout, log: () => {} };
    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: controller.signal });

    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      await running;

      assert.equal(runtime.launched.length, 0, "no worker starts after Ctrl-C");
      // The reservation already effected is preserved and reconcilable: the
      // claim is on the tracker and the registry dir exists.
      const issue = await tracker.readIssue({ repo: REPO, number: 1 });
      assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.claimed));
      assert.ok(existsSync(join(layout.works, "Sanmoo", "my-tasks#1")), "the registry dir stays for reconciliation");
    } finally {
      release.resolve();
      controller.abort();
      await running.catch(() => {});
    }
  });

  test("another run stays refused while the worker concludes, and is admitted after the process exits", async () => {
    const configPath = join(dir, "msf.yaml");
    writeFileSync(
      configPath,
      ["worker-gh-account: bot-do-samuca", "repos: []", `workspace: ${layout.root}`].join("\n"),
      "utf8",
    );
    const shim: GhShim = installGhShim(dir);
    const launchedFile = join(dir, "launched.txt");
    const holdFile = join(dir, "worker-hold");
    const resultFile = join(dir, "result.json");
    writeFileSync(launchedFile, "", "utf8");
    writeFileSync(holdFile, "", "utf8");

    // The owner process: acquire the run lock, then run the loop with the fake
    // seams, holding worker #1 until the test releases it. This is the `run`
    // contract — exclusivity for the whole process life — over the loop's
    // existing test seams.
    const ownerScript = join(dir, "owner.mjs");
    writeFileSync(
      ownerScript,
      [
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        `import { acquireRunLock } from ${JSON.stringify(new URL("../run-lock.js", import.meta.url).href)};`,
        `import { runForever } from ${JSON.stringify(new URL("../loop.js", import.meta.url).href)};`,
        `import { FakeTrackerAdapter, seedIssue } from ${JSON.stringify(new URL("../tracker/fake-adapter.js", import.meta.url).href)};`,
        `import { FakeWorkerRuntime } from ${JSON.stringify(new URL("../runtime/fake-runtime.js", import.meta.url).href)};`,
        `import { workBranchName } from ${JSON.stringify(new URL("../git/port.js", import.meta.url).href)};`,
        `import { DEFAULT_LABELS } from ${JSON.stringify(new URL("../config.js", import.meta.url).href)};`,
        `import { ensureWorkspace } from ${JSON.stringify(new URL("../layout.js", import.meta.url).href)};`,
        "const [configPath, workspaceRoot, launchedFile, holdFile, resultFile] = process.argv.slice(2);",
        "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
        "const workspace = ensureWorkspace(workspaceRoot);",
        "const config = { workerGhAccount: 'bot-do-samuca', repos: ['Sanmoo/my-tasks'], concurrency: 1, workspace: workspace.root, labels: { ...DEFAULT_LABELS }, profileAllowedRoots: [], profileSkipDanglingLinks: false, configPath };",
        "const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });",
        "seedIssue(tracker, { repo: 'Sanmoo/my-tasks', number: 1, createdAt: '2026-01-01T00:00:00Z', labels: [DEFAULT_LABELS.ready] });",
        "seedIssue(tracker, { repo: 'Sanmoo/my-tasks', number: 2, createdAt: '2026-01-02T00:00:00Z', labels: [DEFAULT_LABELS.ready] });",
        "const git = { prepareWork: async (ref) => ({ repoDir: `/clones/${ref.repo}`, branch: workBranchName(ref.number), baseBranch: 'main', branchCreated: true }), cleanupDoneWork: async () => {}, diffWork: async () => '' };",
        "const runtime = new FakeWorkerRuntime({ tracker, outcomes: ['pr-open'] });",
        "runtime.hold = async (request) => {",
        "  appendFileSync(launchedFile, `${request.ref.number}\\n`);",
        "  if (request.ref.number === 1) while (existsSync(holdFile)) await sleep(10);",
        "};",
        "const lock = await acquireRunLock(configPath);",
        "const controller = new AbortController();",
        "process.on('SIGINT', () => controller.abort());",
        "await runForever({ config, tracker, runtime, git, workspace, log: () => {} }, { tickMs: 10, signal: controller.signal });",
        "const feedback = await tracker.readPrFeedback({ repo: 'Sanmoo/my-tasks', number: 1 });",
        "writeFileSync(resultFile, JSON.stringify({ launched: runtime.launched.map((r) => r.ref.number), prOpen: feedback.known && feedback.value.pr !== null }));",
        "await lock.close();",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );

    const owner = spawn(process.execPath, [ownerScript, configPath, layout.root, launchedFile, holdFile, resultFile], {
      cwd: dir,
      // The shim env isolates HOME as well: the owner's lock file stays in the
      // suite's temp dir, like the contender's.
      env: shim.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(owner);

    // The owner is inside the loop, holding a pending worker: the lock covers
    // it. An actual `msf run` contender must be refused.
    await waitFor("the owner's worker #1 to launch", () => readFileSync(launchedFile, "utf8").includes("1"));
    owner.kill("SIGINT");

    const contender = runCli(dir, ["run", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0, `stderr: ${contender.stderr}`);
    assert.match(contender.stderr, /already has an active msf run/);

    // Release the pending worker: the owner concludes it and exits.
    rmSync(holdFile, { force: true });
    const ownerExit = await new Promise<number | null>((resolve) => owner.once("exit", (code) => resolve(code)));
    assert.equal(ownerExit, 0, "the owner ends cleanly after the worker concludes");

    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.deepEqual(result.launched, [1], "Ctrl-C admitted nothing new; the pending worker concluded");
    assert.equal(result.prOpen, true, "the pending work's result was registered before the owner exited");

    // With the owner process gone, the same config is admitted again.
    const ready = join(dir, "admitted-ready");
    const hold = join(dir, "admitted-hold");
    writeFileSync(hold, "", "utf8");
    const admitted = spawnCli(dir, ["run", "--once", "--runtime", "fake"], shim.env({ ready, hold }));
    children.push(admitted);
    await waitFor("a new run to be admitted", () => existsSync(ready));
    rmSync(hold, { force: true });
    admitted.kill("SIGKILL");
  });
});
