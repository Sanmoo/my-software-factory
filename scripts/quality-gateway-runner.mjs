import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { WORKER_IMAGE } from "./worker-image.mjs";

/**
 * The quality gateway runner: composition of the required checks,
 * elapsed-time measurement, the one global deadline, subprocess lifetime,
 * diagnostics and the exit status. The canonical entry composes the OFFICIAL
 * plan with the fixed ceiling; the test-only entry drives the same runner with
 * fixture checks and a short budget.
 *
 * Plain JavaScript so it can run on a clean checkout before its own first
 * stage compiles (and deletes) dist/. The operator contract (invocation,
 * prerequisites, ceiling, exit status) lives in README; the agent obligation
 * in AGENTS.md.
 */

export const BUDGET_MS = 240_000;

const PREREQUISITES = [
  {
    name: "docker daemon",
    command: "docker",
    args: ["info", "--format", "{{.ServerVersion}}"],
    hint: "install/start Docker — the real local Docker integration test is mandatory and never becomes a skip",
  },
  {
    name: `worker image ${WORKER_IMAGE}`,
    command: "docker",
    args: ["image", "inspect", WORKER_IMAGE],
    hint: "build it once with `npm run build:image` before the measured run (image building is provisioning, not validation)",
  },
];

/**
 * The complete deterministic gateway. Compilation IS the TypeScript static
 * validation (tsc type-checks as it emits), so no duplicate `--noEmit` pass is
 * composed. The test stage refuses to run without compiled test files, and
 * MSF_REQUIRE_DOCKER makes the real Docker test fail instead of skipping if its
 * prerequisites vanish after the preflight.
 */
export const OFFICIAL_PLAN = {
  prerequisites: PREREQUISITES,
  stages: [
    { name: "clean", action: "remove-dist" },
    { name: "compile", command: "npm", args: ["run", "build", "--silent"] },
    {
      name: "test",
      command: "npm",
      args: ["run", "test:built", "--silent"],
      env: { MSF_REQUIRE_DOCKER: "1" },
      // A suite without the e2e files, the provisioned image's real loading
      // test or the real Docker integration test is smaller than the required
      // one: refuse it instead of passing quietly.
      requiredTestFiles: ["state/liveness.test.js", "e2e/", "e2e/agent-image.test.js"],
    },
  ],
};

/** Exit statuses that are not a check's own failure code. */
const PREREQUISITE_FAILED = 2;
const BUDGET_EXHAUSTED = 124;
const CHECK_FAILED_WITHOUT_STATUS = 1;
const CHECK_COULD_NOT_START = 127;

/** The check currently running, so an interrupt can kill its whole group. */
let runningChild = null;

/** Kill the check's whole process group: a stalled node --test leaves test
 * subprocesses behind unless the group (spawned detached) dies with it. */
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Spawn one command and wait for it, bounded by `remainingMs`. Output is
 * inherited while `quiet` is false; prerequisite output is captured so a
 * failure can name what the tool said. */
function spawnBounded(stage, cwd, remainingMs, { quiet }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(stage.command, stage.args ?? [], {
        cwd,
        env: { ...process.env, ...(stage.env ?? {}) },
        stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
        detached: true,
      });
    } catch (error) {
      resolvePromise({ code: null, signal: null, error, timedOut: false, output: "" });
      return;
    }
    runningChild = child;
    let output = "";
    if (quiet) {
      child.stdout?.on("data", (chunk) => (output += String(chunk)));
      child.stderr?.on("data", (chunk) => (output += String(chunk)));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, Math.max(0, remainingMs));
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (runningChild === child) runningChild = null;
      resolvePromise({ ...result, timedOut, output });
    };
    child.once("error", (error) => settle({ code: null, signal: null, error }));
    child.once("close", (code, signal) => settle({ code, signal, error: null }));
  });
}

/** Terminate the running check (and its group) when the gateway is interrupted. */
export function installSignalTermination() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (runningChild !== null) killGroup(runningChild);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** The compiled test files a run would execute, relative to `cwd`'s dist. */
function compiledTestFiles(cwd) {
  try {
    return readdirSync(resolve(cwd, "dist"), { recursive: true }).filter((entry) =>
      String(entry).endsWith(".test.js"),
    );
  } catch {
    return [];
  }
}

/** The test sources the compile stage is expected to turn into those files. */
function sourceTestFiles(cwd) {
  try {
    return readdirSync(resolve(cwd, "src"), { recursive: true }).filter((entry) =>
      String(entry).endsWith(".test.ts"),
    );
  } catch {
    return [];
  }
}

