import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGhShim, type GhShim } from "./cli-harness.js";

/**
 * End-to-end of issue #90 at the CLI boundary: `msf run` is exclusive per REAL
 * config path. Real, concurrent CLI subprocesses against a real temp
 * filesystem; the tracker boot read is served by a hermetic `gh` shim on PATH
 * (no keyring, no GitHub, no network). The protected identity is the
 * symlink-resolved path of the config file, never its content or the name on
 * the command line, and the guarantee covers the continuous run and `--once`
 * alike.
 */

const CLI = new URL("../cli.js", import.meta.url).pathname;
const RUN_LOCK = new URL("../run-lock.js", import.meta.url).pathname;

describe("e2e: msf run exclusivity per real config path (issue #90)", () => {
  let dir: string;
  let shim: GhShim;
  let children: ChildProcess[];
  let holdFiles: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-excl-"));
    shim = installGhShim(dir);
    children = [];
    holdFiles = [];
  });

  afterEach(() => {
    // Release every blocked shim BEFORE killing its owner, then kill what is
    // still up: the temp dir can go away without leaked processes.
    for (const hold of holdFiles) rmSync(hold, { force: true });
    for (const child of children) child.kill("SIGKILL");
    children = [];
    holdFiles = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(name: string, workspace: string, extra: string[] = []): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      [
        "worker-gh-account: bot-do-samuca",
        "repos: []",
        `workspace: ${workspace}`,
        ...extra,
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  function newHold(name: string): string {
    const hold = join(dir, name);
    writeFileSync(hold, "", "utf8");
    holdFiles.push(hold);
    return hold;
  }

  function runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd = dir,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function spawnOwner(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return child;
  }

  /** A lock holder that never boots the factory: it only establishes the
   * exclusivity, so the workspace stays absent while the CLI contender is
   * refused. This is the module's public acquisition boundary. */
  function spawnLockHolder(configPath: string): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `import { acquireRunLock } from ${JSON.stringify(RUN_LOCK)};`,
          "const lock = await acquireRunLock(process.argv[1]);",
          'console.log("HELD");',
          'process.on("SIGTERM", async () => { await lock.close(); process.exit(0); });',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        configPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(child);
    return child;
  }

  async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function waitForStdout(child: ChildProcess, text: string, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${text}"; saw: ${out}`)), timeoutMs);
      child.stdout!.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes(text)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`owner exited ${code} before "${text}"; saw: ${out}`));
      });
    });
  }

  /** Spawn a continuous owner held at the tracker boot check: the lock is
   * already held, the process is alive, and the run never reached a worker. */
  async function spawnHeldOwner(
    args = ["run", "--runtime", "fake"],
  ): Promise<{ owner: ChildProcess; ready: string; hold: string }> {
    const token = randomUUID();
    const ready = join(dir, `ready-${token}`);
    const hold = newHold(`hold-${token}`);
    const owner = spawnOwner(args, shim.env({ ready, hold }));
    await waitFor("the owner to establish exclusivity (tracker boot check reached)", () => existsSync(ready));
    return { owner, ready, hold };
  }

  function exitCode(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  // ---- refusal: continuous × continuous, continuous × --once, once × once ----

  test("a second run for the same config is refused immediately, before any operational activity", async () => {
    const workspace = join(dir, "ws");
    const config = writeConfig("msf.yaml", workspace);
    await spawnHeldOwner();

    const contenderReady = join(dir, "contender-ready");
    const contender = runCli(["run", "--runtime", "fake"], shim.env({ ready: contenderReady }));

    assert.notEqual(contender.status, 0, `expected refusal, got:\n${contender.stdout}${contender.stderr}`);
    assert.match(contender.stderr, /already has an active msf run/);
    assert.ok(
      contender.stderr.includes(realpathSync(config)),
      `the diagnostic must identify the configuration:\n${contender.stderr}`,
    );
    assert.ok(!existsSync(contenderReady), "the refused run never reached the tracker boot — no operational activity");
  });

  test("the continuous owner and a --once contender cannot overlap, in both directions", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));

    // Continuous owner → --once contender.
    const first = await spawnHeldOwner();
    const onceContender = runCli(["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(onceContender.status, 0);
    assert.match(onceContender.stderr, /already has an active msf run/);
    first.owner.kill("SIGKILL");

    // --once owner (held at boot, so it stays alive) → continuous contender.
    const onceReady = join(dir, "once-ready");
    const onceHold = newHold("once-hold");
    const onceOwner = spawnOwner(["run", "--once", "--runtime", "fake"], shim.env({ ready: onceReady, hold: onceHold }));
    await waitFor("the --once owner to hold exclusivity", () => existsSync(onceReady));

    const continuousContender = runCli(["run", "--runtime", "fake"], shim.env());
    assert.notEqual(continuousContender.status, 0);
    assert.match(continuousContender.stderr, /already has an active msf run/);

    // --once owner → --once contender.
    const secondOnceContender = runCli(["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(secondOnceContender.status, 0);
    assert.match(secondOnceContender.stderr, /already has an active msf run/);

    onceOwner.kill("SIGKILL");
  });

  // ---- identity: real path, not the spelling on the command line ----

  test("relative, absolute and symlinked spellings of the same config share the protection", async () => {
    const config = writeConfig("msf.yaml", join(dir, "ws"));
    symlinkSync(config, join(dir, "alias.yaml"));
    const holder = spawnLockHolder(config);
    await waitForStdout(holder, "HELD");

    const absolute = runCli(["run", "--once", "--runtime", "fake", "--config", config], shim.env());
    assert.notEqual(absolute.status, 0, `absolute: ${absolute.stderr}`);
    assert.match(absolute.stderr, /already has an active msf run/);

    const relative = runCli(["run", "--once", "--runtime", "fake", "--config", "msf.yaml"], shim.env(), dir);
    assert.notEqual(relative.status, 0, `relative: ${relative.stderr}`);
    assert.match(relative.stderr, /already has an active msf run/);

    const symlinked = runCli(["run", "--once", "--runtime", "fake", "--config", "alias.yaml"], shim.env(), dir);
    assert.notEqual(symlinked.status, 0, `symlink: ${symlinked.stderr}`);
    assert.match(symlinked.stderr, /already has an active msf run/);
  });

  test("editing the config content never releases the active run", async () => {
    const config = writeConfig("msf.yaml", join(dir, "ws"));
    const holder = spawnLockHolder(config);
    await waitForStdout(holder, "HELD");

    // The human edits the config (a different workspace) while the run is up.
    writeConfig("msf.yaml", join(dir, "other-ws"));

    const contender = runCli(["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /already has an active msf run/);
  });

  test("copies at distinct real paths are distinct configurations, identical content included", async () => {
    const configA = writeConfig("a.yaml", join(dir, "ws-a"));
    const configB = writeConfig("b.yaml", join(dir, "ws-b"));
    assert.notEqual(realpathSync(configA), realpathSync(configB));

    const holder = spawnLockHolder(configA);
    await waitForStdout(holder, "HELD");
    const readyB = join(dir, "ready-b");
    const ownerB = spawnOwner(["run", "--runtime", "fake", "--config", "b.yaml"], shim.env({ ready: readyB }));
    // B is NOT blocked by A: it reaches its own tracker boot check (and would
    // have been refused before that point if the identity were shared).
    await waitFor("the second, independent configuration to be admitted", () => existsSync(readyB));
    assert.ok(existsSync(readyB));
    ownerB.kill("SIGKILL");
  });

  // ---- status and failure modes ----

  test("msf status stays available while a run holds the config", async () => {
    const config = writeConfig("msf.yaml", join(dir, "ws"));
    const holder = spawnLockHolder(config);
    await waitForStdout(holder, "HELD");

    const status = runCli(["status"], shim.env());
    assert.equal(status.status, 0, `stderr: ${status.stderr}`);
    assert.match(status.stdout, /msf status/);
    assert.match(status.stdout, /0 eligible/);
  });

  test("a failure to establish the protection prevents the run, with a clear diagnostic and no workspace", () => {
    const workspace = join(dir, "ws-never");
    writeConfig("msf.yaml", workspace);
    // A non-existent TMPDIR makes the lock file unopenable: exclusivity cannot
    // be established, and the run must refuse instead of running unprotected.
    const result = runCli(["run", "--once", "--runtime", "fake"], {
      ...shim.env(),
      TMPDIR: join(dir, "no-such-tmpdir"),
    });

    assert.notEqual(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /cannot establish run exclusivity/);
    assert.ok(!existsSync(workspace), "no operational activity before the protection is established");
  });

  // ---- release and restart ----

  test("a live owner keeps exclusivity over an observation interval (no timeout steals it)", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));
    const { owner, hold } = await spawnHeldOwner();
    // Let the owner boot past the boot check into the idle continuous run.
    rmSync(hold, { force: true });
    await waitForStdout(owner, "sweeping forever");

    // Well past any plausible observation window, still exclusive.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const contender = runCli(["run", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /already has an active msf run/);
    owner.kill("SIGINT");
  });

  test("a new run starts after a normal shutdown, after a startup error, and after SIGKILL", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));

    // (a) Normal shutdown: boot the owner, Ctrl-C it, then a new run is admitted.
    const first = await spawnHeldOwner();
    rmSync(first.hold, { force: true });
    await waitForStdout(first.owner, "sweeping forever");
    first.owner.kill("SIGINT");
    assert.equal(await exitCode(first.owner), 0, "Ctrl-C exits cleanly");

    const afterShutdown = await spawnHeldOwner(["run", "--once", "--runtime", "fake"]);
    afterShutdown.owner.kill("SIGKILL");

    // (b) Startup error AFTER acquisition: the lock is released even though the
    // process ended on an error, so the next run is admitted.
    const failed = spawnOwner(["run", "--once", "--runtime", "fake"], shim.env({ fail: true }));
    assert.notEqual(await exitCode(failed), 0, "the startup error ends the process nonzero");

    const afterError = await spawnHeldOwner(["run", "--once", "--runtime", "fake"]);
    afterError.owner.kill("SIGKILL");

    // (c) Abrupt death (kill -9): the kernel releases the lock, no manual
    // cleanup — a new run is admitted.
    const abrupt = await spawnHeldOwner();
    abrupt.owner.kill("SIGKILL");
    await exitCode(abrupt.owner);

    const afterKill = await spawnHeldOwner(["run", "--once", "--runtime", "fake"]);
    assert.ok(existsSync(afterKill.ready));
    afterKill.owner.kill("SIGKILL");
  });
});
