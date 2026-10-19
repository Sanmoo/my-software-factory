import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolatedEnv, waitForStdout } from "./e2e/cli-harness.js";

const moduleUrl = new URL("./run-lock.js", import.meta.url).href;

/** A holder that never boots the factory: the module's acquisition boundary,
 * used to prove cross-process exclusivity directly. It prints LOCKED once the
 * lock is its own and then stays alive until killed. */
function spawnLockHolder(config: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { acquireRunLock } from ${JSON.stringify(moduleUrl)};
        const lock = await acquireRunLock(process.argv[1]);
        console.log("LOCKED");
        setInterval(() => {}, 1000);
        process.on("SIGTERM", async () => { await lock.close(); process.exit(0); });
      `,
      config,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A contender: exit 0 when admitted, exit 7 carrying the diagnostic when
 * refused. */
function spawnContender(config: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { acquireRunLock } from ${JSON.stringify(moduleUrl)};
        try { await acquireRunLock(process.argv[1]); process.exit(0); }
        catch (error) { console.error(error.message); process.exit(7); }
      `,
      config,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Resolve with the child's exit code, or reject when it never started.
 * Attach it BEFORE killing the child: node emits 'exit' once, and a late
 * listener would hang forever. */
function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

/** Kill a child and wait for it — a no-op (never a hang) when it already
 * exited on its own. */
async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitOf(child);
  child.kill("SIGKILL");
  await exited;
}

/** Refuse-expected: exit 7, diagnostic naming the config. */
async function assertRefused(contender: ChildProcess): Promise<void> {
  let stderr = "";
  contender.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  assert.equal(await exitOf(contender), 7, "the contender is refused");
  assert.match(stderr, /already has an active msf run/);
}

test("run exclusivity is process-wide, aliases converge, and abrupt death releases it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-run-lock-"));
  try {
    // The suite-owned environment: the marker files of this test stay in the
    // temp dir instead of the operator's state dir.
    const env = isolatedEnv(dir);
    const config = join(dir, "msf.yaml");
    const alias = join(dir, "alias.yaml");
    writeFileSync(config, "worker-gh-account: test\nrepos: []\n");
    symlinkSync(config, alias);

    const owner = spawnLockHolder(config, env);
    try {
      await waitForStdout(owner, "LOCKED");

      // The symlinked spelling of the same real file is the same identity.
      await assertRefused(spawnContender(alias, env));

      // Abrupt death: no close(), no handler — the kernel releases the locks.
      const ownerExit = exitOf(owner);
      owner.kill("SIGKILL");
      await ownerExit;

      const restarted = spawnLockHolder(alias, env);
      try {
        await waitForStdout(restarted, "LOCKED");
      } finally {
        const restartedExit = exitOf(restarted);
        restarted.kill("SIGTERM");
        await restartedExit;
      }
    } finally {
      await killAndWait(owner);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guarantee does not depend on HOME: a different state dir still excludes the same config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-run-lock-home-"));
  try {
    const config = join(dir, "msf.yaml");
    writeFileSync(config, "worker-gh-account: test\nrepos: []\n");

    // Two state dirs, as an elevated shell, a systemd unit or a `docker exec
    // -e HOME=…` would produce for the SAME operator and the SAME config.
    const owner = spawnLockHolder(config, isolatedEnv(join(dir, "home-a")));
    try {
      await waitForStdout(owner, "LOCKED");
      await assertRefused(spawnContender(config, isolatedEnv(join(dir, "home-b"))));
    } finally {
      await killAndWait(owner);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
