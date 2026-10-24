import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PI_MODEL_AUTH_ENV_VARS } from "../runtime/model-auth.js";
import { isolatedEnv, runCli } from "./cli-harness.js";

const MODEL = "opencode-go/deepseek-v4.1-flash";
const SECRET = "offline-credential-sentinel";

// Exercise the binary's ordering, not just the credential validator: even an
// empty pool must refuse bad auth before any tracker access or workspace work.
describe("e2e: model credentials gate the first sweep", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let calls: string;
  let trackerReady: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-auth-boot-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    calls = join(dir, "docker-calls.jsonl");
    trackerReady = join(dir, "tracker-ready");
    env = isolatedEnv(dir, { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` });
    for (const name of PI_MODEL_AUTH_ENV_VARS) delete env[name];
    env.MSF_AUTH_PROBE_STATUS = "not_ready";
    // workerToken uses execFile without closing stdin; this shim must answer
    // both token readers without waiting for input.
    writeFileSync(join(binDir, "gh"), [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'if (process.argv[2] !== "auth" || process.argv[3] !== "token") process.exit(1);',
      `fs.writeFileSync(${JSON.stringify(trackerReady)}, "reached");`,
      'console.log("ghp_msf_test_shim");',
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(dir, "msf.yaml"), [
      "worker-gh-account: bot",
      `worker-model: ${MODEL}`,
      "repos: []",
      `workspace: ${join(dir, "ws")}`,
    ].join("\n"));
    writeFileSync(join(binDir, "docker"), [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      'if (args.includes("msf-auth-probe")) {',
      '  const status = process.env.MSF_AUTH_PROBE_STATUS;',
      '  console.log(JSON.stringify({status, provider: "opencode-go", ...(status === "ready" ? {} : {reason: "credentials_not_configured"})}));',
      '  process.exit(status === "ready" ? 0 : 1);',
      "}",
    ].join("\n"), { mode: 0o755 });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function dockerCalls(): string[][] {
    return existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      : [];
  }

  function assertRefused(args: string[]): void {
    const result = runCli(dir, args, env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /factory not started/i);
    assert.match(result.stderr, /opencode-go\/deepseek-v4\.1-flash/);
    assert.match(result.stderr, /OPENCODE_API_KEY/);
    assert.match(result.stderr, /worker-auth-file/);
    assert.match(result.stderr, /personal Pi profile/);
    assert.match(result.stderr, /no sweep was started and no tickets were changed/i);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(SECRET));
    assert.doesNotMatch(result.stdout, /sweeping forever|derived|claiming|launching/);
    assert.equal(existsSync(trackerReady), false, "not even the tracker boot check was reached");
    assert.equal(existsSync(join(dir, "ws")), false, "no reservation, attempt or recovery footprint");
  }

  for (const args of [["run"], ["run", "--once"]]) {
    test(`${args.join(" ")}: missing credentials fail before the first sweep`, () => {
      assertRefused(args);
      assert.deepEqual(dockerCalls(), [], "an absent source needs no Docker probe");
    });
  }

  test("another provider's key does not satisfy the configured model; the probe is offline and never refreshes", () => {
    env.ANTHROPIC_API_KEY = SECRET;
    assertRefused(["run", "--once"]);
    const [probe] = dockerCalls();
    assert.equal(dockerCalls().length, 1, "no workspace liveness read or worker launch");
    assert.ok(probe?.includes("--network"));
    assert.ok(probe?.includes("none"));
    assert.ok(probe?.includes(MODEL));
    assert.ok(probe?.some((arg) => arg.includes("pi auth check") && arg.includes("--no-refresh")));
    assert.ok(!probe?.join(" ").includes(SECRET), "secret values never ride argv");
  });

  test("an unresolved supplied auth file fails at boot, before touching the tracker", () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: SECRET } }));
    writeFileSync(join(dir, "msf.yaml"), `\nworker-auth-file: ${path}\n`, { flag: "a" });
    assertRefused(["run", "--once"]);
    assert.equal(dockerCalls().length, 1);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify({ anthropic: { type: "api_key", key: SECRET } }));
  });

  for (const source of ["environment", "auth file"]) {
    test(`configured credentials from ${source} allow the empty-pool sweep`, () => {
      env.MSF_AUTH_PROBE_STATUS = "ready";
      if (source === "environment") env.OPENCODE_API_KEY = SECRET;
      else {
        const path = join(dir, "auth.json");
        writeFileSync(path, JSON.stringify({ "opencode-go": { type: "api_key", key: SECRET } }));
        writeFileSync(join(dir, "msf.yaml"), `\nworker-auth-file: ${path}\n`, { flag: "a" });
      }
      const result = runCli(dir, ["run", "--once"], env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /sweep done: empty pool/);
      assert.equal(existsSync(trackerReady), true);
      assert.ok(dockerCalls()[0]?.includes("msf-auth-probe"), "credentials precede all sweep probes");
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
    });
  }

  test("a refused restart preserves existing work evidence", () => {
    const work = join(dir, "ws", "trabalhos", "reserved");
    mkdirSync(work, { recursive: true });
    const evidence = join(work, "recovery.json");
    const before = '{"attempt":5,"recoveries":1}\n';
    writeFileSync(evidence, before);
    const result = runCli(dir, ["run", "--once"], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no sweep was started and no tickets were changed/i);
    assert.equal(readFileSync(evidence, "utf8"), before);
    assert.equal(existsSync(trackerReady), false);
    assert.deepEqual(dockerCalls(), []);
  });

  test("--config validates the selected model, not the default config's model", () => {
    const path = join(dir, "other.yaml");
    writeFileSync(path, [
      "worker-gh-account: bot",
      "worker-model: openai/gpt-4o",
      "repos: []",
      `workspace: ${join(dir, "other-ws")}`,
    ].join("\n"));
    const result = runCli(dir, ["run", "--once", "--config", path], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /openai\/gpt-4o/);
    assert.match(result.stderr, /OPENAI_API_KEY/);
    assert.doesNotMatch(result.stderr, /OPENCODE_API_KEY/);
    assert.equal(existsSync(join(dir, "other-ws")), false);
    assert.equal(existsSync(trackerReady), false);
  });

  test("a malformed auth file fails before the credential probe", () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, `{ invalid: ${SECRET}`);
    writeFileSync(join(dir, "msf.yaml"), `\nworker-auth-file: ${path}\n`, { flag: "a" });
    const result = runCli(dir, ["run", "--once"], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /factory not started/i);
    assert.match(result.stderr, /worker-auth-file is not valid JSON/);
    assert.doesNotMatch(result.stderr, new RegExp(SECRET));
    assert.equal(existsSync(trackerReady), false);
    assert.equal(existsSync(join(dir, "ws")), false);
    assert.deepEqual(dockerCalls(), []);
  });

  test("a missing auth file is an initialization error even with an environment key", () => {
    env.OPENCODE_API_KEY = SECRET;
    writeFileSync(join(dir, "msf.yaml"), `\nworker-auth-file: ${join(dir, "absent.json")}\n`, { flag: "a" });
    const result = runCli(dir, ["run", "--once"], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /factory not started/i);
    assert.match(result.stderr, /worker-auth-file is unreadable/);
    assert.match(result.stderr, /no sweep was started and no tickets were changed/i);
    assert.equal(existsSync(trackerReady), false);
    assert.equal(existsSync(join(dir, "ws")), false);
    assert.deepEqual(dockerCalls(), []);
  });

  test("status remains read-only and does not require model credentials", () => {
    const result = runCli(dir, ["status"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(trackerReady), true);
    assert.equal(existsSync(join(dir, "ws")), false);
    assert.deepEqual(dockerCalls().map(([command]) => command), ["ps"], "only the read-only liveness query");
  });
});
