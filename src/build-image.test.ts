import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { WORKER_IMAGE } from "./worker-image.js";

/**
 * `npm run build:image` never replaces a valid image tag with an incomplete
 * build (issue #159). The docker client is a PATH shim: the test observes the
 * exact command sequence and the failure path, without touching the daemon.
 */

const SCRIPT = new URL("../scripts/build-worker-image.mjs", import.meta.url).pathname;

describe("worker image build — a failed build keeps the previous image", () => {
  test("a successful build tags a staging image and moves the final tag only afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const bin = join(dir, "bin");
      const log = join(dir, "docker.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "docker"),
        ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, "exit 0", ""].join("\n"),
        "utf8",
      );
      chmodSync(join(bin, "docker"), 0o755);

      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });

      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.match(
        calls[0] ?? "",
        /^build --build-arg AGENT_UID=\d+ --build-arg AGENT_GID=\d+ --build-arg PI_PACKAGE=@earendil-works\/pi-coding-agent --build-arg PI_VERSION=\d+\.\d+\.\d+ -t .*-build-\d+ -f docker\/Dockerfile \.$/,
      );
      assert.match(calls[1] ?? "", new RegExp(`^tag .*-build-\\d+ ${WORKER_IMAGE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`));
      assert.match(calls[2] ?? "", /^rmi --force .*-build-\d+$/);
      assert.ok(!calls.some((call) => call.startsWith("tag") && call.includes("--force")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed build never moves the final tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-build-image-"));
    try {
      const bin = join(dir, "bin");
      const log = join(dir, "docker.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${log}"`,
          'if [ "$1" = "build" ]; then echo "provision-agent: broken declaration" >&2; exit 1; fi',
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(join(bin, "docker"), 0o755);

      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });

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
      const bin = join(dir, "bin");
      const log = join(dir, "docker.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "docker"),
        ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, "exit 0", ""].join("\n"),
        "utf8",
      );
      chmodSync(join(bin, "docker"), 0o755);

      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MSF_WORKER_IMAGE: "msf-v2-worker:isolated" },
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
