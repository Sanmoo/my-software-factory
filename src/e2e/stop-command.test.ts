import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForever, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { deferred } from "../runtime/deferred.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_RETRO,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import {
  installGhShim,
  installUnreachableDocker,
  isolatedEnv,
  runCli,
  spawnCli,
  waitFor,
  type GhShim,
} from "./cli-harness.js";

/**
 * End-to-end of the operator's requested stop (issue #146, extending #90's
 * contract): the signal closes new admissions at once, the started workers are
 * asked to stop — and end inside the cooperative window — and the run retains
 * its exclusivity until the stop is CONFIRMED. The in-flight worker's attempt
 * is preserved as the operator's requested stop: the next invocation resumes
 * the same attempt without spending the recovery budget, and no PR is invented.
 *
 * The loop effects are driven through the existing fake tracker/runtime/git
 * seams, synchronized on worker events; the process-level case runs a real
 * child holding the real run lock, signalled with real SIGINT, to prove the
 * exclusivity survives the whole stop.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements LegacyGitWork {
  /** Runs inside prepareWork, before it answers — the seam a test uses to park
   * a launch after its reservation and before its worker starts. */
  constructor(private readonly beforePrepare?: () => Promise<void>) {}

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    await this.beforePrepare?.();
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }
}

/** The compiled module's URL, as the child programs import it. */
const moduleUrl = (relative: string): string => JSON.stringify(new URL(relative, import.meta.url).href);

/**
 * The wiring every stopped-child proof shares: the fake seams (tracker, git,
 * runtime) and the config literal. One home, so the two child programs cannot
 * drift apart — the standards review caught their recovery budgets disagreeing
 * while both claimed to prove the same lifecycle.
 */
function childWiring(runtimeOptions: string, configPathExpression: string): string[] {
  return [
    `import { FakeTrackerAdapter, seedIssue } from ${moduleUrl("../tracker/fake-adapter.js")};`,
    `import { FakeWorkerRuntime } from ${moduleUrl("../runtime/fake-runtime.js")};`,
    `import { workBranchName } from ${moduleUrl("../git/port.js")};`,
    `import { expandedGitWorkOf } from ${moduleUrl("./legacy-git.js")};`,
    `import { DEFAULT_LABELS, DEFAULT_LIVENESS_POLICY, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET, DEFAULT_RETRO } from ${moduleUrl("../config.js")};`,
    `import { ensureWorkspace } from ${moduleUrl("../layout.js")};`,
    "const workspace = ensureWorkspace(workspaceRoot);",
    "const config = { workerGhAccount: 'bot-do-samuca', workerModel: 'opencode-go/glm-5.3-flash', jira: [], repos: ['Sanmoo/my-tasks'], concurrency: 1, workspace: workspace.root, labels: { ...DEFAULT_LABELS }, workerAuthFile: null, recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [1] }, liveness: { ...DEFAULT_LIVENESS_POLICY }, retro: { ...DEFAULT_RETRO }, modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET }, notifications: false, configPath: " + configPathExpression + " };",
    "const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });",
    "seedIssue(tracker, { repo: 'Sanmoo/my-tasks', number: 1, createdAt: '2026-01-01T00:00:00Z', labels: [DEFAULT_LABELS.ready] });",
    "const git = expandedGitWorkOf({ prepareWork: async (ref) => ({ repoDir: `/clones/${ref.repo}`, branch: workBranchName(ref.number), baseBranch: 'main', branchCreated: true, branchOnOrigin: false }), cleanupDoneWork: async () => {}, observeRemoteHead: async () => null, diffWork: async () => '', inspectLocalWork: async () => ({ headSha: null, commits: 0, uncommitted: false, operationInProgress: null }) });",
    `const runtime = new FakeWorkerRuntime({ ${runtimeOptions} });`,
  ];
}

