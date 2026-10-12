import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();

async function verifyWithProbe(relativePath: string, source: string) {
  const file = resolve(root, relativePath);
  await writeFile(file, source);
  try {
    const result = spawnSync("npm", ["run", "verify"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(file, { force: true });
  }
}

function assertStoppedBeforeTests(output: string) {
  assert.doesNotMatch(output, /> my-software-factory@[^\n]+ test/);
}

test("verify stops at typecheck failure before lint and tests", async () => {
  const result = await verifyWithProbe(
    `src/verify-type-${process.pid}.ts`,
    "const invalid: VerifyGatewayMissingType = 1;\n",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /VerifyGatewayMissingType/);
  assert.doesNotMatch(result.output, /> my-software-factory@[^\n]+ lint/);
  assertStoppedBeforeTests(result.output);
});

test("verify reports a src lint failure with a location and stops before tests", async () => {
  const relativePath = `src/verify-lint-${process.pid}.ts`;
  const result = await verifyWithProbe(relativePath, "export const probe: any = 1;\n");
  assert.notEqual(result.status, 0);
  assert.match(result.output, new RegExp(`${relativePath}:1:`));
  assert.match(result.output, /no-explicit-any/);
  assertStoppedBeforeTests(result.output);
});

test("verify reports a test lint failure with a location and stops before tests", async () => {
  const relativePath = `test/verify-lint-${process.pid}.ts`;
  const result = await verifyWithProbe(relativePath, "export const probe: any = 1;\n");
  assert.notEqual(result.status, 0);
  assert.match(result.output, new RegExp(`${relativePath}:1:`));
  assert.match(result.output, /no-explicit-any/);
  assertStoppedBeforeTests(result.output);
});
