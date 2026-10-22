import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { ensureWorkspace, workDir } from "../layout.js";
import { runOnce, type LoopDeps } from "../loop.js";
import { localGitWork } from "../git/local.js";
import { seedFixtureRemote, cleanupFixture } from "../git/local-fixtures.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { SandcastleRuntime } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { EFFECT_JOURNAL_FILENAME, GUARDRAIL_STATE_FILENAME } from "../runtime/continuity-artifacts.js";
import { inspectSessionFile, sessionToolCalls } from "../runtime/session-log.js";
import { COMPLETION, startDeterministicModel, type DeterministicModel } from "./deterministic-model.js";
import { SESSIONS_SUBDIR } from "../layout.js";

/**
 * The mandatory REAL integration proof of continuity (issue 119, Testing
 * Decisions #2): the production runtime, Sandcastle, Pi and Docker, with the
 * session persisted on the bind-mounted work dir. A deterministic model pushes
 * the work branch and is SIGKILLed inside the tool; the factory then relaunches
 * the SAME attempt and the runtime must reopen the SAME Pi session, whose
 * guardrail must block the repeated push. Persistence, selection and reopening
 * are real; only the model and the effects (a local bare repo + a fake
 * tracker) are deterministic.
 *
 * The test runs on the operator's host AND inside a worker container (the
 * factory's own tests run there): inside a container, the paths it hands the
 * host daemon are translated through its own bind mounts, which is exactly the
 * host/container path resolution the issue requires.
 */

const ENABLED = process.env["MSF_REQUIRE_DOCKER"] === "1";

interface MissingPrerequisite {
  reason: string;
}

function missingPrerequisite(): MissingPrerequisite | null {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    return { reason: "docker is not reachable — the real continuity proof needs the daemon" };
  }
  try {
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch {
    return { reason: `the worker image ${WORKER_IMAGE} is not built — run npm run build:image` };
  }
  return null;
}

const skipReason = (() => {
  const missing = missingPrerequisite();
  if (missing === null) return undefined;
  if (ENABLED) throw new Error(`real continuity proof explicitly required but a prerequisite is missing: ${missing.reason}`);
  return `${missing.reason} (the gateway sets MSF_REQUIRE_DOCKER=1, where this proof is mandatory)`;
})();

/** Is this process inside a container? Then host paths and container paths differ. */
function insideContainer(): boolean {
  return existsSync("/.dockerenv") && existsSync("/run/.containerenv") === false;
}

/**
 * The one directory this process and the host daemon see at the SAME absolute
 * path, so the worker's binds need no translation. On the operator's host that
 * is the temp dir; inside a worker container the container's own `/tmp` is not
 * on the host, and the daemon would resolve every path the runtime hands it to
 * an empty root-owned directory (ADR 0003). Sandcastle mounts the repository's
 * git common dir at its own host path in every worker (so git works inside),
 * which makes the scratch tree under it visible to both sides under one name.
 *
 * The function proves the property instead of assuming it: the candidate must
 * be an existing bind whose Source IS its Destination.
 */
