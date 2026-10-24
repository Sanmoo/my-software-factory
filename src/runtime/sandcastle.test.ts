import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, describe, beforeEach, afterEach } from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pi, type AgentStreamEvent, type PiOptions, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { buildWorkerPrompt, COMPLETION_SIGNAL, WORK_MOUNT } from "./prompt.js";
import {
  SandcastleRuntime,
  SESSIONS_CONTAINER_DIR,
  AGENT_DIR_ENV,
  AGENT_FILES_MOUNT_DIR,
  MISE_CONTAINER_DIR,
  SANDBOX_BACKSTOP_FACTOR,
  TOOLCHAIN_SUBPATHS,
  GUARDRAIL_CONTAINER_FILE,
  defaultPreflight,
  dockerSocketFromHost,
  retroAnchorDir,
  stageAgentFiles,
  unixSocketPath,
  workerFlagArgs,
  workerShapedDockerRun,
} from "./sandcastle.js";
import { readTurnModelProviderError } from "./model-provider-error.js";
import { IMAGE_INVENTORY_PATH, loadAgentResources } from "./inventory.js";
import { provisionedInventory } from "./agent-inventory-fixture.js";
import { agentExtensionEntry, agentGuidancePath, agentSkillPath } from "./agent-paths.js";
import type { WorkRequest } from "./port.js";
import { githubWork, launchedNumber } from "../e2e/work-fixtures.js";

/**
 * The Sandcastle runtime (ticket 17): the real launch behind the WorkerRuntime
 * port, tested with the container call MOCKED AT THE PROCESS BOUNDARY — the
 * `run()` seam plus the `docker()` provider seam. The mechanics (mounts,
 * prompt, flags, env, network absence) are asserted on the options the runtime
 * hands over; the artifact contract (sessao/, log-<n>.jsonl,
 * desfecho.json) runs on real temp disk with the real runtime module driving
 * the fake container call. The real container proof is the gated e2e
 * (src/e2e/sandcastle-real.test.ts).
 */

const MODEL = "opencode-go/glm-5.3-flash";

describe("the clone a retrospective anchors in (issue 141)", () => {
  let reposDir: string;

  beforeEach(() => {
    reposDir = mkdtempSync(join(tmpdir(), "msf-retro-anchor-"));
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
  });

  test("the window's own clone is used, in the window's order", () => {
    mkdirSync(join(reposDir, "Sanmoo#other"));
    mkdirSync(join(reposDir, "Sanmoo#my-tasks"));

    assert.equal(
      retroAnchorDir(reposDir, ["Sanmoo/other", "Sanmoo/my-tasks"]),
      join(reposDir, "Sanmoo#other"),
      "the first repo of the window that has a clone",
    );
  });

  test("a destination on another code-host site still finds its clone", () => {
    mkdirSync(join(reposDir, "sanmoo#my-tasks@app.example.com"));

    assert.equal(
      retroAnchorDir(reposDir, ["missing/repo", "sanmoo/my-tasks"]),
      join(reposDir, "sanmoo#my-tasks@app.example.com"),
      "the clone dir carries the site's suffix; the round never guesses a site",
    );
  });

  test("no clone (or no repos dir) means no anchor — the round says why instead of inventing one", () => {
    mkdirSync(join(reposDir, "Sanmoo#unrelated"));

    assert.equal(retroAnchorDir(reposDir, ["Sanmoo/my-tasks"]), null);
    assert.equal(retroAnchorDir(join(reposDir, "absent"), ["Sanmoo/my-tasks"]), null);
  });

  test("a repos dir the host cannot read is the host's error, never a silent 'no clone'", () => {
    const unreadable = join(reposDir, "unreadable");
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);
    try {
      assert.throws(() => retroAnchorDir(unreadable, ["Sanmoo/my-tasks"]), /EACCES|EPERM/);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });
});

/** The daemon socket the launch binds (ADR 0003) — pinned like the token:
 *  the mechanics tests never read the machine's real socket. */
const SOCKET = { hostPath: "/var/run/docker.sock", gid: 969 };
const dockerSocket = () => SOCKET;

const RESOURCES = loadAgentResources();

/** The recorded inventory the comparison accepts for RESOURCES (same fields
 *  a provisioned image reports; see agent-inventory-fixture.ts). */
function inventoryJson(): string {
  return JSON.stringify(provisionedInventory(RESOURCES));
}

const READY_PROBE = async () => ({ status: 0, stdout: '{"status":"ready","provider":"openai","authType":"api_key"}', stderr: "" });

