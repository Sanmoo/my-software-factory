import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { pi } from "@ai-hero/sandcastle";

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
import { GUARDRAIL_CONTAINER_FILE, SandcastleRuntime } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { EFFECT_JOURNAL_FILENAME, GUARDRAIL_STATE_FILENAME, readEffectJournal, readPause } from "../runtime/continuity-artifacts.js";
import { planContinuity, recheckPausedEffects } from "../runtime/continuity.js";
import { WORK_MOUNT } from "../runtime/prompt.js";
import { inspectSessionFile, sessionToolCalls, sessionToolResults } from "../runtime/session-log.js";
import { readRecoveryLedger } from "../pool/recovery.js";
import { githubWork } from "./work-fixtures.js";
import {
  COMPLETION,
  REFUSED_CALL_COMMAND,
  SAFE_CALL_COMMAND,
  startDeterministicModel,
  type DeterministicModel,
} from "./deterministic-model.js";
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
  try {
    // The tag alone is not the prerequisite: this proof reads the session the
    // in-container guardrail journals, and the runtime refuses to launch an
    // image without it. Check exactly the file the launch preflight checks, so
    // a stale image reports itself instead of failing mid-proof.
    execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", "test", WORKER_IMAGE, "-f", GUARDRAIL_CONTAINER_FILE],
      { stdio: "ignore" },
    );
  } catch {
    return {
      reason: `the worker image ${WORKER_IMAGE} carries no continuity guardrail at ${GUARDRAIL_CONTAINER_FILE} — run npm run build:image`,
    };
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
      // The deterministic provider is supplied EXPLICITLY into the image's
      // agent dir (issue #159): no personal Pi profile is snapshotted, so the
      // fixture hands over exactly the one file the model needs.
      const agentConfig = join(root, "agent-config");
      mkdirSync(agentConfig, { recursive: true });
      const modelsFile = join(agentConfig, "models.json");
      writeFileSync(
        modelsFile,
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
        workerAuthFile: null,
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
        agentFiles: [{ name: "models.json", hostPath: modelsFile }],
        // The deterministic provider's key is the literal inside models.json;
        // no ambient provider variable rides this proof.
        authEnv: {},
        workspace: workspace.root,
        idleTimeoutSeconds: 120,
        activityPollMs: 100,
      });

      const deps: LoopDeps = {
        config,
        tickets: tracker,
        pullRequests: tracker,
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
      const baseline = model.requests[0]!;
      assert.equal(baseline.resumed, false, "the first call was a new execution");
      assert.equal(baseline.assistantMessages, 0, "a reconstructed execution starts with no history");
      assert.deepEqual(baseline.commands, [], "and no confirmed step behind it");
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

  test(
    "a refusal a probe extension makes AFTER the guardrail's intent is closed from the session, with nobody asked",
    { timeout: 10 * 60 * 1000 },
    async () => {
      // The journal gap of the reported incident, reproduced in the real
      // lifecycle: the guardrail journals the intent, a second extension refuses
      // the call BEFORE it runs (Pi calls no tool_result hook for a refused
      // call, so the guardrail never records a result), and the terminal error
      // exists only in the persisted session. The host must close the journal
      // from that evidence and let continuity proceed — no operator, no replay.
      const repo = "Sanmoo/prova-recuperacao";
      const branch = "agent-issue-172";
      const workspace = ensureWorkspace(join(root, "fabrica-recuperacao"));
      const workDirPath = workDir(workspace, repo, 172);
      mkdirSync(workDirPath, { recursive: true });

      const fixtures = await seedFixtureRemote(join(workDirPath, "fixtures"), repo, { defaultBranch: "main" });
      const remotePath = fixtures.barePath(repo);

      const refusalModel = await startDeterministicModel({
        branch,
        attempt: 1,
        script: "refused-call",
        address: bridgeAddress(),
        workMount: WORK_MOUNT,
        remoteUrl: "/msf-work/fixtures/remotas/Sanmoo#prova-recuperacao.git",
      });
      try {
        const profile = join(root, "perfil-recuperacao");
        mkdirSync(profile, { recursive: true });
        writeFileSync(
          join(profile, "models.json"),
          JSON.stringify(
            {
              providers: {
                deterministico: {
                  name: "Deterministic",
                  baseUrl: refusalModel.baseUrl,
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
        seedIssue(tracker, { repo, number: 172, createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.claimed] });
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
          configPath: join(root, "msf-recuperacao.yaml"),
        };

        const git = localGitWork({ reposDir: workspace.repos, remoteUrl: () => remotePath });
        const probeFile = join(workDirPath, PROBE_FILENAME);
        writeFileSync(probeFile, PROBE_SOURCE, "utf8");
        const runtime = new SandcastleRuntime({
          model: config.workerModel,
          // gh is not used by the script; the non-empty token only satisfies the
          // precondition. No GitHub credential leaves this test.
          token: "recovery-proof-no-github",
          image: WORKER_IMAGE,
          profileDir: profile,
          workspace: workspace.root,
          idleTimeoutSeconds: 120,
          activityPollMs: 100,
          piProvider: probeAfterGuardrailProvider(),
        });

        // 1. The real session, launched exactly as the loop launches it: the
        //    host's own continuity decision (association and guardrail state
        //    written BEFORE the worker starts) and the production runtime.
        const work = githubWork(repo, 172);
        const decision = await planContinuity(
          {
            workDir: workDirPath,
            sessionsDir: join(workDirPath, SESSIONS_SUBDIR),
            work,
            attempt: 1,
            git,
            tickets: tracker,
            pullRequests: tracker,
          },
          "new",
        );
        assert.equal(decision.decision, "launch", JSON.stringify(decision));
        if (decision.decision !== "launch") return;
        const prepared = await git.prepareWorkFor(work);
        const first = await runtime.launch({
          work,
          workDir: workDirPath,
          branch: prepared.branch,
          repoDir: prepared.repoDir,
          baseBranch: prepared.baseBranch,
          attempt: 1,
          session: { mode: "new", sessionId: decision.sessionId },
          material: { ticket: { title: "prove the journal gap is repaired", body: "" }, diff: "" },
        });
        assert.equal(first.outcome, "abrupt-death", "the session ended without an outcome record");

        // 2. The gap, as the real lifecycle left it: the session holds the
        //    terminal error of the refused call, the journal holds its intent
        //    and no result at all.
        const file = findSession(join(workDirPath, SESSIONS_SUBDIR), decision.sessionId);
        assert.ok(file, "the session persisted on the host");
        const inspection = inspectSessionFile(file, decision.sessionId);
        assert.equal(inspection.status, "intact", inspection.detail);
        // 2a. The rule the factory reads needs its POSITIVE control in the SAME
        //     session: a call that really executed carries the duration Pi only
        //     records for one, so "no duration" means "never ran" and not "this
        //     Pi version records none".
        const safe = sessionToolCalls(file, inspection.intactEntries).find((call) => call.command === SAFE_CALL_COMMAND);
        assert.ok(safe, `the harmless call reached the session: ${inspection.detail ?? ""}`);
        const safeTerminal = sessionToolResults(file, inspection.intactEntries).filter(
          (result) => result.callId === safe.callId,
        );
        assert.equal(safeTerminal.length, 1, "the executed call has exactly one terminal result");
        assert.equal(safeTerminal[0]?.isError, false, "the harmless call succeeded");
        assert.equal(typeof safeTerminal[0]?.durationMs, "number", "a call that executed records its duration");
        // 2b. The guarded call, refused by the probe AFTER the guardrail's intent:
        //     the terminal error exists only in the session, and it carries no
        //     duration — the contrast with the call above is the whole rule.
        const refused = sessionToolCalls(file, inspection.intactEntries).find(
          (call) => call.command === REFUSED_CALL_COMMAND,
        );
        assert.ok(refused, `the guarded call reached the session: ${inspection.detail ?? ""}`);
        const terminal = sessionToolResults(file, inspection.intactEntries).filter(
          (result) => result.callId === refused.callId,
        );
        assert.equal(terminal.length, 1, "exactly one terminal result");
        assert.equal(terminal[0]?.isError, true, "the probe refused the call");
        assert.equal(terminal[0]?.durationMs, null, "the refused tool never executed");
        assert.match(terminal[0]?.text ?? "", /refused after the guardrail journaled the intent/);

        const before = readEffectJournal(workDirPath);
        assert.equal(before.intact, true);
        assert.deepEqual(
          before.pending.map((intent) => intent.callId),
          [refused.callId],
          "the guardrail journaled the intent; no result followed it",
        );
        assert.deepEqual(before.results, [], "the journal never received the result the session holds");
        assert.equal(readPause(workDirPath), null, "nothing was paused: the factory had not looked yet");

        // 3. The public operational cycle: the interrupted attempt is recovered
        //    and the journal is completed from the session, with no answer.
        const deps: LoopDeps = {
          config,
          tickets: tracker,
          pullRequests: tracker,
          runtime,
          git,
          workspace,
          log: () => {},
          notifier: new FakeNotifier(),
          wait: async () => {},
        };
        const sweep = await runOnce(deps);

        assert.equal(sweep.launched.length, 1, "one recovery: the work was not paused for help");
        const recovered = sweep.launched[0]!.request;
        assert.equal(recovered.attempt, 1, "the SAME attempt continues");
        assert.deepEqual(recovered.session, { mode: "resume", sessionId: decision.sessionId });
        assert.equal(readPause(workDirPath), null, "no human was asked");
        const issue = await tracker.readIssue({ repo, number: 172 });
        assert.ok(issue.known);
        assert.equal(issue.value.labels.includes(DEFAULT_LABELS.blocked), false, "the ticket was not blocked");

        const journal = readEffectJournal(workDirPath);
        const repaired = journal.results.filter((result) => result.callId === refused.callId);
        assert.equal(repaired.length, 1, "closed exactly once");
        assert.equal(repaired[0]?.ok, false, "the observed error is preserved");
        assert.equal(repaired[0]?.source, "session", "closed from the transcript, not from the guardrail callback");
        assert.equal(repaired[0]?.evidenceAt, terminal[0]?.timestamp, "correlated to the evidence it came from");
        assert.equal(
          journal.intents.filter((intent) => intent.callId === refused.callId).length,
          1,
          "the original intent is preserved as written",
        );
        assert.equal((await readRecoveryLedger(workDirPath)).consumed, 1, "the recovery ruler still applies");
        assert.equal(refusalModel.requests.some((request) => request.resumed), true, "the resumed session really ran");

        const record = JSON.parse(readFileSync(join(workDirPath, "desfecho.json"), "utf8")) as {
          attempt: number;
          class: string;
        };
        assert.equal(record.attempt, 1, "the resumed session wrote attempt 1's outcome");
        assert.equal(record.class, "clean-without-pr");
        assert.match(
          readFileSync(file, "utf8"),
          /refused after the guardrail journaled the intent/,
          "the transcript keeps the evidence the repair came from",
        );

        // 4. Repeating the evaluation duplicates nothing: the intent is already
        //    closed, so a fresh read settles on the same evidence.
        const recheck = await recheckPausedEffects(
          {
            workDir: workDirPath,
            sessionsDir: join(workDirPath, SESSIONS_SUBDIR),
            work,
            attempt: 1,
            git,
            tickets: tracker,
            pullRequests: tracker,
          },
          {
            version: 1,
            work,
            attempt: 1,
            reason: "effect-unsupported",
            detail: "the interrupted call cannot be classified",
            at: "",
          },
        );
        assert.deepEqual(recheck, { resolved: true, pause: null });
        assert.equal(
          readEffectJournal(workDirPath).results.filter((result) => result.callId === refused.callId).length,
          1,
          "no duplicated result",
        );
      } finally {
        await refusalModel.close();
        cleanupFixture(join(workDirPath, "fixtures"));
      }
    },
  );
});

/** The probe the refusal proof loads AFTER the guardrail: Pi registers handlers
 *  in load order, so the guardrail has journaled the intent by the time this one
 *  refuses the call. */
const PROBE_FILENAME = "prova-extensao.js";
const PROBE_SOURCE = `export default function probe(pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    if (String(event.input?.command ?? "") !== ${JSON.stringify(REFUSED_CALL_COMMAND)}) return undefined;
    return { block: true, reason: "msf test probe: refused after the guardrail journaled the intent" };
  });
}
`;

/**
 * The Pi provider of the refusal proof: the production provider, with the probe
 * extension appended AFTER the flags the runtime adds — Pi loads `--extension`
 * paths in the order given, so the guardrail gets the call first.
 *
 * The runtime composes `"<this provider's command> <WORKER_FLAG_ARGS>"`, so the
 * probe cannot simply be appended here. The command is therefore staged through
 * a shell that takes those appended flags as ITS arguments and adds the probe
 * last — same process, same stdin, same exit status.
 */
function probeAfterGuardrailProvider(): (model: string, options?: Parameters<typeof pi>[1]) => ReturnType<typeof pi> {
  return (model, options) => {
    const agent = pi(model, options);
    return {
      ...agent,
      buildPrintCommand: (commandOptions) => {
        const command = agent.buildPrintCommand(commandOptions);
        const staged = `${command.command} "$@" --extension ${WORK_MOUNT}/${PROBE_FILENAME}`;
        return { ...command, command: `/bin/sh -c ${shellQuote(staged)} msf-probe` };
      },
    };
  };
}

/** One POSIX shell word, whatever the value contains. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
