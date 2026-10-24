import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentProvider, RunResult } from "@ai-hero/sandcastle";
import { SandcastleRuntime } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";
import { dockerWorkerProbe } from "../state/liveness.js";
import { WORKSPACE_SUBPATHS } from "../layout.js";
import { COOPERATIVE_STOP_MS } from "../stop-signals.js";
import type { WorkRequest } from "../runtime/port.js";
import { workKeyOf } from "../pool/work-key.js";
import { githubWork } from "./work-fixtures.js";

/**
 * The driver of the real-runtime stop proof (issue #146). It runs INSIDE a
 * container of the worker image that shares the host's paths and daemon
 * socket: the launch it starts is a real Sandcastle worker container, so the
 * stop contract — cooperative and forced — is proven against real containers,
 * never a fake. The agent is deterministic (a `sleep`), so the test never
 * depends on LLM inference.
 *
 * Usage: node real-stop-driver.js <cooperative|forced|abort> <host root>
 *
 * It prints one line to stdout: `MSF_STOP_RESULT=<json>`; diagnostics go to
 * stderr. Exit 0 only when the contract held.
 *
 * Every wait here is bounded WELL below the test's own timeout: a hung Docker
 * must fail this proof by name, never consume the quality gateway's budget.
 */

const MODE = process.argv[2];
const ROOT = process.argv[3];

/** The deterministic agent: a shell command that never ends on its own. The
 *  runtime appends the worker flags to the command, so the shell ignores them. */
function deterministicAgent(): AgentProvider {
  return {
    name: "deterministic",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: "sh -c 'sleep 120'" }),
    parseStreamLine: () => [],
  };
}

/** The container must appear within this bound; a real launch takes seconds. */
const APPEARANCE_LIMIT_MS = 20_000;
/** The launch must settle within this bound once the forced stop ran. */
const SETTLE_LIMIT_MS = 20_000;
/** The abort's own grace: how long the cooperative request alone gets to end
 *  the real container in the abort mode (the factory's window is 10 s). */
const ABORT_GRACE_MS = 15_000;

function log(line: string): void {
  process.stderr.write(`[real-stop] ${line}\n`);
}

