import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isObject, messageOf } from "../src/core/values.js";
import { assertNoSecret } from "../src/experiments/secret-scan.js";

// Helpers that were copied into several modules now have one definition each (review: duplicated code).
const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function sourcesDefining(pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts") && pattern.test(await readFile(path, "utf8"))) found.push(relative(srcRoot, path));
    }
  };
  await walk(srcRoot);
  return found.sort();
}

test("isObject is defined once, in the shared core values module", async () => {
  assert.deepEqual(await sourcesDefining(/(const|function) isObject\b/), ["core/values.ts"]);
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), false, "arrays are not objects");
  assert.equal(isObject(null), false);
  assert.equal(isObject("text"), false);
});

test("messageOf is defined once, and reads an Error's message or stringifies anything else", async () => {
  assert.deepEqual(await sourcesDefining(/(const|function) messageOf\b/), ["core/values.ts"]);
  assert.equal(messageOf(new Error("falhou")), "falhou");
  assert.equal(messageOf("texto"), "texto");
  assert.equal(messageOf(42), "42");
});

test("the secret check is defined once, in the shared experiments module, for both docker experiments", async () => {
  assert.deepEqual(await sourcesDefining(/function assertNoSecret\b/), ["experiments/secret-scan.ts"]);
  assert.doesNotThrow(() => assertNoSecret("no credentials here", "gho_example_token_value"));
  assert.throws(() => assertNoSecret("leak gho_example_token_value", "gho_example_token_value", "logs/run.log"),
    /secret value found in logs\/run\.log/);
});
