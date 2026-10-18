import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pi, type PiOptions, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";
import { buildWorkerPrompt, COMPLETION_SIGNAL, PROFILE_MOUNT, WORK_MOUNT } from "./prompt.js";
import {
  SandcastleRuntime,
  SESSIONS_CONTAINER_DIR,
  AGENT_DIR_ENV,
  WORKER_IMAGE,
  MISE_CONTAINER_DIR,
  NPM_CONTAINER_DIR,
  TOOLCHAIN_SUBPATHS,
  defaultPreflight,
} from "./sandcastle.js";
import type { WorkRequest } from "./port.js";

/**
 * The Sandcastle runtime (ticket 17): the real launch behind the WorkerRuntime
 * port, tested with the container call MOCKED AT THE PROCESS BOUNDARY — the
 * `run()` seam plus the `docker()` provider seam. The mechanics (snapshot,
 * mounts, prompt, flags, env, network absence) are asserted on the options the
 * runtime hands over; the artifact contract (sessao/, log-<n>.jsonl,
 * desfecho.json) runs on real temp disk with the real runtime module driving
 * the fake container call. The real container proof is the gated e2e
 * (src/e2e/sandcastle-real.test.ts).
 */

const MODEL = "opencode-go/glm-5.3-flash";

describe("sandcastle runtime — the launch it hands to Sandcastle", () => {
  let root: string;
  let profileDir: string;
  let runOptions: RunOptions | undefined;
  let dockerOptions: DockerOptions | undefined;
  let piOptionsCaptured: PiOptions | undefined;
  let snapshotSeen: { path: string; auth: string | null; hasSessions: boolean } | undefined;
  let runtime: SandcastleRuntime;
  let request: WorkRequest;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-"));
    workspace = join(root, "fabrica");
    profileDir = join(root, "perfil");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "auth.json"), '{"tokens":{"x":1}}', "utf8");
    writeFileSync(join(profileDir, "settings.json"), "{}", "utf8");

    request = {
      ref: { repo: "Sanmoo/my-tasks", number: 42 },
      workDir: join(root, "trabalhos", "Sanmoo#my-tasks#42"),
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: {
        issue: { title: "The issue", body: "The body" },
        diff: "diff --git a/f b/f",
      },
    };

    runtime = new SandcastleRuntime({
      model: MODEL,
      token: "gh-token-for-the-container",
      profileDir,
      workspace,
      blockedLabel: DEFAULT_LABELS.blocked,
      preflight: async () => {}, // the mechanics tests never touch docker
      runSandcastle: async (options) => {
        runOptions = options;
        return emptyResult(request.branch);
      },
      dockerProvider: (options) => {
        dockerOptions = options;
        // The snapshot is only readable DURING the launch — the temp copy
        // dies with it. Read what the container would see, right here.
        const snapshotPath = options.mounts?.[0]?.hostPath;
        if (snapshotPath !== undefined) {
          snapshotSeen = {
            path: snapshotPath,
            auth: existsSync(join(snapshotPath, "auth.json"))
              ? readFileSync(join(snapshotPath, "auth.json"), "utf8")
              : null,
            hasSessions: existsSync(join(snapshotPath, "sessions")),
          };
        }
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

  test("the sandbox mounts: profile snapshot read-only, work dir read-write, sessions read-write, the two toolchain binds read-write", () => {
    return runtime.launch(request).then(() => {
      const mounts = dockerOptions?.mounts ?? [];
      assert.deepEqual(
        mounts.map((mount: { sandboxPath: string; readonly?: boolean }) => [mount.sandboxPath, mount.readonly ?? false]),
        [
          [PROFILE_MOUNT, true],
          [WORK_MOUNT, false],
          [SESSIONS_CONTAINER_DIR, false],
          [MISE_CONTAINER_DIR, false],
          [NPM_CONTAINER_DIR, false],
        ],
      );
      assert.equal(mounts[1]?.hostPath, request.workDir);
      assert.equal(mounts[2]?.hostPath, join(request.workDir, "sessao"));
      assert.match(snapshotSeen?.path ?? "", /perfil/, "the profile mount is the snapshot, not the profile");
    });
  });

  test("the toolchain binds are workspace-derived: the mise data dir and the agent npm tree on the host", async () => {
    await runtime.launch(request);

    const mounts = dockerOptions?.mounts ?? [];
    assert.equal(mounts[3]?.hostPath, join(workspace, TOOLCHAIN_SUBPATHS.mise));
    assert.equal(mounts[4]?.hostPath, join(workspace, TOOLCHAIN_SUBPATHS.agentNpm));
    assert.equal(mounts[3]?.sandboxPath, "/home/agent/.local/share/mise");
    assert.equal(mounts[4]?.sandboxPath, "/home/agent/.pi/agent/npm");
  });

  test("the toolchain host dirs are created idempotently at launch — pre-existing state is never clobbered", async () => {
    const miseDir = join(workspace, TOOLCHAIN_SUBPATHS.mise);
    const npmDir = join(workspace, TOOLCHAIN_SUBPATHS.agentNpm);
    mkdirSync(miseDir, { recursive: true });
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(miseDir, "go"), "x", "utf8");
    writeFileSync(join(npmDir, "some-package"), "x", "utf8");

    await runtime.launch(request);
    await runtime.launch(request); // a second launch reuses, never resets

    assert.ok(existsSync(join(miseDir, "go")), "the mise volume survives across launches");
    assert.ok(existsSync(join(npmDir, "some-package")), "the npm volume survives across launches");
  });

  test("the profile mount holds the snapshot: real files in, sessions out, never the operator's own profile", async () => {
    mkdirSync(join(profileDir, "sessions"), { recursive: true });
    writeFileSync(join(profileDir, "sessions", "s.jsonl"), "{}\n", "utf8");

    await runtime.launch(request);

    assert.ok(snapshotSeen, "the profile was snapshotted");
    assert.notEqual(snapshotSeen!.path, profileDir, "the container mounts a copy, never the real profile");
    assert.equal(snapshotSeen!.auth, '{"tokens":{"x":1}}');
    assert.equal(snapshotSeen!.hasSessions, false, "session storage never rides the snapshot");
    assert.ok(!existsSync(snapshotSeen!.path), "the temp snapshot dies with the launch");
  });

  test("the agent is the Pi headless template in print mode with the proven closed flags", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as {
      name: string;
      buildPrintCommand(options: { prompt: string }): { command: string; stdin?: string };
    };
    assert.equal(agent.name, "pi");
    const command = agent.buildPrintCommand({ prompt: "p" }).command;
    assert.match(command, /^pi -p --mode json --model/);
    assert.ok(command.includes(MODEL), "the configured model rides the print command");
    for (const flag of [
      "--approve",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-mcp",
      "--tools read,bash,edit,write",
    ]) {
      assert.ok(command.includes(flag), `the print command carries ${flag}`);
    }
  });

  test("the agent env points PI_CODING_AGENT_DIR at the writable copy — never a mount of the real profile", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as { env: Record<string, string> };
    assert.equal(agent.env[AGENT_DIR_ENV], "/home/agent/.pi/agent");
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

  test("a sandbox-ready hook copies the read-only snapshot into the writable agent dir", async () => {
    await runtime.launch(request);

    const hook = runOptions?.hooks?.sandbox?.onSandboxReady?.[0];
    assert.ok(hook, "one setup hook");
    assert.match(hook.command, new RegExp(`${PROFILE_MOUNT}`));
    assert.match(hook.command, /\$HOME\/\.pi\/agent/);
    assert.match(hook.command, /auth\.json/);
  });

  test("the toolchain converges BEFORE the prompt: mise install lands the declared tools in the persistent volume", async () => {
    await runtime.launch(request);

    const hooks = runOptions?.hooks?.sandbox?.onSandboxReady ?? [];
    assert.equal(hooks.length, 2, "profile copy, then the toolchain convergence");
    const mise = hooks[1];
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
      env: { [AGENT_DIR_ENV]: "/home/agent/.pi/agent" },
      sessionStorage: { hostSessionsDir: join(request.workDir, "sessao") },
    });
  });
});

