#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentDeclaration } from "./agent-declaration.mjs";
import { canonicalDeclaration } from "./agent-resources.mjs";
import { WORKER_IMAGE } from "./worker-image.mjs";

/**
 * Build the worker image so that a failed build never replaces a valid one:
 * docker builds under a scratch tag, and the final tag moves only after that
 * build succeeded. The build context is the repository root; the declaration
 * is validated here and staged into it in canonical form, because the image
 * provisions from that form and carries no YAML parser.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DECLARATION = join(ROOT, "agent-resources.yaml");
/** Generated build-context copy of the declaration (gitignored). */
const STAGED_DECLARATION = join(ROOT, "docker", "agent-resources.json");

const scratchTag = (image) => `${image}-build-${process.pid}`;

/** Validate the declaration and stage its canonical form for the build. */
function stageDeclaration() {
  const { declaration } = loadAgentDeclaration(DECLARATION);
  mkdirSync(dirname(STAGED_DECLARATION), { recursive: true });
  writeFileSync(STAGED_DECLARATION, canonicalDeclaration(declaration), "utf8");
  return declaration;
}

function main() {
  const image = WORKER_IMAGE;
  const scratch = scratchTag(image);
  const declaration = stageDeclaration();
  const args = [
    "build",
    "--build-arg",
    `AGENT_UID=${typeof process.getuid === "function" ? process.getuid() : 1000}`,
    "--build-arg",
    `AGENT_GID=${typeof process.getgid === "function" ? process.getgid() : 1000}`,
    "--build-arg",
    `PI_PACKAGE=${declaration.pi.package}`,
    "--build-arg",
    `PI_VERSION=${declaration.pi.version}`,
    "-t",
    scratch,
    "-f",
    "docker/Dockerfile",
    ".",
  ];
  try {
    execFileSync("docker", args, { cwd: ROOT, stdio: "inherit" });
    execFileSync("docker", ["tag", scratch, image], { cwd: ROOT, stdio: "inherit" });
    process.stdout.write(`build:image: ${image} now points at the build just validated\n`);
  } finally {
    // The scratch tag is never the deployable identity: on failure the final
    // tag still names the previous valid image.
    try {
      execFileSync("docker", ["rmi", "--force", scratch], { cwd: ROOT, stdio: "ignore" });
    } catch {
      // No scratch image (the build failed early) — nothing to remove.
    }
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`build:image: ${message}\n`);
  process.exitCode = 1;
}
