#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFrom, type Config } from "./config.js";
import { parseCliArgs } from "./cli-args.js";
import { ensureWorkspace, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "./layout.js";
import { localGitWork } from "./git/local.js";
import { createGitHubAdapter } from "./tracker/github-adapter.js";
import { JiraTicketAdapter } from "./tracker/jira-adapter.js";
import { runForever, runOnce, stopConfirmed, type LoopDeps, type StopReport } from "./loop.js";
import { installStopSignals, type StopSignals } from "./stop-signals.js";
import { utcStamp } from "./log.js";
import { describeError } from "./format.js";
import { deriveStatus, type JiraSelectionReader } from "./state/status.js";
import { workspaceLivenessProbe, type LivenessProbe } from "./state/liveness.js";
import { renderStatus } from "./state/status-render.js";
import { acquireRunLock } from "./run-lock.js";
import { recoverCall } from "./recover.js";
import { SandcastleRuntime, requireModelCredentials, workerToken, type SandcastleRuntimeOptions } from "./runtime/sandcastle.js";
import { WORKER_IMAGE } from "./worker-image.js";
import { modelAuthEnv } from "./runtime/model-auth.js";
import type { WorkerRuntime } from "./runtime/port.js";
import type { PullRequestTracker, TicketTracker } from "./tracker/expanded-port.js";
import type { GitWork } from "./git/port.js";
import { jiraSelectionOf, renderWorkIdentity } from "./tracker/identity.js";
import { LinuxNotifier } from "./notify/linux.js";
import type { Notifier } from "./notify/port.js";

/**
 * `msf run [--once] [--config <path>] [--runtime <name>]` and `msf status [--all] [--config <path>]` — the minimal CLI
 * (fundação #9). The run loads msf.yaml from the cwd, reads the bot token
 * from the gh keyring (boot check, ticket 16: no token → clear failure),
 * guarantees the workspace and hands the thin loop its four seams.
 *
 * Ticket 18: `msf run` (both --once and continuous) is wired with ALL REAL
 * components by default — the real GitHub adapter, the real Sandcastle
 * runtime (configured by worker-model), the real git host. The fake seams exist
 * ONLY for tests: `--runtime fake` keeps the placeholder that never launches,
 * and the fake adapter is injectable ONLY through the exported `wireRunDeps`
 * seams (tests import it) — never through any flag, so the binary's default
 * path can never reach it.
 */

/** Test-only injection points: the seams tests replace with fakes. The
 * production wiring (`msf run`) passes none of them. */
export interface WiredSeams {
  /** The ticket adapter; default is the real GitHub adapter (keyring boot check). */
  tickets?: TicketTracker;
  /** The PR/code-host adapter; default is the same real GitHub adapter. */
  pullRequests?: PullRequestTracker;
  /** The worker runtime; default is the real Sandcastle runtime. */
  runtime?: WorkerRuntime;
  /** The git host; default is the real local git (clone/fetch/branch). */
  git?: GitWork;
  /** Host-side notice delivery; default is the Linux desktop backend. */
  notifier?: Notifier;
  /** The liveness probe; default is the real read-only Docker probe over the
   *  workspace (issue 118) — tests pass a fake one, the binary has no flag. */
  probe?: LivenessProbe;
}

export interface WireRunOptions {
  /** Test-only seams; absent = all real components. */
  seams?: WiredSeams;
}

/**
 * The wiring of `msf run`: config → boot → the thin loop's four seams.
 * Default path: real GitHub adapter (token from the gh keyring), real
 * Sandcastle runtime (image-provisioned agent resources plus explicitly
 * supplied model credentials), real git host.
 */
export async function wireRunDeps(
  config: Config,
  workspace: WorkspaceLayout,
  options: WireRunOptions = {},
): Promise<LoopDeps> {
  const seams = options.seams ?? {};
  let tickets = seams.tickets;
  let pullRequests = seams.pullRequests;
  if ((tickets === undefined) !== (pullRequests === undefined)) {
    // A half-injected pair would silently boot the real adapter (keyring and
    // network) for the other half: the test seam is all-or-nothing.
    throw new Error("the ticket and PR seams must be supplied together");
  }
  if (tickets === undefined || pullRequests === undefined) {
    // The real adapter serves both expanded ports: GitHub owns the issues and
    // the PRs of a GitHub-selected Work (issue 124/126).
    const githubTracker = await createGitHubAdapter({
      account: config.workerGhAccount,
      clonesDir: workspace.repos,
    });
    tickets = githubTracker;
    pullRequests = githubTracker;
  }
  const runtime = seams.runtime ?? (await sandcastleRuntime(config, workspace));
  const git = seams.git ?? localGitWork({ reposDir: workspace.repos });
  const notifier = seams.notifier ?? new LinuxNotifier();
  // The operational liveness read (issue 118): the same read-only Docker probe
  // `msf status` uses, so the two never disagree about the same facts.
  const probe = seams.probe ?? workspaceLivenessProbe(workspace);
  return {
    config,
    tickets,
    pullRequests,
    runtime,
    git,
    workspace,
    notifier,
    probe,
    log: (message) => console.log(message),
  };
}

/**
 * The production launch composition: config → SandcastleRuntime options.
 * Exported so the wiring itself is testable without a container: the model,
 * the worker token, the workspace, the explicitly supplied auth file, and
 * only Pi-supported provider keys from the environment.
 */
export function sandcastleRuntimeOptions(
  config: Config,
  workspace: WorkspaceLayout,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): SandcastleRuntimeOptions {
  return {
    ...workerCredentials(config, env),
    token,
    // The toolchain convergence layer binds <workspace>/toolchains/... into
    // the container: installed once, reused by every launch.
    workspace: workspace.root,
    // The worker self-reports blocked with the SAME vocabulary the factory
    // derives with — a non-default config label must reach the prompt too.
    blockedLabel: config.labels.blocked,
  };
}

function workerCredentials(config: Config, env: NodeJS.ProcessEnv = process.env) {
  return {
    model: config.workerModel,
    authEnv: modelAuthEnv(env),
    agentFiles:
      config.workerAuthFile === null ? [] : [{ name: "auth.json", hostPath: config.workerAuthFile }],
  };
}

async function sandcastleRuntime(config: Config, workspace: WorkspaceLayout): Promise<WorkerRuntime> {
  const token = await workerToken(config.workerGhAccount);
  return new SandcastleRuntime(sandcastleRuntimeOptions(config, workspace, token));
}

/** Jira execution is not part of this release (issue 128): the configuration is
 *  read-only, and the refusal names the configured selections. */
function assertNoJiraExecution(config: Config): void {
  if (config.jira.length === 0) return;
  const selections = config.jira.map((entry) => `${entry.site} → ${entry.destination}`).join(", ");
  throw new Error(
    `Jira execution is not implemented yet: msf.yaml configures ${selections}. ` +
      `This release reads Jira candidates in \`msf status\` only; refusing before any claim, comment or launch`,
  );
}

/** The read-only Jira selections of `msf status`: one adapter per site (so the
 *  Acting account is identified once) and one reader per configured selection. */
function jiraSelectionReaders(config: Config): JiraSelectionReader[] {
  const adapters = new Map<string, JiraTicketAdapter>();
  const adapterFor = (entry: Config["jira"][number]): JiraTicketAdapter => {
    const known = adapters.get(entry.site);
    if (known !== undefined) return known;
    const created = new JiraTicketAdapter({
      site: entry.site,
      account: entry.account,
      tokenEnv: entry.tokenEnv,
    });
    adapters.set(entry.site, created);
    return created;
  };
  return config.jira.map((entry) => ({
    selection: jiraSelectionOf(entry),
    tickets: adapterFor(entry),
  }));
}

/** `--runtime fake`: the placeholder that never launches — tests only; the
 * scripted fake lives in the test files, never on the cli. */
function fakeRuntimePlaceholder(): WorkerRuntime {
  return {
    launch: (request) =>
      Promise.reject(
        new Error(`no worker runtime yet — cannot launch ${renderWorkIdentity(request.work)}`),
      ),
    requestStop: () => {},
    forceStop: async () => {},
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "run") {
    await runCommand(args);
    return;
  }
  if (args.command === "recover") {
    const config = loadConfigFrom(process.cwd(), args.configPath);
    console.log(await recoverCall(config, args.workKey!, args.retry === undefined ? undefined : {
      retry: args.retry, reason: args.reason!, acceptDuplicateRisk: args.acceptDuplicateRisk === true,
    }));
    return;
  }
  await statusCommand(args);
}

async function runCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const once = args.once;
  const runtimeName = args.runtime ?? "sandcastle";
  const overridePath = args.configPath;

  // The operator's stop is armed BEFORE any startup step that leaves a
  // resource active (issue #146): config, run lock, workspace and reservation
  // all live inside the handler's window, for the continuous run and for
  // `run --once` alike.
  const stop = installStopSignals();
  let report: StopReport | null = null;
  try {
    // Strict argument parsing has already completed; config is next, before
    // workspace writes or the keyring boot check.
    const config = loadConfigFrom(process.cwd(), overridePath);
    if (runtimeName !== "sandcastle" && runtimeName !== "fake") {
      console.error(
        utcStamp(`unknown runtime "${runtimeName}" — use --runtime sandcastle (default) or --runtime fake`),
      );
      process.exit(1);
    }

    // One `run` per REAL config path (issue 90), established before ANY
    // operational activity — the workspace below included. A second run for the
    // same configuration is refused here and never touches the factory.
    const lock = await acquireRunLock(config.configPath);
    try {
      // A stop requested during the startup is honoured where it is observed:
      // the engine listens from its construction, so an already-aborted signal
      // closes admission before the first reservation (issue #146).
      report = await executeRun(config, once, runtimeName, stop);
    } finally {
      await lock.close();
    }
  } finally {
    stop.dispose();
  }

  if (report !== null) {
    // A requested stop that could not confirm every worker is not a safe stop:
    // the diagnostic is on stderr and the status says so. The stop is over
    // (confirmed, or reported as unconfirmed) and the exclusivity is released:
    // the process ends NOW — an internal handle of the runtime must never
    // delay the operator's restart.
    process.exit(stopConfirmed(report) ? 0 : 1);
  }
}

