#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage the compiled continuity guardrail into the worker image's build
 * context. Factory-owned code is provisioned at image build time, not at
 * worker startup: the image carries one compiled copy of the code the factory
 * version pins, and `npm run build:image` refuses to stage a missing build
 * instead of shipping an unguarded worker.
 *
 * The staged tree mirrors the compiled layout under dist/ and the image copies
 * it to /opt/msf, so every relative import keeps its build-tree meaning: the
 * extension's `../effects.js` and continuity-artifacts' `../tracker/identity.js`
 * resolve exactly as they do in dist/. Every relative import of a staged file
 * must itself be staged: a module the extension imports but the image lacks
 * makes Pi refuse the whole extension at session start, which the launch
 * preflight cannot see from the file's mere existence.
 *
 * Test-only copies are not needed: the same dist files are imported directly
 * by the unit and e2e tests.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "docker", "guardrail");

const modules = [
  "runtime/effects.js",
  "runtime/json-line.js",
  "runtime/continuity-artifacts.js",
  "runtime/guardrail/extension.js",
  "tracker/identity.js",
];
const files = modules.map((module) => ({ from: join(root, "dist", module), to: join(stage, module) }));

for (const file of files) {
  if (!existsSync(file.from)) {
    process.stderr.write(
      `stage-guardrail: ${file.from} is missing — run \`npm run build\` first (npm run build:image does it).\n`,
    );
    process.exit(1);
  }
}

rmSync(stage, { recursive: true, force: true });
for (const file of files) {
  mkdirSync(dirname(file.to), { recursive: true });
  copyFileSync(file.from, file.to);
}

// The staged tree must be self-contained: follow each relative import.
const missing = [];
for (const path of stagedFiles(stage)) {
  for (const specifier of relativeImports(readFileSync(path, "utf8"))) {
    const target = resolve(dirname(path), specifier);
    if (!existsSync(target)) missing.push(`${path.slice(stage.length + 1)} → ${specifier}`);
  }
}
if (missing.length > 0) {
  process.stderr.write(`stage-guardrail: the staged extension is incomplete — add the module(s) to \`modules\`:\n`);
  for (const entry of missing) process.stderr.write(`  ${entry}\n`);
  process.exit(1);
}

process.stdout.write(`stage-guardrail: staged ${files.length} file(s) into docker/guardrail/\n`);

function stagedFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name));
}

/** `from "./x.js"`, `import "./x.js"` and dynamic `import("./x.js")`. */
function relativeImports(source) {
  const specifiers = new Set();
  const patterns = [/from\s+["'](\.\.?\/[^"']+)["']/g, /import\s+["'](\.\.?\/[^"']+)["']/g, /import\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}