function hostVisibleBase(): string {
  const override = process.env["MSF_CONTINUITY_ROOT"];
  if (override !== undefined && override !== "") return override;
  if (!insideContainer()) return tmpdir();
  const raw = execFileSync("docker", ["inspect", "--format", "{{json .Mounts}}", hostname()], { encoding: "utf8" });
  const mounts = JSON.parse(raw) as Array<{ Type: string; Source: string; Destination: string }>;
  const strip = (path: string): string => path.replace(/\/$/, "");
  const identityDirs = mounts
    .filter((mount) => mount.Type === "bind" && strip(mount.Source) === strip(mount.Destination))
    .map((mount) => strip(mount.Source));
  const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  const underIdentity = identityDirs.some((dir) => gitCommonDir === dir || gitCommonDir.startsWith(`${dir}/`));
  for (const candidate of underIdentity ? [gitCommonDir, ...identityDirs] : identityDirs) {
    try {
      const probe = mkdtempSync(join(candidate, "msf-continuity-probe-"));
      rmSync(probe, { recursive: true, force: true });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    "no directory is visible to the host daemon at this process's own path — the proof cannot hand the worker " +
      "a bind the daemon resolves; set MSF_CONTINUITY_ROOT to such a directory (the value must be the host path too)",
  );
}

/** The address a sibling container dials to reach this process. */
function bridgeAddress(): string {
  if (insideContainer()) {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", hostname()], { encoding: "utf8" });
    const networks = JSON.parse(raw) as Record<string, { IPAddress?: string }>;
    const bridge = networks["bridge"] ?? Object.values(networks)[0];
    if (bridge?.IPAddress === undefined || bridge.IPAddress === "") {
      throw new Error("this container has no bridge address — a sibling worker could not reach the deterministic model");
    }
    return bridge.IPAddress;
  }
  const gateway = execFileSync(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
  if (gateway === "") throw new Error("the docker bridge has no gateway — a sibling worker could not reach the model");
  return gateway;
}


describe("e2e: continuity in the real Sandcastle/Pi/Docker (issue 119)", { skip: skipReason }, () => {
  let root: string;
  let model: DeterministicModel | null = null;

  before(() => {
    // The whole tree — the disposable remote, the factory workspace, the work
    // dir, the profile snapshot — lives under a directory the host daemon sees
    // at the same absolute path, so the runtime's own provider needs no
    // translation and the binds really carry the session file.
    root = mkdtempSync(join(hostVisibleBase(), "msf-continuity-real-"));
    // The runtime snapshots the profile under tmpdir(); it must land in the
    // host-visible tree as well.
    const tmp = join(root, "tmp");
    mkdirSync(tmp, { recursive: true });
    process.env["TMPDIR"] = tmp;
  });

  after(async () => {
    await model?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  test(
    "an interrupted attempt reopens ITS session in the container and the guardrail blocks the repeated push",
    { timeout: 10 * 60 * 1000 },
    async () => {
      const repo = "Sanmoo/prova-continuidade";
      const branch = "agent-issue-119";
      const workspace = ensureWorkspace(join(root, "fabrica"));
      const workDirPath = workDir(workspace, repo, 119);

      // The fixture remote rides the work dir — the one directory the worker
      // container sees (at /msf-work). The test process reaches it by its own
      // path; the worker pushes to the mount path (the deterministic script
      // names it), so one bare repo serves both without a translation layer.
      mkdirSync(workDirPath, { recursive: true });
      const fixtures = await seedFixtureRemote(join(workDirPath, "fixtures"), repo, { defaultBranch: "main" });
      const remotePath = fixtures.barePath(repo);

      model = await startDeterministicModel({
        branch,
        attempt: 1,
        address: bridgeAddress(),
        workMount: "/msf-work",
        remoteUrl: "/msf-work/fixtures/remotas/Sanmoo#prova-continuidade.git",
      });
      const profile = join(root, "perfil");
      mkdirSync(profile, { recursive: true });
      writeFileSync(
        join(profile, "models.json"),
        JSON.stringify(
          {
            providers: {
              deterministico: {
                name: "Deterministic",
                baseUrl: model.baseUrl,
                api: "openai-completions",
                apiKey: "no-credits",
                models: [
                  {
                    id: "roteiro",
                    name: "Deterministic script",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 200000,
                    maxTokens: 8192,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
      seedIssue(tracker, { repo, number: 119, createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
      const config: Config = {
        workerGhAccount: "bot-do-samuca",
        workerModel: "deterministico/roteiro",
        repos: [repo],
        concurrency: 1,
        workspace: workspace.root,
        labels: { ...DEFAULT_LABELS },
        profileAllowedRoots: [],
        profileSkipDanglingLinks: false,
        recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
        liveness: { ...DEFAULT_LIVENESS_POLICY },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
        notifications: false,
        configPath: join(root, "msf.yaml"),
      };

      const runtime = new SandcastleRuntime({
        model: config.workerModel,
        // gh is not used by the script; the non-empty token only satisfies the
        // precondition. No GitHub credential leaves this test.
        token: "continuity-proof-no-github",
        image: WORKER_IMAGE,
        profileDir: profile,
        workspace: workspace.root,
        idleTimeoutSeconds: 120,
        activityPollMs: 100,
      });

      const deps: LoopDeps = {
        config,
        tracker,
        runtime,
        git: localGitWork({ reposDir: workspace.repos, remoteUrl: () => remotePath }),
        workspace,
        log: () => {},
        notifier: new FakeNotifier(),
        wait: async () => {},
      };

      // The first launch runs the worker; we kill the container in the window
      // where the push LANDED but the tool result was never recorded.
      const active = runOnce(deps);
      const container = await waitForPushThenFindWorker(remotePath, branch, workDirPath, join(workDirPath, "log-1.jsonl"));
      killContainer(container);
      const sweep = await active;

      // 1. The interruption was not a new attempt: the recovery relaunched
      //    attempt 1 and reopened the association's session.
      assert.equal(sweep.launched.length, 2, "one interruption, one recovery");
      const [first, second] = sweep.launched;
      assert.equal(first?.request.attempt, 1);
      assert.equal(second?.request.attempt, 1, "the SAME attempt continues");
      assert.equal(second?.request.branch, branch, "the branch is preserved");
      assert.equal(first?.request.session?.mode, "new");
      assert.equal(second?.request.session?.mode, "resume");
      assert.equal(second?.request.session?.sessionId, first?.request.session?.sessionId);

      // 2. The session file on the bind-mounted work dir is the SAME one and
      //    it really went through the container: Pi's header names the id.
      const sessionsDir = join(workDirPath, SESSIONS_SUBDIR);
      const file = findSession(sessionsDir, second!.request.session!.sessionId);
      assert.ok(file, "the session persisted on the host");
      const inspection = inspectSessionFile(file, second!.request.session!.sessionId);
      assert.equal(inspection.status, "intact", inspection.detail);
      assert.ok(inspection.intactEntries > 1, "the resumed session carries the earlier history");

      // 3. The guardrail blocked the repeated push: the transcript holds a
      //    tool result carrying the guardrail reason, and the journal holds
      //    exactly ONE intent for that effect (the interrupted one).
      const calls = sessionToolCalls(file, inspection.intactEntries);
      const pushes = calls.filter((call) => call.command.includes("git push"));
      assert.ok(pushes.length >= 2, `expected the interrupted push and the retry, got ${pushes.length}`);
      const transcript = readFileSync(file, "utf8");
      assert.match(transcript, /msf continuity guardrail/, "the code blocked the repeat inside the container");
      assert.match(transcript, /realized before the interruption/);
      const journal = readFileSync(join(workDirPath, EFFECT_JOURNAL_FILENAME), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { type: string; actions?: Array<{ key: string }> });
      const pushIntents = journal.filter(
        (line) => line.type === "intent" && line.actions?.some((action) => action.key.startsWith("push:")),
      );
      assert.equal(pushIntents.length, 1, "the blocked retry never wrote a second intent");

      // 4. The realized verdict was written by the host BEFORE the resumed
      //    session started.
      const state = JSON.parse(readFileSync(join(workDirPath, GUARDRAIL_STATE_FILENAME), "utf8")) as {
        mode: string;
        verdicts: Record<string, string>;
      };
      assert.equal(state.mode, "resume");
      assert.ok(Object.values(state.verdicts).includes("realized"), JSON.stringify(state.verdicts));

      // 5. The remote received exactly the interrupted push (one commit), and
      //    the resumed session wrote its OWN outcome for attempt 1.
      const remoteHead = execFileSync("git", ["--git-dir", remotePath, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
      assert.match(remoteHead, /^[0-9a-f]{40}$/);
      const record = JSON.parse(readFileSync(join(workDirPath, "desfecho.json"), "utf8")) as { attempt: number };
      assert.equal(record.attempt, 1);
      assert.equal(second?.outcome, "clean-without-pr");

      // 6. Progress reused vs a reconstructed baseline: the interrupted step
      //    was the push, and the resumed conversation opens with it already
      //    behind it. A reconstructed execution starts at zero assistant
      //    messages and would issue the push again as a new step; here the
      //    first resumed call already carries the earlier turn AND the
      //    interrupted command as history, and the step it adds is the
      //    (blocked) retry — one new call, never a redo of the confirmed work.
      const resumedCalls = model.requests.filter((request) => request.resumed);
      assert.ok(resumedCalls.length > 0, `requests: ${model.requests.length}`);
      const firstResumed = resumedCalls[0]!;
      assert.ok(firstResumed.assistantMessages >= 1, "the reopened conversation carries its earlier turn");
      assert.ok(
        firstResumed.commands.some((command) => command.includes("git push")),
        "the interrupted push is part of the reopened history, not redone",
      );
      assert.equal(firstResumed.commands.length, 1, "the resumed turn carried exactly the interrupted step");
      assert.ok(COMPLETION.length > 0);

      cleanupFixture(join(workDirPath, "fixtures"));
    },
  );
});

/**
 * Poll the bare remote until the worker pushed the branch, then find its
 * container. The attempt's own event log is watched too: a session that FAILED
 * before the push (a broken image, a refused flag) is reported with its reason
 * instead of waiting out the deadline.
 */
async function waitForPushThenFindWorker(
  remotePath: string,
  branch: string,
  hostWorkDir: string,
  eventLog: string,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const failure = readSessionFailure(eventLog);
    if (failure !== null) throw new Error(`the worker session failed before the push: ${failure}`);
    const pushed = execFileSync("git", ["--git-dir", remotePath, "for-each-ref", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
    if (pushed !== "") {
      const container = findWorkerContainer(hostWorkDir);
      if (container !== null) return container;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the worker never pushed the branch (or its container was not observable)");
}

/** The reason of a `session-failed` event in the attempt's log, if any. */
function readSessionFailure(eventLog: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(eventLog, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { event?: string; reason?: string };
      if (entry.event === "session-failed") return entry.reason ?? "no reason recorded";
    } catch {
      continue;
    }
  }
  return null;
}

/** The live container of THIS work: its /msf-work bind points at our work dir. */
function findWorkerContainer(hostWorkDir: string): string | null {
  const ids = execFileSync("docker", ["ps", "-q", "--filter", `ancestor=${WORKER_IMAGE}`], { encoding: "utf8" })
    .split("\n")
    .filter((id) => id !== "");
  for (const id of ids) {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .Mounts}}", id], { encoding: "utf8" });
    const mounts = JSON.parse(raw) as Array<{ Source: string; Destination: string }>;
    if (mounts.some((mount) => mount.Destination === "/msf-work" && mount.Source === hostWorkDir)) return id;
  }
  return null;
}

function killContainer(id: string): void {
  execFileSync("docker", ["kill", id], { stdio: "ignore" });
}

function findSession(sessionsDir: string, sessionId: string): string | null {
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = execFileSync("find", [dir, "-type", "f", "-name", `*_${sessionId}.jsonl`], { encoding: "utf8" })
        .split("\n")
        .filter((entry) => entry !== "");
    } catch {
      continue;
    }
    if (entries.length > 0) return entries[0]!;
    for (const entry of entries) {
      const parent = dirname(entry);
      if (parent !== dir) stack.push(parent);
    }
  }
  return null;
}
