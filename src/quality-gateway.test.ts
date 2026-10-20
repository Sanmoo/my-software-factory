import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, describe } from "node:test";

import { WORKER_IMAGE } from "./worker-image.js";

/**
 * The quality gateway's command contract (issue 113). The gateway is the one
 * canonical, budgeted invocation of this repository's deterministic checks;
 * these tests exercise its scheduling and diagnostics through a real process
 * with fixture checks — never by launching the official gateway from inside
 * its own suite (the official test glob would recurse). The production
 * ceiling lives in BUDGET_MS; a fixture plan supplies its own short budget
 * through the narrow test arrangement (the exported runGateway seam), so no
 * user-facing flag can shorten the official deadline.
 */

const GATEWAY_URL = new URL("../scripts/quality-gateway.mjs", import.meta.url);

interface FixtureStage {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  action?: "remove-dist";
  hint?: string;
}

interface FixturePlan {
  prerequisites: FixtureStage[];
  stages: FixtureStage[];
  budgetMs: number;
}

interface FixtureResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Run a plan through the gateway in a real, isolated process rooted at `dir`. */
function runPlan(dir: string, plan: FixturePlan, env: NodeJS.ProcessEnv = process.env): FixtureResult {
  const entry = join(dir, "gateway-fixture.mjs");
  writeFileSync(
    entry,
    [
      `import { runGateway } from ${JSON.stringify(pathToFileURL(GATEWAY_URL.pathname).href)};`,
      `const code = await runGateway(${JSON.stringify(plan)}, { cwd: ${JSON.stringify(dir)}, budgetMs: ${plan.budgetMs} });`,
      "process.exit(code);",
      "",
    ].join("\n"),
    "utf8",
  );
  const started = Date.now();
  const result = spawnSync(process.execPath, [entry], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Date.now() - started,
  };
}

/** A stage that runs a node one-liner in the fixture process' cwd. */
function nodeStage(name: string, source: string): FixtureStage {
  return { name, command: process.execPath, args: ["-e", source] };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "msf-gateway-"));
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

