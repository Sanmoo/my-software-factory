import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LABELS, DEFAULT_LIVENESS_POLICY, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET, type Config } from "../config.js";
import { ensureWorkspace, workDir, SESSIONS_SUBDIR } from "../layout.js";
import { runOnce, type LoopDeps } from "../loop.js";
import { seedFixtureRemote } from "../git/local-fixtures.js";
import { localGitWork } from "../git/local.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { SandcastleRuntime } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { readRecoveryLedger } from "../pool/recovery.js";
import { readEffectJournal, readPause } from "../runtime/continuity-artifacts.js";
import { findSessionFile as findSession, inspectSessionFile, sessionToolResults } from "../runtime/session-log.js";
import { startDeterministicModel, type DeterministicModel } from "./deterministic-model.js";
import { hostVisibleBase, bridgeAddress, waitForPushThenFindWorker, killContainer } from "./real-continuity-fixtures.js";

export async function proveDelegationStop(mode: "requested" | "forced"): Promise<void> {
  const root = mkdtempSync(join(hostVisibleBase(), "msf-delegation-real-"));
  const previousTmp = process.env["TMPDIR"];
  const temp = join(root, "tmp");
  mkdirSync(temp);
  process.env["TMPDIR"] = temp;
  let model: DeterministicModel | null = null;
  try {
    const repo = "Sanmoo/delegation-stop";
    const workspace = ensureWorkspace(join(root, `delegation-factory-${mode}`));
    const target = workDir(workspace, repo, 1);
    mkdirSync(target, { recursive: true });
    const fixtures = await seedFixtureRemote(join(target, "fixtures"), repo, { defaultBranch: "main" });
    model = await startDeterministicModel({
      script: mode === "requested" ? "delegation-stop" : "delegation-kill", branch: "agent-issue-1", attempt: 1,
      address: bridgeAddress(), workMount: "/msf-work", remoteUrl: "/msf-work/fixtures/remotas/Sanmoo#delegation-stop.git",
    });
    const modelsFile = join(root, "delegation-models.json");
    writeFileSync(modelsFile, JSON.stringify({ providers: { deterministico: {
      baseUrl: model.baseUrl, api: "openai-completions", apiKey: "no-credits",
      models: [{ id: "roteiro", name: "stop script", reasoning: false, input: ["text"],
        contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(tracker, { repo, number: 1, createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    const config: Config = {
      workerGhAccount: "bot", workerModel: "deterministico/roteiro", repos: [repo], concurrency: 1,
      workspace: workspace.root, labels: { ...DEFAULT_LABELS }, workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      liveness: { ...DEFAULT_LIVENESS_POLICY }, modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      notifications: false, configPath: join(root, "delegation.yaml"),
    };
    const runtime = new SandcastleRuntime({
      model: config.workerModel, token: "no-github", image: WORKER_IMAGE,
      agentFiles: [{ name: "models.json", hostPath: modelsFile }], authEnv: {},
      workspace: workspace.root, idleTimeoutSeconds: 120, activityPollMs: 100,
    });
    const deps: LoopDeps = {
      config, tickets: tracker, pullRequests: tracker, runtime, workspace,
      git: localGitWork({ reposDir: workspace.repos, remoteUrl: () => fixtures.barePath(repo) }),
      log: () => {}, wait: async () => {},
    };
    const stop = new AbortController();
    const active = runOnce(deps, { signal: stop.signal });
    try {
      if (mode === "requested") {
        const childrenStarted = () => ["code-reviewer", "spec-reviewer"].every((agent) => existsSync(join(target, `delegation-started-${agent}`)));
        // Two real children booting Pi inside one container: the wait covers
        // that startup under a loaded host (the gateway runs the whole suite at
        // once) while staying inside this proof's own 60 s ceiling, so a proof
        // that never starts its children still fails by name.
        const deadline = Date.now() + 45_000;
        while (!childrenStarted() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(childrenStarted(), "both real parallel children started their tools");
      } else {
        const container = await waitForPushThenFindWorker(fixtures.barePath(repo), "agent-issue-1", target, join(target, "log-1.jsonl"));
        killContainer(container);
      }
      stop.abort();
      const stopped = await active;
      assert.deepEqual(stopped.stop?.unconfirmed, []);
      assert.equal((await readRecoveryLedger(target)).lastStop?.kind, "stop-requested");
      const sessionId = stopped.launched[0]!.request.session!.sessionId;
      const file = findSession(join(target, SESSIONS_SUBDIR), sessionId);
      assert.ok(file);
      const inspection = inspectSessionFile(file, sessionId);
      const results = sessionToolResults(file, inspection.intactEntries);
      if (mode === "requested") {
        assert.ok(results.some((result) => result.tool === "subagent"), "the parent persisted the real subagent result");
      }

      const resumed = await runOnce(deps);
      assert.equal(resumed.launched.length, 1, `the restart must not pause: ${readPause(target)?.detail}`);
      assert.equal(resumed.launched[0]?.request.attempt, 1);
      assert.equal(resumed.launched[0]?.request.session?.sessionId, sessionId);
      assert.equal(resumed.launched[0]?.request.session?.mode, "resume");
      assert.equal((await readRecoveryLedger(target)).consumed, 0);
      assert.equal(readPause(target), null);
      assert.ok(existsSync(join(target, "desfecho.json")));
      if (mode === "forced") {
        assert.match(readFileSync(file, "utf8"), /realized before the interruption/, "the child's push is not repeated by the parent");
        const pushes = readEffectJournal(target).intents.filter((intent) => intent.actions.some((action) => action.kind === "push"));
        assert.equal(pushes.length, 1, "exactly one publication intent across child and parent");
      }
    } finally {
      stop.abort();
      await active;
    }
  } finally {
    await model?.close();
    if (previousTmp === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
}