describe("e2e: the operator's requested stop — close admissions, stop the workers, resume (issue #146)", { timeout: 60_000 }, () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let children: ChildProcess[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-stop-"));
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
      workerModel: "opencode-go/glm-5.3-flash",
      jira: [],
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [1, 1, 1] },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      retro: { ...DEFAULT_RETRO },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      notifications: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  test("a requested stop closes admissions, ends the worker cooperatively and preserves the attempt for the next run", async () => {
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
    // slot frees — exactly the launch the stop must suppress.
    runtime.hold = async (request) => {
      if (request.work.ticket.provider === 'github' && request.work.ticket.number === 1) await runtime.whenStopRequested(request.work);
    };

    const deps: LoopDeps = { config, tickets: tracker, pullRequests: tracker, runtime, git: expandedGitWorkOf(new FakeGitWork()), workspace: layout, log: () => {} };
    const stop = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: stop.signal, cooperativeMs: 2_000 });

    await waitFor("worker #1 to launch", () => runtime.launched.length === 1);
    stop.abort();
    const report = await running;

    // The stop was requested and confirmed: the worker ended inside the window.
    assert.deepEqual(report?.forced, [], "the worker ended cooperatively — nothing was forced");
    assert.deepEqual(report?.unconfirmed, [], "the end of the worker was confirmed");
    assert.deepEqual(runtime.stopRequests, ["Sanmoo/my-tasks#1"], "the in-flight worker was asked to stop");
    assert.deepEqual(
      runtime.launched.map((r) => r.work.ticket.provider === 'github' ? r.work.ticket.number : -1),
      [1],
      "the freed slot admits nothing after the requested stop",
    );

    // The attempt is preserved as the operator's requested stop: no fall, no
    // Cancellation, no recovery spent — and no PR invented for a stopped work.
    const issue1 = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue1.known && issue1.value.labels.includes(DEFAULT_LABELS.claimed), "the claim stays");
    const feedback = await tracker.readPrFeedback({ repo: REPO, number: 1 });
    assert.ok(feedback.known && feedback.value.pr === null, "no PR was opened by the stopped worker");
    const ledger = await readRecoveryLedger(join(layout.works, "Sanmoo", "my-tasks#1"));
    assert.equal(ledger.lastStop?.kind, "stop-requested", "the stop is persisted as the operator's own");
    assert.equal(ledger.consumed, 0, "no recovery was consumed by the requested stop");

    // #2 was never claimed — it stays in the pool for the next run.
    const issue2 = await tracker.readIssue({ repo: REPO, number: 2 });
    assert.ok(issue2.known && issue2.value.labels.includes(DEFAULT_LABELS.ready));
  });

  test("a stop past the reservation but before the worker starts leaves the reservation and persists the requested stop", async () => {
    const config = makeConfig(1);
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Park the launch inside git.prepareWork — after the reservation (the
    // claim and the registry dir) and before runtime.launch.
    const entered = deferred();
    const release = deferred();
    const git = new FakeGitWork(async () => {
      entered.resolve();
      await release.promise;
    });

    const deps: LoopDeps = { config, tickets: tracker, pullRequests: tracker, runtime, git: expandedGitWorkOf(git), workspace: layout, log: () => {} };
    const stop = new AbortController();
    const running = runForever(deps, { tickMs: 10, signal: stop.signal, cooperativeMs: 2_000 });

    await entered.promise;
    stop.abort();
    release.resolve();
    const report = await running;

    assert.deepEqual(report?.unconfirmed, [], "no worker had started — nothing to confirm");
    assert.equal(runtime.launched.length, 0, "no worker starts after the requested stop");
    // The reservation already effected is preserved and reconcilable: the
    // claim is on the tracker, the registry dir exists and the reserved
    // attempt is recorded as the operator's requested stop.
    const issue = await tracker.readIssue({ repo: REPO, number: 1 });
    assert.ok(issue.known && issue.value.labels.includes(DEFAULT_LABELS.claimed));
    const workDir = join(layout.works, "Sanmoo", "my-tasks#1");
    assert.ok(existsSync(workDir), "the registry dir stays for reconciliation");
    const ledger = await readRecoveryLedger(workDir);
    assert.equal(ledger.lastStop?.kind, "stop-requested");
    assert.equal(ledger.lastStop?.attempt, 1, "the reserved attempt is the one the next run resumes");
  });

  test("exclusivity holds through the stop, a second SIGINT escalates, and the same config is admitted after the process exits", async () => {
    const configPath = join(dir, "msf.yaml");
    writeFileSync(
      configPath,
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${layout.root}`,
      ].join("\n"),
      "utf8",
    );
    const shim: GhShim = installGhShim(dir);
    const launchedFile = join(dir, "launched.txt");
    const holdFile = join(dir, "worker-hold");
    const resultFile = join(dir, "result.json");
    writeFileSync(launchedFile, "", "utf8");
    writeFileSync(holdFile, "", "utf8");

    // The owner process: acquire the run lock, then run the loop with the fake
    // seams and the CLI's own signal installation, holding worker #1 (it
    // ignores the cooperative request) until the escalating second SIGINT.
    const ownerScript = join(dir, "owner.mjs");
    writeFileSync(
      ownerScript,
      [
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        `import { acquireRunLock } from ${JSON.stringify(new URL("../run-lock.js", import.meta.url).href)};`,
        `import { runForever } from ${JSON.stringify(new URL("../loop.js", import.meta.url).href)};`,
        `import { installStopSignals } from ${JSON.stringify(new URL("../stop-signals.js", import.meta.url).href)};`,
        "const [configPath, workspaceRoot, launchedFile, holdFile, resultFile] = process.argv.slice(2);",
        "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
        ...childWiring("tracker, outcomes: ['pr-open'], ignoreStop: true", "configPath"),
        "runtime.hold = async (request) => {",
        "  appendFileSync(launchedFile, `${request.work.ticket.provider === 'github' ? request.work.ticket.number : -1}\\n`);",
        "  if (request.work.ticket.provider === 'github' && request.work.ticket.number === 1) while (existsSync(holdFile)) await sleep(10);",
        "};",
        "const stop = installStopSignals();",
        "const lock = await acquireRunLock(configPath);",
        "const report = await runForever({ config, tickets: tracker, pullRequests: tracker, runtime, git, workspace, log: () => {} }, { tickMs: 10, signal: stop.requested, escalate: stop.escalated, cooperativeMs: 30_000 });",
        "const feedback = await tracker.readPrFeedback({ repo: 'Sanmoo/my-tasks', number: 1 });",
        "writeFileSync(resultFile, JSON.stringify({ launched: runtime.launched.map((r) => r.work.ticket.provider === 'github' ? r.work.ticket.number : -1), prOpen: feedback.known && feedback.value.pr !== null, forced: report?.forced ?? [], unconfirmed: report?.unconfirmed ?? [] }));",
        "await lock.close();",
        "stop.dispose();",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );

    const owner = spawn(process.execPath, [ownerScript, configPath, layout.root, launchedFile, holdFile, resultFile], {
      cwd: dir,
      env: isolatedEnv(dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(owner);
    let ownerStderr = "";
    owner.stderr?.on("data", (chunk: Buffer) => (ownerStderr += String(chunk)));

    await waitFor("the owner's worker #1 to launch", () => readFileSync(launchedFile, "utf8").includes("1"));
    owner.kill("SIGINT");
    // The worker ignores the cooperative request: the owner is still inside
    // the stop, holding the lock. A contender is refused during that window.
    const contender = runCli(dir, ["run", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0, `stderr: ${contender.stderr}`);
    assert.match(contender.stderr, /already has an active msf run/);
    assert.equal(owner.exitCode, null, "the owner stays alive while the stop is unconfirmed");

    // The second signal escalates: the worker is forced and confirmed.
    owner.kill("SIGINT");
    const ownerExit = await new Promise<number | null>((resolve) => owner.once("exit", (code) => resolve(code)));
    assert.equal(ownerExit, 0, `the owner ends cleanly after the forced, confirmed stop (stderr: ${ownerStderr})`);

    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.deepEqual(result.launched, [1], "the stop admitted nothing new");
    assert.equal(result.prOpen, false, "the stopped worker registered no invented PR");
    assert.deepEqual(result.forced, ["Sanmoo/my-tasks#1"], "the escalated stop forced the refusing worker");
    assert.deepEqual(result.unconfirmed, [], "the forced stop was confirmed");

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

  test("SIGINT and SIGTERM during the startup end the process cleanly — `run --once` and the continuous run", async () => {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${layout.root}`,
      ].join("\n"),
      "utf8",
    );
    const shim = installGhShim(dir);

    const modes = [
      {
        name: "once",
        argv: ["run", "--once", "--runtime", "fake"],
        said: /sweep stopped by the operator: the stop of every worker was confirmed, exit 0/,
        unconfirmed: /sweep stopped by the operator: the stop could not be confirmed, exit 1/,
      },
      {
        name: "continuous",
        argv: ["run", "--runtime", "fake"],
        said: /factory ended cleanly \(the operator's requested stop was confirmed\)/,
        unconfirmed: /factory ended with an UNCONFIRMED stop/,
      },
    ] as const;

    for (const mode of modes) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const ready = join(dir, `startup-ready-${mode.name}-${signal}`);
        const hold = join(dir, `startup-hold-${mode.name}-${signal}`);
        writeFileSync(hold, "", "utf8");
        // The boot check is held: the CLI has installed its handlers and holds
        // the run lock, so the signal lands inside the startup — the window the
        // issue says must be handled, not merely wired.
        const child = spawnCli(dir, [...mode.argv], shim.env({ ready, hold }));
        children.push(child);
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => (stderr += String(chunk)));

        await waitFor(`${mode.name}/${signal}: the CLI to reach its boot check`, () => existsSync(ready));
        child.kill(signal);
        rmSync(hold, { force: true });

        const exit = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
        assert.doesNotMatch(stderr, /Error|error:/, `${mode.name}/${signal}: the startup never crashed`);
        // The verdict and the exit status never disagree: with nothing to stop
        // the stop is confirmed (exit 0) when Docker answers, and the factory
        // says so — never a silent exit. A Docker that cannot answer leaves the
        // workspace unconfirmed (exit 1), the same contract as with workers.
        if (exit === 0) {
          assert.match(stdout, mode.said, `${mode.name}/${signal}: the stop is said out loud`);
        } else {
          assert.equal(exit, 1, `${mode.name}/${signal}: an unconfirmed start stop exits 1 (stdout: ${stdout})`);
          assert.match(stdout, mode.unconfirmed, `${mode.name}/${signal}: the unconfirmed stop is said out loud`);
        }
      }
    }
  });

  test("a Docker that cannot answer makes the startup stop exit nonzero — deterministically, with both signals", async () => {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${layout.root}`,
      ].join("\n"),
      "utf8",
    );
    const shim = installGhShim(dir);
    // The host's Docker never answers this child: no worker can be ruled out,
    // so the stop cannot be called safe — whatever the pool looks like.
    installUnreachableDocker(shim.binDir);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const ready = join(dir, `blind-ready-${signal}`);
      const hold = join(dir, `blind-hold-${signal}`);
      writeFileSync(hold, "", "utf8");
      const child = spawnCli(dir, ["run", "--once", "--runtime", "fake"], shim.env({ ready, hold }));
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += String(chunk)));

      await waitFor(`${signal}: the CLI to reach its boot check`, () => existsSync(ready));
      child.kill(signal);
      rmSync(hold, { force: true });

      const exit = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      assert.equal(exit, 1, `${signal}: a stop it cannot confirm exits nonzero (stdout: ${stdout})`);
      assert.match(
        stdout,
        /sweep stopped by the operator: the stop could not be confirmed, exit 1/,
        `${signal}: and says so — never the confirmed line`,
      );
      assert.doesNotMatch(stdout, /the stop of every worker was confirmed/, `${signal}: no false safe stop`);
      // The reason is the daemon's own words, on the operator's line: the
      // ledger and `msf status` show it as one row, never a wrapped command.
      assert.match(
        stdout,
        new RegExp(
          `stop NOT confirmed: the worker liveness could not be read \\(Cannot connect to the Docker daemon at unix:///var/run/docker.sock\\. Is the docker daemon running\\?\\)`,
        ),
        `${signal}: the diagnostic carries the daemon's reason, on one line (stdout: ${stdout})`,
      );
      assert.doesNotMatch(stderr, /Error|error:/, `${signal}: the startup never crashed`);
    }
  });

  test("a real SIGINT and SIGTERM stop a `run --once` process carrying a worker, and the next run resumes it", async () => {
    const script = join(dir, "once.mjs");
    writeFileSync(
      script,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        `import { installStopSignals } from ${JSON.stringify(new URL("../stop-signals.js", import.meta.url).href)};`,
        `import { runOnce } from ${JSON.stringify(new URL("../loop.js", import.meta.url).href)};`,
        `import { readRecoveryLedger } from ${JSON.stringify(new URL("../work-record/recovery.js", import.meta.url).href)};`,
        "const [mode, workspaceRoot, launchedFile, resultFile] = process.argv.slice(2);",
        "// A signal listener does not keep Node alive: the child must outlive its",
        "// parked worker so the test can deliver the real signal.",
        "const keepAlive = setInterval(() => {}, 1_000);",
        ...childWiring("tracker, outcomes: ['pr-open']", "join(workspaceRoot, 'msf.yaml')"),
        "if (mode === 'stop') runtime.hold = async (request) => { writeFileSync(launchedFile, String(request.work.ticket.provider === 'github' ? request.work.ticket.number : -1)); await runtime.whenStopRequested(request.work); };",
        "const stop = installStopSignals();",
        "const result = await runOnce({ config, tickets: tracker, pullRequests: tracker, runtime, git, workspace, log: () => {} }, { signal: stop.requested, escalate: stop.escalated, cooperativeMs: 10_000 });",
        "const pr = await tracker.readPrFeedback({ repo: 'Sanmoo/my-tasks', number: 1 });",
        "const ledger = await readRecoveryLedger(join(workspace.works, 'Sanmoo', 'my-tasks#1'));",
        "writeFileSync(resultFile, JSON.stringify({ launched: runtime.launched.map((request) => ({ attempt: request.attempt, branch: request.branch })), unconfirmed: result.stop ? result.stop.unconfirmed : null, prOpen: pr.known && pr.value.pr !== null, lastStop: ledger.lastStop }));",
        "stop.dispose();",
        "clearInterval(keepAlive);",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      // A fresh workspace per signal: each run starts from a clean pool, so the
      // second signal sees the same first-attempt situation as the first.
      const root = join(dir, `once-ws-${signal}`);
      const launchedFile = join(dir, `once-launched-${signal}`);
      const stoppedFile = join(dir, `once-stopped-${signal}.json`);
      const stopping = spawn(process.execPath, [script, "stop", root, launchedFile, stoppedFile], {
        cwd: dir,
        env: isolatedEnv(dir),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(stopping);
      let stoppingStderr = "";
      stopping.stderr?.on("data", (chunk: Buffer) => (stoppingStderr += String(chunk)));
      await waitFor(`${signal}: the run --once worker to launch`, () => existsSync(launchedFile));
      stopping.kill(signal);
      const stoppedExit = await new Promise<number | null>((resolve) => stopping.once("exit", (code) => resolve(code)));
      assert.equal(stoppedExit, 0, `${signal}: the stop ended the process cleanly (stderr: ${stoppingStderr})`);
      const stopped = JSON.parse(readFileSync(stoppedFile, "utf8"));
      assert.deepEqual(stopped.launched, [{ attempt: 1, branch: workBranchName(1) }], `${signal}: the attempt and branch are preserved`);
      assert.deepEqual(stopped.unconfirmed, [], `${signal}: the stop was confirmed`);
      assert.equal(stopped.prOpen, false, `${signal}: the stopped worker invented no PR`);
      assert.equal(stopped.lastStop.kind, "stop-requested", `${signal}: the stop is persisted as the operator's`);

      // The next invocation resumes the SAME attempt and registers the real PR.
      const resumedFile = join(dir, `once-resumed-${signal}.json`);
      const resumed = spawn(process.execPath, [script, "run", root, join(dir, "unused"), resumedFile], {
        cwd: dir,
        env: isolatedEnv(dir),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(resumed);
      const resumedExit = await new Promise<number | null>((resolve) => resumed.once("exit", (code) => resolve(code)));
      assert.equal(resumedExit, 0, `${signal}: the resume ends cleanly`);
      const result = JSON.parse(readFileSync(resumedFile, "utf8"));
      assert.deepEqual(result.launched, [{ attempt: 1, branch: workBranchName(1) }], `${signal}: the SAME attempt, no recovery`);
      assert.equal(result.lastStop, null, `${signal}: the stop record was consumed by the resume`);
      assert.equal(result.prOpen, true, `${signal}: the resumed worker registered its real PR`);
    }
  });
});