/** The exported official composition, read from a real process. */
function readOfficialPlan(dir: string): {
  budgetMs: number;
  image: string;
  plan: {
    prerequisites: FixtureStage[];
    stages: FixtureStage[];
  };
} {
  const probe = join(dir, "plan-probe.mjs");
  writeFileSync(
    probe,
    [
      `import * as gateway from ${JSON.stringify(pathToFileURL(GATEWAY_URL.pathname).href)};`,
      "console.log(JSON.stringify({ budgetMs: gateway.BUDGET_MS, image: gateway.WORKER_IMAGE, plan: gateway.OFFICIAL_PLAN }));",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as ReturnType<typeof readOfficialPlan>;
}

describe("quality gateway — the command contract", () => {
  test("a passing plan runs every check in order and exits 0", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    const plan: FixturePlan = {
      budgetMs: 20_000,
      prerequisites: [],
      stages: [
        nodeStage("write-marker", `require("node:fs").writeFileSync("one.txt", "first")`),
        nodeStage("read-marker", `if (require("node:fs").readFileSync("one.txt", "utf8") !== "first") process.exit(9)`),
      ],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /check "write-marker" passed/);
    assert.match(result.stdout, /check "read-marker" passed/);
    assert.match(result.stdout, /quality gateway passed in \d+ms of 20000ms/);
  });

  test("the clean stage removes previous compilation output before compilation runs", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "stale.js"), "stale output", "utf8");
    const plan: FixturePlan = {
      budgetMs: 20_000,
      prerequisites: [],
      stages: [
        { name: "clean", action: "remove-dist" },
        nodeStage(
          "compile",
          `const fs = require("node:fs"); if (fs.existsSync("dist/stale.js")) process.exit(7); fs.mkdirSync("dist"); fs.writeFileSync("dist/fresh.js", "fresh")`,
        ),
      ],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(!existsSync(join(dir, "dist", "stale.js")), "the stale artifact is gone before the compile check");
    assert.ok(existsSync(join(dir, "dist", "fresh.js")), "the compile check wrote into a clean dist");
  });

  test("a failing check fails the gateway, names it, and stops the later checks", () => {
    const dir = freshDir();
    const plan: FixturePlan = {
      budgetMs: 20_000,
      prerequisites: [],
      stages: [
        nodeStage("broken", "process.exit(3)"),
        nodeStage("never-runs", `require("node:fs").writeFileSync("ran.txt", "late")`),
      ],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 3, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /check failed: "broken" \(exit 3/);
    assert.ok(!existsSync(join(dir, "ran.txt")), "a failed check stops the run");
  });

  test("the deadline is global: a second check gets only what the first left", () => {
    const dir = freshDir();
    const plan: FixturePlan = {
      budgetMs: 1_500,
      prerequisites: [],
      stages: [
        nodeStage("first", "setTimeout(() => {}, 900)"),
        nodeStage("second", "setTimeout(() => {}, 900)"),
      ],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 124, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /check "first" passed/);
    assert.match(result.stderr, /BUDGET EXHAUSTED[^\n]*interrupted check: "second"/);
    assert.match(result.stderr, /ceiling 1500ms/);
  });

  test("at the deadline the running check and its descendants are killed", async () => {
    const dir = freshDir();
    const plan: FixturePlan = {
      budgetMs: 1_000,
      prerequisites: [],
      stages: [
        {
          name: "stalled",
          command: "/bin/sh",
          args: ["-c", "sleep 300 & echo $! > child.pid; echo $$ > sh.pid; wait"],
        },
      ],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 124, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /interrupted check: "stalled"/);
    const shPid = Number(readFileSync(join(dir, "sh.pid"), "utf8").trim());
    const childPid = Number(readFileSync(join(dir, "child.pid"), "utf8").trim());
    assert.ok(await gone(shPid), `the check process ${shPid} outlived the gateway`);
    assert.ok(await gone(childPid), `the check's descendant ${childPid} outlived the gateway`);
  });

  test("a missing prerequisite fails before any check, with the actionable hint", () => {
    const dir = freshDir();
    const plan: FixturePlan = {
      budgetMs: 20_000,
      prerequisites: [
        {
          name: "docker daemon",
          command: join(dir, "no-such-docker"),
          args: ["info"],
          hint: "install/start Docker",
        },
      ],
      stages: [nodeStage("check", `require("node:fs").writeFileSync("ran.txt", "late")`)],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /prerequisite failed: docker daemon/);
    assert.match(result.stderr, /hint: install\/start Docker/);
    assert.match(result.stderr, /no check was run/);
    assert.ok(!existsSync(join(dir, "ran.txt")), "no check runs without the prerequisites");
  });

  test("a prerequisite that exists but fails is a prerequisite failure, not a check failure", () => {
    const dir = freshDir();
    const plan: FixturePlan = {
      budgetMs: 20_000,
      prerequisites: [
        { name: "worker image", command: process.execPath, args: ["-e", "process.exit(1)"], hint: "build it" },
      ],
      stages: [nodeStage("check", "process.exit(0)")],
    };

    const result = runPlan(dir, plan);

    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /prerequisite failed: worker image \(exit 1\)/);
  });

  test("the official plan is one 240s budget over clean, compile and the whole test suite", () => {
    const dir = freshDir();
    const { budgetMs, image, plan } = readOfficialPlan(dir);

    assert.equal(budgetMs, 240_000, "the production ceiling is 240 seconds");
    assert.equal(image, WORKER_IMAGE, "the gateway's image name matches the factory's");
    assert.deepEqual(plan.stages.map((stage) => stage.name), ["clean", "compile", "test"]);
    const compile = plan.stages.find((stage) => stage.name === "compile");
    assert.equal(compile?.command, "npm");
    assert.deepEqual(compile?.args, ["run", "build", "--silent"]);
    assert.ok(
      !plan.stages.some((stage) => stage.name.includes("typecheck")),
      "compilation already type-checks — no duplicate no-emit pass",
    );
    const testStage = plan.stages.find((stage) => stage.name === "test");
    assert.deepEqual(testStage?.args, [
      "--test",
      "--test-timeout=60000",
      "--test-force-exit",
      "dist/**/*.test.js",
    ]);
    assert.equal(testStage?.env?.["MSF_REQUIRE_DOCKER"], "1");
    assert.ok(
      !plan.stages.some((stage) => "budgetMs" in stage),
      "no stage resets or owns the global budget",
    );
    assert.deepEqual(
      plan.prerequisites.map((prerequisite) => `${prerequisite.command} ${(prerequisite.args ?? []).join(" ")}`),
      ["docker info --format {{.ServerVersion}}", `docker image inspect ${WORKER_IMAGE}`],
    );
  });

  test("the real Docker check fails (never skips) when the gateway requires it", () => {
    const dir = freshDir();
    const emptyBin = join(dir, "bin");
    mkdirSync(emptyBin, { recursive: true });
    const livenessTest = new URL("./state/liveness.test.js", import.meta.url).pathname;
    // The outer runner marks its descendants; a nested `node --test` must run
    // as an ordinary process or Node skips the file ("called recursively").
    // The focused run also drops the gateway's own requirement: this test
    // proves both sides, so it sets MSF_REQUIRE_DOCKER only where wanted.
    const {
      NODE_TEST_CONTEXT: _nestedRunner,
      MSF_REQUIRE_DOCKER: _requiredByOuter,
      ...env
    } = process.env;
    const run = (requireDocker: boolean) =>
      spawnSync(process.execPath, ["--test", livenessTest], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...env,
          PATH: emptyBin,
          ...(requireDocker ? { MSF_REQUIRE_DOCKER: "1" } : {}),
        },
      });

    const required = run(true);
    assert.notEqual(required.status, 0, "a required Docker check that cannot run fails the file");
    assert.match(`${required.stdout}${required.stderr}`, /requires the real Docker check/);

    const focused = run(false);
    assert.equal(focused.status, 0, "a focused run may still skip, with a reason");
  });
});
