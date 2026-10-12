import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validator = resolve("scripts/lint-suppressions.mjs");

async function runLint(source: string, extraFiles: Record<string, string> = {}) {
  const directory = await mkdtemp(join(resolve("."), "lint-suppressions-fixture-"));
  try {
    const sourceFile = join(directory, "fixture.ts");
    await writeFile(sourceFile, source);
    for (const [relative, content] of Object.entries(extraFiles)) {
      const file = join(directory, relative);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }
    return spawnSync(process.execPath, [validator, relative(process.cwd(), directory)], { cwd: process.cwd(), encoding: "utf8" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts specific justified line and next-line directives, including block comments and multiple rules", async () => {
  const result = await runLint(`// oxlint-disable-next-line typescript/no-explicit-any -- external fixture format\nexport const next: any = 1;\nconst line: any = 2; /* oxlint-disable-line typescript/no-explicit-any, eslint/no-unused-vars -- intentionally dynamic fixture */\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("rejects missing rules, broad directives, file directives, empty reasons, and ESLint aliases with location", async () => {
  const result = await runLint(`// oxlint-disable\n// oxlint-disable-next-line -- missing rule\n// oxlint-disable-line typescript/no-explicit-any --   \n// oxlint-disable-next-line all -- broad group\n// oxlint-enable-next-line typescript/no-explicit-any -- forbidden enable\n// eslint-disable-next-line typescript/no-explicit-any -- alias\nexport const value = 1;\n`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture\.ts:1:/);
  assert.match(result.stderr, /fixture\.ts:6:.*ESLint suppression aliases/);
});

test("Oxlint rejects an otherwise valid directive that suppresses no diagnostic", async () => {
  const result = await runLint("// oxlint-disable-next-line typescript/no-explicit-any -- no violation expected\nexport const value = 1;");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unused oxlint-disable directive/);
});

test("detects directives on individual lines in multiline block comments", async () => {
  const result = await runLint(`/*\n * oxlint-disable typescript/no-explicit-any -- forbidden range directive\n */\nexport const value = 1;\n`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture\.ts:2: invalid suppression/);
});

test("does not mistake strings, templates, or regular expressions for comment directives", async () => {
  const source = [
    'export const a = "// oxlint-disable";',
    'export const b = `oxlint-disable-next-line all`;',
    'export const c = /eslint-disable-next-line/;',
    'export const d = `text ${"/* eslint-disable */"}`;',
  ].join("\n");
  const result = await runLint(source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("checks actual comments inside template interpolations", async () => {
  const result = await runLint('export const value = `text ${/* eslint-disable */ 1}`;');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture\.ts:1:.*ESLint suppression aliases/);
});

test("ignores excluded directories and non-TypeScript files", async () => {
  const result = await runLint(`export const ok = 1;\n`, {
    "nested/.smoke/bad.ts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "nested/.worktrees/bad.ts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "nested/.pilot/bad.ts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "nested/docs/bad.ts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "bad.tsx": "// oxlint-disable\nexport const bad: any = 1;\n",
    "bad.mts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "bad.cts": "// oxlint-disable\nexport const bad: any = 1;\n",
    "bad.js": "// eslint-disable\n",
    "bad.jsx": "// eslint-disable\n",
    "bad.mjs": "// eslint-disable\n",
    "bad.cjs": "// eslint-disable\n",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
