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

test("verify reports failures with locations and stops at the failing step", async () => {
  const typeFailure = await verifyWithProbe(
    `src/verify-type-${process.pid}.ts`,
    "const invalid: VerifyGatewayMissingType = 1;\n",
  );
  assert.notEqual(typeFailure.status, 0);
  assert.match(typeFailure.output, /VerifyGatewayMissingType/);
  assert.doesNotMatch(typeFailure.output, /> my-software-factory@[^\n]+ lint/);
  assertStoppedBeforeTests(typeFailure.output);

  const srcPath = `src/verify-lint-${process.pid}.ts`;
  const srcFailure = await verifyWithProbe(srcPath, "export const probe: any = 1;\n");
  assert.notEqual(srcFailure.status, 0);
  assert.match(srcFailure.output, new RegExp(`${srcPath}:1:`));
  assert.match(srcFailure.output, /no-explicit-any/);
  assertStoppedBeforeTests(srcFailure.output);

  const suppressionPath = `src/verify-suppression-${process.pid}.ts`;
  const suppressionFailure = await verifyWithProbe(
    suppressionPath,
    "// oxlint-disable\nexport const probe: any = 1;\n",
  );
  assert.notEqual(suppressionFailure.status, 0);
  assert.match(suppressionFailure.output, new RegExp(`${suppressionPath}:1: invalid suppression`));
  assert.doesNotMatch(suppressionFailure.output, /no-explicit-any/);
  assertStoppedBeforeTests(suppressionFailure.output);

  const testPath = `test/verify-lint-${process.pid}.ts`;
  const testFailure = await verifyWithProbe(testPath, "export const probe: any = 1;\n");
  assert.notEqual(testFailure.status, 0);
  assert.match(testFailure.output, new RegExp(`${testPath}:1:`));
  assert.match(testFailure.output, /no-explicit-any/);
  assertStoppedBeforeTests(testFailure.output);
});
