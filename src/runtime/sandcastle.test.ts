import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, describe, beforeEach, afterEach } from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pi, type PiOptions, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { buildWorkerPrompt, COMPLETION_SIGNAL, PROFILE_MOUNT, WORK_MOUNT } from "./prompt.js";
import {
  SandcastleRuntime,
  SESSIONS_CONTAINER_DIR,
  AGENT_DIR_ENV,
  MISE_CONTAINER_DIR,
  NPM_CONTAINER_DIR,
  TOOLCHAIN_SUBPATHS,
  WORKER_FLAG_ARGS,
  defaultPreflight,
  dockerSocketFromHost,
  unixSocketPath,
  workerShapedDockerRun,
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

/** The daemon socket the launch binds (ADR 0003) — pinned like the token:
 *  the mechanics tests never read the machine's real socket. */
const SOCKET = { hostPath: "/var/run/docker.sock", gid: 969 };
const dockerSocket = () => SOCKET;

describe("sandcastle runtime — the launch it hands to Sandcastle", () => {
  let root: string;
  let profileDir: string;
  let runOptions: RunOptions | undefined;
  let dockerOptions: DockerOptions | undefined;
  let piOptionsCaptured: PiOptions | undefined;
  let snapshotSeen: { path: string; auth: string | null; hasSessions: boolean; hasSkills: boolean } | undefined;
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
      dockerSocket,
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
            hasSkills:
              existsSync(join(snapshotPath, "skills", "implement", "SKILL.md")) &&
              existsSync(join(snapshotPath, "skills", "code-review", "SKILL.md")),
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

  test("the sandbox mounts: profile snapshot read-only, work dir read-write, sessions read-write, the two toolchain binds read-write, the daemon socket", () => {
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
          [SOCKET.hostPath, false],
        ],
      );
      assert.equal(mounts[1]?.hostPath, request.workDir);
      assert.equal(mounts[2]?.hostPath, join(request.workDir, "sessao"));
      assert.equal(mounts[5]?.hostPath, SOCKET.hostPath, "the socket rides its own host path — DOCKER_HOST names it");
      assert.match(snapshotSeen?.path ?? "", /perfil/, "the profile mount is the snapshot, not the profile");
    });
  });

  test("the container inherits Docker: the socket's group as a supplementary gid and DOCKER_HOST naming the bind (ADR 0003)", async () => {
    await runtime.launch(request);

    assert.deepEqual(dockerOptions?.groups, [SOCKET.gid], "the container user joins the socket's group — not root, not a guess");
    assert.equal(dockerOptions?.env?.["DOCKER_HOST"], `unix://${SOCKET.hostPath}`);
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

  test("the worker's profile carries the operator's skills: /implement and /code-review reach the container (ticket 85)", async () => {
    // The profile's skills are the SOURCE of the procedure (ticket 85): the
    // container mounts a snapshot, so the skills must survive it — real
    // files in, same paths out. The operator's global skills stay untouched.
    mkdirSync(join(profileDir, "skills", "implement"), { recursive: true });
    writeFileSync(join(profileDir, "skills", "implement", "SKILL.md"), "---\nname: implement\n---\nImplement.", "utf8");
    mkdirSync(join(profileDir, "skills", "code-review"), { recursive: true });
    writeFileSync(join(profileDir, "skills", "code-review", "SKILL.md"), "---\nname: code-review\n---\nReview.", "utf8");

    await runtime.launch(request);

    assert.equal(snapshotSeen?.hasSkills, true, "both SKILL.md files ride the snapshot into the container");
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

  test("the agent is the Pi headless template in print mode with the proven closed flags (WORKER_FLAG_ARGS)", async () => {
    await runtime.launch(request);

    const agent = runOptions?.agent as unknown as {
      name: string;
      buildPrintCommand(options: { prompt: string }): { command: string; stdin?: string };
    };
    assert.equal(agent.name, "pi");
    const command = agent.buildPrintCommand({ prompt: "p" }).command;
    assert.match(command, /^pi -p --mode json --model/);
    assert.ok(command.includes(MODEL), "the configured model rides the print command");
    // the flags are single-sourced in WORKER_FLAG_ARGS — the test asserts
    // the constant is what the print command actually carries, entry by entry
    for (const flag of WORKER_FLAG_ARGS) {
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
      dockerSocket,
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
      profileDir,
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

  test("the default preflight checks docker, the image, the token, the git credential helper and Docker inside the worker", async () => {
    const checks: string[][] = [];
    const recorded = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      dockerSocket: SOCKET,
      run: async (command, args) => {
        checks.push([command, ...args]);
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
      dockerSocket: SOCKET,
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
      dockerSocket: SOCKET,
      run: async (_command, args) =>
        args[0] === "run" ? { stdout: "", stderr: "" } : { stdout: "ok", stderr: "" },
    });
    await assert.rejects(failing, /no git credential helper for github\.com/);
    await assert.rejects(failing, /npm run build:image/);
  });

  test("the default preflight refuses an image with no docker CLI — the worker would self-report a missing Docker", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      dockerSocket: SOCKET,
      run: async (_command, args) => {
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
      dockerSocket: SOCKET,
      run: async (_command, args) => {
        if (args.includes("git")) return { stdout: "!gh auth git-credential", stderr: "" };
        if (args.includes("buildx")) throw new Error('docker: "buildx" is not a docker command');
        return { stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(failing, /has no buildx builder/);
    await assert.rejects(failing, /is not a docker command/);
  });

  test("the default preflight refuses a socket the container user cannot reach — an actionable gid", async () => {
    const failing = defaultPreflight({
      token: "present",
      image: WORKER_IMAGE,
      dockerSocket: SOCKET,
      run: async (_command, args) => {
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
      await defaultPreflight({ token: "probe", image: WORKER_IMAGE, dockerSocket: socket })();

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
  let profileDir: string;
  let request: WorkRequest;

  /** A short REAL limit: the suite never waits the production ten minutes. */
  const SHORT_IDLE_SECONDS = 0.3;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-sandcastle-idle-"));
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

  function runtimeWith(runSandcastle: (options: RunOptions) => Promise<RunResult>): SandcastleRuntime {
    return new SandcastleRuntime({
      model: MODEL,
      token: "t",
      profileDir,
      workspace: root,
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
      (captured?.idleTimeoutSeconds ?? 0) >= SHORT_IDLE_SECONDS * 2,
      "Sandcastle's timer never preempts the verified-activity limit",
    );
  });
});
