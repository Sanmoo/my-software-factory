import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  NO_MODEL_AUTH_MESSAGE,
  PI_MODEL_AUTH_ENV_VARS,
  authFileProblem,
  modelAuthEnv,
} from "./model-auth.js";

/**
 * Model credentials are a separate operational secret (issue #159): supported
 * provider env vars or an explicitly supplied auth file. Nothing is read from
 * a personal profile, and a diagnostic never echoes a value.
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

    assert.match(authFileProblem(path) ?? "", /unreadable/);

    writeFileSync(path, "{ broken", "utf8");
    assert.match(authFileProblem(path) ?? "", /not valid JSON/);
    assert.ok(!(authFileProblem(path) ?? "").includes("broken"));

    writeFileSync(path, "[]", "utf8");
    assert.match(authFileProblem(path) ?? "", /not a Pi auth\.json object/);

    writeFileSync(path, '{"openai":{"type":"api_key","key":"sentinel-secret"}}', "utf8");
    assert.equal(authFileProblem(path), null);

    rmSync(dir, { recursive: true, force: true });
  });

  test("the absence diagnostic names the supported sources and carries no secret", () => {
    assert.match(NO_MODEL_AUTH_MESSAGE, /provider API key/);
    assert.match(NO_MODEL_AUTH_MESSAGE, /worker-auth-file/);
    assert.match(NO_MODEL_AUTH_MESSAGE, /never read from a personal Pi profile/);
    // The directive names the variables the RUNBOOK documents, not whatever
    // happens to sit first in the allow-list.
    assert.match(NO_MODEL_AUTH_MESSAGE, /OPENCODE_API_KEY/);
  });
});
