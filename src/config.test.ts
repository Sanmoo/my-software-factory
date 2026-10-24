import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  DEFAULT_CONCURRENCY,
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
} from "./config.js";

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
    assert.equal(config.notifications, true, "local notifications are ON by default");
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

  // ---- model authentication ----

  test("worker-auth-file is optional: absent means provider environment variables", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n");

    const config = loadConfig(path);

    assert.equal(config.workerAuthFile, null);
  });

  test("worker-auth-file expands a leading tilde and accepts an absolute path", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/a]",
        "worker-auth-file: ~/.secrets/msf-auth.json",
      ].join("\n"),
    );

    const config = loadConfig(path);

    assert.equal(config.workerAuthFile, join(homedir(), ".secrets/msf-auth.json"));
  });

  test("worker-auth-file must be a non-empty path when given", () => {
    for (const bad of ["3", '""', "[]"]) {
      const path = writeYaml(
        dir,
        `worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\nworker-auth-file: ${bad}\n`,
      );
      assert.throws(() => loadConfig(path), /worker-auth-file/, `rejected: ${bad}`);
    }
  });

  // ---- the interruption-recovery budget ----

  test("the recovery budget defaults to the #111 values: 3 recoveries, waits 1/4/16 s", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n");

    const config = loadConfig(path);

    assert.deepEqual(config.recovery, DEFAULT_RECOVERY_BUDGET);
    assert.deepEqual(config.recovery, { maxRecoveries: 3, waitsMs: [1_000, 4_000, 16_000] });
  });

  test("the recovery budget is configurable — the value and the backoff are the operator's", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/a]",
        "recovery:",
        "  max: 1",
        "  waits-ms: [250, 1000]",
      ].join("\n"),
    );

    const config = loadConfig(path);

    assert.deepEqual(config.recovery, { maxRecoveries: 1, waitsMs: [250, 1000] });
  });

  test("a partially given recovery mapping keeps the default for the missing key", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "recovery:", "  max: 0"].join("\n"),
    );

    const config = loadConfig(path);

    assert.deepEqual(config.recovery, { maxRecoveries: 0, waitsMs: DEFAULT_RECOVERY_BUDGET.waitsMs });
  });

  test("recovery.max must be a non-negative integer when given", () => {
    for (const bad of ["-1", "1.5", '"three"']) {
      const path = writeYaml(
        dir,
        ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", `recovery:\n  max: ${bad}`].join("\n"),
      );
      assert.throws(() => loadConfig(path), /recovery\.max/, `rejected: ${bad}`);
    }
  });

  test("recovery.waits-ms must be a non-empty list of non-negative milliseconds when given", () => {
    for (const bad of ["[]", "[1, -2]", "[1, nope]", "3"]) {
      const path = writeYaml(
        dir,
        ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", `recovery:\n  waits-ms: ${bad}`].join("\n"),
      );
      assert.throws(() => loadConfig(path), /recovery\.waits-ms/, `rejected: ${bad}`);
    }
  });

  // ---- the model provider failure budget ----

  test("the model provider budget defaults to 4 retries at 15/30/60/120 s — a dedicated outage backoff", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n");

    const config = loadConfig(path);

    assert.deepEqual(config.modelProvider, DEFAULT_MODEL_PROVIDER_BUDGET);
    assert.deepEqual(config.modelProvider, {
      maxRetries: 4,
      waitsMs: [15_000, 30_000, 60_000, 120_000],
    });
  });

  test("the model provider budget is configurable — the value and the backoff are the operator's", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/a]",
        "model-provider:",
        "  max-retries: 2",
        "  waits-ms: [500, 2000]",
      ].join("\n"),
    );

    const config = loadConfig(path);

    assert.deepEqual(config.modelProvider, { maxRetries: 2, waitsMs: [500, 2000] });
  });

  test("a partially given model provider mapping keeps the default for the missing key", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "model-provider:", "  max-retries: 0"].join("\n"),
    );

    const config = loadConfig(path);

    assert.deepEqual(config.modelProvider, { maxRetries: 0, waitsMs: DEFAULT_MODEL_PROVIDER_BUDGET.waitsMs });
  });

  test("model-provider.max-retries must be a non-negative integer when given", () => {
    for (const bad of ["-1", "1.5", '"three"']) {
      const path = writeYaml(
        dir,
        ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", `model-provider:\n  max-retries: ${bad}`].join("\n"),
      );
      assert.throws(() => loadConfig(path), /model-provider\.max-retries/, `rejected: ${bad}`);
    }
  });

  test("model-provider.waits-ms must be a non-empty list of non-negative milliseconds when given", () => {
    for (const bad of ["[]", "[1, -2]", "[1, nope]", "3"]) {
      const path = writeYaml(
        dir,
        ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", `model-provider:\n  waits-ms: ${bad}`].join("\n"),
      );
      assert.throws(() => loadConfig(path), /model-provider\.waits-ms/, `rejected: ${bad}`);
    }
  });

  // ---- the liveness policy ----

  test("the unavailability warning defaults to 60 s of continuous Docker silence", () => {
    const path = writeYaml(dir, "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n");

    const config = loadConfig(path);

    assert.deepEqual(config.liveness, DEFAULT_LIVENESS_POLICY);
    assert.equal(config.liveness.unavailableWarnMs, 60_000);
  });

  test("the warning threshold is configurable — the operator fits it to the environment", () => {
    const path = writeYaml(
      dir,
      [
        "worker-gh-account: bot",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/a]",
        "liveness:",
        "  unavailable-warn-ms: 5000",
      ].join("\n"),
    );

    assert.equal(loadConfig(path).liveness.unavailableWarnMs, 5_000);
  });

  test("liveness.unavailable-warn-ms must be a non-negative number of milliseconds when given", () => {
    for (const bad of ["-1", '"60s"', "[1]"]) {
      const path = writeYaml(
        dir,
        [
          "worker-gh-account: bot",
          "worker-model: opencode-go/glm-5.3-flash",
          "repos: [Sanmoo/a]",
          `liveness:\n  unavailable-warn-ms: ${bad}`,
        ].join("\n"),
      );
      assert.throws(() => loadConfig(path), /liveness\.unavailable-warn-ms/, `rejected: ${bad}`);
    }
  });

  test("a non-mapping liveness value is refused instead of silently ignored", () => {
    const path = writeYaml(
      dir,
      ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]", "liveness: 60"].join("\n"),
    );
    assert.throws(() => loadConfig(path), /liveness/);
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

describe("config: the retrospective block", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash", "repos: [Sanmoo/a]"];

  test("retro is OFF when the block is absent — the trigger, model and language get their defaults", () => {
    const config = loadConfig(writeYaml(dir, base.join("\n")));

    assert.deepEqual(config.retro, DEFAULT_RETRO);
    assert.equal(config.retro.enabled, false);
    assert.equal(config.retro.threshold, 5);
    assert.equal(config.retro.model, null, "the model inherits the worker model until configured");
    assert.equal(config.retro.language, "en", "English by default");
  });

  test("an enabled retro needs its factory-items destination — fail-closed, never a silent default", () => {
    const path = writeYaml(dir, [...base, "retro:", "  enabled: true"].join("\n"));

    assert.throws(() => loadConfig(path), /retro\.factory-items-destination.*required/);
  });

  test("every retro field is configurable when given", () => {
    const path = writeYaml(
      dir,
      [
        ...base,
        "retro:",
        "  enabled: true",
        "  threshold: 10",
        "  model: anthropic/claude-opus-4.5",
        "  language: pt-BR",
        "  factory-items-destination: Sanmoo/my-software-factory",
      ].join("\n"),
    );

    assert.deepEqual(loadConfig(path).retro, {
      enabled: true,
      threshold: 10,
      model: "anthropic/claude-opus-4.5",
      language: "pt-BR",
      factoryItemsDestination: "Sanmoo/my-software-factory",
    });
  });

  test("the retro block is validated field by field — never a silently ignored value", () => {
    const cases: Array<[string, RegExp]> = [
      ["retro:\n  threshold: 0", /retro\.threshold/],
      ['retro:\n  threshold: "5"', /retro\.threshold/],
      ["retro:\n  model: opus", /retro\.model/],
      ["retro:\n  language: ''", /retro\.language/],
      ["retro:\n  factory-items-destination: nowhere", /retro\.factory-items-destination/],
      ["retro:\n  enabled: yes", /retro\.enabled/],
      ["retro: 5", /retro/],
    ];
    for (const [block, error] of cases) {
      const path = writeYaml(dir, [...base, block].join("\n"));
      assert.throws(() => loadConfig(path), error, `accepted: ${block}`);
    }
  });
});
