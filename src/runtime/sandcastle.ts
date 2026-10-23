import { execFile as execFileCallback } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { run as sandcastleRun, pi, type AgentProvider, type AgentStreamEvent, type PiOptions, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import { docker, type DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { DEFAULT_LABELS } from "../config.js";
import { SESSIONS_SUBDIR, workspaceLayout } from "../layout.js";
import { workKeyOf } from "../pool/work-key.js";
import { deferred, type Deferred } from "./deferred.js";
import { dockerWorkerForceStop } from "./worker-stop.js";
import {
  describeForeignRecord,
  ownOutcomeRecord,
  readOutcomeRecord,
  type OutcomeRecord,
} from "../state/outcome.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { describeError } from "../format.js";
import { buildWorkerPrompt, COMPLETION_SIGNAL, WORK_MOUNT } from "./prompt.js";
import {
  AGENT_DIR,
  agentExtensionEntry,
  agentGuidancePath,
  agentSkillPath,
} from "./agent-paths.js";
import {
  DEFAULT_IDLE_LIMIT_MS,
  startActivityWatch,
  workActivityDirs,
  type ActivityWatch,
} from "./activity.js";
import {
  AGENT_DECLARATION_PATH,
  IMAGE_INVENTORY_PATH,
  loadAgentResources,
  verifyAgentInventory,
  type LoadedAgentResources,
} from "./inventory.js";
import { authFileProblem, NO_MODEL_AUTH_MESSAGE } from "./model-auth.js";
import { appendAttemptEvent, sandcastleLogName } from "./attempt-logs.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "./port.js";
import { GITHUB_SITE, type WorkIdentity } from "../tracker/identity.js";

export { AGENT_DIR, AGENT_SKILLS_DIR, agentExtensionEntry, agentGuidancePath, agentSkillPath } from "./agent-paths.js";

const execFile = promisify(execFileCallback);

/**
 * The real runtime (ticket 17): worker sessions ARE Sandcastle — the `run()`
 * API of `@ai-hero/sandcastle` with the Pi headless template in print mode —
 * behind the same WorkerRuntime port the fake mirrors. The proven mechanics
 * of the v1 (research 01-sandcastle-sessao-headless):
 *
 *   - the image carries every skill, extension and reviewer agent the
 *     factory declares (provisioned at build time, issue #159): the launch
 *     loads exactly those paths with discovery and project trust disabled —
 *     no host profile, no target-project resource, no startup install;
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
 * absence is the class "abrupt-death" and nothing writes it for it). Only the
 * record OF THIS ATTEMPT is read as the session's outcome: an earlier
 * attempt's record on disk is history and is logged as rejected (issue 143).
 */

/** One running session of this runtime: its cooperative request and the
 *  forced stop that ends it even when Sandcastle's unwind lags behind. */
interface RunningSession {
  work: WorkIdentity;
  stop: AbortController;
  forced: Deferred;
}

/** Inside the container: the image-provisioned agent dir; only sessions/ is a host bind. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const SESSIONS_CONTAINER_DIR = `${AGENT_DIR}/sessions`;

/**
 * The toolchain convergence layer (ticket 18): the workspace subpaths bound
 * read-write over the container's toolchain homes. Tools installed by `mise`
 * inside these host dirs persist ACROSS launches — the container is recreated
 * per work, the volume survives — so the first launch of a new toolchain pays
 * the install and every later launch reuses it. The image's agent resources
 * stay outside every writable bind: a mount can never hide or replace them.
 */
export const TOOLCHAIN_SUBPATHS = {
  /** <workspace>/toolchains/mise → /home/agent/.local/share/mise (RW). */
  mise: "toolchains/mise",
} as const;
export const MISE_CONTAINER_DIR = "/home/agent/.local/share/mise";

/** An explicitly supplied auth.json: its host dir mounts read-only at the
 *  agent dir `/msf-auth`, and the start hook copies `/msf-auth/auth.json`. */
export const AUTH_MOUNT_DIR = "/msf-auth";
export const AUTH_MOUNT = `${AUTH_MOUNT_DIR}/auth.json`;

/** Stage the supplied auth file in a private host dir for the read-only bind.
 *  The caller removes the dir with the launch. */
export function stageAuthFile(authFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "msf-auth-"));
  const target = join(dir, "auth.json");
  copyFileSync(authFile, target);
  chmodSync(target, 0o600);
  return dir;
}

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

