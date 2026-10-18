import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, DEFAULT_CONCURRENCY, DEFAULT_LABELS } from "./config.js";

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
      ["worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash", "repos:", "  - Sanmoo/my-tasks"].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.workerGhAccount, "bot-do-samuca");
    assert.equal(config.workerModel, "opencode-go/glm-5.3-flash");
    assert.deepEqual(config.repos, ["Sanmoo/my-tasks"]);
    assert.equal(config.concurrency, DEFAULT_CONCURRENCY);
    assert.equal(config.workspace, join(homedir(), ".local/share/msf"));
    assert.deepEqual(config.labels, DEFAULT_LABELS);
    assert.equal(config.notifications, true, "local notifications are ON by default (issue 93)");
  });

  test("missing worker-model is an error", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nrepos: [Sanmoo/a]\n");
    assert.throws(() => loadConfig(path), /worker-model.*required/);
  });

  test("worker-model must be provider/model-id", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: sem-barra\nrepos: [Sanmoo/a]\n");
    assert.throws(() => loadConfig(path), /worker-model.*provider\/model-id/);
  });

  test("missing worker-gh-account is an error", () => {
    const path = writeYaml(dir, "repos:\n  - Sanmoo/my-tasks\n");
    assert.throws(() => loadConfig(path), /worker-gh-account/);
  });

  test("missing repos is an error", () => {
    const path = writeYaml(dir, "worker-gh-account: bot-do-samuca\nworker-model: opencode-go/glm-5.3-flash\n");
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
        "worker-model: opencode-go/glm-5.3-flash",
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
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "labels:", "  ready: pronto"].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.labels.ready, "pronto");
    assert.equal(config.labels.claimed, DEFAULT_LABELS.claimed);
    assert.equal(config.labels.blocked, DEFAULT_LABELS.blocked);
  });

  test("workspace `~` expands to the home directory", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "workspace: ~/msf-ws"].join("\n"),
    );

    const config = loadConfig(path);

    assert.ok(!config.workspace.startsWith("~"), "tilde must be expanded");
    assert.ok(config.workspace.endsWith("msf-ws"));
  });

  test("non-positive concurrency is rejected", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "concurrency: 0"].join("\n"),
    );
    assert.throws(() => loadConfig(path), /concurrency/);
  });

  test("repos must be a list of strings", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: 3\n");
    assert.throws(() => loadConfig(path), /repos/);
  });

  // ---- the profile-snapshot keys (ticket 18 wiring) ----

  test("profile-allowed-roots defaults to EMPTY — no operator-personal path in the product", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n");

    const config = loadConfig(path);

    // The default carries no root: a profile with symlinks then fails the
    // snapshot fail-closed (ProfileSnapshotError naming the link and the
    // "profile-allowed-roots" key) until THIS operator declares the roots
    // the own machine's profile legitimately reaches.
    assert.deepEqual(config.profileAllowedRoots, []);
    assert.equal(config.profileSkipDanglingLinks, false, "fail closed by default");
  });

  test("profile-allowed-roots and profile-skip-dangling-links parse when given", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/a]",
        "profile-allowed-roots:",
        "  - ~/meus-dotfiles",
        "  - /abs/raiz",
        "profile-skip-dangling-links: true",
      ].join("\n"),
    );

    const config = loadConfig(path);

    assert.deepEqual(config.profileAllowedRoots, [join(homedir(), "meus-dotfiles"), "/abs/raiz"]);
    assert.equal(config.profileSkipDanglingLinks, true);
  });

  test("profile-allowed-roots must be a list of strings when given", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\nprofile-allowed-roots: 3\n");
    assert.throws(() => loadConfig(path), /profile-allowed-roots/);
  });

  test("profile-skip-dangling-links must be a boolean when given", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\nprofile-skip-dangling-links: yes-please\n");
    assert.throws(() => loadConfig(path), /profile-skip-dangling-links/);
  });

  test("notifications can be explicitly disabled — the factory then runs silently", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "notifications: false"].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.notifications, false);
  });

  test("notifications must be a boolean when given", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "notifications: always"].join("\n"),
    );
    assert.throws(() => loadConfig(path), /notifications.*boolean/);
  });
});
