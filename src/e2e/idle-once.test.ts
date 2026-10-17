import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end of the idle `--once`: the factory boots with a minimal config,
 * derives an empty pool, launches no worker and exits clean. Real temp dir
 * for the workspace — the disk is never mocked; no network, no container.
 */

describe("e2e: msf run --once with an empty pool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-once-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMinimalConfig(extra?: string): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "repos:",
        "  - Sanmoo/my-tasks",
        `workspace: ${join(dir, "ws")}`,
        ...(extra ? [extra] : []),
      ].join("\n"),
      "utf8",
    );
  }

  function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
    const cli = new URL("../cli.js", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("boots, derives an empty pool, launches no worker and exits 0", () => {
    writeMinimalConfig();

    const result = runCli(["run", "--once"], dir);

    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /empty pool/i);

    // the workspace is guaranteed with its derived subpaths — real disk
    const ws = join(dir, "ws");
    assert.ok(existsSync(join(ws, "repos")));
    assert.ok(existsSync(join(ws, "trabalhos")));
    assert.ok(existsSync(join(ws, "arquivo")));
  });

  test("--config overrides the msf.yaml of the cwd", () => {
    writeMinimalConfig();
    const other = join(dir, "other.yaml");
    writeFileSync(
      other,
      ["worker-gh-account: other-bot", "repos:", "  - Sanmoo/other", `workspace: ${join(dir, "ws2")}`].join(
        "\n",
      ),
      "utf8",
    );

    const result = runCli(["run", "--once", "--config", other], dir);

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(dir, "ws2", "repos")));
  });

  test("missing required config fails fast at boot, nonzero exit", () => {
    writeFileSync(join(dir, "msf.yaml"), "concurrency: 2\n", "utf8");

    const result = runCli(["run", "--once"], dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /worker-gh-account/);
  });

  test("the built cli is the msf bin (dist/cli.js exists with a node shebang)", () => {
    const cli = new URL("../cli.js", import.meta.url).pathname;
    const head = execFileSync("head", ["-1", cli], { encoding: "utf8" });
    assert.match(head, /^#!.*node/);
  });
});
