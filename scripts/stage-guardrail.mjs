#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage the compiled continuity guardrail into the worker image's build
 * context (issue 119, ADR 0001). Factory-owned agent resources are provisioned
 * at image build time, not at worker startup: the image carries ONE compiled
 * copy of the code the factory version pins, and `npm run build:image` refuses
 * to stage a missing build instead of shipping an unguarded worker.
 *
 * The relative layout mirrors dist/runtime, so the extension's `../effects.js`
 * import resolves inside /opt/msf. Every relative import of a staged file must
 * itself be staged: a module the extension imports but the image lacks makes
 * Pi refuse the whole extension at session start, which the launch preflight
 * cannot see from the file's mere existence.
 *
 * Test-only copies are not needed: the same dist files are imported directly
 * by the unit and e2e tests.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "docker", "guardrail");

const files = [
  { from: join(root, "dist", "runtime", "effects.js"), to: join(stage, "effects.js") },
  { from: join(root, "dist", "runtime", "json-line.js"), to: join(stage, "json-line.js") },
  { from: join(root, "dist", "runtime", "continuity-artifacts.js"), to: join(stage, "continuity-artifacts.js") },
  { from: join(root, "dist", "runtime", "guardrail", "extension.js"), to: join(stage, "guardrail", "extension.js") },
];

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
  process.stderr.write(`stage-guardrail: the staged extension is incomplete — add the module(s) to \`files\`:\n`);
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
