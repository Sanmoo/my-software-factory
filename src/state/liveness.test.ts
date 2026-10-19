import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

  test("an unreadable start time fails the probe instead of showing a fabricated 0s", () => {
    const unreadable = [
      { ...container("aaa111", "Sanmoo/my-tasks#4", "2026-02-01T11:58:30Z"), State: { Running: true } },
    ];
    assert.throws(
      () => parseWorkerContainers("aaa111", JSON.stringify(unreadable), WORKS, NOW),
      /no readable start time — liveness unknown/,
      "a live worker whose age is unknowable is unknown liveness, not a worker that just started",
    );
  });

  test("inspect output that is not JSON fails the probe — never an empty factory", () => {
    assert.throws(
      () => parseWorkerContainers("aaa111", "docker: something went wrong", WORKS, NOW),
      /not JSON — liveness unknown/,
    );
  });
});

/**
 * The real path, in the tracker-smoke pattern (issue 102): it runs inside
 * `npm test` where Docker and the worker image are there, and SKIPS WITH A
 * REASON where they are not — never a silent pass, never a false positive.
 */
const dockerSkipReason: string | undefined = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    return "docker is not reachable on this machine — the real probe has no daemon to read (the pure parser covers the correlation)";
  }
  try {
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch {
    return `the worker image ${WORKER_IMAGE} is not built here (npm run build:image) — the real probe has nothing to list`;
  }
  return undefined;
})();

describe("liveness — the real Docker shell", () => {
  test(
    "a real worker-image container carrying a work dir is read back as that work",
    { skip: dockerSkipReason, timeout: 60_000 },
    async () => {
      const worksRoot = mkdtempSync(join(tmpdir(), "msf-liveness-"));
      const workDir = join(worksRoot, "Sanmoo", "my-tasks#7");
      mkdirSync(workDir, { recursive: true });
      // A throwaway container of the worker image, no network, one dir bound
      // the way the runtime binds the work — the probe must correlate it back.
      const containerId = execFileSync(
        "docker",
        ["run", "-d", "--rm", "--network", "none", "--entrypoint", "sleep", "-v", `${workDir}:/msf-work`, WORKER_IMAGE, "60"],
        { encoding: "utf8" },
      ).trim();
      try {
        const workers = await dockerWorkerProbe({ image: WORKER_IMAGE, worksRoot })();
        assert.deepEqual(workers.map((worker) => worker.key), ["Sanmoo/my-tasks#7"]);
        assert.ok(workers[0]!.ageMs >= 0, "the age comes from the container's start");
      } finally {
        rmSync(worksRoot, { recursive: true, force: true });
        try {
          execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
        } catch {
          // Already gone (the container's own --rm): nothing to clean up.
        }
      }
    },
  );
});
