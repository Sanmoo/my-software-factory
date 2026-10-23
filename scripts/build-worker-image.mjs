#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgentResources } from "./agent-resources.mjs";
import { WORKER_IMAGE } from "./worker-image.mjs";

/**
 * Build the worker image without ever replacing a previously valid one with an
 * incomplete build (issue #159). Docker only moves the final tag after a
 * successful build anyway; the explicit staging tag also covers a tag/rename
 * failure, so `msf-v2-worker:local` keeps pointing at the last VALID image.
 *
 * The build context is the repository root (the Dockerfile copies the
 * declaration, the provisioning script and the factory-owned reviewer agents);
 * `.dockerignore` keeps it small.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_TAG = (image) => `${image}-build-${process.pid}`;

/** The declaration is the single source of Pi's package and version: the
 *  Dockerfile receives them as build args and installs exactly that spec. */
function piSpec() {
  const declarationPath = resolve(ROOT, "agent-resources.json");
  let raw;
  try {
    raw = readFileSync(declarationPath, "utf8");
  } catch {
    throw new Error(`agent-resource declaration is unreadable: ${declarationPath}`);
  }
  const declaration = parseAgentResources(raw, declarationPath);
  return { package: declaration.pi.package, version: declaration.pi.version };
}

function main() {
  const image = WORKER_IMAGE;
  const staging = TEMP_TAG(image);
  const pi = piSpec();
  const args = [
    "build",
    "--build-arg",
    `AGENT_UID=${typeof process.getuid === "function" ? process.getuid() : 1000}`,
    "--build-arg",
    `AGENT_GID=${typeof process.getgid === "function" ? process.getgid() : 1000}`,
    "--build-arg",
    `PI_PACKAGE=${pi.package}`,
    "--build-arg",
    `PI_VERSION=${pi.version}`,
    "-t",
    staging,
    "-f",
    "docker/Dockerfile",
    ".",
  ];
  try {
    execFileSync("docker", args, { cwd: ROOT, stdio: "inherit" });
    execFileSync("docker", ["tag", staging, image], { cwd: ROOT, stdio: "inherit" });
    process.stdout.write(`build:image: ${image} now points at the build just validated\n`);
  } finally {
    // The staged tag is never the deployable identity; a failure leaves the
    // final tag untouched and this cleanup is best-effort.
    try {
      execFileSync("docker", ["rmi", "--force", staging], { cwd: ROOT, stdio: "ignore" });
    } catch {
      // No staged image (the build failed) — nothing to remove.
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
