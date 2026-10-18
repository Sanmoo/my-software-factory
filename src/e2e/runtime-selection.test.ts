import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cli selects the runtime (ticket 17, retightened by 18): the DEFAULT is
 * the real Sandcastle runtime — it demands a model; `--runtime fake` (tests
 * only) is accepted without one; an unknown runtime is rejected. The flag
 * validation happens BEFORE the keyring boot check — bad flags fail fast
 * without touching the machine, and this suite stays offline.
 */

describe("e2e: the cli selects the worker runtime", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-runtime-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const cli = new URL("../cli.js", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function writeMinimalConfig(): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      ["worker-gh-account: bot-do-samuca", "repos:", `  - Sanmoo/nothing`, `workspace: ${join(dir, "ws")}`].join("\n"),
      "utf8",
    );
  }

  test("an unknown runtime is rejected at boot with exit 1", () => {
    writeMinimalConfig();
    const result = runCli(["run", "--once", "--runtime", "podman"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown runtime/);
  });

  test("the default runtime (real Sandcastle) without --model is rejected at boot", () => {
    writeMinimalConfig();
    const result = runCli(["run", "--once"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--model/);
  });

  test("--runtime sandcastle without --model is rejected at boot", () => {
    writeMinimalConfig();
    const result = runCli(["run", "--once", "--runtime", "sandcastle"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--model/);
  });

  test("--runtime fake is accepted without a model (tests only) and still hits the keyring boot check", () => {
    // The fake ADAPTER is not reachable from the binary — the boot check for
    // the REAL tracker adapter runs anyway; with an account that has no
    // token in the keyring, the run fails at boot with the clear message
    // (ticket 16), offline: the token lookup is a local keyring read.
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: msf-no-such-account",
        "repos:",
        `  - Sanmoo/nothing`,
        `workspace: ${join(dir, "ws")}`,
      ].join("\n"),
      "utf8",
    );
    const result = runCli(["run", "--once", "--runtime", "fake"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no GitHub token in the gh keyring for account "msf-no-such-account"/);
  });
});
