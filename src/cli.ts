#!/usr/bin/env node
import { loadConfigFrom } from "./config.js";
import { ensureWorkspace } from "./layout.js";
import { createGitHubAdapter } from "./tracker/github-adapter.js";
import { runForever, runOnce, type LoopDeps } from "./loop.js";
import type { WorkerRuntime } from "./runtime/port.js";

/**
 * `msf run [--once] [--config <path>]` and `msf status` — the minimal CLI
 * (fundação #9). The run loads msf.yaml from the cwd, reads the bot token
 * from the gh keyring (boot check, ticket 16: no token → clear failure),
 * guarantees the workspace and hands the thin loop its four seams.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "run") {
    await runCommand(argv.slice(1));
    return;
  }
  if (command === "status") {
    statusCommand(argv.slice(1));
    return;
  }
  console.error("usage: msf run [--once] [--config <path>]\n       msf status");
  process.exit(1);
}

async function runCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const configIndex = argv.indexOf("--config");
  const overridePath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (configIndex >= 0 && !overridePath) {
    console.error("--config requires a path");
    process.exit(1);
  }

  const config = loadConfigFrom(process.cwd(), overridePath);
  const workspace = ensureWorkspace(config.workspace);

  // Boot check (ticket 16): the real tracker is the only adapter of v0.1 —
  // without the bot token in the gh keyring, msf run fails here, at boot,
  // with a clear message. The fake (test mirror) never runs in production.
  const tracker = await createGitHubAdapter({
    account: config.workerGhAccount,
    clonesDir: workspace.repos,
  });

  const deps: LoopDeps = {
    config,
    tracker,
    runtime: workerRuntime(),
    workspace,
    log: (message) => console.log(message),
  };
  if (once) {
    const result = await runOnce(deps);
    console.log(
      result.launched.length === 0
        ? `sweep done: empty pool, 0 workers, exit 0`
        : `sweep done: ${result.launched.length} worker(s) launched`,
    );
    return;
  }

  console.log("msf run: sweeping forever on the fixed tick (Ctrl-C to end)");
  await runForever(deps);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function workerRuntime(): WorkerRuntime {
  // TODO(ticket-13): the Sandcastle runtime replaces this placeholder; with
  // the pool derived empty nothing ever reaches launch.
  return {
    launch: (request) =>
      Promise.reject(
        new Error(`no worker runtime yet — cannot launch ${request.ref.repo}#${request.ref.number}`),
      ),
  };
}

function statusCommand(argv: string[]): void {
  const configIndex = argv.indexOf("--config");
  const overridePath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  const config = loadConfigFrom(process.cwd(), overridePath);
  // TODO(ticket-14): derivation on demand + local registry sweep.
  console.log(`msf status: watching ${config.repos.length} repo(s) — status view lands in a later ticket`);
}
