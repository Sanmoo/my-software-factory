#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The quality gateway's composition and its one global deadline (issue 113).
 * Plain JavaScript because the first check deletes `dist/`, the compiled tree
 * this file cannot be part of. The operator contract (invocation, prerequisites,
 * ceiling, exit status) lives in README; the agent obligation in AGENTS.md.
 */

/** Production ceiling for the complete deterministic gateway. */
const BUDGET_MS = 240_000;

/** The image the real local Docker integration test correlates against.
 * Single-sourced in src/worker-image.ts for the factory; the gateway cannot
 * import TypeScript, so a test asserts the two values stay equal. */
const WORKER_IMAGE = "msf-v2-worker:local";

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
const OFFICIAL_PLAN = {
  prerequisites: PREREQUISITES,
  stages: [
    { name: "clean", action: "remove-dist" },
    { name: "compile", command: "npm", args: ["run", "build", "--silent"] },
    {
      name: "test",
      command: process.execPath,
      args: ["--test", "--test-timeout=60000", "--test-force-exit", "dist/**/*.test.js"],
      env: { MSF_REQUIRE_DOCKER: "1" },
      requiresCompiledTests: true,
    },
  ],
};

/** Exit statuses that are not a check's own failure code. */
const PREREQUISITE_FAILED = 2;
const BUDGET_EXHAUSTED = 124;
const CHECK_FAILED_WITHOUT_STATUS = 1;
const CHECK_COULD_NOT_START = 127;

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

/**
 * Run a plan to completion under one global deadline. Returns the process exit
 * status: 0 only when every prerequisite and every check passed within the
 * budget; 2 for a failed prerequisite; 124 when the budget is exhausted; the
 * check's own nonzero status otherwise.
 */
async function runGateway(plan, { cwd, budgetMs }) {
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const elapsed = () => Date.now() - started;

  const budgetExhausted = (interrupted) => {
    fail(`BUDGET EXHAUSTED after ${elapsed()}ms (ceiling ${budgetMs}ms)${interrupted === undefined ? "" : `; interrupted ${interrupted}`}`);
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
      fail(`prerequisite failed: ${prerequisite.name} (${detail})`);
      fail(`  ${prerequisite.command} ${(prerequisite.args ?? []).join(" ")}`);
      if (result.output.trim() !== "") fail(`  ${result.output.trim().split("\n").join("\n  ")}`);
      fail(`  hint: ${prerequisite.hint}`);
      fail("no check was run — the gateway cannot pass without its mandatory prerequisites");
      return PREREQUISITE_FAILED;
    }
    log(`${name} ready`);
  }

  const stages = plan.stages ?? [];
  for (const [index, stage] of stages.entries()) {
    const position = `[${index + 1}/${stages.length}]`;
    const check = `"${stage.name}"`;
    if (remaining() <= 0) return budgetExhausted(check);
    const stageStarted = Date.now();
    if (stage.action === "remove-dist") {
      try {
        rmSync(resolve(cwd, "dist"), { recursive: true, force: true });
      } catch (error) {
        fail(`check failed: ${check} ${position} — could not remove dist: ${error.message}`);
        return CHECK_FAILED_WITHOUT_STATUS;
      }
      log(`${position} check ${check} passed (${Date.now() - stageStarted}ms)`);
      continue;
    }
    if (stage.requiresCompiledTests === true) {
      const count = compiledTestFiles(cwd).length;
      if (count === 0) {
        fail(`check failed: ${check} ${position} — no compiled test files under dist/; refusing to validate an empty suite`);
        return CHECK_FAILED_WITHOUT_STATUS;
      }
      log(`${position} check ${check}: ${count} compiled test file(s)`);
    }
    const result = await spawnBounded(stage, cwd, remaining(), { quiet: false });
    const took = Date.now() - stageStarted;
    if (result.timedOut) return budgetExhausted(`check ${check} ${position}`);
    if (result.error !== null) {
      fail(`check failed: ${check} ${position} — ${result.error.message} (${took}ms)`);
      return CHECK_COULD_NOT_START;
    }
    if (result.code !== 0) {
      fail(`check failed: ${check} ${position} (exit ${result.code ?? `signal ${result.signal}`}; ${took}ms)`);
      return result.code ?? CHECK_FAILED_WITHOUT_STATUS;
    }
    log(`${position} check ${check} passed (${took}ms)`);
  }

  const total = elapsed();
  if (total > budgetMs) {
    fail(`BUDGET EXHAUSTED: the gateway took ${total}ms, over the ${budgetMs}ms ceiling`);
    return BUDGET_EXHAUSTED;
  }
  log(`quality gateway passed in ${total}ms of ${budgetMs}ms`);
  return 0;
}

/**
 * The test arrangement (issue 113, Testing Decisions): a fixture plan and a
 * short budget let the command-contract tests spawn this real command with
 * bounded checks instead of waiting four minutes or re-entering the official
 * suite. The official invocation has no flag that changes the plan or ceiling.
 */
function testArrangement() {
  const planPath = process.env.MSF_GATEWAY_TEST_PLAN;
  const budget = process.env.MSF_GATEWAY_TEST_BUDGET_MS;
  if (planPath === undefined && budget === undefined) return undefined;
  if (planPath === undefined || budget === undefined) {
    fail("incomplete test arrangement: set both MSF_GATEWAY_TEST_PLAN and MSF_GATEWAY_TEST_BUDGET_MS");
    return null;
  }
  const budgetMs = Number(budget);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    fail(`invalid test arrangement: MSF_GATEWAY_TEST_BUDGET_MS must be a positive number, got "${budget}"`);
    return null;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    fail(`cannot read the test arrangement plan at ${planPath}: ${error.message}`);
    return null;
  }
  return { plan, budgetMs };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arrangement = testArrangement();
  if (arrangement === null) {
    process.exitCode = PREREQUISITE_FAILED;
  } else {
    const { plan, budgetMs } = arrangement ?? { plan: OFFICIAL_PLAN, budgetMs: BUDGET_MS };
    process.exitCode = await runGateway(plan, { cwd: process.cwd(), budgetMs });
  }
}