describe("sandcastle runtime — the artifact contract on real disk (ticket 13's)", () => {
  let root: string;
  let profileDir: string;
  let request: WorkRequest;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-disk-"));
    profileDir = join(root, "perfil");
    mkdirSync(profileDir, { recursive: true });
    request = {
      ref: { repo: "Sanmoo/my-tasks", number: 42 },
      workDir: join(root, "trabalhos", "Sanmoo#my-tasks#42"),
      branch: "agent-issue-42",
      repoDir: join(root, "repos", "Sanmoo#my-tasks"),
      baseBranch: "main",
      attempt: 1,
      material: { issue: { title: "t", body: "b" }, diff: "" },
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtimeThat(fakes: {
    outcome?: OutcomeRecord["class"];
    die?: string;
  }): SandcastleRuntime {
    return new SandcastleRuntime({
      model: MODEL,
      token: "t",
      profileDir,
      workspace: root,
      preflight: async () => {}, // offline: the contract tests never touch docker
      runSandcastle: async () => {
        if (fakes.die !== undefined) throw new Error(fakes.die);
        if (fakes.outcome !== undefined) {
          const record: OutcomeRecord = {
            class: fakes.outcome,
            attempt: request.attempt,
            ...(fakes.outcome === "pr-open"
              ? { pr: { repo: request.ref.repo, number: 9, branch: request.branch } }
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
      profileDir,
      workspace: root,
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

  test("attempt numbering comes from the WorkRequest — attempt 2 writes log-2.jsonl", async () => {
    await runtimeThat({ outcome: "clean-without-pr" }).launch({ ...request, attempt: 2 });

    assert.ok(readLines(join(request.workDir, "log-2.jsonl"))[0]?.includes("session-start"));
    assert.ok(existsSync(join(request.workDir, "sessao")));
  });

  test("a preflight failure throws before any footprint — infra is not a work fall", async () => {
    const failing = new SandcastleRuntime({
      model: MODEL,
      token: "t",
      profileDir,
      workspace: root,
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

  test("the default preflight checks docker, the image and a non-empty token", async () => {
    const checks: string[][] = [];
    const recorded = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      run: async (command, args) => {
        checks.push([command, ...args]);
        return { stdout: "29.7.2", stderr: "" };
      },
    });
    await recorded();
    assert.deepEqual(checks, [
      ["docker", "info", "--format", "{{.ServerVersion}}"],
      ["docker", "image", "inspect", WORKER_IMAGE],
    ]);

    const failing = defaultPreflight({
      token: "",
      image: WORKER_IMAGE,
      run: async () => ({ stdout: "29.7.2", stderr: "" }),
    });
    await assert.rejects(failing, /token/);
  });
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