async function executeRun(
  config: Config,
  once: boolean,
  runtimeName: string,
  stop: StopSignals,
): Promise<StopReport | null> {
  // Before the workspace, the keyring read, any claim or any launch: a sweep
  // that silently ignored its Jira selections would pretend the configured work
  // was handled.
  assertNoJiraExecution(config);
  if (runtimeName === "sandcastle") {
    try {
      await requireModelCredentials({ image: WORKER_IMAGE, ...workerCredentials(config) });
    } catch (error) {
      throw new Error(
        `factory not started (worker model ${config.workerModel}): ${describeError(error)}\n` +
          "No sweep was started and no tickets were changed.",
      );
    }
  }
  const workspace = ensureWorkspace(config.workspace);
  const deps: LoopDeps = await wireRunDeps(config, workspace, {
    ...(runtimeName === "fake" ? { seams: { runtime: fakeRuntimePlaceholder() } } : {}),
  });
  const stopOptions = { signal: stop.requested, escalate: stop.escalated };
  if (once) {
    const result = await runOnce(deps, stopOptions);
    if (result.stop !== null) {
      console.log(
        utcStamp(
          stopConfirmed(result.stop)
            ? "sweep stopped by the operator: the stop of every worker was confirmed, exit 0"
            : "sweep stopped by the operator: the stop could not be confirmed, exit 1",
        ),
      );
      return result.stop;
    }
    console.log(
      utcStamp(
        result.launched.length === 0
          ? `sweep done: empty pool, 0 workers, exit 0`
          : `sweep done: ${result.launched.length} worker(s) launched`,
      ),
    );
    return null;
  }

  // Ticket 14: ending the factory is a human act — Ctrl-C exits cleanly.
  // Issue #146: the close of admission, the cooperative request and the
  // confirmation of every worker's end now live in the loop's lifecycle; the
  // stop line below is still a proof of registration — a SIGINT sent right
  // after it can never land in the default-disposition window.
  console.log(utcStamp("msf run: sweeping forever on the fixed tick (Ctrl-C to end)"));
  return runForever(deps, { ...stopOptions });
}

