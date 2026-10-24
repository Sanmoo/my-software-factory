import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  PI_MODEL_AUTH_ENV_VARS,
  agentFileProblem,
  modelAuthEnv,
  modelAuthSources,
} from "./model-auth.js";

/**
 * Model credentials are a separate operational secret: supported provider
 * env vars or an explicitly supplied auth file. Nothing is read from a
 * personal profile, and a diagnostic never echoes a value.
 */

describe("model authentication — explicit sources only", () => {
  test("only Pi's supported provider variables are forwarded, non-empty", () => {
    const env = {
      OPENAI_API_KEY: "openai-value",
      OPENCODE_API_KEY: "opencode-value",
      AZURE_OPENAI_API_KEY: "azure-value",
      AWS_REGION: "us-west-2",
      ANTHROPIC_API_KEY: "",
      GH_TOKEN: "github-token-must-not-ride-the-model-env",
      UNRELATED_SECRET: "nope",
    };

    const forwarded = modelAuthEnv(env);

    assert.deepEqual(forwarded, {
      OPENAI_API_KEY: "openai-value",
      OPENCODE_API_KEY: "opencode-value",
      AZURE_OPENAI_API_KEY: "azure-value",
      AWS_REGION: "us-west-2",
    });
    assert.ok(!("GH_TOKEN" in forwarded));
    assert.ok(PI_MODEL_AUTH_ENV_VARS.includes("OPENAI_API_KEY"));
    assert.ok(PI_MODEL_AUTH_ENV_VARS.includes("OPENCODE_API_KEY"));
    assert.ok(PI_MODEL_AUTH_ENV_VARS.includes("AZURE_OPENAI_API_KEY"));
    assert.ok(PI_MODEL_AUTH_ENV_VARS.includes("AWS_ACCESS_KEY_ID"));
  });

  test("an empty environment forwards nothing", () => {
    assert.deepEqual(modelAuthEnv({}), {});
  });

  test("a supplied auth file is validated without reading its values out", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-auth-"));
    const path = join(dir, "auth.json");

    assert.match(agentFileProblem("worker-auth-file", path) ?? "", /unreadable/);

    writeFileSync(path, "{ broken", "utf8");
    assert.match(agentFileProblem("worker-auth-file", path) ?? "", /not valid JSON/);
    assert.ok(!(agentFileProblem("worker-auth-file", path) ?? "").includes("broken"));

    writeFileSync(path, "[]", "utf8");
    assert.match(agentFileProblem("worker-auth-file", path) ?? "", /not a Pi JSON object/);

    writeFileSync(path, '{"openai":{"type":"api_key","key":"sentinel-secret"}}', "utf8");
    assert.equal(agentFileProblem("worker-auth-file", path), null);

    rmSync(dir, { recursive: true, force: true });
  });

  test("the diagnostic names the configured provider's key, not keys for other providers", () => {
    for (const [provider, key] of [
      ["opencode-go", "OPENCODE_API_KEY"],
      ["opencode", "OPENCODE_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
    ]) {
      const message = modelAuthSources(`${provider}/model`);
      assert.ok(message.includes(key!));
      assert.ok(message.includes(`model provider "${provider}"`));
      assert.match(message, /worker-auth-file/);
      assert.match(message, /never read from a personal Pi profile/);
      assert.deepEqual(message.match(/[A-Z_]+_API_KEY/g), [key]);
    }
  });

  test("a provider without a known key hint gets no guessed variable", () => {
    const message = modelAuthSources("custom/model");
    assert.match(message, /Pi-supported provider credentials/);
    assert.match(message, /model provider "custom"/);
    assert.doesNotMatch(message, /OPENCODE_API_KEY|CUSTOM_API_KEY/);
  });
});
