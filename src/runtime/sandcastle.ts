import { execFile as execFileCallback } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { run as sandcastleRun, pi, type AgentProvider, type AgentStreamEvent, type PiOptions, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import { docker, type DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { buildWorkerPrompt, COMPLETION_SIGNAL, PROFILE_MOUNT, WORK_MOUNT } from "./prompt.js";
import { startActivityWatch } from "./activity.js";
import { snapshotProfile, DEFAULT_SNAPSHOT_SKIP } from "./profile-snapshot.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "./port.js";

const execFile = promisify(execFileCallback);

/**
 * The real runtime (ticket 17): worker sessions ARE Sandcastle — the `run()`
 * API of `@ai-hero/sandcastle` with the Pi headless template in print mode —
 * behind the same WorkerRuntime port the fake mirrors. The proven mechanics
 * of the v1 (research 01-sandcastle-sessao-headless):
 *
 *   - the container NEVER mounts the operator's real profile: the host
 *     resolves it once into a read-only snapshot (profile-snapshot.ts) and a
 *     sandbox-ready hook copies it into the container's writable agent dir —
 *     OAuth renewal and session writes happen on the copy;
 *   - the work's session dir (<workDir>/sessao/) is bind-mounted read-write
 *     at the agent's session path: the session is persisted on the HOST;
 *   - GH_TOKEN rides the container env: `gh` inside authenticates as the
 *     factory's worker account (scan goes through the keyring — ticket 09);
 *   - no `network` option: Docker's default bridge, open egress;
 *   - the work branch strategy is the named branch the git host prepared,
 *     born from the base it reported — Sandcastle reuses the existing
 *     worktree when clean and preserves it when dirty;
 *   - one full agent run per launch (`maxIterations: 1`); the session ends
 *     its turn with the completion signal after writing its outcome record.
 *
 * The artifact contract (ticket 13) is written around the session: sessao/
 * and log-<n>.jsonl at launch time — BEFORE any outcome, so an abrupt death
 * leaves the footprint the registry reads — and desfecho.json whenever the
 * session manages (the worker writes it through the /msf-work mount; its
 * absence is the class "abrupt-death" and nothing writes it for it).
 */

/** Inside the container: the agent dir is the writable COPY of the snapshot. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const AGENT_DIR = "/home/agent/.pi/agent";
export const SESSIONS_CONTAINER_DIR = `${AGENT_DIR}/sessions`;

/**
 * The toolchain convergence layer (ticket 18): the workspace subpaths bound
 * read-write over the container's toolchain homes. Tools installed by `mise`
 * inside these host dirs persist ACROSS launches — the container is recreated
 * per work, the volume survives — so the first launch of a new toolchain pays
 * the install and every later launch reuses it. The v1's proven sandboxMounts
 * (research 01-sandcastle-sessao-headless): the mise data dir (shared between
 * profiles) and the agent's npm tree.
 */
export const TOOLCHAIN_SUBPATHS = {
  /** <workspace>/toolchains/mise → /home/agent/.local/share/mise (RW). */
  mise: "toolchains/mise",
  /** <workspace>/toolchains/agent/npm → /home/agent/.pi/agent/npm (RW). */
  agentNpm: "toolchains/agent/npm",
} as const;
export const MISE_CONTAINER_DIR = "/home/agent/.local/share/mise";
export const NPM_CONTAINER_DIR = `${AGENT_DIR}/npm`;

/**
 * Docker inside the worker (ADR 0003): the worker inherits the host's daemon
 * by binding its socket and joining the socket's group, so it builds the
 * worker image and runs the repo's real Docker tests. The container sees the
 * socket where the host has it, and DOCKER_HOST names that same path.
 */
export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

/** The daemon socket a worker container inherits, with the group it needs. */
export interface DockerSocket {
  /** The daemon socket on the host — the same path inside the container. */
  hostPath: string;
  /** The socket's gid: the supplementary group the container user joins to
   *  read a root-owned 0660 socket (Docker-outside-of-Docker). */
  gid: number;
}

export interface DockerSocketDeps {
  env?: NodeJS.ProcessEnv;
  /** Injectable stat for the tests; the default reads the real socket. */
  stat?: (path: string) => Pick<Stats, "gid" | "isSocket">;
}

/**
 * The socket the host's Docker answers on. Refuses instead of guessing: a
 * daemon reached over tcp has no socket to bind, and a missing socket lands in
 * the container as an empty mount.
 */
export function dockerSocketFromHost(deps: DockerSocketDeps = {}): DockerSocket {
  const hostPath = unixSocketPath((deps.env ?? process.env).DOCKER_HOST);
  const stat = deps.stat ?? ((path: string) => statSync(path));
  let stats: Pick<Stats, "gid" | "isSocket">;
  try {
    stats = stat(hostPath);
  } catch {
    throw new Error(
      `the Docker daemon socket ${hostPath} is missing — the worker inherits Docker through it. Start Docker (or point DOCKER_HOST at the socket your daemon uses) and run again.`,
    );
  }
  if (!stats.isSocket()) {
    throw new Error(
      `the Docker daemon path ${hostPath} is not a unix socket — the worker inherits Docker by binding it. Point DOCKER_HOST at the daemon's socket.`,
    );
  }
  return { hostPath, gid: stats.gid };
}

/** The unix socket path DOCKER_HOST names, or the default when unset. */
export function unixSocketPath(dockerHost: string | undefined): string {
  const host = dockerHost?.trim() ?? "";
  if (host === "") return DEFAULT_DOCKER_SOCKET_PATH;
  const prefix = host.startsWith("unix://") ? "unix://" : host.startsWith("unix:") ? "unix:" : null;
  if (prefix === null) {
    throw new Error(
      `DOCKER_HOST=${host} is not a unix socket — the worker inherits Docker through a bind-mounted socket, so the factory needs a socket-based daemon (unset DOCKER_HOST, or set it to unix://${DEFAULT_DOCKER_SOCKET_PATH}).`,
    );
  }
  return host.slice(prefix.length);
}

/**
 * The `docker run` flags that shape a probe like a worker container: the
 * socket's group, the bind and DOCKER_HOST. They live HERE, once, because the
 * launch's preconditions and the real Docker test both prove the capability —
 * two hand-written copies would let the proof drift from the launch.
 */
export function workerShapedDockerRun(
  socket: DockerSocket,
  image: string,
  entrypoint: string,
  args: readonly string[],
): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--group-add",
    String(socket.gid),
    "-e",
    `DOCKER_HOST=unix://${socket.hostPath}`,
    "-v",
    `${socket.hostPath}:${socket.hostPath}`,
    "--entrypoint",
    entrypoint,
    image,
    ...args,
  ];
}

