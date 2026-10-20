#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The quality gateway (issue 113): the one canonical invocation of this
 * repository's deterministic checks, under a single wall-clock ceiling.
 *
 * The official composition lives in OFFICIAL_PLAN; runGateway owns everything
 * else — elapsed measurement, the global deadline, subprocess lifetime,
 * diagnostics and the exit status. Plain JavaScript on purpose: the first
 * check deletes `dist/`, so the gateway itself cannot be one of the compiled
 * artifacts it is about to remove.
 *
 * Provisioning (`npm install`, `npm run build:image`) is NOT part of the
 * gateway: the caller prepares it before the measured run. LLM reviews, the
 * real-model proof and the real GitHub smoke live outside this deterministic
 * contract. Every future check required for readiness joins OFFICIAL_PLAN and
 * shares this one budget.
 */

/** Production ceiling for the complete deterministic gateway. */
export const BUDGET_MS = 240_000;

/** The image the real local Docker integration test correlates against.
 * Single-sourced in src/worker-image.ts for the factory; the gateway cannot
 * import TypeScript, so a test asserts the two values stay equal. */
export const WORKER_IMAGE = "msf-v2-worker:local";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PREREQUISITES = [
  {
    name: "docker daemon",
    command: "docker",
    args: ["info", "--format", "{{.ServerVersion}}"],
    hint: "install/start Docker — the gateway runs the real local Docker integration test; a missing daemon is a failed prerequisite, never a skipped check",
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
 * composed. The test glob includes the unit, end-to-end and real local Docker
 * integration suites; MSF_REQUIRE_DOCKER makes that Docker test fail instead
 * of skipping if its prerequisites vanish after the preflight.
 */
export const OFFICIAL_PLAN = {
  prerequisites: PREREQUISITES,
  stages: [
    { name: "clean", action: "remove-dist" },
    { name: "compile", command: "npm", args: ["run", "build", "--silent"] },
    {
      name: "test",
      command: process.execPath,
      args: ["--test", "--test-timeout=60000", "--test-force-exit", "dist/**/*.test.js"],
      env: { MSF_REQUIRE_DOCKER: "1" },
    },
  ],
};

/** Exit statuses that are not a check's own failure code. */
const PREREQUISITE_FAILED = 2;
const BUDGET_EXHAUSTED = 124;

function log(line) {
  process.stdout.write(`quality gateway: ${line}\n`);
}

function fail(line) {
  process.stderr.write(`quality gateway: ${line}\n`);
}

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
      resolvePromise({ ...result, timedOut, output });
    };
    child.once("error", (error) => settle({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => settle({ code, signal, error: null }));
  });
}

/**
 * Run a plan to completion under one global deadline. Returns the process exit
 * status: 0 only when every prerequisite and every check passed within the
 * budget; 2 for a failed prerequisite; 124 when the budget is exhausted; the
 * check's own nonzero status otherwise.
 */
export async function runGateway(plan, { cwd = REPO_ROOT, budgetMs = BUDGET_MS } = {}) {
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const elapsed = () => Date.now() - started;

  for (const prerequisite of plan.prerequisites ?? []) {
    if (remaining() <= 0) {
      fail(`BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms) during prerequisite "${prerequisite.name}"`);
      return BUDGET_EXHAUSTED;
    }
    const result = await spawnBounded(prerequisite, cwd, remaining(), { quiet: true });
    if (result.timedOut) {
      fail(`BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms) during prerequisite "${prerequisite.name}"`);
      return BUDGET_EXHAUSTED;
    }
    if (result.error !== null || result.code !== 0) {
      const detail =
        result.error !== null ? result.error.message : `exit ${result.code ?? `signal ${result.signal}`}`;
      fail(`prerequisite failed: ${prerequisite.name} (${detail})`);
      fail(`  ${prerequisite.command} ${(prerequisite.args ?? []).join(" ")}`);
      if (result.output.trim() !== "") fail(`  ${result.output.trim().split("\n").join("\n  ")}`);
      fail(`  hint: ${prerequisite.hint}`);
      fail("no check was run — the gateway cannot pass without its mandatory prerequisites");
      return PREREQUISITE_FAILED;
    }
    log(`prerequisite "${prerequisite.name}" ready`);
  }

  const stages = plan.stages ?? [];
  for (const [index, stage] of stages.entries()) {
    const position = `[${index + 1}/${stages.length}]`;
    if (remaining() <= 0) {
      fail(
        `BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms); interrupted check: "${stage.name}" ${position}`,
      );
      return BUDGET_EXHAUSTED;
    }
    const stageStarted = Date.now();
    if (stage.action === "remove-dist") {
      try {
        rmSync(resolve(cwd, "dist"), { recursive: true, force: true });
      } catch (error) {
        fail(`check failed: "${stage.name}" — could not remove dist: ${error.message}`);
        return 1;
      }
      log(`${position} check "${stage.name}" passed (${Date.now() - stageStarted}ms)`);
      continue;
    }
    const result = await spawnBounded(stage, cwd, remaining(), { quiet: false });
    const took = Date.now() - stageStarted;
    if (result.timedOut) {
      fail(
        `BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms); interrupted check: "${stage.name}" ${position}`,
      );
      return BUDGET_EXHAUSTED;
    }
    if (result.error !== null) {
      fail(`check failed: "${stage.name}" — ${result.error.message} (${took}ms)`);
      return 127;
    }
    if (result.code !== 0) {
      fail(`check failed: "${stage.name}" (exit ${result.code ?? `signal ${result.signal}`}; ${took}ms)`);
      return result.code ?? 1;
    }
    log(`${position} check "${stage.name}" passed (${took}ms)`);
  }

  const total = elapsed();
  if (total > budgetMs) {
    fail(`BUDGET EXHAUSTED: the gateway took ${total}ms, over the ${budgetMs}ms ceiling`);
    return BUDGET_EXHAUSTED;
  }
  log(`quality gateway passed in ${total}ms of ${budgetMs}ms`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGateway(OFFICIAL_PLAN);
}