/**
 * Run a plan to completion under one global deadline. Returns the process exit
 * status: 0 only when every prerequisite and every check passed within the
 * budget; 2 for a failed prerequisite; 124 when the budget is exhausted; the
 * check's own nonzero status otherwise.
 */
export async function runGateway(plan, { cwd, budgetMs, label = "quality gateway" }) {
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const elapsed = () => Date.now() - started;
  const report = (line) => process.stdout.write(`${label}: ${line}\n`);
  const reportError = (line) => process.stderr.write(`${label}: ${line}\n`);

  const budgetExhausted = (interrupted) => {
    reportError(
      `BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms)${interrupted === undefined ? "" : `; interrupted ${interrupted}`}`,
    );
    return BUDGET_EXHAUSTED;
  };

  for (const prerequisite of plan.prerequisites ?? []) {
    const name = `prerequisite "${prerequisite.name}"`;
    if (remaining() <= 0) return budgetExhausted(name);
    const result = await spawnBounded(prerequisite, cwd, remaining(), { quiet: true });
    if (result.timedOut) return budgetExhausted(name);
    if (result.error !== null || result.code !== 0) {
      const detail =
        result.error !== null ? result.error.message : `exit ${result.code ?? `signal ${result.signal}`}`;
      reportError(`prerequisite failed: ${prerequisite.name} (${detail})`);
      reportError(`  ${prerequisite.command} ${(prerequisite.args ?? []).join(" ")}`);
      if (result.output.trim() !== "") reportError(`  ${result.output.trim().split("\n").join("\n  ")}`);
      reportError(`  hint: ${prerequisite.hint}`);
      reportError("no check was run — the gateway cannot pass without its mandatory prerequisites");
      return PREREQUISITE_FAILED;
    }
    report(`${name} ready`);
  }

  const stages = plan.stages ?? [];
  for (const [index, stage] of stages.entries()) {
    const position = `[${index + 1}/${stages.length}]`;
    const check = `"${stage.name}"`;
    if (remaining() <= 0) return budgetExhausted(`check ${check} ${position}`);
    const stageStarted = Date.now();
    if (stage.action === "remove-dist") {
      try {
        rmSync(resolve(cwd, "dist"), { recursive: true, force: true });
      } catch (error) {
        reportError(`check failed: ${check} ${position} — could not remove dist: ${error.message}`);
        return CHECK_FAILED_WITHOUT_STATUS;
      }
      report(`${position} check ${check} passed (${Date.now() - stageStarted}ms)`);
      continue;
    }
    if (stage.requiredTestFiles !== undefined) {
      const files = compiledTestFiles(cwd);
      const sources = sourceTestFiles(cwd);
      const missing = stage.requiredTestFiles.filter(
        (required) => !files.some((file) => file === required || file.startsWith(required)),
      );
      if (files.length === 0 || missing.length > 0 || files.length < sources.length) {
        let gap;
        if (files.length === 0) gap = "no test files under dist/";
        else if (missing.length > 0) gap = `missing ${missing.join(", ")}`;
        else gap = `${files.length} of ${sources.length} source test files compiled`;
        reportError(`check failed: ${check} ${position} — the compiled suite is incomplete (${gap}); refusing to validate a smaller suite`);
        return CHECK_FAILED_WITHOUT_STATUS;
      }
      report(`${position} check ${check}: ${files.length} compiled test file(s)`);
    }
    const result = await spawnBounded(stage, cwd, remaining(), { quiet: false });
    const took = Date.now() - stageStarted;
    if (result.timedOut) return budgetExhausted(`check ${check} ${position}`);
    if (result.error !== null) {
      reportError(`check failed: ${check} ${position} — ${result.error.message} (${took}ms)`);
      return CHECK_COULD_NOT_START;
    }
    if (result.code !== 0) {
      reportError(`check failed: ${check} ${position} (exit ${result.code ?? `signal ${result.signal}`}; ${took}ms)`);
      return result.code ?? CHECK_FAILED_WITHOUT_STATUS;
    }
    report(`${position} check ${check} passed (${took}ms)`);
  }

  const total = elapsed();
  if (total > budgetMs) {
    reportError(`BUDGET EXHAUSTED: the gateway took ${total}ms, over the ${budgetMs}ms ceiling`);
    return BUDGET_EXHAUSTED;
  }
  report(`passed in ${total}ms of ${budgetMs}ms`);
  return 0;
}
