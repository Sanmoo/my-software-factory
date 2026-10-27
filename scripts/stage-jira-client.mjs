#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Stage the compiled Jira worker client into the worker image's build context.
 * The worker holds no Jira credential: the factory performs every API call, and
 * the client it runs inside the container is the tool that asks for one. Like
 * the guardrail, it is factory-owned code provisioned at image build time from
 * the compiled tree this checkout pins.
 *
 * What to stage is the exact relative-import closure of the compiled CLI, so a
 * module the client loads can never be missing from the image and a file the
 * client does not load is never shipped.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const stage = join(root, "docker", "jira-client");
const ENTRY = "tracker/jira-client-cli.js";

let staging;
try {
  staging = await import(pathToFileURL(join(dist, "runtime", "image-staging.js")).href);
} catch {
  process.stderr.write(
    "stage-jira-client: the compiled staging module is missing — run `npm run build` first (npm run build:image does it).\n",
  );
  process.exit(1);
}

const closure = staging.relativeImportClosure(dist, [ENTRY]);
if (closure.missing.length > 0) {
  process.stderr.write("stage-jira-client: the compiled client names modules dist does not carry:\n");
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
  process.stderr.write("stage-jira-client: the staged tree does not match the client's import closure:\n");
  for (const module of absent) process.stderr.write(`  missing ${module}\n`);
  for (const module of dead) process.stderr.write(`  not imported ${module}\n`);
  process.exit(1);
}

process.stdout.write(
  `stage-jira-client: staged the ${closure.modules.length} module(s) the client imports into docker/jira-client/\n`,
);

function stagedModules(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, resolve(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"))
    .sort();
}