/** The mise convergence hook's ceiling: a first install of many declared
 *  tools (java, elixir, python…) is slow — the launch waits so the session
 *  NEVER meets a missing declared tool; every later launch is a no-op hit
 *  on the persisted volume. */
export const TOOLCHAIN_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

/** Where the host profiles live by default. */
export const DEFAULT_PROFILE_DIR = join(homedir(), ".pi", "agent");

/** The proven closed flags of the worker's print command (v1 agentFor):
 *  automatic tool approval, no context files / prompt templates / MCP, a
 *  closed tool list. pi's buildPrintCommand returns a bare command STRING
 *  (PrintCommand carries `command` + optional `stdin`, no structured args
 *  array), so the flags ride a string concatenation — single-sourced HERE:
 *  this constant is the only place the list lives, and the one concatenation
 *  in runOptionsFor is the only place it is applied. Change the flags here,
 *  never inline. */
export const WORKER_FLAG_ARGS: readonly string[] = [
  "--approve",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-mcp",
  "--tools read,bash,edit,write,subagent,subagents_enable",
  "--exclude-tools 'mcp__*,mcp'",
];

const PROFILE_SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

/**
 * The sandbox's own clock is a LAST RESORT behind the activity watchdog (issue
 * 112): the agent can be silent on stdout for a long time while its reviewer
 * subagents work, so the effective idle limit is the one measured on verifiable
 * activity. Sandcastle's timer only guards the case where the watchdog itself
 * cannot see the filesystem — never the ordinary wait on a live subagent.
 */
