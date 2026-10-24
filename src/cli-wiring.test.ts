import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { sandcastleRuntimeOptions } from "./cli.js";
import { loadConfig } from "./config.js";
import { ensureWorkspace } from "./layout.js";

/**
 * The production launch composition (issue #159): msf.yaml → the options the
 * real SandcastleRuntime receives. Credentials ride only the two explicit
 * sources; the image, the model and the workspace are the configured ones.
 */

function configFrom(yaml: string): { config: ReturnType<typeof loadConfig>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "msf-cli-wiring-"));
  const path = join(dir, "msf.yaml");
  writeFileSync(path, yaml, "utf8");
  return { config: loadConfig(path), dir };
}

describe("the production launch composition — config → runtime options", () => {
  test("the auth file from msf.yaml reaches the launch, and only supported provider keys are forwarded", () => {
    const { config, dir } = configFrom(
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: [Sanmoo/my-tasks]",
        "worker-auth-file: ~/.secrets/msf-auth.json",
        "labels:",
        "  blocked: agent-blocked-custom",
      ].join("\n"),
    );
    try {
      const workspace = ensureWorkspace(join(dir, "ws"));
      const options = sandcastleRuntimeOptions(config, workspace, "gh-token", {
        OPENCODE_API_KEY: "opencode-value",
        OPENAI_API_KEY: "",
        GH_TOKEN: "must-not-be-forwarded-as-a-model-key",
      });

      assert.equal(options.model, "opencode-go/glm-5.3-flash");
      assert.equal(options.token, "gh-token");
      assert.equal(options.workspace, workspace.root);
      assert.deepEqual(options.agentFiles, [{ name: "auth.json", hostPath: join(homedir(), ".secrets/msf-auth.json") }]);
      assert.deepEqual(options.authEnv, { OPENCODE_API_KEY: "opencode-value" });
      assert.equal(options.blockedLabel, "agent-blocked-custom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without worker-auth-file the launch carries no auth-file option — provider env vars are the source", () => {
    const { config, dir } = configFrom(
      "worker-gh-account: bot\nworker-model: opencode-go/glm-5.3-flash\nrepos: [Sanmoo/a]\n",
    );
    try {
      const workspace = ensureWorkspace(join(dir, "ws"));
      const options = sandcastleRuntimeOptions(config, workspace, "t", {});

      assert.deepEqual(options.agentFiles, [], "no file source is invented");
      assert.deepEqual(options.authEnv, {});
      assert.equal(options.blockedLabel, "agent-blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
