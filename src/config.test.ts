import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, DEFAULT_CONCURRENCY, DEFAULT_LABELS, DEFAULT_WORKSPACE } from "./config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "msf-config-"));
}

function writeYaml(dir: string, content: string): string {
  const path = join(dir, "msf.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("config", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("minimal config: only required fields, every optional gets its default", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot-do-samuca", "repos:", "  - Sanmoo/my-tasks"].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.workerGhAccount, "bot-do-samuca");
    assert.deepEqual(config.repos, ["Sanmoo/my-tasks"]);
    assert.equal(config.concurrency, DEFAULT_CONCURRENCY);
    assert.equal(config.workspace, join(homedir(), ".local/share/msf"));
    assert.deepEqual(config.labels, DEFAULT_LABELS);
  });

  test("missing worker-gh-account is an error", () => {
    const path = writeYaml(dir, "repos:\n  - Sanmoo/my-tasks\n");
    assert.throws(() => loadConfig(path), /worker-gh-account/);
  });

  test("missing repos is an error", () => {
    const path = writeYaml(dir, "worker-gh-account: bot-do-samuca\n");
    assert.throws(() => loadConfig(path), /repos/);
  });

  test("missing config file is an error", () => {
    assert.throws(() => loadConfig(join(dir, "nope.yaml")), /not found/i);
  });

  test("malformed yaml is an error, not a crash with a stack full of library frames", () => {
    const path = writeYaml(dir, "worker-gh-account: [unclosed");
    assert.throws(() => loadConfig(path), /msf\.yaml|parse/i);
  });

  test("every optional field can be overridden", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "repos:",
        "  - Sanmoo/a",
        "  - Sanmoo/b",
        "concurrency: 5",
        "workspace: /tmp/msf-workspace",
        "labels:",
        "  ready: pronto",
        "  claimed: tomado",
        "  blocked: travado",
      ].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.concurrency, 5);
    assert.equal(config.workspace, "/tmp/msf-workspace");
    assert.deepEqual(config.labels, {
      ready: "pronto",
      claimed: "tomado",
      blocked: "travado",
    });
  });

  test("a partially given labels map keeps defaults for the missing keys", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "repos: [Sanmoo/a]", "labels:", "  ready: pronto"].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.labels.ready, "pronto");
    assert.equal(config.labels.claimed, DEFAULT_LABELS.claimed);
    assert.equal(config.labels.blocked, DEFAULT_LABELS.blocked);
  });

  test("workspace `~` expands to the home directory", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "repos: [Sanmoo/a]", "workspace: ~/msf-ws"].join("\n"),
    );

    const config = loadConfig(path);

    assert.ok(!config.workspace.startsWith("~"), "tilde must be expanded");
    assert.ok(config.workspace.endsWith("msf-ws"));
  });

  test("non-positive concurrency is rejected", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "repos: [Sanmoo/a]", "concurrency: 0"].join("\n"),
    );
    assert.throws(() => loadConfig(path), /concurrency/);
  });

  test("repos must be a list of strings", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nrepos: 3\n");
    assert.throws(() => loadConfig(path), /repos/);
  });
});
