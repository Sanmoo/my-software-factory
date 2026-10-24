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

  // ---- the interruption-recovery budget (issue 123) ----

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

  // ---- the model provider failure budget (issue 144) ----

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

  // ---- the liveness policy (issue 118) ----

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

// ---- Jira Cloud selections (issue 128) ----

describe("config: Jira Cloud selections", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal GitHub header; the Jira section is appended by each test. */
  const HEAD = ["worker-gh-account: bot", "worker-model: opencode-go/glm-5.3-flash"];

  function jiraYaml(...entries: string[]): string {
    return writeYaml(dir, [...HEAD, "repos: [Sanmoo/github-issues]", "jira:", ...entries].join("\n"));
  }

  function oneEntry(overrides: Partial<Record<string, string>> = {}): string {
    const fields: Record<string, string> = {
      site: "acme.atlassian.net",
      account: "bot@acme.example",
      "token-env": "MSF_JIRA_ACME_TOKEN",
      jql: "project = ABC AND assignee = currentUser()",
      destination: "Sanmoo/my-tasks",
      ...overrides,
    };
    return Object.entries(fields)
      .map(([key, value], index) => `  ${index === 0 ? "-" : " "} ${key}: ${JSON.stringify(value)}`)
      .join("\n");
  }

  test("a Jira selection carries site, account, the local credential reference, the query and the destination", () => {
    const config = loadConfig(jiraYaml(oneEntry()));

    assert.equal(config.jira.length, 1);
    assert.deepEqual(config.jira[0], {
      site: "acme.atlassian.net",
      account: "bot@acme.example",
      tokenEnv: "MSF_JIRA_ACME_TOKEN",
      jql: "project = ABC AND assignee = currentUser() ORDER BY Rank ASC",
      destination: "Sanmoo/my-tasks",
    });
  });

  test("a GitHub-only config stays valid and has no Jira selection", () => {
    const path = writeYaml(dir, `${HEAD.join("\n")}\nrepos: [Sanmoo/a]`);

    assert.deepEqual(loadConfig(path).jira, []);
  });

  test("the destination is explicit — a Jira-only config lists no GitHub Issues repo", () => {
    const config = loadConfig(writeYaml(dir, [...HEAD, "repos: []", "jira:", oneEntry()].join("\n")));

    assert.deepEqual(config.repos, [], "no GitHub Issues source is invented");
    assert.equal(config.jira[0]?.destination, "Sanmoo/my-tasks");
  });

  test("an API token is not a permitted YAML value — the error names token-env and never echoes the secret", () => {
    const secret = "ATATT3xFfGF0-super-secret-value";
    const path = jiraYaml(oneEntry({ token: secret }));

    let message = "";
    try {
      loadConfig(path);
      assert.fail("a token value must be refused");
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /token-env/);
    assert.match(message, /token/);
    assert.ok(!message.includes(secret), "the token value never reaches the diagnostic");
  });

  test("token-env is the NAME of a local variable — a pasted token is refused", () => {
    const path = jiraYaml(oneEntry({ "token-env": "ATATT3xFfGF0secret" }));
    assert.throws(() => loadConfig(path), /token-env.*environment variable/i);

    const lower = jiraYaml(oneEntry({ "token-env": "msf_jira_token" }));
    assert.throws(() => loadConfig(lower), /token-env.*environment variable/i);
  });

  test("the site must be a Jira Cloud site, never an arbitrary host", () => {
    for (const site of ["jira.example.com", "acme.atlassian.net.evil", "https://acme.atlassian.net"]) {
      const path = jiraYaml(oneEntry({ site }));
      assert.throws(() => loadConfig(path), /atlassian\.net|Cloud/, `rejected: ${site}`);
    }
  });

  test("the account is the Atlassian login used for API-token authentication", () => {
    const path = jiraYaml(oneEntry({ account: "not-an-email" }));
    assert.throws(() => loadConfig(path), /account/);
  });

  test("a query with an explicit Rank ascending order is kept as configured", () => {
    const config = loadConfig(jiraYaml(oneEntry({ jql: "project = ABC ORDER BY Rank ASC" })));
    assert.equal(config.jira[0]?.jql, "project = ABC ORDER BY Rank ASC");
  });

  test("a JQL with no filter before its ordering is a configuration error", () => {
    for (const jql of ["ORDER BY Rank ASC", "ORDER BY Rank"]) {
      const path = jiraYaml(oneEntry({ jql }));
      assert.throws(() => loadConfig(path), /jira\[0\]\.jql.*only an ordering and no selection filter/, jql);
    }
  });

  test("a conflicting ordering is rejected as a configuration error, naming the field", () => {
    for (const jql of ["project = ABC ORDER BY created ASC", "project = ABC ORDER BY Rank DESC"]) {
      const path = jiraYaml(oneEntry({ jql }));
      assert.throws(() => loadConfig(path), /jira\[0\]\.jql/, `rejected: ${jql}`);
    }
  });

  test("every required field of a selection is required", () => {
    for (const key of ["site", "account", "token-env", "jql", "destination"]) {
      const fields = {
        site: "acme.atlassian.net",
        account: "bot@acme.example",
        "token-env": "MSF_JIRA_ACME_TOKEN",
        jql: "project = ABC",
        destination: "Sanmoo/my-tasks",
      } as Record<string, string | undefined>;
      delete fields[key];
      const entry = Object.entries(fields)
        .map(([name, value], index) => `  ${index === 0 ? "-" : " "} ${name}: ${JSON.stringify(value)}`)
        .join("\n");
      assert.throws(() => loadConfig(jiraYaml(entry)), new RegExp(key), `missing ${key}`);
    }
  });

  test("an unknown key is refused instead of ignored", () => {
    const path = jiraYaml(oneEntry({ nonsense: "x" }));
    assert.throws(() => loadConfig(path), /nonsense/);
  });

  test("two queries may feed the same site, but one site has one authenticated identity", () => {
    const sameIdentity = loadConfig(
      jiraYaml(oneEntry(), oneEntry({ destination: "Sanmoo/other-tasks", jql: "project = OTHER" })),
    );
    assert.equal(sameIdentity.jira.length, 2);

    const path = jiraYaml(oneEntry(), oneEntry({ account: "other@acme.example" }));
    assert.throws(() => loadConfig(path), /acme\.atlassian\.net.*account|account.*acme\.atlassian\.net/);
  });
});
