import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, runCli as runCliProcess } from "./cli-harness.js";

describe("e2e: strict CLI parsing and configured worker model", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-runtime-"));
    env = isolatedEnv(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    return runCliProcess(dir, args, env);
  }
  function config(model = "opencode-go/glm-5.3-flash"): void {
    writeFileSync(join(dir, "msf.yaml"), [
      "worker-gh-account: msf-no-such-account", `worker-model: ${model}`, "repos: [Sanmoo/nothing]", `workspace: ${join(dir, "ws")}`,
    ].join("\n"));
  }

  test("missing worker-model fails config load before touching keyring or workspace", () => {
    writeFileSync(join(dir, "msf.yaml"), "worker-gh-account: msf-no-such-account\nrepos: [Sanmoo/nothing]\n");
    const result = runCli(["run", "--once"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /worker-model.*required/);
    assert.equal(existsSync(join(dir, "ws")), false);
    assert.doesNotMatch(result.stderr, /keyring/);
  });

  test("--model is an unknown flag and does not touch the keyring", () => {
    config();
    const result = runCli(["run", "--model", "x/y"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag "--model"/);
    assert.match(result.stderr, /usage: msf run/);
    assert.equal(existsSync(join(dir, "ws")), false);
    assert.doesNotMatch(result.stderr, /keyring/);
  });

  test("known flags without values fail before config, workspace, and keyring", () => {
    config();
    const result = runCli(["run", "--runtime"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag "--runtime"/);
    assert.match(result.stderr, /usage: msf run/);
    assert.equal(existsSync(join(dir, "ws")), false);
  });

  test("extra positional arguments are rejected by the binary", () => {
    config();
    const result = runCli(["run", "gadget"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected argument "gadget"/);
  });

  test("--runtime fake is accepted and reaches the offline keyring boot check", () => {
    config();
    const result = runCli(["run", "--once", "--runtime", "fake"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no GitHub token in the gh keyring for account "msf-no-such-account"/);
  });
});
