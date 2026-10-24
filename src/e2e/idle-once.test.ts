import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, runCli } from "./cli-harness.js";

/**
 * Boot behavior of the cli: without the bot token for the account,
 * `msf run` fails at boot with a clear message. The child gets an isolated
 * environment ({@link isolatedEnv}), so the REAL `gh` finds no credential for
 * the ghost account — the failure stays local, with no network and no
 * credential needed, and the run's lock state never lands in the
 * operator's dirs. The runs pass `--runtime fake` (the tests-only flag) so the
 * configured model is irrelevant to this boot check. The live boot
 * (token present, real derivation) is proven in the credential-gated smoke
 * (`npm run smoke:github`).
 */

describe("e2e: msf run boots through the keyring check", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-boot-"));
    env = isolatedEnv(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMinimalConfig(account?: string, extra?: string): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        `worker-gh-account: ${account ?? "bot-do-samuca"}`,
        "worker-model: opencode-go/glm-5.3-flash",
        "repos:",
        "  - Sanmoo/my-tasks",
        `workspace: ${join(dir, "ws")}`,
        ...(extra ? [extra] : []),
      ].join("\n"),
      "utf8",
    );
  }

  test("without the bot token in the keyring, the boot fails with a clear message", () => {
    const ghost = "msf-boot-test-ghost-account";
    writeMinimalConfig(ghost);

    const result = runCli(dir, ["run", "--once", "--runtime", "fake"], env);

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
      [`worker-gh-account: ${ghost}`, "worker-model: opencode-go/glm-5.3-flash", "repos:", "  - Sanmoo/other", `workspace: ${join(dir, "ws2")}`].join(
        "\n",
      ),
      "utf8",
    );

    const result = runCli(dir, ["run", "--once", "--runtime", "fake", "--config", other], env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, new RegExp(`"${ghost}"`));
  });

  test("missing required config fails fast at boot, nonzero exit", () => {
    writeFileSync(join(dir, "msf.yaml"), "concurrency: 2\n", "utf8");

    const result = runCli(dir, ["run", "--once"], env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /worker-gh-account/);
  });

  test("the built cli is the msf bin (dist/cli.js exists with a node shebang)", () => {
    const cli = new URL("../cli.js", import.meta.url).pathname;
    const head = execFileSync("head", ["-1", cli], { encoding: "utf8" });
    assert.match(head, /^#!.*node/);
  });

  test("the built cli is executable — the bin symlink runs the file itself", () => {
    // `npm link`/`npm i -g` symlink the bin straight to dist/cli.js, so the
    // shebang only works if the file keeps the exec bit: a compile into a
    // fresh dist (the gateway deletes it) emits 644, and the global `msf` then
    // dies with EACCES.
    const cli = new URL("../cli.js", import.meta.url).pathname;
    assert.doesNotThrow(() => accessSync(cli, constants.X_OK));
  });
});
