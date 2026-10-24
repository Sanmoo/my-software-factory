import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { WORKER_IMAGE } from "../worker-image.js";
import { fakeDocker, inspectedContainer } from "./fake-docker.js";
import {
  dockerWorkerProbe,
  duplicateWorkers,
  occupiedSlots,
  parseWorkerContainers,
  probeLiveness,
  screenWorkerContainers,
} from "./liveness.js";

/**
 * The liveness parser: the interpretation of the Docker outputs is
 * a PURE function over canned strings — the command shell around it is the
 * only impure part, so the correlation container → work is proven without
 * Docker.
 */

const WORKS = "/ws/trabalhos";
const NOW = new Date("2026-02-01T12:00:00.000Z");

/** A worker's container: its work dir, its session dir and the toolchain volume. */
function container(id: string, workKey: string, startedAt: string): Record<string, unknown> {
  return inspectedContainer(
    id,
    ["/ws/toolchains/mise", `${WORKS}/${workKey}`, `${WORKS}/${workKey}/sessao`],
    startedAt,
  );
}

describe("liveness — the pure parser over the canned docker outputs", () => {
  test("each listed container correlates to its work by the mount under the works root, with the age of its start", () => {
    const ps = "aaa111\nbbb222\n";
    const inspect = JSON.stringify([
      container("aaa111", "Sanmoo/my-software-factory#86", "2026-02-01T11:47:00.000Z"),
      container("bbb222", "Sanmoo/my-tasks#4", "2026-02-01T11:58:30.000Z"),
    ]);

    assert.deepEqual(parseWorkerContainers(ps, inspect, WORKS, NOW), [
      { key: "Sanmoo/my-software-factory#86", containerId: "aaa111", ageMs: 13 * 60_000 },
      { key: "Sanmoo/my-tasks#4", containerId: "bbb222", ageMs: 90_000 },
    ]);
  });

  test("two containers of the same work are two workers — the count is never hidden by the work", () => {
    const ps = "aaa111\nzzz999\n";
    const inspect = JSON.stringify([
      container("aaa111", "Sanmoo/my-tasks#4", "2026-02-01T11:47:00Z"),
      container("zzz999", "Sanmoo/my-tasks#4", "2026-02-01T11:58:30Z"),
    ]);

    assert.deepEqual(parseWorkerContainers(ps, inspect, WORKS, NOW), [
      { key: "Sanmoo/my-tasks#4", containerId: "aaa111", ageMs: 13 * 60_000 },
      { key: "Sanmoo/my-tasks#4", containerId: "zzz999", ageMs: 90_000 },
    ]);
    assert.deepEqual(duplicateWorkers(parseWorkerContainers(ps, inspect, WORKS, NOW)), [
      { key: "Sanmoo/my-tasks#4", containers: 2 },
    ]);
  });

  test("a container carrying no work dir is an auxiliary container, not a worker", () => {
    const ps = "ccc333\n";
    const auxiliary = [
      {
        Id: "ccc333",
        State: { Running: true, StartedAt: "2026-02-01T11:00:00Z" },
        Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }],
      },
    ];
    assert.deepEqual(parseWorkerContainers(ps, JSON.stringify(auxiliary), WORKS, NOW), []);
  });

  test("a work mount under our root that cannot be named is unknown liveness, never 'no worker' ", () => {
    const ps = "ccc333\n";
    const stranger = [
      {
        Id: "ccc333",
        State: { Running: true, StartedAt: "2026-02-01T11:00:00Z" },
        Mounts: [{ Type: "bind", Source: `${WORKS}/moved-work-dir`, Destination: "/msf-work" }],
      },
    ];
    assert.throws(
      () => parseWorkerContainers(ps, JSON.stringify(stranger), WORKS, NOW),
      /ccc333.*identity is inconclusive.*liveness unknown/,
      "an inconclusive correlation cannot authorize assuming no relevant worker",
    );
  });

  test("another workspace's worker is decided, not ours — a sibling factory never makes liveness unknown", () => {
    const ps = "ddd444\n";
    const foreign = [
      {
        Id: "ddd444",
        State: { Running: true, StartedAt: "2026-02-01T11:30:00Z" },
        Mounts: [
          { Type: "bind", Source: "/elsewhere/trabalhos/Sanmoo/my-tasks#4", Destination: "/msf-work" },
          { Type: "bind", Source: "/elsewhere/trabalhos/Sanmoo/my-tasks#4/sessao", Destination: "/sessions" },
        ],
      },
    ];
    assert.deepEqual(
      parseWorkerContainers(ps, JSON.stringify(foreign), WORKS, NOW),
      [],
      "a work under another works root belongs to another workspace",
    );
  });

  test("the correlation verdict is mount-order independent: a named work wins over a stray bind", () => {
    const ps = "fff666\n";
    const mixed = [
      {
        Id: "fff666",
        State: { Running: true, StartedAt: "2026-02-01T11:30:00Z" },
        Mounts: [
          { Type: "bind", Source: `${WORKS}/stray-dir`, Destination: "/extra" },
          { Type: "bind", Source: `${WORKS}/Sanmoo/my-tasks#4`, Destination: "/msf-work" },
        ],
      },
    ];
    assert.deepEqual(
      parseWorkerContainers(ps, JSON.stringify(mixed), WORKS, NOW),
      [{ key: "Sanmoo/my-tasks#4", containerId: "fff666", ageMs: 30 * 60_000 }],
      "the order of the mounts never changes the verdict",
    );
  });

  test("a mount under THIS works root that names no work is inconclusive, never ignored", () => {
    const ps = "eee555\n";
    const ambiguous = [
      {
        Id: "eee555",
        State: { Running: true, StartedAt: "2026-02-01T11:30:00Z" },
        Mounts: [{ Type: "bind", Source: `${WORKS}/not-a-work-dir`, Destination: "/msf-work" }],
      },
    ];
    assert.throws(
      () => parseWorkerContainers(ps, JSON.stringify(ambiguous), WORKS, NOW),
      /eee555.*identity is inconclusive/,
    );
  });

  test("only the containers the listing reported count, even when inspect carries others", () => {
    const inspect = JSON.stringify([
      container("aaa111", "Sanmoo/my-software-factory#86", "2026-02-01T11:47:00Z"),
      container("zzz999", "Sanmoo/my-tasks#9", "2026-02-01T11:00:00Z"),
    ]);
    assert.deepEqual(parseWorkerContainers("aaa111", inspect, WORKS, NOW), [
      { key: "Sanmoo/my-software-factory#86", containerId: "aaa111", ageMs: 13 * 60_000 },
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

describe("liveness — the shared interpretation", () => {
  const workers = (pairs: Array<[string, string]>): Array<{ key: string; containerId: string; ageMs: number }> =>
    pairs.map(([key, containerId]) => ({ key, containerId, ageMs: 60_000 }));

  test("a worker seen by the process and by Docker occupies one slot, not two", () => {
    const live = workers([["Sanmoo/a#1", "ctr-a1"]]);
    assert.equal(occupiedSlots(live, new Set(["Sanmoo/a#1"])), 1, "the same worker is counted once");
    assert.equal(occupiedSlots(live, new Set()), 1, "a survivor alone occupies its slot");
    assert.equal(
      occupiedSlots(workers([["Sanmoo/a#1", "ctr-a1"], ["Sanmoo/a#1", "ctr-a2"]]), new Set()),
      2,
      "distinct containers of one work are distinct slots",
    );
    assert.equal(
      occupiedSlots([], new Set(["Sanmoo/a#1", "Sanmoo/a#2"])),
      2,
      "a launch Docker does not show yet still holds its slot",
    );
  });

  test("multiplicity is one fact for status and the cycle: the works with more than one container", () => {
    const live = workers([
      ["Sanmoo/a#1", "ctr-a1"],
      ["Sanmoo/a#2", "ctr-b1"],
      ["Sanmoo/a#2", "ctr-b2"],
      ["Sanmoo/a#3", "ctr-c1"],
      ["Sanmoo/a#3", "ctr-c2"],
    ]);
    assert.deepEqual(duplicateWorkers(live), [
      { key: "Sanmoo/a#2", containers: 2 },
      { key: "Sanmoo/a#3", containers: 2 },
    ]);
    assert.deepEqual(duplicateWorkers(workers([["Sanmoo/a#1", "ctr-a1"]])), []);
  });

  test("a container that exits between the listing and the inspect is dropped, not read as unknown liveness", async () => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "ps") return "aaa111\nbbb222\n";
      if (args[0] === "inspect" && args.length > 2) {
        throw new Error(`Command failed: docker inspect aaa111 bbb222\nError: No such object: bbb222`);
      }
      if (args[1] === "bbb222") throw new Error(`Command failed: docker inspect bbb222\nError: No such object: bbb222`);
      return JSON.stringify([container("aaa111", "Sanmoo/my-tasks#4", "2026-02-01T11:58:30.000Z")]);
    };
    const probe = dockerWorkerProbe({ worksRoot: WORKS, run });
    const workers = await probe();
    assert.deepEqual(workers.map((worker) => [worker.key, worker.containerId]), [["Sanmoo/my-tasks#4", "aaa111"]]);
    assert.equal(calls.filter((args) => args[0] === "inspect").length, 3, "the batch, then each id");

    // Any other failure is still unknown: the probe never invents an empty factory.
    const broken = dockerWorkerProbe({
      worksRoot: WORKS,
      run: async (args) => {
        if (args[0] === "ps") return "aaa111\n";
        throw new Error("Cannot connect to the Docker daemon");
      },
    });
    await assert.rejects(broken, /Cannot connect to the Docker daemon/);
  });

  test("a failing probe, an invalid answer or a timeout is unknown — never an empty factory", async () => {
    const failure = await probeLiveness(() => Promise.reject(new Error("docker: daemon down")));
    assert.deepEqual(failure, { state: "unknown", reason: "docker: daemon down" });

    const invalid = await probeLiveness(async () => {
      throw new Error("docker inspect output is not JSON — liveness unknown");
    });
    assert.equal(invalid.state, "unknown", "an unparseable answer is not a list of no workers");

    // A probe that never answers is a probe that failed: the query is bounded.
    const expired = await probeLiveness(() => new Promise(() => {}), 10);
    assert.equal(expired.state, "unknown");
    assert.match(expired.state === "unknown" ? expired.reason : "", /did not answer within 10ms/);

    const reliable = await probeLiveness(async () => workers([["Sanmoo/a#1", "ctr-a1"]]));
    assert.deepEqual(reliable, {
      state: "known",
      workers: [{ key: "Sanmoo/a#1", containerId: "ctr-a1", ageMs: 60_000 }],
    });
  });
});

describe("liveness — the worker identity survives the image reference moving", () => {
  const OLD_WORKER = "a".repeat(64);
  const SECOND = "b".repeat(64);

  test("a live worker launched before the tag moved is recognised by its work mount, never by the image", async () => {
    // Once its tag points at another image, Docker renders the container's
    // image as the bare ID — the work mount is the identity that stays.
    const listing = [
      `${OLD_WORKER} ${WORKS}/Sanmoo/my-tasks#7,/var/run/docker.sock`,
      `${SECOND} /var/run/docker.sock`,
    ].join("\n");
    const shell = fakeDocker({
      listing,
      inspect: JSON.stringify([container(OLD_WORKER, "Sanmoo/my-tasks#7", "2026-02-01T11:47:00Z")]),
    });

    const workers = await dockerWorkerProbe({ worksRoot: WORKS, run: shell.run })();

    assert.deepEqual(
      workers.map((worker) => ({ key: worker.key, containerId: worker.containerId })),
      [{ key: "Sanmoo/my-tasks#7", containerId: OLD_WORKER }],
    );
    assert.ok(workers[0]!.ageMs >= 0, "the age comes from the container's own start");
    assert.ok(
      !shell.calls.some((args) => args[0] === "image" || args.some((arg) => arg.includes("ancestor"))),
      "no query resolves the worker image reference — it can already point to another image",
    );
  });

  test("two containers of one work stay a duplicate after the tag moved", async () => {
    const listing = [
      `${OLD_WORKER} ${WORKS}/Sanmoo/my-tasks#7`,
      `${SECOND} ${WORKS}/Sanmoo/my-tasks#7`,
    ].join("\n");
    const shell = fakeDocker({
      listing,
      inspect: JSON.stringify([
        container(OLD_WORKER, "Sanmoo/my-tasks#7", "2026-02-01T11:47:00Z"),
        container(SECOND, "Sanmoo/my-tasks#7", "2026-02-01T11:58:30Z"),
      ]),
    });

    const workers = await dockerWorkerProbe({ worksRoot: WORKS, run: shell.run })();

    assert.equal(workers.length, 2, "both containers are reported, not collapsed into one row");
    assert.deepEqual(duplicateWorkers(workers), [{ key: "Sanmoo/my-tasks#7", containers: 2 }]);
  });

  test("no running container of this workspace is zero workers — a moved reference hides nothing", async () => {
    // The listing is every running container and is not image-filtered, so its
    // emptiness is a decided zero: no worker can be hidden from it.
    const probe = dockerWorkerProbe({ worksRoot: WORKS, run: fakeDocker({ listing: "" }).run });
    assert.deepEqual(await probeLiveness(probe), { state: "known", workers: [] });
  });

  test("another factory's containers are a decided absence, not unknown", async () => {
    // The row carries its mounts and none of them binds OUR works root: the
    // absence is decided, so an interrupted attempt stays recoverable instead
    // of stalling the factory behind a permanent unknown.
    const probe = dockerWorkerProbe({
      worksRoot: WORKS,
      run: fakeDocker({ listing: `${SECOND} ${WORKS}-other/Sanmoo/my-tasks#9` }).run,
    });

    assert.deepEqual(await probeLiveness(probe), { state: "known", workers: [] });
  });

  test("a container the listing did not describe is inspected, and its work mount recognised", async () => {
    // No mount sources were rendered for the row, so the listing alone cannot
    // say what it binds: `docker inspect` — the authoritative mounts — decides.
    const shell = fakeDocker({
      listing: SECOND,
      inspect: JSON.stringify([container(SECOND, "Sanmoo/my-tasks#7", "2026-02-01T11:47:00Z")]),
    });
    const probe = dockerWorkerProbe({ worksRoot: WORKS, run: shell.run });

    const workers = await probeLiveness(probe);

    assert.deepEqual(
      workers.state === "known" ? workers.workers.map((worker) => worker.key) : workers,
      ["Sanmoo/my-tasks#7"],
      "the container the moved reference made unreadable is still a worker of ours",
    );
    assert.ok(shell.calls.some((args) => args[0] === "inspect"), "the inspect decided the identity");
  });

  test("a container the listing did not describe and the inspect places elsewhere is a decided absence", async () => {
    const shell = fakeDocker({
      listing: SECOND,
      inspect: JSON.stringify([inspectedContainer(SECOND, [])]),
    });

    assert.deepEqual(
      await probeLiveness(dockerWorkerProbe({ worksRoot: WORKS, run: shell.run })),
      { state: "known", workers: [] },
      "an inspect that shows no work mount is a decided absence, never unknown",
    );
  });

  test("a truncated mount column is not read as absence either", async () => {
    const shell = fakeDocker({
      listing: `${SECOND} /home/sanmoo/…,/var/run/docke…`,
      inspect: JSON.stringify([container(SECOND, "Sanmoo/my-tasks#7", "2026-02-01T11:47:00Z")]),
    });

    const workers = await probeLiveness(dockerWorkerProbe({ worksRoot: WORKS, run: shell.run }));

    assert.deepEqual(
      workers.state === "known" ? workers.workers.map((worker) => worker.key) : workers,
      ["Sanmoo/my-tasks#7"],
    );
  });

  test("Docker failing is unknown, never an empty factory", async () => {
    const probe = dockerWorkerProbe({
      worksRoot: WORKS,
      run: fakeDocker({ listing: "", failure: new Error("docker: daemon down") }).run,
    });

    const observation = await probeLiveness(probe);

    assert.equal(observation.state, "unknown");
    assert.match(observation.state === "unknown" ? observation.reason : "", /daemon down/);
  });

  test("the screening places containers under THIS works root and leaves the rest to the inspect", () => {
    const unrendered = "c".repeat(64);
    const listing = [
      `${OLD_WORKER} ${WORKS}/Sanmoo/my-tasks#7,/var/run/docker.sock`,
      `${SECOND} ${WORKS}-old/Sanmoo/my-tasks#8`,
      unrendered,
    ].join("\n");
    assert.deepEqual(screenWorkerContainers(listing, WORKS), {
      candidates: [OLD_WORKER],
      needsInspect: [unrendered],
    });
    assert.deepEqual(
      screenWorkerContainers(`${OLD_WORKER} /home/sanmoo/…`, WORKS).needsInspect,
      [OLD_WORKER],
      "a truncated mount column is not read as absence",
    );
  });
});

/**
 * The real path, in the tracker-smoke pattern: it runs inside
 * `npm test` where Docker and the worker image are there, and SKIPS WITH A
 * REASON where they are not — never a silent pass, never a false positive.
 * The quality gateway sets MSF_REQUIRE_DOCKER=1, turning that skip into a
 * failure: inside the measured gateway a missing daemon or image must never
 * look like a successful run of the required integration check. Module scope
 * on purpose: this throw must fail the file; a throw raised while the suite is
 * built is reported in TAP but still exits 0.
 */
const dockerSkipReasonForFocusedRun = dockerSkipReasonUnlessRequired();

function dockerSkipReasonUnlessRequired(): string | undefined {
  const missing = missingDockerReason();
  if (missing !== undefined && process.env.MSF_REQUIRE_DOCKER === "1") {
    throw new Error(`the quality gateway requires the real Docker check, but ${missing}`);
  }
  return missing;
}

function missingDockerReason(): string | undefined {
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
}

describe("liveness — the real Docker shell", () => {
  test(
    "a real container carrying a work dir is read back as that work",
    { skip: dockerSkipReasonForFocusedRun, timeout: 60_000 },
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
        const workers = await dockerWorkerProbe({ worksRoot })();
        assert.deepEqual(workers.map((worker) => worker.key), ["Sanmoo/my-tasks#7"]);
        assert.ok(workers[0]!.ageMs >= 0, "the age comes from the container's start");
        assert.ok(
          workers[0]!.containerId.startsWith(containerId.slice(0, 12)),
          "the container's own identity is preserved",
        );
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

  test(
    "two real containers of one work are two workers in the count, never one",
    { skip: dockerSkipReasonForFocusedRun, timeout: 60_000 },
    async () => {
      const worksRoot = mkdtempSync(join(tmpdir(), "msf-liveness-dup-"));
      const workDir = join(worksRoot, "Sanmoo", "my-tasks#8");
      mkdirSync(workDir, { recursive: true });
      const start = (): string =>
        execFileSync(
          "docker",
          ["run", "-d", "--rm", "--network", "none", "--entrypoint", "sleep", "-v", `${workDir}:/msf-work`, WORKER_IMAGE, "60"],
          { encoding: "utf8" },
        ).trim();
      const first = start();
      const second = start();
      try {
        const workers = await dockerWorkerProbe({ worksRoot })();
        const seen = workers.filter((worker) => worker.key === "Sanmoo/my-tasks#8");
        assert.equal(seen.length, 2, "both containers are reported, not collapsed into one row");
        assert.equal(new Set(seen.map((worker) => worker.containerId)).size, 2);
        assert.deepEqual(duplicateWorkers(workers), [{ key: "Sanmoo/my-tasks#8", containers: 2 }]);
        assert.equal(occupiedSlots(workers, new Set()), 2);
      } finally {
        rmSync(worksRoot, { recursive: true, force: true });
        for (const id of [first, second]) {
          try {
            execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
          } catch {
            // Already gone (the container's own --rm).
          }
        }
      }
    },
  );
});