const SANDBOX_BACKSTOP_FACTOR = 6;

/** The polling interval of the activity watch: often enough to notice work
 *  well inside a short limit, rarely enough not to walk the tree constantly. */
function defaultActivityPollMs(idleMs: number): number {
  return Math.max(100, Math.min(Math.floor(idleMs / 4), 30_000));
}

export interface SandcastleRuntimeOptions {
  /** Pi model for the headless session: "provider/model-id". */
  model: string;
  /** The worker account's GitHub token — injected as GH_TOKEN in the container. */
  token: string;
  /** The worker image; defaults to WORKER_IMAGE (build with `npm run build:image`). */
  image?: string;
  /** The operator's Pi agent dir to snapshot; defaults to ~/.pi/agent. */
  profileDir?: string;
  /** Roots the profile may reach through links; see profile-snapshot.ts. */
  allowedRoots?: readonly string[];
  /** Stale (dangling) profile links are skipped and logged instead of
   * blocking the launch. Off by default — fail closed. */
  skipDanglingProfileLinks?: boolean;
  /** Extra top-level profile entries not copied (on top of sessions and
   * npm) — operator state with no meaning in the container. */
  skipProfileEntries?: readonly string[];
  /** The workspace root the toolchain binds derive from (the convergence
   * layer): <workspace>/toolchains/... created idempotently at launch and
   * bound read-write so installed toolchains survive the container. */
  workspace: string;
  /** The Docker daemon socket the container inherits (ADR 0003). Resolved at
   * launch; defaults to dockerSocketFromHost(). */
  dockerSocket?: () => DockerSocket;
  /** The blocked label the worker self-reports; defaults to the config default. */
  blockedLabel?: string;
  /** Full agent runs per launch; defaults to 1 (one session, one full run). */
  maxIterations?: number;
  /** Sandcastle's idle timeout in seconds — the SANDBOX backstop; the effective
   *  idle limit is measured on verifiable agent activity (issue 112). */
  idleTimeoutSeconds?: number;
  /** How often the activity watch reads the watched tree; derived from the idle
   *  limit when unset (tests shorten it). */
  activityPollMs?: number;

  // ---- process-boundary seams (tests inject; production leaves unset) ----
  /** The Pi agent factory itself. */
  piProvider?: (model: string, options?: PiOptions) => AgentProvider;
  /** The Sandcastle `run()` itself. */
  runSandcastle?: (options: RunOptions) => Promise<RunResult>;
  /** The docker provider factory. */
  dockerProvider?: (options: DockerOptions) => SandboxProvider;
  /** Launch preconditions; default defaultPreflight. */
  preflight?: () => Promise<void>;
}

export class SandcastleRuntime implements WorkerRuntime {
  private readonly model: string;
  private readonly token: string;
  private readonly image: string;
  private readonly workspace: string;
  private readonly resolveDockerSocket: () => DockerSocket;
  private readonly profileDir: string;
  private readonly allowedRoots: readonly string[];
  private readonly skipDanglingProfileLinks: boolean;
  private readonly skipProfileEntries: readonly string[];
  private readonly blockedLabel: string;
  private readonly maxIterations: number;
  private readonly idleTimeoutSeconds: number;
  private readonly activityPollMs: number;
  private readonly runSandcastle: (options: RunOptions) => Promise<RunResult>;
  private readonly dockerProvider: (options: DockerOptions) => SandboxProvider;
  private readonly preflight: () => Promise<void>;
  private readonly piProvider: (model: string, options?: PiOptions) => AgentProvider;

