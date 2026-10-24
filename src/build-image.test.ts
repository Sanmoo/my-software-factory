import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadAgentDeclaration } from "../scripts/agent-declaration.mjs";
import { canonicalDeclaration } from "../scripts/agent-resources.mjs";
import { WORKER_IMAGE } from "./worker-image.js";

/**
 * `npm run build:image` validates the declaration, stages its canonical form
 * and never replaces a valid image tag with an incomplete build. The docker
 * client is a PATH shim here: the tests observe the exact command sequence
 * and the failure paths without touching a daemon.
 */

const SCRIPT = new URL("../scripts/build-worker-image.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

/** A `docker` shim that records its arguments and runs `body` as its answer. */
function dockerShim(dir: string, body: string): { log: string; env: NodeJS.ProcessEnv } {
  const bin = join(dir, "bin");
  const log = join(dir, "docker.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, body, ""].join("\n"), "utf8");
  chmodSync(join(bin, "docker"), 0o755);
  return { log, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

/** A throwaway checkout: the build script and its modules, plus `declaration`. */
function checkout(dir: string, declaration: string): string {
  const root = join(dir, "checkout");
  cpSync(join(ROOT, "scripts"), join(root, "scripts"), {
    recursive: true,
    filter: (source) => !source.endsWith(".d.mts"),
  });
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  // The declaration loader parses YAML with the repo's dependency.
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "agent-resources.yaml"), declaration, "utf8");
  return root;
}

describe("worker image build — the declaration gates the build", () => {
  test("a successful build stages the declaration's canonical form, then tags and moves the final tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const { log, env } = dockerShim(dir, "exit 0");
      const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });

      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.match(
        calls[0] ?? "",
        /^build --build-arg AGENT_UID=\d+ --build-arg AGENT_GID=\d+ --build-arg PI_PACKAGE=@earendil-works\/pi-coding-agent --build-arg PI_VERSION=\d+\.\d+\.\d+ -t .*-build-\d+ -f docker\/Dockerfile \.$/,
      );
      assert.match(calls[1] ?? "", new RegExp(`^tag .*-build-\\d+ ${WORKER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      assert.match(calls[2] ?? "", /^rmi --force .*-build-\d+$/);
      assert.ok(!calls.some((call) => call.startsWith("tag") && call.includes("--force")));

      // The image provisions from this staged copy, not from the YAML itself.
      const staged = readFileSync(join(ROOT, "docker", "agent-resources.json"), "utf8");
      const { declaration } = loadAgentDeclaration(join(ROOT, "agent-resources.yaml"));
      assert.equal(staged, canonicalDeclaration(declaration));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalid declaration fails before any docker call — the previous image stays untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const { log, env } = dockerShim(dir, "exit 0");
      const root = checkout(dir, "pi:\n  version: 1.0.0\n");

      const result = spawnSync(process.execPath, [join(root, "scripts", "build-worker-image.mjs")], {
        encoding: "utf8",
        env,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /build:image: .*agent-resources\.yaml is missing "schema"/);
      assert.ok(!existsSync(log), "docker is never asked to build from an invalid declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed build never moves the final tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const { log, env } = dockerShim(
        dir,
        'if [ "$1" = "build" ]; then echo "provision-agent: broken declaration" >&2; exit 1; fi\nexit 0',
      );
      const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /build:image: .*failed/);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(calls.some((call) => call.startsWith("build ")));
      assert.ok(!calls.some((call) => call.startsWith("tag ")), "the final tag is never moved on failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MSF_WORKER_IMAGE keeps an isolated checkout's tag apart from the shared default", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const { log, env } = dockerShim(dir, "exit 0");
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...env, MSF_WORKER_IMAGE: "msf-v2-worker:isolated" },
      });

      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.match(calls[0] ?? "", /-t msf-v2-worker:isolated-build-\d+/);
      assert.match(calls[1] ?? "", /^tag .*-build-\d+ msf-v2-worker:isolated$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
