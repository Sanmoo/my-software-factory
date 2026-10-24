#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Stage compiled factory modules into a worker-image build context. Factory
 * code is provisioned at image build time, not at worker startup: the image
 * carries one compiled copy of the code the factory version pins, and
 * `npm run build:image` refuses to stage a missing build instead of shipping
 * a worker missing the tool it needs.
 *
 * The staged tree mirrors the compiled layout under dist/ and the image copies
 * it to /opt/msf, so every relative import keeps its build-tree meaning. Every
 * relative import of a staged file must itself be staged: a module the worker
 * tool imports but the image lacks fails at the worker's tool call. The check
 * follows imports so a forgotten module is refused here, not discovered by an
 * agent inside the container.
 */
export function stageModules({ name, root, stage, modules }) {
  const files = modules.map((module) => ({ from: join(root, "dist", module), to: join(stage, module) }));

  for (const file of files) {
    if (!existsSync(file.from)) {
      process.stderr.write(
        `${name}: ${file.from} is missing — run \`npm run build\` first (npm run build:image does it).\n`,
      );
      process.exit(1);
    }
  }

  rmSync(stage, { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(dirname(file.to), { recursive: true });
    copyFileSync(file.from, file.to);
  }

  const missing = [];
  for (const path of stagedFiles(stage)) {
    for (const specifier of relativeImports(readFileSync(path, "utf8"))) {
      const target = resolve(dirname(path), specifier);
      if (!existsSync(target)) missing.push(`${path.slice(stage.length + 1)} → ${specifier}`);
    }
  }
  if (missing.length > 0) {
    process.stderr.write(`${name}: the staged tree is incomplete — add the module(s) to \`modules\`:\n`);
    for (const entry of missing) process.stderr.write(`  ${entry}\n`);
    process.exit(1);
  }

  process.stdout.write(`${name}: staged ${files.length} file(s) into ${stage.slice(root.length + 1)}/\n`);
}

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