  constructor(options: SandcastleRuntimeOptions) {
    this.model = options.model;
    this.token = options.token;
    this.image = options.image ?? WORKER_IMAGE;
    this.workspace = options.workspace;
    this.resolveDockerSocket = options.dockerSocket ?? (() => dockerSocketFromHost());
    this.profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
    this.allowedRoots = options.allowedRoots ?? [];
    this.skipDanglingProfileLinks = options.skipDanglingProfileLinks ?? false;
    this.skipProfileEntries = options.skipProfileEntries ?? [];
    this.blockedLabel = options.blockedLabel ?? DEFAULT_LABELS.blocked;
    this.maxIterations = options.maxIterations ?? 1;
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
    this.activityPollMs =
      options.activityPollMs ?? defaultActivityPollMs(this.idleTimeoutSeconds * 1000);
    this.runSandcastle = options.runSandcastle ?? (async (runOptions) => sandcastleRun(runOptions));
    this.dockerProvider = options.dockerProvider ?? ((dockerOptions) => docker(dockerOptions));
    this.preflight =
      options.preflight ??
      (async () =>
        defaultPreflight({
          token: this.token,
          image: this.image,
          dockerSocket: this.resolveDockerSocket(),
        })());
    this.piProvider = options.piProvider ?? ((model, piOptions) => pi(model, piOptions));
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    // Preconditions BEFORE any footprint: infra and config failures are not
    // work falls — the factory fails fast with the reason (the v1's refusal).
    await this.preflight();

    // The Docker socket the container inherits (ADR 0003), resolved with the
    // preconditions: a socket that vanished between the two is the factory's
    // failure to refuse out loud, never a work-level fall.
    const dockerSocket = this.resolveDockerSocket();

    // The read-only profile snapshot: resolved once, mounted, copied by the
    // hook, and gone after the launch (never the operator's own profile).
    const snapshotDir = mkdtempSync(join(tmpdir(), "msf-perfil-"));
    try {
      const { warnings } = await snapshotProfile(this.profileDir, snapshotDir, {
        allowedRoots: this.allowedRoots,
        skipDanglingLinks: this.skipDanglingProfileLinks,
        skip: [...DEFAULT_SNAPSHOT_SKIP, ...this.skipProfileEntries],
      });

      // The footprint comes first (ticket 13): sessao/ and the attempt's log
      // exist before any outcome can exist. An abrupt death leaves exactly
      // this — the start line without an end, the record's absence.
      const sessionsDir = join(request.workDir, "sessao");
      mkdirSync(sessionsDir, { recursive: true });
      this.event(request, "session-start", {
        branch: request.branch,
        baseBranch: request.baseBranch,
        model: this.model,
        image: this.image,
        ...(warnings.length > 0 ? { profileWarnings: warnings } : {}),
      });

      // The verified-activity idle limit (issue 112): the watchdog aborts the
      // run once nothing verifiable happened for the configured idle time.
      const watch = this.activityWatch(request, sessionsDir);
      let outcome: SessionResult["outcome"];
      try {
        await this.runSandcastle(
          this.runOptionsFor(request, snapshotDir, sessionsDir, dockerSocket, watch.signal),
        );
        outcome = await this.observedOutcome(request);
      } catch (error) {
        this.event(request, "session-failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        outcome = "abrupt-death";
      } finally {
        // The watch dies with the session: a resolved or failed run is not an idle.
        watch.stop();
      }
      this.event(request, "session-end", { outcome });
      return { request, outcome };
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  /**
   * The verified-activity idle limit (issue 112): a watchdog over the files the
   * agents write, aborting the run once nothing verifiable happened for the
   * configured idle time. Reviewer subagent transcripts count (they are real
   * work); the factory's own logs do not (they only echo stdout). The returned
   * signal carries the abort into Sandcastle, which kills the agent subprocess.
   */
  private activityWatch(
    request: WorkRequest,
    sessionsDir: string,
  ): { signal: AbortSignal; stop: () => void } {
    const idleMs = this.idleTimeoutSeconds * 1000;
    const controller = new AbortController();
    const watch = startActivityWatch({
      dirs: [sessionsDir, request.workDir],
      exclude: [
        join(request.workDir, `log-${request.attempt}.jsonl`),
        join(sessionsDir, `sandcastle-${request.attempt}.log`),
      ],
      idleMs,
      pollMs: this.activityPollMs,
      onIdle: (measured) => {
        this.appendLine(join(request.workDir, `log-${request.attempt}.jsonl`), {
          event: "activity-idle",
          attempt: request.attempt,
          idleMs: Math.round(measured),
        });
        controller.abort(
          new Error(
            `no verifiable activity for ${formatIdle(measured)} — the session was ended by the idle limit`,
          ),
        );
      },
    });
    return { signal: controller.signal, stop: () => watch.stop() };
  }

  /** The toolchain binds (ticket 18): workspace-derived host dirs, created
   * idempotently at launch (mkdir is a no-op on an existing volume) and bound
   * read-write. Convergence happens INSIDE the volume across launches — the
   * runtime itself never pre-installs a toolchain. */
  private toolchainBinds(): Array<{ hostPath: string; sandboxPath: string; readonly: false }> {
    const miseDir = join(this.workspace, TOOLCHAIN_SUBPATHS.mise);
    const npmDir = join(this.workspace, TOOLCHAIN_SUBPATHS.agentNpm);
    mkdirSync(miseDir, { recursive: true });
    mkdirSync(npmDir, { recursive: true });
    return [
      { hostPath: miseDir, sandboxPath: MISE_CONTAINER_DIR, readonly: false },
      { hostPath: npmDir, sandboxPath: NPM_CONTAINER_DIR, readonly: false },
    ];
  }

  /** The Docker socket bind (ADR 0003): the host's daemon socket, read-write
   * (a socket is a channel, not a file tree), at the path the host has it. */

  /** The RunOptions handed to Sandcastle — the mechanics, in one place. */
  private runOptionsFor(
    request: WorkRequest,
    snapshotDir: string,
    sessionsDir: string,
    dockerSocket: DockerSocket,
    signal: AbortSignal,
  ): RunOptions {
    const agent = this.piProvider(this.model, {
      // No implicit capture: the sessions bind does the persistence, the
      // session file already lives on the host (the resume path of later
      // tickets reads it from there).
      captureSessions: false,
      env: { [AGENT_DIR_ENV]: AGENT_DIR },
      sessionStorage: { hostSessionsDir: sessionsDir },
    });

    // The proven closed flags (v1 agentFor): automatic tool approval, no
    // context files / prompt templates / MCP, a closed tool list — the one
    // concatenation that applies WORKER_FLAG_ARGS (single-sourced above;
    // pi's print command is a string, not structured args).
    const agentWithFlags = {
      ...agent,
      buildPrintCommand(options: Parameters<typeof agent.buildPrintCommand>[0]) {
        const command = agent.buildPrintCommand(options);
        return {
          ...command,
          command: `${command.command} ${WORKER_FLAG_ARGS.join(" ")}`,
        };
      },
    };

    return {
      agent: agentWithFlags,
      sandbox: this.dockerProvider({
        imageName: this.image,
        // GH_TOKEN authenticates gh; DOCKER_HOST names the socket the worker
        // inherits, so the CLI inside reaches the host daemon (ADR 0003).
        env: { GH_TOKEN: this.token, DOCKER_HOST: `unix://${dockerSocket.hostPath}` },
        // The socket's own group, as a supplementary gid: the container user
        // is the host user, not root, and the socket is root-owned 0660.
        groups: [dockerSocket.gid],
        // No `network` — Docker's default bridge, open egress.
        mounts: [
          { hostPath: snapshotDir, sandboxPath: PROFILE_MOUNT, readonly: true },
          { hostPath: request.workDir, sandboxPath: WORK_MOUNT, readonly: false },
          { hostPath: sessionsDir, sandboxPath: SESSIONS_CONTAINER_DIR, readonly: false },
          ...this.toolchainBinds(),
          { hostPath: dockerSocket.hostPath, sandboxPath: dockerSocket.hostPath, readonly: false },
        ],
      }),
      cwd: request.repoDir,
      // The branch the git host prepared: reuse when clean, preserve when
      // dirty (Sandcastle's own worktree behavior) — never recreated.
      branchStrategy: { type: "branch", branch: request.branch, baseBranch: request.baseBranch },
      prompt: buildWorkerPrompt(request, { blockedLabel: this.blockedLabel }),
      maxIterations: this.maxIterations,
      completionSignal: COMPLETION_SIGNAL,
      idleTimeoutSeconds: this.idleTimeoutSeconds * SANDBOX_BACKSTOP_FACTOR,
      signal,
      name: `work-${request.ref.number}-attempt-${request.attempt}`,
      hooks: {
        sandbox: {
          onSandboxReady: [
            {
              // The writable agent dir is built from the read-only snapshot
              // BEFORE the prompt (the v1's prepare-profile, inlined): the
              // agent dir must be writable because OAuth renewal rewrites
              // auth.json and sessions are written by default.
              command:
                `mkdir -p "$HOME/.pi/agent" && ` +
                `cp -R ${PROFILE_MOUNT}/. "$HOME/.pi/agent/" && ` +
                `[ -f "$HOME/.pi/agent/auth.json" ] && chmod 600 "$HOME/.pi/agent/auth.json" || true`,
              timeoutMs: PROFILE_SETUP_TIMEOUT_MS,
            },
            {
              // The toolchain convergence BEFORE the prompt (the declared
              // tools are ready, never hunted mid-session): `mise install`
              // reads the active configs (the snapshot's global config and
              // the repo's mise.toml, when the repo declares one) and lands
              // every declared tool + shim in the PERSISTENT volume. First
              // launch of a toolchain pays; every later launch is a no-op.
              command: "mise install -y",
              timeoutMs: TOOLCHAIN_SETUP_TIMEOUT_MS,
            },
          ],
        },
      },
      logging: {
        type: "file",
        // The attempt's readable log rides the session dir (inspection).
        path: join(request.workDir, "sessao", `sandcastle-${request.attempt}.log`),
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          this.agentEvent(request, event);
        },
      },
    };
  }

  /** The outcome the runtime observed: the record's class, or the absence. */
  private async observedOutcome(request: WorkRequest): Promise<SessionResult["outcome"]> {
    const record: OutcomeRecord | null = await readOutcomeRecord(request.workDir);
    return record?.class ?? "abrupt-death";
  }

  private event(request: WorkRequest, event: string, extra: Record<string, unknown> = {}): void {
    this.appendLine(join(request.workDir, `log-${request.attempt}.jsonl`), {
      event,
      attempt: request.attempt,
      ...extra,
    });
  }

  private agentEvent(request: WorkRequest, event: AgentStreamEvent): void {
    const payload: Record<string, unknown> =
      event.type === "text"
        ? { event: "agent-text", message: event.message }
        : event.type === "toolCall"
          ? { event: "agent-tool", tool: event.name, args: event.formattedArgs }
          : { event: "agent-raw", line: event.line };
    this.appendLine(join(request.workDir, `log-${request.attempt}.jsonl`), {
      attempt: request.attempt,
      iteration: event.iteration,
      ...payload,
    });
  }

  private appendLine(path: string, value: Record<string, unknown>): void {
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  }
}

export async function workerToken(account: string): Promise<string> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  let stdout: string;
  try {
    ({ stdout } = await execFile("gh", ["auth", "token", "--user", account], { encoding: "utf8", env }));
  } catch {
    throw new Error(
      `gh has no token for account ${account}; the factory's worker account is the only source — no fallback to another account.`,
    );
  }
  const token = stdout.trim();
  if (token === "") {
    throw new Error(`gh returned an empty token for account ${account}; the factory's worker account is the only source.`);
  }
  return token;
}

// ---- the launch preconditions ----

export interface PreflightDeps {
  token: string;
  image: string;
  /** The daemon socket the worker container inherits (ADR 0003). */
  dockerSocket: DockerSocket;
  /** The command runner (docker); injectable for tests. */
  run?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * The launch preconditions (the v1's refusal pattern): Docker is alive, the
 * worker image exists, the token is present, the image carries the git
 * credential helper the worker's push needs, the image carries the docker CLI
 * and the socket bind really reaches the daemon (ADR 0003). A failure is a
 * factory-level failure, not a work outcome — the launch throws before any
 * artifact.
 */
export function defaultPreflight(deps: PreflightDeps): () => Promise<void> {
  return async () => {
    const run = deps.run ?? (async (command, args) => execFile(command, args, { encoding: "utf8" }));

    try {
      await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    } catch {
      throw new Error("Docker is unavailable (docker info failed) — refusing to launch a worker.");
    }
    try {
      await run("docker", ["image", "inspect", deps.image]);
    } catch {
      throw new Error(
        `worker image ${deps.image} is missing. Build it with: npm run build:image`,
      );
    }
    if (deps.token === "") {
      throw new Error(
        "no GitHub token for the worker: pass the worker account's token (gh keyring) — GH_TOKEN is how the container authenticates.",
      );
    }

    // The worker publishes with `git push` over HTTPS. GH_TOKEN authenticates
    // gh, but git only calls the keyring bridge when the image configures a
    // credential.helper; an image without it fails at the push with "could
    // not read Username", which the worker can only read as a work-level
    // blocked report. Refuse at boot instead, naming the rebuild. The check
    // reads the image's config from a throwaway container — no network, no
    // artifact, no workspace.
    let helper = "";
    try {
      ({ stdout: helper } = await run("docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "git",
        deps.image,
        "config",
        "--get",
        "credential.https://github.com.helper",
      ]));
    } catch {
      helper = "";
    }
    if (helper.trim() === "") {
      throw new Error(
        `worker image ${deps.image} has no git credential helper for github.com — the worker cannot push. Rebuild it with: npm run build:image`,
      );
    }

    // Docker INSIDE the worker (ADR 0003). A capability the image lacks or a
    // socket the container user cannot read lands in the round as a "no docker
    // here" blocked report — the agent has nothing to distinguish it from a
    // host without Docker. Under test is the MANDATED operation, not just the
    // binary: `npm run build:image` needs the CLI, the buildx builder and the
    // daemon, so a throwaway container shaped like a worker proves all three.
    const socket = deps.dockerSocket;
    const probe = (entrypoint: string, args: string[]) =>
      run("docker", workerShapedDockerRun(socket, deps.image, entrypoint, args));

    try {
      await probe("docker", ["--version"]);
    } catch (error) {
      throw new Error(
        `worker image ${deps.image} carries no usable docker CLI (docker --version failed inside it: ${reasonOf(error)}). Rebuild it with: npm run build:image`,
      );
    }
    try {
      await probe("docker", ["buildx", "version"]);
    } catch (error) {
      throw new Error(
        `worker image ${deps.image} has no buildx builder (docker buildx version failed inside it: ${reasonOf(error)}) — npm run build:image would fail in the round. Rebuild it with: npm run build:image`,
      );
    }
    try {
      await probe("docker", ["info", "--format", "{{.ServerVersion}}"]);
    } catch (error) {
      throw new Error(
        `worker image ${deps.image} cannot reach the Docker daemon through ${socket.hostPath} as gid ${socket.gid} (docker info inside it failed: ${reasonOf(error)}) — a worker would have no Docker. Check that this is the daemon's socket and that its group is readable by the container user.`,
      );
    }
  };
}

/** An error's message, for a refusal that must carry what actually failed. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The idle span in the operator's units: 300 ms is not "0 seconds". */
function formatIdle(idleMs: number): string {
  return idleMs < 1000 ? `${Math.round(idleMs)} ms` : `${(idleMs / 1000).toFixed(1)} s`;
}