describe("sandcastle runtime — the launch it hands to Sandcastle", () => {
  let root: string;
  let authFile: string;
  let runOptions: RunOptions | undefined;
  let dockerOptions: DockerOptions | undefined;
  let piOptionsCaptured: PiOptions | undefined;
  let runtime: SandcastleRuntime;
  let request: WorkRequest;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-"));
    workspace = join(root, "fabrica");
    authFile = join(root, "auth.json");
    writeFileSync(authFile, '{"openai":{"type":"api_key","key":"test-sentinel"}}', "utf8");

    request = {
      work: githubWork("Sanmoo/my-tasks", 42),
      workDir: join(root, "trabalhos", "Sanmoo#my-tasks#42"),
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: {
        ticket: { title: "The issue", body: "The body" },
        diff: "diff --git a/f b/f",
      },
    };

    runtime = new SandcastleRuntime({
      model: MODEL,
      token: "gh-token-for-the-container",
      workspace,
      dockerSocket,
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "test-sentinel" },
      blockedLabel: DEFAULT_LABELS.blocked,
      preflight: async () => {}, // the mechanics tests never touch docker
      runSandcastle: async (options) => {
        runOptions = options;
        return emptyResult(request.branch);
      },
      dockerProvider: (options) => {
        dockerOptions = options;
        return dummySandbox();
      },
      piProvider: (model, options) => {
        piOptionsCaptured = options;
        return pi(model, options);
      },
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the sandbox mounts: work dir read-write, sessions read-write, the toolchain bind read-write, the daemon socket — nothing hides image resources", async () => {
    await runtime.launch(request);

    const mounts = dockerOptions?.mounts ?? [];
    assert.deepEqual(
      mounts.map((mount: { sandboxPath: string; readonly?: boolean }) => [mount.sandboxPath, mount.readonly ?? false]),
      [
        [WORK_MOUNT, false],
        [SESSIONS_CONTAINER_DIR, false],
        [MISE_CONTAINER_DIR, false],
        [SOCKET.hostPath, false],
      ],
    );
    assert.equal(mounts[0]?.hostPath, request.workDir);
    assert.equal(mounts[1]?.hostPath, join(request.workDir, "sessao"));
    assert.equal(mounts[3]?.hostPath, SOCKET.hostPath, "the socket rides its own host path — DOCKER_HOST names it");
  });

  test("the container inherits Docker: the socket's group as a supplementary gid and DOCKER_HOST naming the bind (ADR 0003)", async () => {
    await runtime.launch(request);

    assert.deepEqual(dockerOptions?.groups, [SOCKET.gid], "the container user joins the socket's group — not root, not a guess");
    assert.equal(dockerOptions?.env?.["DOCKER_HOST"], `unix://${SOCKET.hostPath}`);
  });

  test("the toolchain bind is workspace-derived: the mise data dir on the host, nothing inside the agent dir", async () => {
    await runtime.launch(request);

    const mounts = dockerOptions?.mounts ?? [];
    assert.equal(mounts[2]?.hostPath, join(workspace, TOOLCHAIN_SUBPATHS.mise));
    assert.equal(mounts[2]?.sandboxPath, "/home/agent/.local/share/mise");
    assert.ok(
      mounts.every(
        (mount) =>
          !mount.sandboxPath.startsWith("/home/agent/.pi/agent/skills") &&
          !mount.sandboxPath.startsWith("/home/agent/.pi/agent/extensions"),
      ),
      "no bind can shadow the provisioned skills or extensions inside the agent dir",
    );
  });

  test("the launch never reads the operator's personal Pi profile — a profile on the host reaches nothing", async () => {
    // A poisoned ~/.pi/agent is the honest probe: no snapshot, no personal
    // skills and no personal credential may reach the container or the launch's
    // arguments.
    const fakeHome = join(root, "home");
    mkdirSync(join(fakeHome, ".pi", "agent", "skills", "implement"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".pi", "agent", "skills", "implement", "SKILL.md"),
      "---\nname: implement\n---\npersonal\n",
      "utf8",
    );
    writeFileSync(join(fakeHome, ".pi", "agent", "auth.json"), '{"openai":{"type":"api_key","key":"personal"}}', "utf8");

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await runtime.launch(request);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    const mounts = dockerOptions?.mounts ?? [];
    assert.ok(mounts.every((mount) => !mount.hostPath.startsWith(fakeHome)), "no mount comes from the personal profile");
    const agent = runOptions?.agent as unknown as { env: Record<string, string> };
    assert.equal(agent.env[AGENT_DIR_ENV], "/home/agent/.pi/agent", "the agent dir is the image's");
    const hooks = (runOptions?.hooks?.sandbox?.onSandboxReady ?? []).map((hook) => hook.command).join("\n");
    assert.ok(!hooks.includes(fakeHome), "no setup hook copies a personal profile");
    const command = (
      runOptions?.agent as unknown as { buildPrintCommand(options: { prompt: string }): { command: string } }
    ).buildPrintCommand({ prompt: "p" }).command;
    assert.ok(!command.includes(fakeHome), "no personal path rides the print command");
    assert.ok(!(runOptions?.prompt ?? "").includes(fakeHome), "no personal path rides the prompt");
    assert.ok(!command.includes("auth.json"), "no auth file is named when none is supplied");
  });

  test("the toolchain host dir is created idempotently at launch — pre-existing state is never clobbered", async () => {
    const miseDir = join(workspace, TOOLCHAIN_SUBPATHS.mise);
    mkdirSync(miseDir, { recursive: true });
    writeFileSync(join(miseDir, "go"), "x", "utf8");

    await runtime.launch(request);
    await runtime.launch(request); // a second launch reuses, never resets

    assert.ok(existsSync(join(miseDir, "go")), "the mise volume survives across launches");
  });

  test("the worker's capability set: the pi-subagent tools ride the print command (ticket 85)", async () => {
    // The tool list alone is not proof of function — but a print command
    // WITHOUT the subagent tools is proof of absence. The launch must
    // deliver the capability the /code-review procedure demands.
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as {
      buildPrintCommand(options: { prompt: string }): { command: string };
    };
    const command = agent.buildPrintCommand({ prompt: "p" }).command;
    assert.ok(command.includes("subagent"), "the subagent tool is available to the worker");
    assert.ok(command.includes("subagents_enable"), "the subagents tool is available to the worker");
  });

  test("the agent is the Pi headless template in print mode with the closed flags — every declared resource named", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as {
      name: string;
      buildPrintCommand(options: { prompt: string }): { command: string; stdin?: string };
    };
    assert.equal(agent.name, "pi");
    const command = agent.buildPrintCommand({ prompt: "p" }).command;
    assert.match(command, /^pi -p --mode json --model/);
    assert.ok(command.includes(MODEL), "the configured model rides the print command");
    for (const flag of workerFlagArgs(RESOURCES)) {
      assert.ok(command.includes(flag), `the print command carries ${flag}`);
    }
  });

  test("discovery is off: no skills/extensions from the host or target project, no project trust", async () => {
    await runtime.launch(request);

    const command = (
      runOptions?.agent as unknown as { buildPrintCommand(options: { prompt: string }): { command: string } }
    ).buildPrintCommand({ prompt: "p" }).command;
    for (const flag of ["--no-skills", "--no-extensions", "--no-approve", "--no-context-files", "--no-prompt-templates"]) {
      assert.ok(command.includes(flag), `${flag} closes discovery`);
    }
    for (const skill of RESOURCES.declaration.skills.selected) {
      assert.ok(command.includes(`--skill '${agentSkillPath(skill.name)}'`), `${skill.name} is loaded explicitly`);
    }
    for (const extension of RESOURCES.declaration.extensions) {
      assert.ok(command.includes(`--skill '${agentGuidancePath(extension)}'`), `${extension.package} guidance is loaded`);
      assert.ok(command.includes(`-e '${agentExtensionEntry(extension)}'`), `${extension.package} is loaded explicitly`);
    }
  });

  test("the agent env points PI_CODING_AGENT_DIR at the image agent dir and forwards only the supplied auth env", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as { env: Record<string, string> };
    assert.equal(agent.env[AGENT_DIR_ENV], "/home/agent/.pi/agent");
    assert.equal(agent.env["OPENAI_API_KEY"], "test-sentinel");
  });

  test("GH_TOKEN rides the container env; no network option — Docker's default bridge", async () => {
    await runtime.launch(request);

    const env = dockerOptions?.env ?? {};
    assert.equal(env["GH_TOKEN"], "gh-token-for-the-container");
    assert.equal(dockerOptions?.network, undefined, "the provider default is the default bridge network");
    assert.equal(dockerOptions?.imageName, WORKER_IMAGE);
  });

  test("the work branch strategy: named branch, born from the base the git host reported", async () => {
    await runtime.launch(request);

    assert.deepEqual(runOptions?.branchStrategy, {
      type: "branch",
      branch: request.branch,
      baseBranch: request.baseBranch,
    });
    assert.equal(runOptions?.cwd, request.repoDir);
  });

  test("the prompt is the worker prompt built from the launch material", async () => {
    await runtime.launch(request);

    assert.equal(runOptions?.prompt, buildWorkerPrompt(request, { blockedLabel: DEFAULT_LABELS.blocked }));
    assert.equal(runOptions?.completionSignal, COMPLETION_SIGNAL);
    assert.equal(runOptions?.maxIterations, 1, "v0.1: one session, one full agent run");
  });

  test("an explicitly supplied agent file is mounted read-only and copied into the agent dir at start — never baked in", async () => {
    let authContent: string | undefined;
    const withAuth = new SandcastleRuntime({
      model: MODEL,
      token: "gh-token-for-the-container",
      workspace,
      dockerSocket,
      agentResources: RESOURCES,
      agentFiles: [{ name: "auth.json", hostPath: authFile }],
      authEnv: {},
      blockedLabel: DEFAULT_LABELS.blocked,
      preflight: async () => {},
      runSandcastle: async (options) => {
        runOptions = options;
        return emptyResult(request.branch);
      },
      dockerProvider: (options) => {
        dockerOptions = options;
        const mount = (options.mounts ?? []).find((candidate) => candidate.sandboxPath === AGENT_FILES_MOUNT_DIR);
        if (mount !== undefined) authContent = readFileSync(join(mount.hostPath, "auth.json"), "utf8");
        return dummySandbox();
      },
    });

    await withAuth.launch(request);

    const agentFilesMount = (dockerOptions?.mounts ?? []).find((mount) => mount.sandboxPath === AGENT_FILES_MOUNT_DIR);
    assert.ok(agentFilesMount, "the supplied-files dir is mounted read-only");
    assert.equal(agentFilesMount?.readonly, true);
    assert.match(agentFilesMount?.hostPath ?? "", /msf-agent-files-/);
    assert.equal(authContent, readFileSync(authFile, "utf8"));
    const hook = runOptions?.hooks?.sandbox?.onSandboxReady?.[0];
    assert.ok(hook, "the auth copy runs first");
    assert.ok(hook?.command.includes(`${AGENT_FILES_MOUNT_DIR}/auth.json`));
    assert.match(hook?.command ?? "", /\$HOME\/\.pi\/agent/);
    assert.ok(!existsSync(agentFilesMount!.hostPath), "the staged dir dies with the launch");
  });

  test("a supplied file name is a bare, shell-safe name — the start hook interpolates it", () => {
    for (const name of ["../auth.json", "sub/auth.json", "auth.json; rm -rf /", "a b.json", ""]) {
      assert.throws(() => stageAgentFiles([{ name, hostPath: authFile }]), /bare file name/, `refused: ${name}`);
    }
    const dir = stageAgentFiles([{ name: "auth.json", hostPath: authFile }]);
    try {
      assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), readFileSync(authFile, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a supplied file no files mount is created — provider env vars are the other explicit source", async () => {
    await runtime.launch(request);

    const mounts = dockerOptions?.mounts ?? [];
    assert.ok(mounts.every((mount) => mount.sandboxPath !== AGENT_FILES_MOUNT_DIR));
  });

  test("the toolchain converges BEFORE the prompt: mise install lands the declared tools in the persistent volume", async () => {
    await runtime.launch(request);

    const hooks = runOptions?.hooks?.sandbox?.onSandboxReady ?? [];
    assert.equal(hooks.length, 1, "no auth file: only the toolchain convergence");
    const mise = hooks[0];
    assert.ok(mise, "the convergence hook exists");
    assert.match(mise.command, /^mise install -y$/);
    assert.ok((mise.timeoutMs ?? 0) >= 10 * 60 * 1000, "a first install of many tools is slow — the launch waits");
  });

  test("the run is named after the work and the attempt", async () => {
    await runtime.launch(request);
    assert.equal(runOptions?.name, "work-42-attempt-1");
  });

  test("the sessions bind: the run's session storage is the work's sessao/ dir on host", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as { captureSessions: boolean };
    assert.equal(agent.captureSessions, false, "no implicit capture — the bind does the persistence");
    assert.deepEqual(piOptionsCaptured, {
      captureSessions: false,
      env: { [AGENT_DIR_ENV]: "/home/agent/.pi/agent", OPENAI_API_KEY: "test-sentinel" },
      sessionStorage: { hostSessionsDir: join(request.workDir, "sessao") },
    });
  });
});

