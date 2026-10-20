import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe } from "node:test";

import { WORKER_IMAGE } from "./worker-image.js";

/**
 * The quality gateway's command contract (issue 113). Every test spawns the
 * REAL command (`scripts/quality-gateway.mjs`) with an isolated working
 * directory and controlled environment. The official composition is exercised
 * end to end over a fixture project whose `npm`/`docker` are executable shims;
 * deadline behaviour uses the narrowly scoped test arrangement (a fixture plan
 * and short budget through MSF_GATEWAY_TEST_*), never the official plan with a
 * shortened ceiling — the production invocation has no such flag.
 */

const GATEWAY = new URL("../scripts/quality-gateway.mjs", import.meta.url).pathname;

interface CommandStage {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  action?: "remove-dist";
  requiresCompiledTests?: boolean;
  hint?: string;
}

interface Plan {
  prerequisites: CommandStage[];
  stages: CommandStage[];
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "msf-gateway-"));
}

/** The child environment: no outer test-runner mark (a nested `node --test`
 * would be skipped as recursive) and no inherited gateway requirement, so a
 * suite can exercise both sides of MSF_REQUIRE_DOCKER. */
function baseEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    NODE_TEST_CONTEXT: _nestedRunner,
    MSF_REQUIRE_DOCKER: _requiredByOuter,
    MSF_GATEWAY_TEST_PLAN: _plan,
    MSF_GATEWAY_TEST_BUDGET_MS: _budget,
    ...env
  } = process.env;
  return { ...env, ...extra };
}

/** Spawn the real gateway command in `dir`. A plan/budget selects the test
 * arrangement; without both, the command runs its official composition. */
