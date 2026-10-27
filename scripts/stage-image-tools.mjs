#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Stage the compiled factory-owned tools into the worker image's build context
 * (ADR 0001): the continuity guardrail and the mediated-tracker client. Such
 * code is provisioned at image build time, not at worker startup — the image
 * carries one compiled copy of what the factory version pins, and
 * `npm run build:image` refuses to stage a missing build instead of shipping a
 * worker without a tool it may load.
 *
 * What to stage is not a list to maintain: it is EXACTLY the relative-import
 * closure of each compiled entry, computed from dist/. The staged tree mirrors
 * the compiled layout under dist/ and the image copies it to /opt/msf, so every
 * relative import keeps its build-tree meaning. A relative import whose module
 * dist lacks fails the build by that exact name; a file in the staged tree the
 * entry does not import is reported as dead and the build fails too. The launch
 * preflight requires the same closures inside the image, so a stale image is
 * refused by name.
 *
 * Test-only copies are not needed: the same dist files are imported directly
 * by the unit and e2e tests.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

let staging;
let layout;
try {
  staging = await import(pathToFileURL(join(dist, "runtime", "image-staging.js")).href);
  layout = await import(pathToFileURL(join(dist, "layout.js")).href);
} catch {
  process.stderr.write(
    "stage-image-tools: the compiled staging module is missing — run `npm run build` first (npm run build:image does it).\n",
  );
  process.exit(1);
}

/** Each tool: its compiled entry, the build-context dir it lands in, and what
 *  the worker loses when the image does not carry it. */
const TOOLS = [
  {
    entry: staging.GUARDRAIL_ENTRY_MODULE,
    stage: join(root, "docker", "guardrail"),
    label: "continuity guardrail",
  },
  {
    entry: layout.JIRA_CLIENT_ENTRY_MODULE,
    stage: join(root, "docker", "jira-client"),
    label: "mediated Jira client",
  },
];

for (const tool of TOOLS) stageTool(tool);

/** One tool's closure, staged and then verified against what it really copies. */
function stageTool(tool) {
  const name = relative(root, tool.stage).split(sep).join("/");
  const closure = staging.relativeImportClosure(dist, [tool.entry]);
  if (closure.missing.length > 0) {
    process.stderr.write(`stage-image-tools: the compiled ${tool.label} names modules dist does not carry:\n`);
    for (const entry of closure.missing) {
      const importer = entry.from === "." ? "the entry" : `imported by ${entry.from}`;
      process.stderr.write(`  ${entry.module} (${importer})\n`);
    }
    process.exit(1);
  }

  rmSync(tool.stage, { recursive: true, force: true });
  for (const module of closure.modules) {
    const target = join(tool.stage, module);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dist, module), target);
  }

  const staged = stagedModules(tool.stage);
  const expected = new Set(closure.modules);
  const dead = staged.filter((module) => !expected.has(module));
  const absent = closure.modules.filter((module) => !staged.includes(module));
  if (dead.length > 0 || absent.length > 0) {
    process.stderr.write(`stage-image-tools: the staged ${tool.label} does not match its import closure:\n`);
    for (const module of absent) process.stderr.write(`  missing ${module}\n`);
    for (const module of dead) process.stderr.write(`  not imported ${module}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `stage-image-tools: staged the ${closure.modules.length} module(s) the ${tool.label} imports into ${name}/\n`,
  );
}

function stagedModules(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, resolve(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"))
    .sort();
}
