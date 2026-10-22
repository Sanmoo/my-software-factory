#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage the compiled continuity guardrail into the worker image's build
 * context (issue 119, ADR 0001). Factory-owned agent resources are provisioned
 * at image build time, not at worker startup: the image carries ONE compiled
 * copy of the code the factory version pins, and `npm run build:image` refuses
 * to stage a missing build instead of shipping an unguarded worker.
 *
 * The relative layout mirrors dist/runtime, so the extension's
 * `../effects.js` import resolves inside /opt/msf.
 *
 * Test-only copies are not needed: the same dist files are imported directly
 * by the unit and e2e tests.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "docker", "guardrail");

const files = [
  { from: join(root, "dist", "runtime", "effects.js"), to: join(stage, "effects.js") },
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

process.stdout.write(`stage-guardrail: staged ${files.length} file(s) into docker/guardrail/\n`);
