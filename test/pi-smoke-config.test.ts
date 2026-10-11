import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("requires explicit provider/model before creating a fixture or calling Pi", () => {
  const env = { ...process.env };
  delete env.SMOKE_MODEL;
  const result = spawnSync(process.execPath,
    ["--import", "tsx", "src/experiments/pi-smoke.ts"],
    { env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set SMOKE_MODEL explicitly to provider\/model/);
  assert.ok(!result.stdout.includes("Artifacts:"));
});