describe("sandcastle runtime — the artifact contract on real disk (ticket 13's)", () => {
  let root: string;
  let request: WorkRequest;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-disk-"));
    request = {
      work: githubWork("Sanmoo/my-tasks", 42),
      workDir: join(root, "trabalhos", "Sanmoo#my-tasks#42"),
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: { ticket: { title: "t", body: "b" }, diff: "" },
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtimeThat(fakes: {
    outcome?: OutcomeRecord["class"];
    /** The attempt the written record declares; defaults to the launched one. */
    recordAttempt?: number;
    /** A record body written verbatim, whatever the reader makes of it (legacy, malformed). */
    rawRecord?: string;
    die?: string;
  }): SandcastleRuntime {
    return new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      dockerSocket,
      preflight: async () => {}, // offline: the contract tests never touch docker
      runSandcastle: async () => {
        if (fakes.die !== undefined) throw new Error(fakes.die);
        if (fakes.rawRecord !== undefined) {
          writeFileSync(join(request.workDir, DESFECHO_FILENAME), fakes.rawRecord, "utf8");
        } else if (fakes.outcome !== undefined) {
          const record: OutcomeRecord = {
            class: fakes.outcome,
            attempt: fakes.recordAttempt ?? request.attempt,
            ...(fakes.outcome === "pr-open"
              ? { pr: { repo: request.work.destination.repo, number: 9, branch: request.branch } }
              : {}),
          };
          writeFileSync(join(request.workDir, DESFECHO_FILENAME), JSON.stringify(record, null, 2), "utf8");
        }
        return { iterations: [], stdout: "", commits: [], branch: request.branch };
      },
      dockerProvider: () => dummySandbox(),
    });
  }

  test("launch time writes the footprint BEFORE any outcome: sessao/ + log-1.jsonl started (the registry's evidence)", async () => {
    let seen: { sessao: boolean; startLine: string | undefined } = { sessao: false, startLine: undefined };
    const dying = new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      dockerSocket,
      preflight: async () => {}, // offline: the contract tests never touch docker
      runSandcastle: async () => {
        seen = {
          sessao: existsSync(join(request.workDir, "sessao")),
          startLine: readLines(join(request.workDir, "log-1.jsonl"))[0],
        };
        throw new Error("container died mid-flight");
      },
      dockerProvider: () => dummySandbox(),
    });

    const result = await dying.launch(request);

    assert.equal(result.outcome, "abrupt-death");
    assert.equal(seen.sessao, true, "the session dir exists at launch time");
    assert.ok(seen.startLine?.includes("session-start"), "the log started before the outcome");
    assert.ok(!existsSync(join(request.workDir, DESFECHO_FILENAME)), "no record — the ruler reads the absence");
    const lines = readLines(join(request.workDir, "log-1.jsonl"));
    assert.ok(
      lines.some((line) => line.includes("session-failed")),
      "the death is logged with its reason",
    );
  });

  test("the session's end is logged with the outcome the record declares", async () => {
    const result = await runtimeThat({ outcome: "pr-open" }).launch(request);

    assert.equal(result.outcome, "pr-open");
    const lines = readLines(join(request.workDir, "log-1.jsonl"));
    assert.ok(lines[0]?.includes("session-start"));
    assert.ok(lines.at(-1)?.includes("session-end"));
    assert.ok(lines.at(-1)?.includes("pr-open"));
  });

  test("a completed run whose session forgot the record is an abrupt death — the absence is the class", async () => {
    const result = await runtimeThat({}).launch(request);

    assert.equal(result.outcome, "abrupt-death");
    assert.equal(await readOutcomeRecord(request.workDir), null);
  });

  test("a record left by another attempt is never this attempt's outcome: attempt 2 reads the attempt-1 record as an abrupt death (issue 143)", async () => {
    const result = await runtimeThat({ outcome: "pr-open", recordAttempt: 1 }).launch({
      ...request,
      attempt: 2,
    });

    assert.equal(result.outcome, "abrupt-death", "the older attempt's outcome is history, not this session's outcome");
    const record = await readOutcomeRecord(request.workDir);
    assert.equal(record?.attempt, 1, "the record on disk stays untouched — it is the history of attempt 1");
    const rejected = readLines(join(request.workDir, "log-2.jsonl"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line["event"] === "outcome-record-rejected");
    assert.ok(rejected, "the attempt's log says the record was rejected");
    assert.equal(rejected["attempt"], 2, "the log line belongs to the session that ended");
    assert.equal(rejected["recordedAttempt"], 1, "the log names the attempt the record belongs to");
    assert.equal(
      typeof rejected["reason"],
      "string",
      "the reason is carried for the operator, not left to the mismatch to imply",
    );
    assert.ok(
      readLines(join(request.workDir, "log-2.jsonl")).at(-1)?.includes("abrupt-death"),
      "session-end records the observed outcome — the absence",
    );
  });

  test("the attempt's own record still ends the session with the class it declares", async () => {
    const result = await runtimeThat({ outcome: "pr-open", recordAttempt: 2 }).launch({
      ...request,
      attempt: 2,
    });

    assert.equal(result.outcome, "pr-open");
    assert.ok(
      !readLines(join(request.workDir, "log-2.jsonl")).some((line) => line.includes("outcome-record-rejected")),
      "an own record is never rejected",
    );
  });

  test("a legacy record without an attempt field is not accepted as this attempt's outcome (issue 143)", async () => {
    const result = await runtimeThat({
      rawRecord: JSON.stringify({ class: "pr-open" }),
    }).launch(request);

    assert.equal(result.outcome, "abrupt-death", "a record that names no attempt is no attempt's outcome");
  });

  test("attempt numbering comes from the WorkRequest — attempt 2 writes log-2.jsonl", async () => {
    await runtimeThat({ outcome: "clean-without-pr", recordAttempt: 2 }).launch({ ...request, attempt: 2 });

    assert.ok(readLines(join(request.workDir, "log-2.jsonl"))[0]?.includes("session-start"));
    assert.ok(existsSync(join(request.workDir, "sessao")));
  });

  test("a provider error in the stream is readable from the attempt's own log (issue 144)", async () => {
    const at = 1_792_571_444_513;
    const emitting = new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      dockerSocket,
      preflight: async () => {},
      runSandcastle: async (options) => {
        const logging = options.logging as { onAgentStreamEvent?: (event: AgentStreamEvent) => void };
        logging.onAgentStreamEvent?.({
          type: "raw",
          iteration: 1,
          timestamp: new Date(),
          line: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              provider: "opencode-go",
              model: "deepseek-v4.1-flash",
              stopReason: "error",
              errorMessage: '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
              timestamp: at,
            },
          }),
        });
        return { iterations: [], stdout: "", commits: [], branch: request.branch };
      },
      dockerProvider: () => dummySandbox(),
    });

    const result = await emitting.launch(request);

    assert.equal(result.outcome, "abrupt-death");
    assert.deepEqual(await readTurnModelProviderError(request.workDir, 1), {
      message: '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
      identity: new Date(at).toISOString(),
    });
  });

  test("a preflight failure throws before any footprint — infra is not a work fall", async () => {
    const failing = new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      dockerSocket,
      preflight: async () => {
        throw new Error("docker unavailable");
      },
      runSandcastle: async () => {
        throw new Error("run must never be reached");
      },
      dockerProvider: () => dummySandbox(),
    });

    await assert.rejects(failing.launch(request), /docker unavailable/);
    assert.ok(!existsSync(request.workDir), "no footprint: no dir, no logs, no session");
  });

  test("a socket that cannot be resolved is a factory failure before any footprint — never a work fall", async () => {
    const failing = new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      dockerSocket: () => {
        throw new Error("the Docker daemon socket /var/run/docker.sock is missing");
      },
      preflight: async () => {},
      runSandcastle: async () => {
        throw new Error("run must never be reached");
      },
      dockerProvider: () => dummySandbox(),
    });

    await assert.rejects(failing.launch(request), /socket \/var\/run\/docker\.sock is missing/);
    assert.ok(!existsSync(request.workDir), "no footprint: the refusal is infra, not an attempt");
  });

  test("the default preflight checks Docker, the image inventory, the token, the git helper, Docker inside and the model auth", async () => {
    const checks: string[][] = [];
    const recorded = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (command, args) => {
        checks.push([command, ...args]);
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        return { stdout: "29.7.2", stderr: "" };
      },
    });
    await recorded();
    assert.deepEqual(checks, [
      ["docker", "info", "--format", "{{.ServerVersion}}"],
      ["docker", "image", "inspect", WORKER_IMAGE],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "cat",
        WORKER_IMAGE,
        IMAGE_INVENTORY_PATH,
      ],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "git",
        WORKER_IMAGE,
        "config",
        "--get",
        "credential.https://github.com.helper",
      ],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "test",
        WORKER_IMAGE,
        "-f",
        GUARDRAIL_CONTAINER_FILE,
        "-a", "-f", "/opt/msf/runtime/call-recovery.js",
        "-a", "-f", "/opt/msf/runtime/stop-request.js",
        "-a", "-f", "/opt/msf/runtime/guardrail/delegation.js",
        "-a", "-f", "/opt/msf/runtime/guardrail/journal-lock.js",
      ],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--group-add",
        "969",
        "-e",
        "DOCKER_HOST=unix:///var/run/docker.sock",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--entrypoint",
        "docker",
        WORKER_IMAGE,
        "--version",
      ],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--group-add",
        "969",
        "-e",
        "DOCKER_HOST=unix:///var/run/docker.sock",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--entrypoint",
        "docker",
        WORKER_IMAGE,
        "buildx",
        "version",
      ],
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--group-add",
        "969",
        "-e",
        "DOCKER_HOST=unix:///var/run/docker.sock",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--entrypoint",
        "docker",
        WORKER_IMAGE,
        "info",
        "--format",
        "{{.ServerVersion}}",
      ],
    ]);

    const failing = defaultPreflight({
      token: "",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async () => ({ stdout: "29.7.2", stderr: "" }),
    });
    await assert.rejects(failing, /token/);
  });

  test("the default preflight refuses an image without the git credential helper", async () => {
    // The image exists and the token is present: only the push capability is
    // missing. It must fail at boot (an actionable rebuild), never later as a
    // work-level blocked report the worker reads as its own failure.
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        return args[0] === "run" ? { stdout: "", stderr: "" } : { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /no git credential helper for github\.com/);
    await assert.rejects(failing, /npm run build:image/);
  });

  test("the default preflight refuses an image with no docker CLI — the worker would self-report a missing Docker", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        // The git helper probe answers; the docker CLI probe does not.
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        if (args.includes("--version")) throw new Error("exec: docker: not found");
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /carries no usable docker CLI/);
    await assert.rejects(failing, /exec: docker: not found/, "the refusal carries what actually failed");
    await assert.rejects(failing, /npm run build:image/);
  });

  test("the default preflight refuses an image without the buildx builder — npm run build:image is the mandated operation", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        if (args.includes("buildx")) throw new Error('docker: "buildx" is not a docker command');
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /has no buildx builder/);
    await assert.rejects(failing, /is not a docker command/);
  });

  test("the default preflight refuses to launch without any explicit model credential", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: {},
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /no model credentials for the worker/);
    await assert.rejects(failing, /never read from a personal Pi profile/);
  });

  test("an agent that makes no model call declares it — the credential precondition stands down, every other one still runs", async () => {
    const checks: string[][] = [];
    const preflight = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "deterministic/stop-proof",
      agentResources: RESOURCES,
      authEnv: {},
      agentMakesModelCalls: false,
      dockerSocket: SOCKET,
      // Any credential would be a lie for a deterministic agent: the probe is
      // never called.
      authProbe: async () => {
        throw new Error("the credential probe must not run for a model-less agent");
      },
      run: async (command, args) => {
        checks.push([command, ...args]);
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        return { stdout: "ok", stderr: "" };
      },
    });

    await preflight();

    assert.ok(checks.some((call) => call.includes(IMAGE_INVENTORY_PATH)), "the image inventory was still checked");
    assert.ok(checks.some((call) => call.includes("git")), "the git credential helper was still checked");
    assert.ok(checks.some((call) => call.includes("info")), "Docker inside the worker was still checked");
  });

  test("an unreadable worker-auth-file fails before any probe and never echoes its content", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: {},
      agentFiles: [{ name: "auth.json", hostPath: "/does/not/exist/auth.json" }],
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /worker-auth-file is unreadable: \/does\/not\/exist\/auth\.json/);
  });

  test("an unresolved credential is a clear not_ready diagnosis, never a secret value", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "sentinel-value" },
      dockerSocket: SOCKET,
      authProbe: async () => ({
        status: 1,
        stdout: '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}',
        stderr: "",
      }),
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /model credentials for openai\/gpt-4o are not ready/);
      assert.match(error.message, /credentials_not_configured/);
      assert.ok(!error.message.includes("sentinel-value"));
      return true;
    });
  });

  test("a stale image is refused at preflight: the image inventory must match this checkout's declaration", async () => {
    const stale = JSON.parse(inventoryJson()) as { pi: { version: string } };
    stale.pi.version = "1.2.0";
    const checks: string[][] = [];
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (command, args) => {
        checks.push([command, ...args]);
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: JSON.stringify(stale), stderr: "" };
        return { stdout: "29.7.2", stderr: "" };
      },
    });
    await assert.rejects(failing, /does not match this checkout's agent-resources\.yaml/);
    await assert.rejects(failing, /Pi is @earendil-works\/pi-coding-agent@1\.2\.0/);
    await assert.rejects(failing, /npm run build:image/);
    assert.ok(
      !checks.some((call) => call.includes("git") || call.includes("--version")),
      "the refusal happens at the inventory check — no later probe and no worker launch",
    );
  });

  test("the default preflight refuses a socket the container user cannot reach — an actionable gid", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      model: "openai/gpt-4o",
      agentResources: RESOURCES,
      authEnv: { OPENAI_API_KEY: "probe-sentinel" },
      dockerSocket: SOCKET,
      authProbe: READY_PROBE,
      run: async (_command, args) => {
        if (args.includes(IMAGE_INVENTORY_PATH)) return { stdout: inventoryJson(), stderr: "" };
        // Everything passes until the daemon probe INSIDE the container.
        if (args[0] === "run" && args.includes("info")) throw new Error("permission denied while trying to connect");
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /cannot reach the Docker daemon through \/var\/run\/docker\.sock as gid 969/);
    await assert.rejects(failing, /permission denied while trying to connect/);
  });
});

