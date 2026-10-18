#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFrom, type Config } from "./config.js";
import { parseCliArgs } from "./cli-args.js";
import { ensureWorkspace, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "./layout.js";
import { localGitWork } from "./git/local.js";
import { createGitHubAdapter } from "./tracker/github-adapter.js";
import { runForever, runOnce, type LoopDeps } from "./loop.js";
import { deriveStatus, renderStatus } from "./state/status.js";
import { SandcastleRuntime, workerToken } from "./runtime/sandcastle.js";
import type { WorkerRuntime } from "./runtime/port.js";
import type { TrackerPort } from "./tracker/port.js";
import type { GitWork } from "./git/port.js";
import { LinuxNotifier } from "./notify/linux.js";
import type { Notifier } from "./notify/port.js";

/**
 * `msf run [--once] [--config <path>] [--runtime <name>]` and `msf status` — the minimal CLI
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
  /** The tracker adapter; default is the real GitHub adapter (keyring boot check). */
  tracker?: TrackerPort;
  /** The worker runtime; default is the real Sandcastle runtime. */
  runtime?: WorkerRuntime;
  /** The git host; default is the real local git (clone/fetch/branch). */
  git?: GitWork;
  /** The host-side notification delivery; default is the Linux desktop
   * backend. Tests inject a recorder to stay off any desktop session. */
  notifier?: Notifier;
}

export interface WireRunOptions {
  /** Test-only seams; absent = all real components. */
  seams?: WiredSeams;
}

/**
 * The wiring of `msf run` (ticket 18): config → boot → the thin loop's four
 * seams. Default path: real GitHub adapter (token from the gh keyring — the
 * boot check of ticket 16), real Sandcastle runtime (profile snapshot fed
 * from the config's allowed roots — the fail-closed behavior of the
 * ticket-17 proof), real git host.
 */
export async function wireRunDeps(
  config: Config,
  workspace: WorkspaceLayout,
  options: WireRunOptions = {},
): Promise<LoopDeps> {
  const seams = options.seams ?? {};
  const tracker =
    seams.tracker ??
    (await createGitHubAdapter({
      account: config.workerGhAccount,
      clonesDir: workspace.repos,
    }));
  const runtime = seams.runtime ?? (await sandcastleRuntime(config, workspace, config.workerModel));
  const git = seams.git ?? localGitWork({ reposDir: workspace.repos });
  // The delivery seam belongs to the CLI on the HOST (issue 93): the real
  // Linux desktop backend by default; tests inject a recorder. A disabled
  // config is honoured by the loop, so the wiring stays unconditional.
  const notifier = seams.notifier ?? new LinuxNotifier();
  return { config, tracker, runtime, git, workspace, notifier, log: (message) => console.log(message) };
}

/** The real runtime: Sandcastle, demanding the model and the keyring token
 * (ticket 17), fed the config's profile-snapshot settings (ticket 18) and the
 * workspace root the toolchain binds derive from (the convergence layer,
 * ticket 18 — tools installed inside the volume survive the container). */
async function sandcastleRuntime(config: Config, workspace: WorkspaceLayout, model: string): Promise<WorkerRuntime> {
  const token = await workerToken(config.workerGhAccount);
  return new SandcastleRuntime({
    model,
    token,
    // The toolchain convergence layer binds <workspace>/toolchains/... into
    // the container (ticket 18): installed once, reused by every launch.
    workspace: workspace.root,
    // The config feeds the snapshot's fail-closed admission (ticket 18):
    // the allowed roots the profile legitimately reaches (defaults fixed in
    // config.ts — the ticket-17 proof's roots) and the dangling-link escape.
    allowedRoots: config.profileAllowedRoots,
    skipDanglingProfileLinks: config.profileSkipDanglingLinks,
    // The worker self-reports blocked with the SAME vocabulary the factory
    // derives with — a non-default config label must reach the prompt too.
    blockedLabel: config.labels.blocked,
  });
}

/** `--runtime fake`: the placeholder that never launches — tests only; the
 * scripted fake lives in the test files, never on the cli. */
function fakeRuntimePlaceholder(): WorkerRuntime {
  return {
    launch: (request) =>
      Promise.reject(
        new Error(`no worker runtime yet — cannot launch ${request.ref.repo}#${request.ref.number}`),
      ),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "run") {
    await runCommand(args);
    return;
  }
  await statusCommand(args);
}

async function runCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const once = args.once;
  const runtimeName = args.runtime ?? "sandcastle";
  const overridePath = args.configPath;

  // Strict argument parsing has already completed; config is next, before
  // workspace writes or the keyring boot check.
  const config = loadConfigFrom(process.cwd(), overridePath);
  const workspace = ensureWorkspace(config.workspace);

  if (runtimeName !== "sandcastle" && runtimeName !== "fake") {
    console.error(`unknown runtime "${runtimeName}" — use --runtime sandcastle (default) or --runtime fake`);
    process.exit(1);
  }
  const deps: LoopDeps = await wireRunDeps(config, workspace, {
    ...(runtimeName === "fake" ? { seams: { runtime: fakeRuntimePlaceholder() } } : {}),
  });
  if (once) {
    const result = await runOnce(deps);
    console.log(
      result.launched.length === 0
        ? `sweep done: empty pool, 0 workers, exit 0`
        : `sweep done: ${result.launched.length} worker(s) launched`,
    );
    return;
  }

  // Ticket 14: ending the factory is a human act — Ctrl-C exits cleanly.
  // The handler is armed BEFORE the announcement: the boot line is then a
  // proof of registration — a SIGINT sent right after it can never land in
  // the default-disposition window (kernel kills the process instead of
  // running the handler).
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.on("SIGINT", onInterrupt);
  console.log("msf run: sweeping forever on the fixed tick (Ctrl-C to end)");
  try {
    await runForever(deps, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
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
  // disk). Only the keyring read at boot touches the machine; the reads
  // themselves are the same REST reads the sweep does, and the command
  // writes NOTHING to the tracker. Without the bot credential in the
  // keyring, status fails with the same clear boot message as run.
  const tracker = await createGitHubAdapter({ account: config.workerGhAccount });
  const view = await deriveStatus(tracker, config, layout);
  console.log(renderStatus(view));
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
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
