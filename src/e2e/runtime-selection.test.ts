import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cli selects the runtime (ticket 17): `--runtime sandcastle` demands a
 * model and a keyring credential; an unknown runtime is rejected. The
 * selection is validated BEFORE any launch — with an empty pool nothing
 * reaches the runtime either way, but the flags must parse at boot.
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

  test("--runtime sandcastle without --model is rejected at boot", () => {
    writeMinimalConfig();
    const result = runCli(["run", "--once", "--runtime", "sandcastle"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--model/);
  });
});