async function statusCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = loadConfigFrom(process.cwd(), args.configPath);

  // Read-only: status never creates the workspace — an absent one is empty
  // (status before any run is a legal, informative state).
  const layout: WorkspaceLayout = {
    root: config.workspace,
    repos: join(config.workspace, WORKSPACE_SUBPATHS.repos),
    works: join(config.workspace, WORKSPACE_SUBPATHS.works),
    archive: join(config.workspace, WORKSPACE_SUBPATHS.archive),
  };

  // Ticket 18: status reads the REAL tracker — the trail it shows is the
  // work's real trail (issue labels, PR, the works the registry holds on
  // disk). Only the keyring read at boot touches the machine (and only when a
  // GitHub Issues repo is configured); the reads themselves are the same REST
  // reads the sweep does, and the command writes NOTHING to the tracker.
  const github = config.repos.length === 0 ? null : await createGitHubAdapter({ account: config.workerGhAccount });
  // The Jira selections are read through their own adapters — the same read-only
  // read and native Rank order the adapter contract suite proves. A selection
  // whose credential is missing is reported as unknown, never skipped.
  const view = await deriveStatus(
    { github, jira: jiraSelectionReaders(config) },
    config,
    layout,
    workspaceLivenessProbe(layout),
  );
  console.log(renderStatus(view, { all: args.all }));
}

// The binary runs main(); the module imported (by the tests of the wiring)
// does not — the exported wireRunDeps is the entry the tests drive. The
// comparison is by real path so a symlinked bin (`npm link`) still counts.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(utcStamp(describeError(error)));
    process.exit(1);
  });
}
