import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Boot behavior of the cli (ticket 16): without the bot token in the gh
 * keyring, `msf run` fails at boot with a clear message. The account used
 * here has no token in any keyring, so the failure is local — no network,
 * no credential needed. The live boot (token present, real derivation) is
 * proven in the credential-gated smoke (`npm run smoke:github`).
 */

describe("e2e: msf run boots through the keyring check", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-boot-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMinimalConfig(account?: string, extra?: string): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        `worker-gh-account: ${account ?? "bot-do-samuca"}`,
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

  test("without the bot token in the keyring, the boot fails with a clear message", () => {
    const ghost = "msf-boot-test-ghost-account";
    writeMinimalConfig(ghost);

    const result = runCli(["run", "--once"], dir);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      new RegExp(`no GitHub token in the gh keyring for account "${ghost}"`),
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  });

  test("--config overrides the msf.yaml of the cwd (the named account is the one checked)", () => {
    writeMinimalConfig();
    const other = join(dir, "other.yaml");
    const ghost = "msf-boot-test-ghost-account-2";
    writeFileSync(
      other,
      [`worker-gh-account: ${ghost}`, "repos:", "  - Sanmoo/other", `workspace: ${join(dir, "ws2")}`].join(
        "\n",
      ),
      "utf8",
    );

    const result = runCli(["run", "--once", "--config", other], dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, new RegExp(`"${ghost}"`));
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
