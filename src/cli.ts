#!/usr/bin/env node
import { join } from "node:path";
import { loadConfigFrom, type Config } from "./config.js";
import { ensureWorkspace, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "./layout.js";
import { localGitWork } from "./git/local.js";
import { createGitHubAdapter } from "./tracker/github-adapter.js";
import { FakeTrackerAdapter } from "./tracker/fake-adapter.js";
import { runForever, runOnce, type LoopDeps } from "./loop.js";
import { deriveStatus, renderStatus } from "./state/status.js";
import { SandcastleRuntime, workerToken } from "./runtime/sandcastle.js";
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
    await statusCommand(argv.slice(1));
    return;
  }
  console.error("usage: msf run [--once] [--config <path>]\n       msf status");
  process.exit(1);
}

async function runCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const runtimeName = optionValue(argv, "--runtime") ?? "fake";
  const model = optionValue(argv, "--model");
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
    runtime: await workerRuntime(runtimeName, config, model),
    git: localGitWork({ reposDir: workspace.repos }),
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function optionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * The runtime the cli selects (ticket 17): `--runtime sandcastle` is the real
 * launch (Sandcastle run(), Pi headless, container); `--runtime fake` (the
 * default) keeps the placeholder that never launches — the scripted mirror
 * lives in tests (FakeWorkerRuntime), not on the cli.
 */
async function workerRuntime(name: string, config: Config, model: string | undefined): Promise<WorkerRuntime> {
  if (name === "fake") {
    return {
      launch: (request) =>
        Promise.reject(
          new Error(`no worker runtime yet — cannot launch ${request.ref.repo}#${request.ref.number}`),
        ),
    };
  }
  if (name === "sandcastle") {
    if (!model) {
      console.error("--runtime sandcastle requires --model <provider/model-id>");
      process.exit(1);
    }
    const token = await workerToken(config.workerGhAccount);
    return new SandcastleRuntime({ model, token });
  }
  console.error(`unknown runtime "${name}" — use --runtime fake or --runtime sandcastle`);
  process.exit(1);
}

async function statusCommand(argv: string[]): Promise<void> {
  const configIndex = argv.indexOf("--config");
  const overridePath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  const config = loadConfigFrom(process.cwd(), overridePath);

  // Read-only: status never creates the workspace — an absent one is empty
  // (status before any run is a legal, informative state).
  const layout: WorkspaceLayout = {
    root: config.workspace,
    repos: join(config.workspace, WORKSPACE_SUBPATHS.repos),
    works: join(config.workspace, WORKSPACE_SUBPATHS.works),
    archive: join(config.workspace, WORKSPACE_SUBPATHS.archive),
  };

  // Derivation on demand through the port — the factory being stopped changes
  // nothing. The fake keeps `msf status` offline (read-only, no keyring read);
  // ticket 16 wires the real GitHub adapter into the run loop only — the boot
  // check must not gate a read-only status command.
  const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
  const view = await deriveStatus(tracker, config, layout);
  console.log(renderStatus(view));
}