/**
 * The closed flags of the worker's print command. Pi's buildPrintCommand
 * returns a bare command STRING (no structured args array), so the flags ride
 * one concatenation. Every resource is named explicitly and discovery is off:
 * no host profile, no project skills/extensions/prompts/context, no target
 * project trust — only what the factory's declaration provisioned, plus the
 * guardrail the image build stages from this checkout. `--no-approve` is Pi's
 * "ignore project-local files for this run": it also makes pi-subagents skip
 * the target repository's agent definitions, which would otherwise shadow
 * `code-reviewer`.
 */
export function workerFlagArgs(resources: LoadedAgentResources): string[] {
  const { declaration } = resources;
  return [
    "--no-approve",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-skills",
    "--no-extensions",
    ...declaration.skills.selected.map((skill) => `--skill '${agentSkillPath(skill.name)}'`),
    ...declaration.extensions.flatMap((extension) => [
      `--skill '${agentGuidancePath(extension)}'`,
      `-e '${agentExtensionEntry(extension)}'`,
    ]),
    `-e '${GUARDRAIL_CONTAINER_FILE}'`,
    "--tools read,bash,edit,write,subagent,subagents_enable",
    "--exclude-tools 'mcp__*,mcp'",
  ];
}

/**
 * The guardrail extension the worker image carries: the in-container code that
 * journals effects before they happen and blocks a repeat on a resumed
 * session. It is factory code staged from this checkout's compiled `dist/` by
 * `npm run build:image` (not a distributed package), and the staged tree
 * mirrors `dist/` so its relative imports resolve; the preflight refuses an
 * image without it rather than running the session unguarded.
 */
export const GUARDRAIL_CONTAINER_DIR = "/opt/msf/runtime/guardrail";
export const GUARDRAIL_CONTAINER_FILE = `${GUARDRAIL_CONTAINER_DIR}/extension.js`;

const AUTH_SETUP_TIMEOUT_MS = 30 * 1000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = DEFAULT_IDLE_LIMIT_MS / 1000;

/**
 * The sandbox's own clock is a LAST RESORT behind the activity watchdog (issue
 * 112): the agent can be silent on stdout for as long as its reviewer subagents
 * work, so the effective idle limit is the one measured on verifiable activity.
 * Sandcastle's timer only guards a watchdog that stopped running — an
 * unreadable tree is still observed as "nothing changes" and times out — so it
 * is kept just far enough to never preempt the verified limit.
 */
export const SANDBOX_BACKSTOP_FACTOR = 2;

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
  /** An explicitly supplied Pi auth.json (worker-auth-file); mounted
   * read-only and copied into the container's agent dir at start. */
  authFile?: string;
  /** Pi-supported provider API-key variables to forward. Required: the
   *  runtime never reads the ambient environment on its own. */
  authEnv: Readonly<Record<string, string>>;
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
  /** The committed declaration, already loaded; defaults to the checkout's
   * agent-resources.json. Tests inject a fixture; production leaves it unset. */
  agentResources?: LoadedAgentResources;
  /** Launch preconditions; default defaultPreflight. */
  preflight?: () => Promise<void>;
}

export class SandcastleRuntime implements WorkerRuntime {
  private readonly model: string;
  private readonly token: string;
  private readonly image: string;
  private readonly workspace: string;
  private readonly resolveDockerSocket: () => DockerSocket;
  private readonly authFile: string | undefined;
  private readonly authEnv: Readonly<Record<string, string>>;
  private readonly agentResources: LoadedAgentResources;
  private readonly blockedLabel: string;
  private readonly maxIterations: number;
  private readonly idleTimeoutSeconds: number;
  private readonly activityPollMs: number;
  private readonly runSandcastle: (options: RunOptions) => Promise<RunResult>;
  private readonly dockerProvider: (options: DockerOptions) => SandboxProvider;
  private readonly preflight: () => Promise<void>;
  private readonly piProvider: (model: string, options?: PiOptions) => AgentProvider;

  /** The running sessions of this process, by work key — what a stop reaches. */
  private readonly sessions = new Map<string, RunningSession>();
  /** Keys whose stop was requested before their session registered. */
  private readonly stopRequested = new Set<string>();
  /** The one forced stop of this runtime: same image, same workspace. */
  private stopper: ((key: string) => Promise<void>) | null = null;

