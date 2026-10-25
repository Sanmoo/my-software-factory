import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { Notification } from "../notify/port.js";
import type { LiveWorker, LivenessProbe } from "../state/liveness.js";
import { openSurvivors, type ReservedWork, type Survivors, type SurvivorsDeps } from "./survivors.js";

/**
 * The liveness and the survivor ledger at its own seam (epic #198, ticket #206):
 * the domain through {@link Survivors} with a FAKE probe and an INJECTED clock —
 * no factory, no derivation, no Docker, no container. What the module asks the
 * cycle for (the end of a survivor, the operator's notice) is a recording port,
 * so a test sees exactly what was reported and what was not.
 */

const REPO = "Sanmoo/my-tasks";

/** One live worker the fake Docker reports: the container's own identity. */
function worker(number: number, containerId: string, ageMs = 5 * 60_000): LiveWorker {
  return { key: `${REPO}#${number}`, containerId, ageMs };
}

/** A world the tests steer: what Docker answers now, and what time it is. */
interface World {
  probe: LivenessProbe;
  clock: { t: number };
  log: string[];
  notices: Notification[];
  ends: Array<{ key: string; attempt: number }>;
  module: Survivors;
  workspace: string;
}

/** The probe answers what `answer` returns; a rejected `answer` is Docker's
 *  silence, exactly as the production probe reports it. */
function world(
  options: {
    answer?: () => Promise<LiveWorker[]>;
    warnMs?: number;
    idleLimitMs?: number;
    probeTimeoutMs?: number;
    ended?: (key: string, attempt: number) => Promise<null>;
  } = {},
): World {
  const clock = { t: 1_000_000 };
  const log: string[] = [];
  const notices: Notification[] = [];
  const ends: Array<{ key: string; attempt: number }> = [];
  const workspace = mkdtempSync(join(tmpdir(), "msf-survivors-"));
  const probe: LivenessProbe = options.answer ?? (async () => []);
  const deps: SurvivorsDeps = {
    probe,
    now: () => clock.t,
    log: (message) => log.push(message),
    unavailableWarnMs: options.warnMs ?? 60_000,
    ...(options.idleLimitMs === undefined ? {} : { idleLimitMs: options.idleLimitMs }),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    cycle: {
      ended: async (launchable, attempt) => {
        ends.push({ key: `${REPO}#${0}`, attempt });
        await options.ended?.(`${launchable.kind}`, attempt);
        return null;
      },
      notice: async (notification) => {
        notices.push(notification);
      },
    },
  };
  return { probe, clock, log, notices, ends, module: openSurvivors(deps), workspace };
}

const silent = (): LivenessProbe => () => Promise.reject(new Error("docker: daemon is not reachable"));

function count(lines: readonly string[], fragment: string): number {
  return lines.filter((line) => line.includes(fragment)).length;
}