/** Poll a condition for at most `ms`; resolves whether it held inside. */
async function waitForSettle(ms: number, condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=msf stop proof", "-c", "user.email=prova@msf.local", "-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

async function main(): Promise<void> {
  if (MODE !== "cooperative" && MODE !== "forced" && MODE !== "abort") {
    throw new Error(`unknown mode ${MODE}: use cooperative, forced or abort`);
  }
  if (ROOT === undefined || !existsSync(ROOT)) throw new Error(`the root ${ROOT} does not exist`);

  const repoDir = join(ROOT, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "the disposable repo of the stop proof\n", "utf8");
  if (!existsSync(join(repoDir, ".git"))) {
    git(repoDir, "init", "--initial-branch", "main");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "seed: the disposable repo");
  }

  const workspace = join(ROOT, "fabrica");
  const workDir = join(workspace, "trabalhos", "Sanmoo", "stop#1");
  for (const path of [workDir, join(workspace, "toolchains", "mise"), join(workspace, "toolchains", "agent", "npm")]) {
    mkdirSync(path, { recursive: true });
  }
  const profileDir = join(ROOT, "perfil");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "settings.json"), "{}", "utf8");

  // The factory's own read-only liveness probe (ADR 0002): Docker is the
  // authority on which containers carry the work.
  const probe = dockerWorkerProbe({
    worksRoot: join(workspace, WORKSPACE_SUBPATHS.works),
  });

  const request: WorkRequest = {
    work: githubWork("Sanmoo/stop", 1),
    workDir,
    branch: "agent-stop-1",
    repoDir,
    baseBranch: "main",
    attempt: 1,
    material: { ticket: { title: "the real stop proof", body: "" }, diff: "" },
  };

  const runtime = new SandcastleRuntime({
    model: "deterministic/stop-proof",
    token: "no-github-token",
    image: WORKER_IMAGE,
    profileDir,
    workspace,
    // A short poll so the activity watch never interferes with the stop; the
    // agent is silent on purpose, and the stop arrives long before the limit.
    idleTimeoutSeconds: 120,
    activityPollMs: 200,
    piProvider: () => deterministicAgent(),
  });

  const launched = runtime.launch(request);
  let launchSettled = false;
  let outcome: string | undefined;
  launched.then(
    (result) => {
      launchSettled = true;
      outcome = result.outcome;
    },
    (error: unknown) => {
      launchSettled = true;
      outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );

  // The worker container is really there: the probe names the work before any
  // stop is requested (otherwise the stop would prove nothing).
  let seenWorker = false;
  const appearanceDeadline = Date.now() + APPEARANCE_LIMIT_MS;
  while (!seenWorker && Date.now() < appearanceDeadline) {
    const live = await probe();
    seenWorker = live.some((worker) => worker.key === workKeyOf(request.work));
    if (!seenWorker) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!seenWorker) throw new Error("the worker container never appeared — the proof cannot proceed");
  log(`worker of  is alive`);

  // The factory's contract, exactly as the loop applies it: the requested stop
  // first, the forced stop at the end of the cooperative window (mode
  // "cooperative"), or the second-signal escalation straight away (mode
  // "forced"). Mode "abort" never forces: it proves the cooperative request
  // alone ends the real container, through the runtime's own abort.
  let settledInWindow = false;
  let forced = false;
  log(`requesting the cooperative stop (mode ${MODE})`);
  runtime.requestStop(request.work);
  if (MODE === "abort") {
    const settledByAbort = await waitForSettle(ABORT_GRACE_MS, () => launchSettled);
    log(`the abort ${settledByAbort ? "settled the launch" : "did not settle the launch"} on its own`);
  } else if (MODE === "cooperative") {
    settledInWindow = await waitForSettle(COOPERATIVE_STOP_MS, () => launchSettled);
    if (settledInWindow) {
      log("the session ended inside the cooperative window");
    } else {
      log("the cooperative window ended without the session ending; forcing the stop");
      await runtime.forceStop(request.work);
      forced = true;
      log(`forced; the probe now sees: ${JSON.stringify((await probe()).map((w) => w.key))}`);
    }
  } else {
    log("escalating: forcing the stop now");
    await runtime.forceStop(request.work);
    forced = true;
    log(`forced; the probe now sees: ${JSON.stringify((await probe()).map((w) => w.key))}`);
  }

  // The runtime's confirmation: the launch settles after the forced stop;
  // either way the probe must show nothing left.
  const settled = await Promise.race([
    new Promise<boolean>((resolve) => {
      const check = (): void => {
        if (launchSettled) resolve(true);
        else setTimeout(check, 100);
      };
      check();
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SETTLE_LIMIT_MS)),
  ]);
  const surviving = await probe();
  const result = {
    mode: MODE,
    workerSeen: seenWorker,
    settledInWindow,
    forcedStop: forced,
    launchSettled: settled,
    outcome: outcome ?? null,
    surviving: surviving.map((worker) => worker.key),
  };
  process.stdout.write(`MSF_STOP_RESULT=${JSON.stringify(result)}\n`);
  if (surviving.length > 0) throw new Error(`a worker survived the ${MODE} stop: ${result.surviving.join(", ")}`);
  if (!settled) throw new Error(`the ${MODE} stop did not settle the launch`);
  if (MODE === "abort" && forced) throw new Error("the abort mode forced a stop — the proof is void");
}

try {
  await main();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
// The proof is done and printed: Sandcastle's internal unwind may outlive the
// forced stop in this process, exactly as the factory's CLI exits once the
// stop is confirmed (the container absence is the proof, not a lingering
// handle).
process.exit(0);