  constructor(options: SandcastleRuntimeOptions) {
    this.model = options.model;
    this.token = options.token;
    this.image = options.image ?? WORKER_IMAGE;
    this.workspace = options.workspace;
    this.resolveDockerSocket = options.dockerSocket ?? (() => dockerSocketFromHost());
    this.authFile = options.authFile;
    this.authEnv = options.authEnv;
    this.agentResources = options.agentResources ?? loadAgentResources();
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
          model: this.model,
          agentResources: this.agentResources,
          authFile: this.authFile,
          authEnv: this.authEnv,
          dockerSocket: this.resolveDockerSocket(),
        })());
    this.piProvider = options.piProvider ?? ((model, piOptions) => pi(model, piOptions));
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    const key = workKeyOf(request.work);
    // The session is registered BEFORE the preconditions (issue #146): a stop
    // arriving during them reaches this launch instead of being lost in the
    // window between the factory's check and the worker's start.
    const session: RunningSession = { work: request.work, stop: new AbortController(), forced: deferred() };
    this.sessions.set(key, session);
    try {
      return await this.launchRegistered(request, session);
    } finally {
      this.sessions.delete(key);
    }
  }

  private async launchRegistered(request: WorkRequest, session: RunningSession): Promise<SessionResult> {
    const stopSignal = session.stop.signal;
    // Preconditions BEFORE any footprint: infra and config failures are not
    // work falls — the factory fails fast with the reason (the v1's refusal).
    await this.preflight();

    // Stopped while the preconditions ran: no footprint, no worker. The
    // requested stop is not a session this runtime has to report, and the
    // request is consumed here — it was remembered for exactly this launch.
    const key = workKeyOf(request.work);
    if (stopSignal.aborted || this.stopRequested.delete(key)) {
      return { request, outcome: "abrupt-death" };
    }

    // The Docker socket the container inherits (ADR 0003), resolved with the
    // preconditions: a socket that vanished between the two is the factory's
    // failure to refuse out loud, never a work-level fall.
    const dockerSocket = this.resolveDockerSocket();

    // An explicitly supplied auth file is staged into a private host dir for
    // the read-only mount — never written to the image, never read from a
    // personal profile. Staged BEFORE the footprint so a vanished file is a
    // factory failure, not a half-written attempt. The dir dies with the launch.
    const authDir = this.authFile === undefined ? undefined : stageAuthFile(this.authFile);
    try {
      // The footprint comes first (ticket 13): sessao/ and the attempt's log
      // exist before any outcome can exist. An abrupt death leaves exactly
      // this — the start line without an end, the record's absence.
      const sessionsDir = join(request.workDir, SESSIONS_SUBDIR);
      mkdirSync(sessionsDir, { recursive: true });
      // A relaunch reopens the attempt's OWN native Pi session (ADR 0005)
      // instead of reconstructing context — and the recorded association is
      // the ONLY selection (issue 119): never the newest file on disk.
      const resumeSession = request.session?.mode === "resume" ? request.session.sessionId : undefined;
      this.event(request, "session-start", {
        branch: request.branch,
        baseBranch: request.baseBranch,
        model: this.model,
        image: this.image,
        ...(resumeSession === undefined ? {} : { resumeSession }),
        resources: {
          skills: this.agentResources.declaration.skills.selected.map((skill) => skill.name),
          extensions: this.agentResources.declaration.extensions.map(
            (extension) => `${extension.package}@${extension.version}`,
          ),
        },
      });

      // The verified-activity idle limit (issue 112): the watchdog aborts the
      // run once nothing verifiable happened for the configured idle time. The
      // requested stop aborts the same run (issue #146): Sandcastle kills the
      // agent subprocess and tears the container down before the promise
      // settles.
      const watch = await this.activityWatch(request);
      const runSignal = AbortSignal.any([watch.signal, stopSignal]);
      let outcome: SessionResult["outcome"];
      // The forced stop settles the launch on its own (issue #146): the
      // runtime confirmed the container gone through Docker, so waiting for
      // Sandcastle's own unwind (which can outlive the container) would hold
      // the factory hostage. The in-flight run keeps unwinding in the
      // background with its rejection observed.
      const run = this.runSandcastle(
        this.runOptionsFor(request, authDir, sessionsDir, dockerSocket, runSignal, resumeSession),
      );
      void run.catch(() => {});
      try {
        await Promise.race([run, session.forced.promise]);
        outcome = await this.observedOutcome(request);
      } catch (error) {
        this.event(request, stopSignal.aborted ? "session-stop" : "session-failed", {
          reason: describeError(error),
        });
        outcome = "abrupt-death";
      } finally {
        // The watch dies with the session: a resolved, failed or forced run is
        // not an idle.
        watch.stop();
      }
      this.event(request, "session-end", { outcome });
      return { request, outcome };
    } finally {
      if (authDir !== undefined) rmSync(authDir, { recursive: true, force: true });
    }
  }

  /**
   * The cooperative stop (issue #146): Sandcastle aborts the in-flight agent
   * and tears the sandbox down before the launch promise settles, so the
   * request never abandons that promise. `forceStop` is the backstop for a
   * worker that survives it.
   */
  requestStop(work: WorkIdentity): void {
    const key = workKeyOf(work);
    this.stopRequested.add(key);
    this.sessions.get(key)?.stop.abort();
  }

  /**
   * Force the worker gone and prove it, through Docker. Only after the
   * container is confirmed gone does the launch settle: an unconfirmed end
   * rejects and the launch stays owned, never declared safe.
   */
  async forceStop(work: WorkIdentity): Promise<void> {
    const key = workKeyOf(work);
    this.stopRequested.add(key);
    const session = this.sessions.get(key);
    session?.stop.abort();
    await this.forceStopper()(key);
    session?.forced.resolve();
  }

  private forceStopper(): (key: string) => Promise<void> {
    this.stopper ??= dockerWorkerForceStop({
      worksRoot: workspaceLayout(this.workspace).works,
    });
    return this.stopper;
  }

  /**
   * The verified-activity idle limit (issue 112): a watchdog over the files the
   * agents write, aborting the run once nothing verifiable happened for the
   * configured idle time. Reviewer subagent transcripts count (they are real
   * work); the factory's own logs do not (they only echo stdout). The returned
   * signal carries the abort into Sandcastle, which kills the agent subprocess.
   */
  private async activityWatch(request: WorkRequest): Promise<ActivityWatch & { signal: AbortSignal }> {
    const idleMs = this.idleTimeoutSeconds * 1000;
    const controller = new AbortController();
    const watch = startActivityWatch({
      ...(await workActivityDirs(request.workDir)),
      idleMs,
      pollMs: this.activityPollMs,
      onIdle: (measured) => {
        appendAttemptEvent(request.workDir, request.attempt, {
          event: "activity-idle",
          idleMs: Math.round(measured),
        });
        controller.abort(
          new Error(
            `no verifiable activity for ${formatIdle(measured)} — the session was ended by the idle limit`,
          ),
        );
      },
    });
    return { ...watch, signal: controller.signal };
  }

  /** The toolchain binds (ticket 18): workspace-derived host dirs, created
   * idempotently at launch (mkdir is a no-op on an existing volume) and bound
   * read-write. Convergence happens INSIDE the volume across launches — the
   * runtime itself never pre-installs a toolchain. */
  private toolchainBinds(): Array<{ hostPath: string; sandboxPath: string; readonly: false }> {
    const miseDir = join(this.workspace, TOOLCHAIN_SUBPATHS.mise);
    mkdirSync(miseDir, { recursive: true });
    return [{ hostPath: miseDir, sandboxPath: MISE_CONTAINER_DIR, readonly: false }];
  }

  /** The RunOptions handed to Sandcastle — the mechanics, in one place. */
  private runOptionsFor(
    request: WorkRequest,
    authDir: string | undefined,
    sessionsDir: string,
    dockerSocket: DockerSocket,
    signal: AbortSignal,
    resumeSession?: string,
  ): RunOptions {
    const agent = this.piProvider(this.model, {
      // No implicit capture: the sessions bind does the persistence, the
      // session file already lives on the host (the resume path of later
      // tickets reads it from there).
      captureSessions: false,
      // Model credentials ride the environment; the agent dir still holds the
      // image-provisioned resources and the session bind.
      env: { [AGENT_DIR_ENV]: AGENT_DIR, ...this.authEnv },
      sessionStorage: { hostSessionsDir: sessionsDir },
    });

    // Every resource is named explicitly and discovery is off — one
    // concatenation because pi's print command is a string, not structured
    // args (`workerFlagArgs` is the single source of the list). A NEW session
    // is born with the id the factory already recorded (issue 119): the
    // association exists before the worker starts, so a recovery can never
    // pick the wrong file.
    const flags = workerFlagArgs(this.agentResources);
    const newSessionId = request.session?.mode === "new" ? request.session.sessionId : null;
    const agentWithFlags = {
      ...agent,
      buildPrintCommand(options: Parameters<typeof agent.buildPrintCommand>[0]) {
        const command = agent.buildPrintCommand(options);
        // The flag fragment, named for what it is: the id itself is above.
        const sessionFlag = newSessionId === null ? "" : ` --session-id ${newSessionId}`;
        return {
          ...command,
          command: `${command.command} ${flags.join(" ")}${sessionFlag}`,
        };
      },
    };

    return {
      agent: agentWithFlags,
      sandbox: this.dockerProvider({
        imageName: this.image,
        // GH_TOKEN authenticates gh; DOCKER_HOST names the socket the worker
        // inherits, so the CLI inside reaches the host daemon (ADR 0003).
        // MSF_WORK_MOUNT tells the guardrail extension where the work dir is.
        env: {
          GH_TOKEN: this.token,
          DOCKER_HOST: `unix://${dockerSocket.hostPath}`,
          MSF_WORK_MOUNT: WORK_MOUNT,
        },
        // The socket's own group, as a supplementary gid: the container user
        // is the host user, not root, and the socket is root-owned 0660.
        groups: [dockerSocket.gid],
        // No `network` — Docker's default bridge, open egress.
        mounts: [
          ...(authDir === undefined
            ? []
            : [{ hostPath: authDir, sandboxPath: AUTH_MOUNT_DIR, readonly: true }]),
          { hostPath: request.workDir, sandboxPath: WORK_MOUNT, readonly: false },
          { hostPath: sessionsDir, sandboxPath: SESSIONS_CONTAINER_DIR, readonly: false },
          ...this.toolchainBinds(),
          // The daemon socket bind (ADR 0003), at the path the host has it:
          // read-write because a socket is a channel, not a file tree.
          { hostPath: dockerSocket.hostPath, sandboxPath: dockerSocket.hostPath, readonly: false },
        ],
      }),
      cwd: request.repoDir,
      // The branch the git host prepared: reuse when clean, preserve when
      // dirty (Sandcastle's own worktree behavior) — never recreated.
      branchStrategy: { type: "branch", branch: request.branch, baseBranch: request.baseBranch },
      prompt: buildWorkerPrompt(request, {
        blockedLabel: this.blockedLabel,
        continuesSession: resumeSession !== undefined,
        agentResources: this.agentResources,
      }),
      maxIterations: this.maxIterations,
      completionSignal: COMPLETION_SIGNAL,
      idleTimeoutSeconds: this.idleTimeoutSeconds * SANDBOX_BACKSTOP_FACTOR,
      // A resume reopens the attempt's OWN session (issue 119): Sandcastle
      // hands the id to Pi (`--session <id>`) from the bind-mounted store,
      // where the session file already lives.
      ...(resumeSession === undefined ? {} : { resumeSession }),
      signal,
      name: containerNameOf(request.work, request.attempt),
      hooks: {
        sandbox: {
          onSandboxReady: [
            ...(authDir === undefined
              ? []
              : [
                  {
                    // The explicitly supplied auth.json is copied into the
                    // writable agent dir (OAuth renewal may rewrite it); the
                    // read-only mount never leaves the launch.
                    command:
                      `mkdir -p "$HOME/.pi/agent" && ` +
                      `install -m 600 ${AUTH_MOUNT} "$HOME/.pi/agent/auth.json"`,
                    timeoutMs: AUTH_SETUP_TIMEOUT_MS,
                  },
                ]),
            {
              // The toolchain convergence BEFORE the prompt (the declared
              // tools are ready, never hunted mid-session): `mise install`
              // reads the active configs (the toolchain volume's global
              // config and the repo's mise.toml, when it declares one) and lands
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
        path: join(request.workDir, SESSIONS_SUBDIR, sandcastleLogName(request.attempt)),
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          this.agentEvent(request, event);
        },
      },
    };
  }

  /**
   * The outcome the runtime observed: the class of THIS attempt's record, or
   * the absence (issue 143). A record left by another attempt is absence here
   * — never that attempt's outcome read as this session's — and the attempt's
   * log names the mismatch so the diagnosis needs no guessing.
   */
  private async observedOutcome(request: WorkRequest): Promise<SessionResult["outcome"]> {
    const record: OutcomeRecord | null = await readOutcomeRecord(request.workDir);
    const own = ownOutcomeRecord(record, request.attempt);
    if (own !== null) return own.class;
    if (record !== null) {
      this.event(request, "outcome-record-rejected", {
        recordedAttempt: record.attempt,
        reason: `${describeForeignRecord(record.attempt)} — attempt ${request.attempt} wrote no outcome record of its own`,
      });
    }
    return "abrupt-death";
  }

  private event(request: WorkRequest, event: string, extra: Record<string, unknown> = {}): void {
    appendAttemptEvent(request.workDir, request.attempt, { event, ...extra });
  }

  private agentEvent(request: WorkRequest, event: AgentStreamEvent): void {
    const payload: Record<string, unknown> =
      event.type === "text"
        ? { event: "agent-text", message: event.message }
        : event.type === "toolCall"
          ? { event: "agent-tool", tool: event.name, args: event.formattedArgs }
          : { event: "agent-raw", line: event.line };
    appendAttemptEvent(request.workDir, request.attempt, { iteration: event.iteration, ...payload });
  }
}

/** The container's name: the GitHub ticket number keeps its historical shape;
 *  another source names the Work's stable key instead of inventing a number. */
function containerNameOf(work: WorkIdentity, attempt: number): string {
  const name =
    work.ticket.provider === "github" && work.ticket.site === GITHUB_SITE
      ? String(work.ticket.number)
      : workKeyOf(work).replace(/[^A-Za-z0-9_.-]/g, "-");
  return `work-${name}-attempt-${attempt}`;
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
  /** The configured worker model — the auth probe resolves its provider. */
  model: string;
  /** The committed declaration the image must match. */
  agentResources: LoadedAgentResources;
  /** An explicitly supplied Pi auth.json (worker-auth-file). */
  authFile?: string | undefined;
  /** Pi-supported provider API-key variables forwarded to the container. */
  authEnv: Readonly<Record<string, string>>;
  /** The daemon socket the worker container inherits (ADR 0003). */
  dockerSocket: DockerSocket;
  /** The command runner (docker); injectable for tests. */
  run?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** The model-auth probe; injectable for tests. */
  authProbe?: () => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

/** Run `docker` and keep its output even on a non-zero exit (no throw). */
function execFileResult(
  command: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFileCallback(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolvePromise({
        status: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/**
 * Resolve the configured model's credentials inside a throwaway container,
 * using exactly the auth sources the worker will receive. The JSON answer is
 * parsed for status/reason only: a credential value never reaches a message.
 */
export async function dockerAuthProbe(deps: {
  image: string;
  model: string;
  authFile?: string | undefined;
  authEnv: Readonly<Record<string, string>>;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const args = ["run", "--rm", "--network", "none"];
  let envDir: string | undefined;
  let authDir: string | undefined;
  try {
    // A temp env-file keeps provider key VALUES off the docker argv (ps).
    if (Object.keys(deps.authEnv).length > 0) {
      envDir = mkdtempSync(join(tmpdir(), "msf-auth-env-"));
      const envFile = join(envDir, "env");
      writeFileSync(
        envFile,
        `${Object.entries(deps.authEnv).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      args.push("--env-file", envFile);
    }
    if (deps.authFile !== undefined) {
      authDir = stageAuthFile(deps.authFile);
      args.push("-v", `${authDir}:${AUTH_MOUNT_DIR}:ro`);
      args.push(
        "--entrypoint",
        "sh",
        deps.image,
        "-c",
        `mkdir -p /tmp/msf-auth && cp ${AUTH_MOUNT} /tmp/msf-auth/auth.json && ` +
          `chmod 600 /tmp/msf-auth/auth.json && PI_CODING_AGENT_DIR=/tmp/msf-auth ` +
          'exec pi auth check --model "$1" --json --no-refresh',
        "msf-auth-probe",
        deps.model,
      );
    } else {
      args.push("-e", "PI_CODING_AGENT_DIR=/tmp", "--entrypoint", "pi", deps.image, "auth", "check", "--model", deps.model, "--json", "--no-refresh");
    }
    return await execFileResult("docker", args);
  } finally {
    if (authDir !== undefined) rmSync(authDir, { recursive: true, force: true });
    if (envDir !== undefined) rmSync(envDir, { recursive: true, force: true });
  }
}

/**
 * The launch preconditions: Docker is alive, the image exists and its recorded
 * inventory matches this checkout's declaration, the token is present, the
 * image carries the git credential helper the worker's push needs, Docker
 * inside the worker reaches the daemon (ADR 0003), and the configured model
 * credentials resolve from an explicit source. A failure is a factory-level
 * failure, not a work outcome — the launch throws before any artifact.
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

    // The image's OWN record of what it provisioned, compared with the
    // declaration in this checkout. The mutable Docker tag is not evidence.
    let inventoryText = "";
    try {
      ({ stdout: inventoryText } = await run("docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "cat",
        deps.image,
        IMAGE_INVENTORY_PATH,
      ]));
    } catch {
      inventoryText = "";
    }
    try {
      verifyAgentInventory(deps.agentResources, inventoryText);
    } catch (error) {
      throw new Error(describeError(error));
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

    // The continuity guardrail must be IN the image (issue 119): the session
    // journals effects before they happen and blocks a repeat on a resume. An
    // image built before this feature would run unguarded, so the launch is
    // refused instead of trusting the worker's prose. One throwaway container,
    // no network, no artifact.
    try {
      await run("docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "test",
        deps.image,
        "-f",
        GUARDRAIL_CONTAINER_FILE,
      ]);
    } catch {
      throw new Error(
        `worker image ${deps.image} has no continuity guardrail at ${GUARDRAIL_CONTAINER_FILE} — a resumed session could repeat an external effect. Rebuild it with: npm run build:image`,
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
        `worker image ${deps.image} carries no usable docker CLI (docker --version failed inside it: ${describeError(error)}). Rebuild it with: npm run build:image`,
      );
    }
    try {
      await probe("docker", ["buildx", "version"]);
    } catch (error) {
      throw new Error(
        `worker image ${deps.image} has no buildx builder (docker buildx version failed inside it: ${describeError(error)}) — npm run build:image would fail in the round. Rebuild it with: npm run build:image`,
      );
    }
    try {
      await probe("docker", ["info", "--format", "{{.ServerVersion}}"]);
    } catch (error) {
      throw new Error(
        `worker image ${deps.image} cannot reach the Docker daemon through ${socket.hostPath} as gid ${socket.gid} (docker info inside it failed: ${describeError(error)}) — a worker would have no Docker. Check that this is the daemon's socket and that its group is readable by the container user.`,
      );
    }

    // Model credentials (issue #159): an explicit file and/or Pi-supported
    // provider variables — never a personal profile. Both the absence and an
    // unresolved/expired credential fail with the reason only (no value).
    if (deps.authFile !== undefined) {
      const problem = authFileProblem(deps.authFile);
      if (problem !== null) throw new Error(problem);
    }
    if (deps.authFile === undefined && Object.keys(deps.authEnv).length === 0) {
      throw new Error(NO_MODEL_AUTH_MESSAGE);
    }
    const probeAuth =
      deps.authProbe ??
      (() =>
        dockerAuthProbe({
          image: deps.image,
          model: deps.model,
          authFile: deps.authFile,
          authEnv: deps.authEnv,
        }));
    const auth = await probeAuth();
    let status = "";
    let reason = "";
    try {
      const parsed = JSON.parse(auth.stdout) as { status?: unknown; reason?: unknown };
      status = typeof parsed.status === "string" ? parsed.status : "";
      reason = typeof parsed.reason === "string" ? parsed.reason : "";
    } catch {
      status = "";
    }
    if (status !== "ready") {
      throw new Error(
        `model credentials for ${deps.model} are not ready (${status === "" ? "the probe returned no readable status" : status}${reason === "" ? "" : `: ${reason}`}). ` +
          "Supply a valid provider API key in the factory's environment or a valid worker-auth-file; nothing is read from a personal Pi profile.",
      );
    }
  };
}

/** The idle span in the operator's units: 300 ms is not "0 seconds". */
function formatIdle(idleMs: number): string {
  return idleMs < 1000 ? `${Math.round(idleMs)} ms` : `${(idleMs / 1000).toFixed(1)} s`;
}