describe("sandcastle runtime — the daemon socket the container inherits (ADR 0003)", () => {
  test("DOCKER_HOST unset: the default socket path", () => {
    assert.equal(unixSocketPath(undefined), "/var/run/docker.sock");
    assert.equal(unixSocketPath(""), "/var/run/docker.sock");
  });

  test("a unix DOCKER_HOST names the socket — both spellings docker accepts", () => {
    assert.equal(unixSocketPath("unix:///run/user/1000/docker.sock"), "/run/user/1000/docker.sock");
    assert.equal(unixSocketPath("unix:/run/docker.sock"), "/run/docker.sock");
  });

  test("a daemon reached over tcp is refused, naming why a socket is required", () => {
    assert.throws(() => unixSocketPath("tcp://127.0.0.1:2375"), /not a unix socket/);
    assert.throws(() => unixSocketPath("ssh://host"), /unix:\/\/\/var\/run\/docker\.sock/);
  });

  test("the probe shape is the launch's trio, once: group, bind and DOCKER_HOST (the real test and the preflight share it)", () => {
    assert.deepEqual(workerShapedDockerRun(SOCKET, WORKER_IMAGE, "docker", ["info"]), [
      "run",
      "--rm",
      "--network",
      "none",
      "--group-add",
      String(SOCKET.gid),
      "-e",
      `DOCKER_HOST=unix://${SOCKET.hostPath}`,
      "-v",
      `${SOCKET.hostPath}:${SOCKET.hostPath}`,
      "--entrypoint",
      "docker",
      WORKER_IMAGE,
      "info",
    ]);
  });

  test("the socket's own gid is what the container user joins — never an assumed 999/0", () => {
    assert.deepEqual(
      dockerSocketFromHost({ env: {}, stat: () => ({ gid: 969, isSocket: () => true }) }),
      { hostPath: "/var/run/docker.sock", gid: 969 },
    );
  });

  test("a missing socket is refused at boot instead of becoming an empty mount", () => {
    assert.throws(
      () =>
        dockerSocketFromHost({
          env: {},
          stat: () => {
            throw new Error("ENOENT");
          },
        }),
      /socket \/var\/run\/docker\.sock is missing/,
    );
  });

  test("a path that is not a unix socket is refused", () => {
    assert.throws(
      () => dockerSocketFromHost({ env: {}, stat: () => ({ gid: 0, isSocket: () => false }) }),
      /is not a unix socket/,
    );
  });
});

