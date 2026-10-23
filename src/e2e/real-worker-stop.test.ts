import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

import { dockerWorkerProbe } from "../state/liveness.js";
import { dockerWorkerForceStop } from "../runtime/worker-stop.js";
import { dockerSocketFromHost } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";

/**
 * The real-runtime proof of the stop (issue #146, mandatory complement): a fake
 * cannot prove that a worker container ends. The driver runs INSIDE a container
 * of the worker image, sharing the host's paths and daemon socket, and starts a
 * REAL Sandcastle worker (deterministic `sleep` agent — no LLM inference):
 *
 *   - cooperative: the requested stop aborts the session, the launch settles
 *     and the probe shows no surviving container;
 *   - forced: the forced stop removes the container and confirms it, with the
 *     same absence proven by the factory's own probe afterwards.
 *
 * Paths cross the container boundary: this suite may itself run inside a
 * factory worker container, where the daemon resolves bind sources on the
 * HOST. The helper container binds the repository at its host path, so the
 * driver and the daemon agree on every path.
 */

/**
 * One mode's ceiling: comfortably above the driver's own bounds (30 s to see the
 * container, 30 s to settle, 20 s of cooperative grace) and far below the
 * gateway's 240 s, so a hang fails THIS check by name instead of exhausting the
 * budget as an unidentified timeout.
 */
const MODE_TIMEOUT_MS = 90_000;

/** The docker/image prerequisite: a focused run skips with the reason, the
 *  gateway (MSF_REQUIRE_DOCKER=1) fails — never a silent pass. */
function dockerSkipReason(): string | undefined {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    return "docker is not reachable — the real worker stop cannot be proven";
  }
  try {
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch {
    return `the worker image ${WORKER_IMAGE} is not built (npm run build:image) — the real worker stop has nothing to launch`;
  }
  return undefined;
}

const skipReason = (() => {
  const missing = dockerSkipReason();
  if (missing !== undefined && process.env.MSF_REQUIRE_DOCKER === "1") {
    throw new Error(`the quality gateway requires the real worker-stop check, but ${missing}`);
  }
  return missing;
})();

/**
 * The HOST path of a path inside this container. The daemon knows the answer:
 * `docker inspect` of THIS container (the hostname is its id) lists the bind
 * mounts with the host Source behind every container Destination. Running on
 * the host itself, there is no container to inspect and the path already is
 * the host's.
 */
function hostPathOf(path: string): string {
  let mounts: Array<{ Source?: string; Destination?: string }> = [];
  try {
    const container = readFileSync("/etc/hostname", "utf8").trim();
    const inspected = JSON.parse(
      execFileSync("docker", ["inspect", container], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    ) as Array<{ Mounts?: Array<{ Source?: string; Destination?: string }> }>;
    mounts = inspected[0]?.Mounts ?? [];
  } catch {
    return path;
  }
  let best: { destination: string; source: string } | null = null;
  for (const mount of mounts) {
    if (mount.Source === undefined || mount.Destination === undefined) continue;
    if (path === mount.Destination || path.startsWith(`${mount.Destination}/`)) {
      if (best === null || mount.Destination.length > best.destination.length) {
        best = { destination: mount.Destination, source: mount.Source };
      }
    }
  }
  if (best === null) return path;
  const suffix = relative(best.destination, path).split(sep).join("/");
  return suffix === "" ? best.source : `${best.source}/${suffix}`;
}

/** The repository root, from the compiled test's location (dist/e2e/). */
function repoRoot(): string {
  return resolve(new URL("../../", import.meta.url).pathname);
}

interface StopResult {
  mode: string;
  workerSeen: boolean;
  /** The deadline or the second signal forced what the request left behind. */
  forcedStop: boolean;
  settledInWindow: boolean;
  launchSettled: boolean;
  outcome: string | null;
  surviving: string[];
}

/**
 * Run the driver in a container shaped like a worker: the repository bound at
 * its HOST path (so the daemon resolves the same paths the driver uses) and the
 * daemon socket joined by its group (ADR 0003).
 */
function runDriver(mode: "cooperative" | "forced" | "abort", testRoot: string): StopResult {
  const hostRepo = hostPathOf(repoRoot());
  const hostRoot = hostPathOf(testRoot);
  const socket = dockerSocketFromHost();
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--group-add",
    String(socket.gid),
    "-e",
    `DOCKER_HOST=unix://${socket.hostPath}`,
    "-v",
    `${socket.hostPath}:${socket.hostPath}`,
    "-v",
    `${hostRepo}:${hostRepo}`,
    "-w",
    hostRoot,
    "--entrypoint",
    "node",
    WORKER_IMAGE,
    join(hostRepo, "dist", "e2e", "real-stop-driver.js"),
    mode,
    hostRoot,
  ];
  const stdout = execFileSync("docker", args, {
    encoding: "utf8",
    timeout: MODE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = stdout
    .split("\n")
    .filter((candidate) => candidate.startsWith("MSF_STOP_RESULT="))
    .at(-1);
  assert.ok(line !== undefined, `the driver printed its result; stdout: ${stdout}`);
  return JSON.parse(line.slice("MSF_STOP_RESULT=".length)) as StopResult;
}

/** The factory's own probe over the host workspace root: no worker survives. */
async function workersOf(root: string): Promise<string[]> {
  const worksRoot = join(hostPathOf(root), "fabrica", "trabalhos");
  const workers = await dockerWorkerProbe({ image: WORKER_IMAGE, worksRoot })();
  return workers.map((worker) => worker.key);
}

function freshRoot(): string {
  const base = join(repoRoot(), "node_modules");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, ".msf-stop-"));
}

describe("e2e: the real worker container ends on the requested stop (issue #146)", { skip: skipReason, timeout: MODE_TIMEOUT_MS }, () => {
  for (const mode of ["cooperative", "forced", "abort"] as const) {
    test(`the ${mode} stop ends the real Sandcastle container and leaves no surviving worker`, async () => {
      const root = freshRoot();
      const key = "Sanmoo/stop#1";
      try {
        const result = runDriver(mode, root);

        assert.equal(result.workerSeen, true, "the worker container really existed before the stop");
        assert.equal(result.launchSettled, true, "the stop settled the launch (no abandoned promise)");
        assert.equal(result.outcome, "abrupt-death", "a stopped session ends without an invented outcome");
        assert.deepEqual(result.surviving, [], "the runtime's own probe confirms no worker survives");
        if (mode === "forced") assert.equal(result.forcedStop, true, "the escalation forced the worker");
        if (mode === "abort") {
          assert.equal(result.forcedStop, false, "the cooperative request alone ended the real container");
        }
        if (mode === "cooperative") {
          assert.equal(
            result.forcedStop,
            !result.settledInWindow,
            "the forced phase runs exactly when the cooperative window ended first",
          );
        }

        // The factory's probe, from this side of the boundary, agrees.
        assert.deepEqual(await workersOf(root), [], "no container of the work survives after the driver exits");
      } finally {
        try {
          await dockerWorkerForceStop({
            image: WORKER_IMAGE,
            worksRoot: join(hostPathOf(root), "fabrica", "trabalhos"),
          })(key);
        } catch {
          // No survivor to clean (the normal end).
        }
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
