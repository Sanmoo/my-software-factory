import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForStdout } from "./e2e/cli-harness.js";

const moduleUrl = new URL("./run-lock.js", import.meta.url).href;

/** The child env: an isolated HOME keeps this suite's lock files inside the
 * temp dir instead of the operator's real state dir. */
const childEnv = (home: string): NodeJS.ProcessEnv => ({ ...process.env, HOME: home });

/** A holder that never boots the factory: the module's acquisition boundary,
 * used to prove cross-process exclusivity directly. It prints LOCKED once the
 * lock is its own and then stays alive until killed. */
function spawnLockHolder(config: string, home: string): ChildProcess {
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
    { env: childEnv(home), stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A contender: exit 0 when admitted, exit 7 carrying the diagnostic when
 * refused. */
function spawnContender(config: string, home: string): ChildProcess {
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
    { env: childEnv(home), stdio: ["ignore", "pipe", "pipe"] },
  );
}

function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
}

test("run exclusivity is process-wide, aliases converge, and abrupt death releases it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-run-lock-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const config = join(dir, "msf.yaml");
    const alias = join(dir, "alias.yaml");
    writeFileSync(config, "worker-gh-account: test\nrepos: []\n");
    symlinkSync(config, alias);

    let owner: ChildProcess | undefined = spawnLockHolder(config, home);
    try {
      await waitForStdout(owner, "LOCKED");

      // The symlinked spelling of the same real file is the same identity.
      const contender = spawnContender(alias, home);
      let stderr = "";
      contender.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      assert.equal(await exitOf(contender), 7);
      assert.match(stderr, /already has an active msf run/);

      // Abrupt death: no close(), no handler — the kernel releases the lock.
      owner.kill("SIGKILL");
      await exitOf(owner);
      owner = undefined;

      const restarted = spawnLockHolder(alias, home);
      try {
        await waitForStdout(restarted, "LOCKED");
      } finally {
        restarted.kill("SIGTERM");
        await exitOf(restarted);
      }
    } finally {
      owner?.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
