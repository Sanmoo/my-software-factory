import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGhShim, runCli, spawnCli, waitFor, waitForStdout, type GhShim } from "./cli-harness.js";

/**
 * End-to-end of issue #90 at the CLI boundary: `msf run` is exclusive per REAL
 * config path. Real, concurrent CLI subprocesses against a real temp
 * filesystem; the tracker boot read is served by a hermetic `gh` shim on PATH
 * (no keyring, no GitHub, no network) whose `env` also isolates the child's
 * HOME. The protected identity is the symlink-resolved path of the config
 * file, never its content or the name on the command line, and the guarantee
 * covers the continuous run and `--once` alike.
 *
 * The owner is always a real `msf run` (held at the tracker boot check, past
 * the lock acquisition), never the lock module: the contract is observed at
 * the public boundary, not through the mechanism.
 *
 * The suite runs with the global `--test-timeout` (60 s, `npm test`): every
 * case is a set of real node processes, and under a loaded machine their
 * startup — not the behaviour under test — dominates.
 */

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
      ["worker-gh-account: bot-do-samuca", "repos: []", `workspace: ${workspace}`, ...extra].join("\n"),
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

  function spawnOwner(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawnCli(dir, args, env);
    children.push(child);
    return child;
  }

  /** Spawn a real `msf run` held at the tracker boot check: the lock is
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
    const owner = await spawnHeldOwner();

    const contenderReady = join(dir, "contender-ready");
    const contender = runCli(dir, ["run", "--runtime", "fake"], shim.env({ ready: contenderReady }));

    assert.notEqual(contender.status, 0, `expected refusal, got:\n${contender.stdout}${contender.stderr}`);
    assert.match(contender.stderr, /already has an active msf run/);
    assert.ok(
      contender.stderr.includes(realpathSync(config)),
      `the diagnostic must identify the configuration:\n${contender.stderr}`,
    );
    assert.ok(!existsSync(contenderReady), "the refused run never reached the tracker boot — no operational activity");
    assert.equal(owner.owner.exitCode, null, "the active run stays alive and untouched after the refusal");
  });

  test("the continuous owner and a --once contender cannot overlap, in both directions", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));

    // Continuous owner → --once contender.
    const first = await spawnHeldOwner();
    const onceContender = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(onceContender.status, 0);
    assert.match(onceContender.stderr, /already has an active msf run/);
    first.owner.kill("SIGKILL");

    // --once owner (held at boot, so it stays alive) → continuous contender.
    const onceReady = join(dir, "once-ready");
    const onceHold = newHold("once-hold");
    const onceOwner = spawnOwner(["run", "--once", "--runtime", "fake"], shim.env({ ready: onceReady, hold: onceHold }));
    await waitFor("the --once owner to hold exclusivity", () => existsSync(onceReady));

    const continuousContender = runCli(dir, ["run", "--runtime", "fake"], shim.env());
    assert.notEqual(continuousContender.status, 0);
    assert.match(continuousContender.stderr, /already has an active msf run/);

    // --once owner → --once contender.
    const secondOnceContender = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(secondOnceContender.status, 0);
    assert.match(secondOnceContender.stderr, /already has an active msf run/);

    onceOwner.kill("SIGKILL");
  });

  test("simultaneous contenders: exactly one proceeds, the rest fail without operational effects", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));

    interface Racer {
      child: ChildProcess;
      ready: string;
      hold: string;
      exit: number | null;
      stderr: string;
    }
    const racers: Racer[] = [];
    for (let index = 0; index < 6; index += 1) {
      const ready = join(dir, `race-ready-${index}`);
      const hold = newHold(`race-hold-${index}`);
      const child = spawnOwner(["run", "--runtime", "fake"], shim.env({ ready, hold }));
      const racer: Racer = { child, ready, hold, exit: null, stderr: "" };
      child.stderr!.on("data", (chunk) => {
        racer.stderr += String(chunk);
      });
      child.once("exit", (code) => {
        racer.exit = code;
      });
      racers.push(racer);
    }

    // Every process reaches one of the two outcomes: it acquired the lock and
    // parked at the boot check (ready), or it was refused and exited.
    await waitFor(
      "all simultaneous contenders to settle",
      () => racers.every((racer) => existsSync(racer.ready) || racer.exit !== null),
      20_000,
    );

    const winners = racers.filter((racer) => existsSync(racer.ready));
    assert.equal(winners.length, 1, "exactly one process acquired the lock");
    for (const loser of racers.filter((racer) => !existsSync(racer.ready))) {
      assert.notEqual(loser.exit, 0, `loser must exit nonzero; stderr: ${loser.stderr}`);
      assert.match(loser.stderr, /already has an active msf run/);
    }

    // The winner is intact: release the boot check and confirm it boots.
    const winner = winners[0]!;
    rmSync(winner.hold, { force: true });
    await waitForStdout(winner.child, "sweeping forever");
    winner.child.kill("SIGINT");
  });

  // ---- identity: real path, not the spelling on the command line ----

  test("relative, absolute and symlinked spellings of the same config share the protection", async () => {
    const config = writeConfig("msf.yaml", join(dir, "ws"));
    symlinkSync(config, join(dir, "alias.yaml"));
    await spawnHeldOwner();

    const absolute = runCli(dir, ["run", "--once", "--runtime", "fake", "--config", config], shim.env());
    assert.notEqual(absolute.status, 0, `absolute: ${absolute.stderr}`);
    assert.match(absolute.stderr, /already has an active msf run/);

    const relative = runCli(dir, ["run", "--once", "--runtime", "fake", "--config", "msf.yaml"], shim.env());
    assert.notEqual(relative.status, 0, `relative: ${relative.stderr}`);
    assert.match(relative.stderr, /already has an active msf run/);

    const symlinked = runCli(dir, ["run", "--once", "--runtime", "fake", "--config", "alias.yaml"], shim.env());
    assert.notEqual(symlinked.status, 0, `symlink: ${symlinked.stderr}`);
    assert.match(symlinked.stderr, /already has an active msf run/);
  });

  test("editing the config content never releases the active run", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));
    await spawnHeldOwner();

    // The human edits the config (a different workspace) while the run is up.
    writeConfig("msf.yaml", join(dir, "other-ws"));

    const contender = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /already has an active msf run/);
  });

  test("an editor's atomic save (a new inode at the same real path) never releases the active run", async () => {
    const workspace = join(dir, "ws");
    const config = writeConfig("msf.yaml", workspace);
    const before = statSync(config).ino;
    await spawnHeldOwner(["run", "--runtime", "fake"]);

    // The ordinary atomic save: the editor writes a fresh file and renames it
    // over the config. The real path keeps its identity, the inode does not —
    // so the config file's own lock no longer matches and the path-keyed
    // marker is the one that must refuse the contender.
    const replacement = join(dir, "msf.yaml.saved");
    writeFileSync(replacement, readFileSync(config));
    renameSync(replacement, config);
    assert.notEqual(statSync(config).ino, before, "the save really produced a new inode");

    const contender = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0, `the replaced config still has its owner: ${contender.stderr}`);
    assert.match(contender.stderr, /already has an active msf run/);
    assert.ok(
      contender.stderr.includes(realpathSync(config)),
      `the diagnostic still identifies the configuration:\n${contender.stderr}`,
    );
  });

  test("copies at distinct real paths are distinct configurations, identical content included", async () => {
    const sharedWorkspace = join(dir, "ws-shared");
    const configA = writeConfig("a.yaml", sharedWorkspace);
    // b.yaml is byte-identical to a.yaml (same content, same workspace): only
    // the real path differs.
    writeFileSync(join(dir, "b.yaml"), readFileSync(configA));
    assert.notEqual(realpathSync(configA), realpathSync(join(dir, "b.yaml")));

    await spawnHeldOwner(["run", "--runtime", "fake", "--config", "a.yaml"]);
    const readyB = join(dir, "ready-b");
    const ownerB = spawnOwner(["run", "--runtime", "fake", "--config", "b.yaml"], shim.env({ ready: readyB }));
    await waitFor("the byte-identical copy to be admitted", () => existsSync(readyB));
    assert.ok(existsSync(readyB), "identical content at a distinct real path is not blocked");
    ownerB.kill("SIGKILL");

    // An independent configuration with its own workspace is likewise not
    // blocked by the first (the spec's independent-workspace scenario).
    writeConfig("c.yaml", join(dir, "ws-c"));
    const readyC = join(dir, "ready-c");
    const ownerC = spawnOwner(["run", "--runtime", "fake", "--config", "c.yaml"], shim.env({ ready: readyC }));
    await waitFor("the independent-workspace configuration to be admitted", () => existsSync(readyC));
    assert.ok(existsSync(readyC), "independent workspaces are not blocked by this rule");
    ownerC.kill("SIGKILL");
  });

  // ---- status and failure modes ----

  test("msf status stays available while a run holds the config", async () => {
    writeConfig("msf.yaml", join(dir, "ws"));
    const { owner } = await spawnHeldOwner();

    const status = runCli(dir, ["status"], shim.env());
    assert.equal(status.status, 0, `stderr: ${status.stderr}`);
    assert.match(status.stdout, /msf status/);
    assert.match(status.stdout, /0 eligible/);
    assert.equal(owner.exitCode, null, "status never disturbs the active run");
  });

  test("a failure to establish the protection prevents the run, with a clear diagnostic and no workspace", () => {
    const workspace = join(dir, "ws-never");
    writeConfig("msf.yaml", workspace);
    // The per-user lock storage cannot be created under a HOME that is a
    // regular file: exclusivity cannot be established, so the run must refuse
    // instead of running unprotected.
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "", "utf8");
    const result = runCli(dir, ["run", "--once", "--runtime", "fake"], { ...shim.env(), HOME: notADir });

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
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const contender = runCli(dir, ["run", "--runtime", "fake"], shim.env());
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /already has an active msf run/);
    owner.kill("SIGINT");
  });

  test("a --once run that completes naturally releases the config for the next run", () => {
    writeConfig("msf.yaml", join(dir, "ws"));

    const first = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.equal(first.status, 0, `first --once: ${first.stderr}`);
    const second = runCli(dir, ["run", "--once", "--runtime", "fake"], shim.env());
    assert.equal(second.status, 0, `second --once: ${second.stderr}`);
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