describe("liveness and the survivor ledger — the answer the cycle reads", () => {
  test("a decided zero is a known answer that carries nobody — the cycle acts on it", async () => {
    const w = world({ answer: async () => [] });
    try {
      await w.module.observe(new Set());

      assert.equal(w.module.isKnown(), true, "Docker answered: the zero is decided, not unknown");
      assert.deepEqual(w.module.observation(), { state: "known", workers: [] });
      assert.equal(w.module.carriers().size, 0, "no Work is carried");
      assert.equal(w.module.carries(`${REPO}#7`), false, "the Work of the decided zero is not carried");
      assert.deepEqual(w.log, [], "a decided zero is not an occurrence: nothing is announced");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("an unreadable answer is unknown: nobody is carried, and it is never the decided zero", async () => {
    const w = world({ answer: silent() });
    try {
      await w.module.observe(new Set());

      assert.equal(w.module.isKnown(), false, "the failed read is unknown, never 'no worker'");
      assert.equal(w.module.observation().state, "unknown");
      assert.equal(w.module.carriers().size, 0, "an unreadable answer carries nobody…");
      assert.equal(w.module.carries(`${REPO}#7`), false, "…and never claims a Work is running");

      // The same empty ledger, two different facts: the engine acts on the zero
      // and suspends on the unknown. Only `isKnown` tells them apart.
      await w.module.observe(new Set());
      assert.equal(w.module.isKnown(), false, "still unknown while Docker stays silent");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("the suspension is announced once per episode, not once per tick", async () => {
    const w = world({ answer: silent() });
    try {
      await w.module.observe(new Set());
      await w.module.observe(new Set());
      await w.module.observe(new Set());

      assert.equal(
        count(w.log, "liveness unknown ("),
        1,
        "the cause is diagnosed on the first failure and never repeated inside the episode",
      );
      assert.ok(w.log[0]!.includes("no attempt or recovery spent"), "the operator learns nothing was spent");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a reliable answer closes the episode once, by itself — and a new one is a new appearance", async () => {
    let alive = false;
    const w = world({
      answer: async () => {
        if (!alive) throw new Error("docker: daemon is not reachable");
        return [];
      },
    });
    try {
      await w.module.observe(new Set());
      await w.module.observe(new Set());
      alive = true;
      await w.module.observe(new Set());
      await w.module.observe(new Set());

      assert.equal(count(w.log, "liveness unknown ("), 1);
      assert.equal(count(w.log, "liveness reliable again"), 1, "the closing is said once, not per tick");

      alive = false;
      await w.module.observe(new Set());
      assert.equal(count(w.log, "liveness unknown ("), 2, "a second episode is a second appearance");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("the unavailability warning fires once per episode at the threshold, with one notice, and re-arms", async () => {
    let failing = true;
    const w = world({
      warnMs: 60_000,
      answer: async () => {
        w.clock.t += 30_000;
        if (failing) throw new Error("docker: daemon is not reachable");
        return [];
      },
    });
    try {
      await w.module.observe(new Set()); // the episode starts here
      await w.module.observe(new Set()); // 30 s
      assert.equal(count(w.log, "WARNING: Docker has not answered"), 0, "below the threshold nothing is said");
      await w.module.observe(new Set()); // 60 s — the threshold
      assert.equal(count(w.log, "WARNING: Docker has not answered"), 1);
      await w.module.observe(new Set());
      await w.module.observe(new Set());
      assert.equal(count(w.log, "WARNING: Docker has not answered"), 1, "never twice inside one episode");
      assert.equal(w.notices.length, 1, "one notice per episode");
      assert.equal(w.notices[0]!.kind, "factory-unavailable", "the notice is the factory's own, naming no Work");

      failing = false;
      await w.module.observe(new Set());
      failing = true;
      await w.module.observe(new Set()); // a new episode starts here
      await w.module.observe(new Set()); // 30 s
      await w.module.observe(new Set()); // 60 s — the new episode's threshold
      assert.equal(count(w.log, "WARNING: Docker has not answered"), 2, "a reliable answer re-arms the warning");
      assert.equal(w.notices.length, 2, "and the new episode has its own single notice");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a probe that never answers is bounded: the answer is unknown, not a stall", async () => {
    const w = world({ probeTimeoutMs: 20, answer: () => new Promise<LiveWorker[]>(() => {}) });
    try {
      await w.module.observe(new Set());
      assert.equal(w.module.isKnown(), false);
      assert.ok(
        w.log.some((line) => line.includes("did not answer within 20ms")),
        "the cause names the bound the probe missed",
      );
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("the reservations handed over are what the ledger speaks of — nothing is invented from a key", async () => {
    const w = world();
    try {
      const reservations = new Map<string, ReservedWork>();
      await w.module.observe(new Set());
      assert.deepEqual(await w.module.reconcile(reservations), new Set(), "an empty world settles nothing");
      assert.deepEqual(w.module.takeRecoveries(), [], "and asks for no continuation");
      assert.deepEqual(w.log, []);
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});