function runGateway(dir: string, extraEnv: NodeJS.ProcessEnv = {}, plan?: Plan, budgetMs?: number): CommandResult {
  const arrangement: NodeJS.ProcessEnv = {};
  if (plan !== undefined) {
    const planPath = join(dir, "fixture-plan.json");
    writeFileSync(planPath, JSON.stringify(plan), "utf8");
    arrangement["MSF_GATEWAY_TEST_PLAN"] = planPath;
  }
  if (budgetMs !== undefined) arrangement["MSF_GATEWAY_TEST_BUDGET_MS"] = String(budgetMs);
  const result = spawnSync(process.execPath, [GATEWAY], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: baseEnv({ ...arrangement, ...extraEnv }),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function nodeStage(name: string, source: string): CommandStage {
  return { name, command: process.execPath, args: ["-e", source] };
}

function writeShim(binDir: string, name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

/** A minimal project the OFFICIAL gateway can run: `docker` passes the
 * preflight (recording its calls), `npm run build` proves dist is clean and
 * compiles one fixture test, and `node --test` really executes it. */
function officialFixture(): { dir: string; dockerLog: string; env: NodeJS.ProcessEnv } {
  const dir = freshDir();
  const binDir = join(dir, "bin");
  const dockerLog = join(dir, "docker.log");
  const testSource = join(dir, "sample.test.source.js");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    testSource,
    [
      'const { test } = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("the fixture suite executes", () => { assert.equal(1, 1); });',
      "",
    ].join("\n"),
    "utf8",
  );
  writeShim(
    binDir,
    "docker",
    [
      "#!/bin/sh",
      `printf '%s\\n' "docker $*" >> "${dockerLog}"`,
      'if [ -n "$FIXTURE_DOCKER_FAIL" ]; then exit 1; fi',
      "case \"$1\" in",
      "  info|image) exit 0 ;;",
      "esac",
      "exit 7",
      "",
    ].join("\n"),
  );
  writeShim(
    binDir,
    "npm",
    [
      "#!/bin/sh",
      'if [ "$1" = "run" ] && [ "$2" = "build" ]; then',
      '  if [ -e dist/stale.js ]; then echo "stale dist visible to compile" >&2; exit 9; fi',
      '  if [ "$FIXTURE_WRITE_TESTS" = "0" ]; then exit 0; fi',
      "  mkdir -p dist || exit 8",
      '  if [ "$FIXTURE_FAILING_TEST" = "1" ]; then',
      '    printf \'%s\\n\' \'const { test } = require("node:test"); test("fails", () => { throw new Error("fixture failure"); });\' > dist/sample.test.js',
      "  else",
      '    cp "$FIXTURE_TEST_SOURCE" dist/sample.test.js || exit 8',
      "  fi",
      "  exit 0",
      "fi",
      'echo "unexpected npm $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "stale.js"), "stale artifact", "utf8");
  return {
    dir,
    dockerLog,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FIXTURE_TEST_SOURCE: testSource,
    },
  };
}

/** Wait until `pid` is gone or a zombie (SIGKILL is not instant, and an
 * orphaned zombie stays visible to `kill(pid, 0)` until it is reaped). */
async function gone(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 3 (after the parenthesised comm) is the process state.
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return true;
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("quality gateway — the command contract", () => {
  test("the official command prepares, cleans, compiles and runs the whole suite under 240s", () => {
    const { dir, dockerLog, env } = officialFixture();

    const result = runGateway(dir, env);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /prerequisite "docker daemon" ready/);
    assert.match(result.stdout, new RegExp(`prerequisite "worker image ${WORKER_IMAGE}" ready`));
    assert.match(result.stdout, /\[1\/3\] check "clean" passed/);
    assert.match(result.stdout, /\[2\/3\] check "compile" passed/);
    assert.match(result.stdout, /\[3\/3\] check "test": 1 compiled test file\(s\)/);
    assert.match(result.stdout, /\[3\/3\] check "test" .*passed/);
    assert.match(result.stdout, /quality gateway passed in \d+ms of 240000ms/);
    assert.ok(!existsSync(join(dir, "dist", "stale.js")), "the clean stage removed the stale artifact");
    assert.ok(existsSync(join(dir, "dist", "sample.test.js")), "the freshly compiled suite executed");
    const calls = readFileSync(dockerLog, "utf8");
    assert.match(calls, /docker info --format \{\{\.ServerVersion\}\}/);
    assert.match(calls, new RegExp(`docker image inspect ${WORKER_IMAGE}`));
  });

  test("a missing Docker prerequisite fails before any check runs", () => {
    const { dir, env } = officialFixture();

    const result = runGateway(dir, { ...env, FIXTURE_DOCKER_FAIL: "1" });

    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /prerequisite failed: docker daemon \(exit 1\)/);
    assert.match(result.stderr, /hint: install\/start Docker/);
    assert.match(result.stderr, /no check was run/);
    assert.ok(existsSync(join(dir, "dist", "stale.js")), "no check ran, so nothing was cleaned");
    assert.ok(!existsSync(join(dir, "dist", "sample.test.js")), "the suite was never compiled");
  });

  test("an empty compiled suite is refused instead of passing with zero tests", () => {
    const { dir, env } = officialFixture();

    const result = runGateway(dir, { ...env, FIXTURE_WRITE_TESTS: "0" });

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /check failed: "test" .*no compiled test files under dist/);
    assert.doesNotMatch(result.stdout, /check "test" .*passed/);
  });

  test("a failing compiled suite fails the gateway and names the test stage", () => {
    const { dir, env } = officialFixture();

    const result = runGateway(dir, { ...env, FIXTURE_FAILING_TEST: "1" });

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /check failed: "test" .*\(exit 1;/);
    assert.match(`${result.stdout}${result.stderr}`, /fixture failure/);
  });

  test("a passing fixture plan runs every check in order and exits 0", () => {
    const dir = freshDir();
    const plan: Plan = {
      prerequisites: [],
      stages: [
        nodeStage("write-marker", `require("node:fs").writeFileSync("one.txt", "first")`),
        nodeStage(
          "read-marker",
          `if (require("node:fs").readFileSync("one.txt", "utf8") !== "first") process.exit(9)`,
        ),
      ],
    };

    const result = runGateway(dir, {}, plan, 20_000);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[1\/2\] check "write-marker" passed/);
    assert.match(result.stdout, /\[2\/2\] check "read-marker" passed/);
    assert.match(result.stdout, /quality gateway passed in \d+ms of 20000ms/);
  });

  test("a failing check fails the gateway, names it, and stops the later checks", () => {
    const dir = freshDir();
    const plan: Plan = {
      prerequisites: [],
      stages: [
        nodeStage("broken", "process.exit(3)"),
        nodeStage("never-runs", `require("node:fs").writeFileSync("ran.txt", "late")`),
      ],
    };

    const result = runGateway(dir, {}, plan, 20_000);

    assert.equal(result.status, 3, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /check failed: "broken" .*exit 3/);
    assert.ok(!existsSync(join(dir, "ran.txt")), "a failed check stops the run");
  });

  test("the deadline is global: a second check gets only what the first left", () => {
    const dir = freshDir();
    const plan: Plan = {
      prerequisites: [],
      stages: [nodeStage("first", "setTimeout(() => {}, 900)"), nodeStage("second", "setTimeout(() => {}, 900)")],
    };

    const result = runGateway(dir, {}, plan, 1_500);

    assert.equal(result.status, 124, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /check "first" .*passed/);
    assert.match(result.stderr, /BUDGET EXHAUSTED[^\n]*interrupted check "second"/);
    assert.match(result.stderr, /ceiling 1500ms/);
  });

  test("at the deadline the running check and its descendants are killed", async () => {
    const dir = freshDir();
    const plan: Plan = {
      prerequisites: [],
      stages: [
        {
          name: "stalled",
          command: "/bin/sh",
          args: ["-c", "sleep 300 & echo $! > child.pid; echo $$ > sh.pid; wait"],
        },
      ],
    };

    const result = runGateway(dir, {}, plan, 1_000);

    assert.equal(result.status, 124, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /interrupted check "stalled"/);
    const shPid = Number(readFileSync(join(dir, "sh.pid"), "utf8").trim());
    const childPid = Number(readFileSync(join(dir, "child.pid"), "utf8").trim());
    assert.ok(await gone(shPid), `the check process ${shPid} outlived the gateway`);
    assert.ok(await gone(childPid), `the check's descendant ${childPid} outlived the gateway`);
  });

  test("the real Docker check fails (never skips) when the gateway requires it", () => {
    const dir = freshDir();
    const emptyBin = join(dir, "bin");
    mkdirSync(emptyBin, { recursive: true });
    const livenessTest = new URL("./state/liveness.test.js", import.meta.url).pathname;
    const run = (requireDocker: boolean) =>
      spawnSync(process.execPath, ["--test", livenessTest], {
        encoding: "utf8",
        timeout: 30_000,
        env: baseEnv({
          PATH: emptyBin,
          ...(requireDocker ? { MSF_REQUIRE_DOCKER: "1" } : {}),
        }),
      });

    const required = run(true);
    assert.notEqual(required.status, 0, "a required Docker check that cannot run fails the file");
    assert.match(`${required.stdout}${required.stderr}`, /requires the real Docker check/);

    const focused = run(false);
    assert.equal(focused.status, 0, "a focused run may still skip, with a reason");
  });
});
