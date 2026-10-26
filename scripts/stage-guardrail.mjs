#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Stage the compiled continuity guardrail into the worker image's build
 * context (ADR 0001). Factory-owned code is provisioned at image build time,
 * not at worker startup: the image carries one compiled copy of the code the
 * factory version pins, and `npm run build:image` refuses to stage a missing
 * build instead of shipping an unguarded worker.
 *
 * What to stage is not a list to maintain: it is EXACTLY the
 * relative-import closure of the compiled extension, computed from dist/. The
 * staged tree mirrors the compiled layout under dist/ and the image copies it
 * to /opt/msf, so every relative import keeps its build-tree meaning. A
 * relative import whose module dist lacks fails the build by that exact name;
 * a file in the staged tree the extension does not import is reported as dead
 * and the build fails too. The launch preflight requires the same closure
 * inside the image, so a stale image is refused by name.
 *
 * Test-only copies are not needed: the same dist files are imported directly
 * by the unit and e2e tests.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const stage = join(root, "docker", "guardrail");

let staging;
try {
  staging = await import(pathToFileURL(join(dist, "runtime", "guardrail", "staging.js")).href);
} catch {
  process.stderr.write(
    "stage-guardrail: the compiled staging module is missing — run `npm run build` first (npm run build:image does it).\n",
  );
  process.exit(1);
}

const closure = staging.relativeImportClosure(dist, [staging.GUARDRAIL_ENTRY_MODULE]);
if (closure.missing.length > 0) {
  process.stderr.write("stage-guardrail: the compiled guardrail names modules dist does not carry:\n");
  for (const entry of closure.missing) {
    const importer = entry.from === "." ? "the entry" : `imported by ${entry.from}`;
    process.stderr.write(`  ${entry.module} (${importer})\n`);
  }
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
for (const module of closure.modules) {
  const target = join(stage, module);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(dist, module), target);
}

const staged = stagedModules(stage);
const expected = new Set(closure.modules);
const dead = staged.filter((module) => !expected.has(module));
const absent = closure.modules.filter((module) => !staged.includes(module));
if (dead.length > 0 || absent.length > 0) {
  process.stderr.write("stage-guardrail: the staged tree does not match the guardrail's import closure:\n");
  for (const module of absent) process.stderr.write(`  missing ${module}\n`);
  for (const module of dead) process.stderr.write(`  not imported ${module}\n`);
  process.exit(1);
}

process.stdout.write(
  `stage-guardrail: staged the ${closure.modules.length} module(s) the guardrail imports into docker/guardrail/\n`,
);

function stagedModules(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, resolve(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"))
    .sort();
}
