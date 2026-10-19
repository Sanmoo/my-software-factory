import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { WORKER_IMAGE } from "../worker-image.js";
import { dockerWorkerProbe, parseWorkerContainers } from "./liveness.js";

/**
 * The liveness parser (issue 102): the interpretation of the Docker outputs is
 * a PURE function over canned strings — the command shell around it is the
 * only impure part, so the correlation container → work is proven without
 * Docker.
 */

const WORKS = "/ws/trabalhos";
const NOW = new Date("2026-02-01T12:00:00.000Z");

/** One container as `docker inspect` renders it, with the mounts a worker carries. */
function container(id: string, workKey: string, startedAt: string): Record<string, unknown> {
  return {
    Id: id,
    State: { Running: true, StartedAt: startedAt },
    Mounts: [
      { Type: "bind", Source: "/ws/toolchains/mise", Destination: "/home/agent/.local/share/mise" },
      { Type: "bind", Source: `${WORKS}/${workKey}`, Destination: "/msf-work" },
      { Type: "bind", Source: `${WORKS}/${workKey}/sessao`, Destination: "/home/agent/.pi/agent/sessions" },
    ],
  };
}

describe("liveness — the pure parser over the canned docker outputs", () => {
  test("each listed container correlates to its work by the mount under the works root, with the age of its start", () => {
    const ps = "aaa111\nbbb222\n";
    const inspect = JSON.stringify([
      container("aaa111", "Sanmoo/my-software-factory#86", "2026-02-01T11:47:00.000Z"),
      container("bbb222", "Sanmoo/my-tasks#4", "2026-02-01T11:58:30.000Z"),
    ]);

    assert.deepEqual(parseWorkerContainers(ps, inspect, WORKS, NOW), [
      { key: "Sanmoo/my-software-factory#86", ageMs: 13 * 60_000 },
      { key: "Sanmoo/my-tasks#4", ageMs: 90_000 },
    ]);
  });

  test("a container without a mount under the works root is not a factory worker", () => {
    const ps = "ccc333\n";
    const stranger = [{ Id: "ccc333", State: { Running: true, StartedAt: "2026-02-01T11:00:00Z" }, Mounts: [] }];
    assert.deepEqual(parseWorkerContainers(ps, JSON.stringify(stranger), WORKS, NOW), []);
  });

  test("only the containers the listing reported count, even when inspect carries others", () => {
    const inspect = JSON.stringify([
      container("aaa111", "Sanmoo/my-software-factory#86", "2026-02-01T11:47:00Z"),
      container("zzz999", "Sanmoo/my-tasks#9", "2026-02-01T11:00:00Z"),
    ]);
    assert.deepEqual(parseWorkerContainers("aaa111", inspect, WORKS, NOW), [
      { key: "Sanmoo/my-software-factory#86", ageMs: 13 * 60_000 },
    ]);
  });

  test("an empty listing reads as no live worker — the shape of a stopped factory", () => {
    assert.deepEqual(parseWorkerContainers("\n", JSON.stringify([]), WORKS, NOW), []);
  });
});

/**
 * The real path, in the tracker-smoke pattern (issue 102): it runs inside
 * `npm test` where Docker is up, and SKIPS WITH A REASON where it is not —
 * never a silent pass, never a false positive.
 */
const dockerUnavailableReason: string | undefined = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    return undefined;
  } catch {
    return "docker is not reachable on this machine — the real probe has no daemon to read (the pure parser covers the correlation)";
  }
})();

describe("liveness — the real Docker shell", () => {
  test(
    "the real probe over the worker image reads the daemon and returns well-formed workers (or none)",
    { skip: dockerUnavailableReason },
    async () => {
      const worksRoot = mkdtempSync(join(tmpdir(), "msf-liveness-"));
      try {
        const workers = await dockerWorkerProbe({ image: WORKER_IMAGE, worksRoot })();
        for (const worker of workers) {
          assert.match(worker.key, /#\d+$/, "every live worker carries a work key");
          assert.ok(worker.ageMs >= 0, "the age is never negative");
        }
      } finally {
        rmSync(worksRoot, { recursive: true, force: true });
      }
    },
  );
});