/**
 * The real path (ADR 0003): the launch's own preconditions, the launch's own
 * socket bind and group, applied to the real worker image. It runs inside
 * `npm test` where Docker and the image are there, and SKIPS WITH A REASON
 * where they are not — never a silent pass. This is the proof that a worker
 * can run the repo's Docker checks instead of self-reporting a missing Docker.
 */
const dockerSkipReason: string | undefined = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    return "docker is not reachable on this machine — the real worker has no daemon to reach (the options tests cover the wiring)";
  }
  try {
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch {
    return `the worker image ${WORKER_IMAGE} is not built here (npm run build:image) — there is no image to prove Docker inside of`;
  }
  return undefined;
})();

describe("sandcastle runtime — the real Docker shell", () => {
  test(
    "the launch's preconditions hold for real, and a worker-image container builds and runs containers through the host daemon",
    { skip: dockerSkipReason, timeout: 120_000 },
    async () => {
      const socket = dockerSocketFromHost();

      // The launch's own preconditions, end to end: docker alive, image
      // present, credential helper, docker CLI, and the daemon reachable
      // through the socket as the socket's group.
      await defaultPreflight({
        token: "probe",
        image: WORKER_IMAGE,
        model: "openai/gpt-4o",
        agentResources: RESOURCES,
        authEnv: { OPENAI_API_KEY: "msf-probe-not-a-real-key" },
        dockerSocket: socket,
      })();

      // Docker inside the worker: the same bind, the same group, the image's
      // own user. `docker build` is the npm run build:image path (buildx), and
      // the nested `docker run` is a worker launching a container of its own.
      const inside = execFileSync(
        "docker",
        workerShapedDockerRun(socket, WORKER_IMAGE, "sh", [
          "-c",
          [
            "set -e",
            `docker info --format '{{.ServerVersion}}'`,
            "mkdir -p /tmp/msf-build-probe",
            "printf 'FROM scratch\\nLABEL msf=probe\\n' > /tmp/msf-build-probe/Dockerfile",
            "docker build -q -t msf-dind-probe:local /tmp/msf-build-probe >/dev/null",
            "docker image rm -f msf-dind-probe:local >/dev/null",
            `docker run --rm --network none --entrypoint true ${WORKER_IMAGE}`,
            "echo DOCKER_INSIDE_OK",
          ].join(" && "),
        ]),
        { encoding: "utf8" },
      ).trim();

      const [serverVersion, marker] = inside.split("\n");
      assert.match(serverVersion ?? "", /^\d+\.\d+/, "the daemon answers the container's docker CLI");
      assert.equal(marker, "DOCKER_INSIDE_OK", "the worker built an image and ran a container of its own");
    },
  );
});

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function emptyResult(branch: string): RunResult {
  return { iterations: [], stdout: "", commits: [], branch };
}

