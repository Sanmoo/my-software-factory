import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("./run-lock.js", import.meta.url).href;

function child(config: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireRunLock } from ${JSON.stringify(moduleUrl)};
    const lock = await acquireRunLock(process.argv[1]);
    console.log("LOCKED");
    setInterval(() => {}, 1000);
    process.on("SIGTERM", async () => { await lock.close(); process.exit(0); });
  `, config], { stdio: ["ignore", "pipe", "pipe"] });
}

function waitForLine(process: ReturnType<typeof child>, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    process.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) resolve();
    });
    process.once("exit", (code) => reject(new Error(`child exited ${code}: ${output}`)));
  });
}

test("run exclusivity is process-wide, aliases converge, and abrupt death releases it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-run-lock-"));
  const config = join(dir, "msf.yaml");
  const alias = join(dir, "alias.yaml");
  writeFileSync(config, "worker-gh-account: test\nrepos: []\n");
  symlinkSync(config, alias);
  let owner: ReturnType<typeof child> | undefined;
  try {
    owner = child(config);
    await waitForLine(owner, "LOCKED");
    const contender = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireRunLock } from ${JSON.stringify(moduleUrl)};
      try { await acquireRunLock(process.argv[1]); process.exit(0); }
      catch (error) { console.error(error.message); process.exit(7); }
    `, alias], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    contender.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = await new Promise<number>((resolve) => contender.once("exit", (code) => resolve(code ?? -1)));
    assert.equal(exit, 7);
    assert.match(stderr, /already has an active msf run/);
    owner.kill("SIGKILL");
    await new Promise<void>((resolve) => owner!.once("exit", () => resolve()));
    owner = undefined;
    const restarted = child(alias);
    try {
      await waitForLine(restarted, "LOCKED");
    } finally {
      restarted.kill("SIGTERM");
      await new Promise<void>((resolve) => restarted.once("exit", () => resolve()));
    }
  } finally {
    owner?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