/** A SandboxProvider the tests hand to run() — never actually invoked there. */
function dummySandbox(): SandboxProvider {
  return {
    name: "dummy",
    env: {},
  } as unknown as SandboxProvider;
}

describe("sandcastle runtime — the idle limit measured on verifiable activity (issue 112)", () => {
  let root: string;
  let request: WorkRequest;

  /** A short REAL limit: the suite never waits the production ten minutes. */
  const SHORT_IDLE_SECONDS = 0.3;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-idle-"));
    request = {
      work: githubWork("Sanmoo/my-tasks", 42),
      workDir: join(root, "trabalhos", "Sanmoo#my-tasks#42"),
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: { ticket: { title: "t", body: "b" }, diff: "" },
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtimeWith(runSandcastle: (options: RunOptions) => Promise<RunResult>): SandcastleRuntime {
    return new SandcastleRuntime({
      model: MODEL,
      token: "t",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: root,
      // The daemon socket the launch binds (ADR 0003) — pinned like every
      // other runtime test here: the idle-limit mechanics never read the
      // machine's real socket.
      dockerSocket,
      preflight: async () => {}, // offline: the tests never touch docker
      idleTimeoutSeconds: SHORT_IDLE_SECONDS,
      activityPollMs: 25,
      runSandcastle,
      dockerProvider: () => dummySandbox(),
    });
  }

  /** Hold the run open until the runtime aborts it (or a generous safety net). */
  function untilAborted(options: RunOptions, safetyMs: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      assert.ok(signal, "the runtime hands the watchdog's signal to Sandcastle");
      const done = setTimeout(() => resolve(emptyResult(request.branch)), safetyMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(done);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test("reviewer subagent transcripts keep the worker alive past the idle limit", async () => {
    // The worker is silent on stdout while two reviewers work: what changes is
    // the session dir — exactly what the watchdog measures.
    const result = await runtimeWith(async () => {
      const reviewerDir = join(request.workDir, "sessao", "sessao-principal", "run-das-revisoes");
      mkdirSync(reviewerDir, { recursive: true });
      for (let tick = 0; tick < 6; tick += 1) {
        writeFileSync(join(reviewerDir, "transcript.jsonl"), `${tick}\n`, "utf8");
        await sleep(60);
      }
      writeFileSync(
        join(request.workDir, DESFECHO_FILENAME),
        JSON.stringify({ class: "pr-open", attempt: 1 }),
        "utf8",
      );
      return emptyResult(request.branch);
    }).launch(request);

    assert.equal(result.outcome, "pr-open", "the session survived far past the short idle limit");
    const lines = readLines(join(request.workDir, "log-1.jsonl"));
    assert.ok(!lines.some((line) => line.includes("activity-idle")), "verifiable work is never an idle");
  });

  test("no verifiable activity still ends the session at the idle limit", async () => {
    const startedAt = Date.now();
    const result = await runtimeWith((options) => untilAborted(options, 5_000)).launch(request);
    const elapsed = Date.now() - startedAt;

    assert.equal(result.outcome, "abrupt-death");
    assert.ok(elapsed < 2_000, `the wait ended at the short limit, not by the safety net (${elapsed}ms)`);
    const lines = readLines(join(request.workDir, "log-1.jsonl"));
    assert.ok(lines.some((line) => line.includes("activity-idle")), "the idle is diagnosed in the attempt's log");
    assert.ok(
      lines.some((line) => line.includes("no verifiable activity")),
      "the reason names the activity, not only the sandbox clock",
    );
  });

  test("an unconditional heartbeat is not proof of work: the factory's own logs never keep a dead session alive", async () => {
    const startedAt = Date.now();
    const result = await runtimeWith(async (options) => {
      const run = untilAborted(options, 5_000);
      // Handled while the heartbeat loop below runs: the rejection is the
      // assertion's subject, not a stray unhandled one.
      run.catch(() => {});
      // The two logs the factory itself writes from the agent's stdout: a
      // session that only "reports" liveness must still time out.
      const sandcastleLog = join(request.workDir, "sessao", "sandcastle-1.log");
      for (let tick = 0; tick < 40; tick += 1) {
        appendFileSync(join(request.workDir, "log-1.jsonl"), "{}\n", "utf8");
        appendFileSync(sandcastleLog, "still here\n", "utf8");
        await sleep(25);
      }
      return run;
    }).launch(request);
    const elapsed = Date.now() - startedAt;

    assert.equal(result.outcome, "abrupt-death");
    assert.ok(elapsed < 2_000, "the heartbeat did not extend the limit");
    assert.ok(
      readLines(join(request.workDir, "log-1.jsonl")).some((line) => line.includes("activity-idle")),
      "the idle limit remained effective",
    );
  });

  test("the sandbox's own clock is only a backstop behind the verified-activity limit", async () => {
    let captured: RunOptions | undefined;
    await runtimeWith(async (options) => {
      captured = options;
      return emptyResult(request.branch);
    }).launch(request);

    assert.ok(captured?.signal, "the watchdog signal reaches the run");
    assert.ok(
      (captured?.idleTimeoutSeconds ?? 0) >= SHORT_IDLE_SECONDS * SANDBOX_BACKSTOP_FACTOR,
      "Sandcastle's timer never preempts the verified-activity limit",
    );
  });
});

describe("sandcastle runtime — the requested stop and the native session resume (issue #146)", () => {
  let root: string;
  let workDir: string;
  let request: WorkRequest;
  let runOptions: RunOptions | undefined;
  let runStarted: () => void;
  let started: Promise<void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-stop-"));
    workDir = join(root, "trabalhos", "Sanmoo#my-tasks#42");
    mkdirSync(workDir, { recursive: true });
    request = {
      work: githubWork("Sanmoo/my-tasks", 42),
      workDir,
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: { ticket: { title: "The issue", body: "The body" }, diff: "" },
    };
    started = new Promise<void>((resolve) => (runStarted = resolve));
    runOptions = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The options the launch handed over (read through a call, so the
   *  compiler sees the closure's write, not the outer `undefined`). */
  const captured = (): RunOptions | undefined => runOptions;

  function makeRuntime(): SandcastleRuntime {
    return new SandcastleRuntime({
      model: MODEL,
      token: "gh-token",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: join(root, "fabrica"),
      dockerSocket,
      preflight: async () => {},
      runSandcastle: async (options) => {
        runOptions = options;
        runStarted();
        return emptyResult(request.branch);
      },
      dockerProvider: () => dummySandbox(),
    });
  }

  test("a resume reopens the session the attempt's OWN association records; a new execution is born with its id", async () => {
    // Two sessions of the attempt's history and one of another work sit in the
    // same dir: the newest file is NOT the selection rule (issue 119).
    const sessionsDir = join(workDir, "sessao", "--sandbox-cwd--");
    mkdirSync(sessionsDir, { recursive: true });
    const recorded = "22222222-2222-2222-2222-222222222222";
    const session = (id: string, dir = sessionsDir, name = `2026-01-01T00-00-00-000Z_${id}.jsonl`): void => {
      writeFileSync(join(dir, name), `${JSON.stringify({ type: "session", id })}\n`, "utf8");
    };
    session("11111111-1111-1111-1111-111111111111", sessionsDir, "2026-01-01T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl");
    session(recorded, sessionsDir, "2025-12-01T00-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl");
    // A NEWER session of another work: never this attempt's to reopen.
    const other = join(workDir, "sessao", "--other-work--");
    mkdirSync(other, { recursive: true });
    session("33333333-3333-3333-3333-333333333333", other, "2026-02-01T00-00-00-000Z_33333333-3333-3333-3333-333333333333.jsonl");

    await makeRuntime().launch({ ...request, session: { mode: "resume", sessionId: recorded } });
    assert.equal(
      captured()?.resumeSession,
      recorded,
      "the resumed attempt reopens the session its association names, not the newest file (ADR 0005)",
    );
    assert.equal(
      (captured()?.prompt as string).includes("This session CONTINUES attempt 1"),
      true,
      "the prompt matches the continuation the runtime really does",
    );

    // A NEW session is not a resume: it is born with the id the factory
    // recorded before the launch, so a later recovery picks exactly it.
    runOptions = undefined;
    const fresh = "44444444-4444-4444-4444-444444444444";
    await makeRuntime().launch({ ...request, session: { mode: "new", sessionId: fresh } });
    assert.equal(captured()?.resumeSession, undefined, "a new execution never resumes another session");
    const agent = captured()?.agent as unknown as {
      buildPrintCommand(options: { prompt: string }): { command: string };
    };
    assert.ok(
      agent.buildPrintCommand({ prompt: "p" }).command.includes(`--session-id ${fresh}`),
      "the new session carries the id the factory already associated",
    );
    assert.equal(
      (captured()?.prompt as string).includes("This session CONTINUES"),
      false,
      "a new execution is never told it continues",
    );
  });

  test("a caller with no session selection gets Pi's own fresh session — nothing is invented from the disk", async () => {
    // The port's contract: only a direct caller (no factory, no recovery) may
    // omit the selection. The runtime then starts fresh: it never guesses a
    // session by mtime, and the prompt never claims continuity.
    const sessionsDir = join(workDir, "sessao", "--sandbox-cwd--");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "2026-01-01T00-00-00-000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl"),
      `${JSON.stringify({ type: "session", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })}\n`,
      "utf8",
    );

    await makeRuntime().launch(request);
    assert.equal(captured()?.resumeSession, undefined);
    assert.equal((captured()?.prompt as string).includes("This session CONTINUES"), false);
  });

  test("a requested stop aborts the in-flight run and the launch promise settles with its aftermath", async () => {
    let aborted: string | undefined;
    const runtime = new SandcastleRuntime({
      model: MODEL,
      token: "gh-token",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: join(root, "fabrica"),
      dockerSocket,
      preflight: async () => {},
      runSandcastle: (options) =>
        new Promise<RunResult>((_resolve, reject) => {
          runOptions = options;
          runStarted();
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = "the run was aborted";
              reject(new Error("aborted by the factory"));
            },
            { once: true },
          );
        }),
      dockerProvider: () => dummySandbox(),
    });

    const launched = runtime.launch(request);
    await started;
    runtime.requestStop(request.work);
    const result = await launched;

    assert.equal(aborted, "the run was aborted", "the stop reaches the run's own signal");
    assert.equal(result.outcome, "abrupt-death", "a stopped session ends without an outcome record");
    const events = readFileSync(join(workDir, "log-1.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { event: string });
    assert.ok(
      events.some((event) => event.event === "session-stop"),
      "the log says the session ended by the requested stop, not by a broken run",
    );
  });

  test("a stop requested before the run starts leaves no session footprint", async () => {
    let called = false;
    const runtime = new SandcastleRuntime({
      model: MODEL,
      token: "gh-token",
      agentResources: RESOURCES,
      authEnv: {},
      workspace: join(root, "fabrica"),
      dockerSocket,
      preflight: async () => {},
      runSandcastle: async () => {
        called = true;
        return emptyResult(request.branch);
      },
      dockerProvider: () => dummySandbox(),
    });

    runtime.requestStop(request.work);
    const result = await runtime.launch(request);
    assert.equal(result.outcome, "abrupt-death");
    assert.equal(called, false, "the container was never started");
    assert.equal(existsSync(join(workDir, "log-1.jsonl")), false, "no footprint for a worker that never started");
  });
});
