import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { githubWork } from "../e2e/work-fixtures.js";
import type { Launchable } from "../launch/launch.js";
import type { Notification } from "../notify/port.js";
import type { LiveWorker, LivenessProbe } from "../state/liveness.js";
import { eventLogName } from "../work-record/logs.js";
import { EMPTY_REPAIR_CYCLE, writeRepairCycle } from "../work-record/repair.js";
import {
  openSurvivors,
  type ReservedWork,
  type Survivors,
  type SurvivorsDeps,
} from "./survivors.js";

/**
 * The liveness and the survivor ledger at its own seam (epic #198, ticket #206):
 * the domain through {@link Survivors} with a FAKE probe and an INJECTED clock —
 * no factory, no derivation, no Docker, no container. What the module asks the
 * cycle for (the end of a survivor, the operator's notice) is a recording port,
 * so a test sees exactly what was reported and what was not.
 *
 * Every "once per appearance, never once per tick" rule below is proven the same
 * way: the same world is observed several times and the occurrence is counted.
 */

const REPO = "Sanmoo/my-tasks";

/** One live worker the fake Docker reports: the container's own identity. */
function worker(number: number, containerId: string, ageMs = 5 * 60_000): LiveWorker {
  return { key: `${REPO}#${number}`, containerId, ageMs };
}

/** A world the tests steer: what Docker answers now, and what time it is. */
interface World {
  clock: { t: number };
  log: string[];
  notices: Notification[];
  /** Every end the ledger asked the cycle to rule, in order. */
  ends: Array<{ launchable: Launchable; attempt: number }>;
  module: Survivors;
  workspace: string;
  /** The reservation of one seeded Work: its key, its Work and its dir. */
  reserved(number: number, attempts?: number[]): ReservedWork;
}

/** The probe answers what `answer` returns; a rejected `answer` is Docker's
 *  silence, exactly as the production probe reports it. */
function world(
  options: {
    answer?: () => Promise<LiveWorker[]>;
    warnMs?: number;
    idleLimitMs?: number;
    probeTimeoutMs?: number;
    /** The continuation an end asks for — absent: the end continues nothing. */
    continuation?: (launchable: Launchable, attempt: number) => Launchable | null;
  } = {},
): World {
  const clock = { t: 1_000_000 };
  const log: string[] = [];
  const notices: Notification[] = [];
  const ends: Array<{ launchable: Launchable; attempt: number }> = [];
  const workspace = mkdtempSync(join(tmpdir(), "msf-survivors-"));
  const deps: SurvivorsDeps = {
    probe: options.answer ?? (async () => []),
    now: () => clock.t,
    log: (message) => log.push(message),
    unavailableWarnMs: options.warnMs ?? 60_000,
    ...(options.idleLimitMs === undefined ? {} : { idleLimitMs: options.idleLimitMs }),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    cycle: {
      ended: async (launchable, attempt) => {
        ends.push({ launchable, attempt });
        return options.continuation?.(launchable, attempt) ?? null;
      },
      notice: async (notification) => {
        notices.push(notification);
      },
    },
  };
  return {
    clock,
    log,
    notices,
    ends,
    module: openSurvivors(deps),
    workspace,
    reserved: (number, attempts = [1]) => {
      const key = `${REPO}#${number}`;
      const dir = join(workspace, key);
      mkdirSync(dir, { recursive: true });
      for (const attempt of attempts) writeFileSync(join(dir, eventLogName(attempt)), "{}\n", "utf8");
      return { key, work: githubWork(REPO, number), dir };
    },
  };
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

  test("an empty world settles nothing and asks for no continuation", async () => {
    const w = world();
    try {
      await w.module.observe(new Set());
      assert.deepEqual(await w.module.reconcile(new Map()), new Set(), "an empty world settles nothing");
      assert.deepEqual(w.module.takeRecoveries(), [], "and asks for no continuation");
      assert.deepEqual(w.log, []);
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});

describe("the ledger answers which worker carries each Work", () => {
  test("a survivor is the ledger's answer: the container that carries the Work, named as a survivor", async () => {
    const w = world({ answer: async () => [worker(7, "ctr000000007")] });
    try {
      const reserved = w.reserved(7, [1, 2]);
      await w.module.observe(new Set());
      await w.module.reconcile(new Map([[reserved.key, reserved]]));

      assert.equal(w.module.carries(reserved.key), true);
      assert.equal(w.module.carries(`${REPO}#8`), false, "a Work no container lists is not carried");
      assert.deepEqual(w.module.survivorKeys(), new Set([reserved.key]), "the ledger names the survivor it adopted");
      assert.deepEqual(w.module.carriers().get(reserved.key), [
        { containerId: "ctr000000007", ageMs: 5 * 60_000, role: "survivor" },
      ]);
      assert.equal(
        count(w.log, "recognizing surviving worker"),
        1,
        "the recognition names the attempt its artifacts number, once per appearance",
      );
      assert.ok(w.log.some((line) => line.includes("attempt 2")), "the attempt is read from the evidence on disk");

      await w.module.observe(new Set());
      await w.module.reconcile(new Map([[reserved.key, reserved]]));
      assert.equal(count(w.log, "recognizing surviving worker"), 1, "a survivor already in the ledger is not re-announced");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a container this process launched is an admission, never a survivor", async () => {
    const w = world({ answer: async () => [worker(7, "ctr000000007")] });
    try {
      const reserved = w.reserved(7);
      await w.module.observe(new Set([reserved.key]));
      assert.deepEqual(await w.module.reconcile(new Map([[reserved.key, reserved]])), new Set());

      assert.deepEqual(w.module.carriers().get(reserved.key), [
        { containerId: "ctr000000007", ageMs: 5 * 60_000, role: "launch" },
      ]);
      assert.deepEqual(w.module.survivorKeys(), new Set(), "our own launch is no survivor");
      assert.equal(count(w.log, "recognizing surviving worker"), 0, "our own launch is not news");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("two containers of one Work are two carriers and one duplicate — said once per appearance", async () => {
    let second = true;
    const w = world({
      answer: async () => (second ? [worker(7, "ctr000000007"), worker(7, "ctr000000099")] : [worker(7, "ctr000000007")]),
    });
    try {
      const reserved = w.reserved(7);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      assert.equal(w.module.carriers().get(reserved.key)?.length, 2, "two containers, two carriers, one Work");
      assert.equal(count(w.log, "duplicate workers for"), 1, "the duplicate is never a line per tick");
      assert.equal(w.notices.filter((notice) => notice.kind === "intervention").length, 1);
      assert.equal(w.ends.length, 0, "no owner is chosen and nothing is ended");

      // One container left: the duplicate is no longer an appearance…
      second = false;
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      assert.equal(w.module.carriers().get(reserved.key)?.length, 1);

      // …and a new duplicate of the same Work is a new appearance.
      second = true;
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      assert.equal(count(w.log, "duplicate workers for"), 2, "a new appearance is said again");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a container nobody can address is held, and two of them are a duplicate that invents no notice", async () => {
    const key = "nao-um-work";
    const w = world({
      answer: async () => [
        { key, containerId: "ctr000000003", ageMs: 1 },
        { key, containerId: "ctr000000004", ageMs: 2 },
      ],
    });
    try {
      await w.module.observe(new Set());
      await w.module.reconcile(new Map());

      assert.equal(count(w.log, "duplicate workers for"), 1, "two containers of one key are a duplicate");
      assert.equal(
        count(w.log, "no intervention notice for duplicate"),
        1,
        "a key that names no Work is said, never invented into one",
      );
      assert.equal(w.notices.length, 0, "no notice is delivered for a Work nobody can name");
      assert.equal(w.module.carriers().get(key)?.[0]?.role, "held", "a container nobody can address is held");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});

describe("the survivor's activity watch", () => {
  test("the agents' own writes keep a survivor alive; the factory's own log never does", async () => {
    const w = world({ answer: async () => [worker(7, "ctr000000007")], idleLimitMs: 60_000 });
    try {
      const reserved = w.reserved(7);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations); // the baseline

      // The factory's derived log grows every cycle: it must not look like work.
      for (let cycle = 0; cycle < 4; cycle += 1) {
        w.clock.t += 30_000;
        appendFileSync(join(reserved.dir, eventLogName(1)), '{"event":"heartbeat"}\n', "utf8");
        await w.module.observe(new Set());
        await w.module.reconcile(reservations);
      }

      assert.equal(count(w.log, "no verifiable activity"), 1, "silence past the limit warns exactly once");
      assert.equal(
        w.notices.filter((notice) => notice.kind === "intervention").length,
        1,
        "the operator is asked once, with one intervention notice",
      );
      assert.equal(w.ends.length, 0, "the factory does not end a worker it did not launch");
      assert.equal(w.module.carries(reserved.key), true, "the slot stays the survivor's");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a survivor writing its own files past the limit is never called idle", async () => {
    const w = world({ answer: async () => [worker(7, "ctr000000007")], idleLimitMs: 60_000 });
    try {
      const reserved = w.reserved(7);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      for (let cycle = 0; cycle < 4; cycle += 1) {
        w.clock.t += 30_000;
        writeFileSync(join(reserved.dir, `anotacoes-${cycle}.md`), "trabalho\n", "utf8");
        await w.module.observe(new Set());
        await w.module.reconcile(reservations);
      }

      assert.equal(count(w.log, "no verifiable activity"), 0, "the agents' own work is proof of life");
      assert.equal(w.notices.length, 0);
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});

describe("the end of a survivor", () => {
  test("a survivor that vanished is settled once: the engine rules its end and the continuation is queued", async () => {
    let alive = true;
    const w = world({
      answer: async () => (alive ? [worker(7, "ctr000000007")] : []),
      continuation: (launchable, attempt) => ({ ...launchable, kind: "recover", attempt }),
    });
    try {
      const reserved = w.reserved(7, [1]);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      alive = false;
      await w.module.observe(new Set());
      assert.deepEqual(await w.module.reconcile(reservations), new Set([reserved.key]), "the work is settled this sweep");
      await w.module.observe(new Set());
      assert.deepEqual(await w.module.reconcile(reservations), new Set(), "and never settled again");

      assert.equal(w.ends.length, 1, "the engine rules the end exactly once");
      assert.equal(w.ends[0]!.attempt, 1, "over the attempt the evidence numbers");
      assert.equal(w.ends[0]!.launchable.kind, "claim", "a plain attempt is not a repair round");
      assert.equal(
        count(w.log, "confirmed finished by a reliable probe"),
        1,
        "the operator sees the end once, never once per tick",
      );
      const recoveries = w.module.takeRecoveries();
      assert.equal(recoveries.length, 1, "the continuation is queued for the derivation");
      assert.equal(recoveries[0]!.kind, "recover");
      assert.deepEqual(w.module.takeRecoveries(), [], "and taken only once");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a survivor of a repair round is ruled as a repair, not as a new claim", async () => {
    let alive = true;
    const w = world({ answer: async () => (alive ? [worker(7, "ctr000000007")] : []) });
    try {
      const reserved = w.reserved(7, [1]);
      // The repair cycle of the SAME attempt: its end must be ruled as a repair.
      await writeRepairCycle(reserved.dir, {
        ...EMPTY_REPAIR_CYCLE,
        usedRounds: 1,
        attempt: {
          evidence: "checks-reprovados",
          attempt: 1,
          observedHeadSha: "a".repeat(40),
          remoteHeadSha: null,
          publication: "published",
          localWork: null,
        },
      });
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      alive = false;
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      assert.equal(w.ends.length, 1);
      assert.equal(w.ends[0]!.launchable.kind, "repair");
      assert.ok(w.log.some((line) => line.includes("the attempt was a repair round")));
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("a survivor that ended with no attempt evidence is said once and rules nothing", async () => {
    let alive = true;
    const w = world({ answer: async () => (alive ? [worker(7, "ctr000000007")] : []) });
    try {
      const reserved = w.reserved(7, []);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      alive = false;
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      assert.equal(w.ends.length, 0, "no attempt is invented from a survivor that numbered none");
      assert.ok(w.log.some((line) => line.includes("no attempt evidence on disk")));
      assert.deepEqual(w.module.takeRecoveries(), []);
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("an appearance survives an unavailable episode: nothing is announced twice, nobody is ended by silence", async () => {
    let mode: "alive" | "silent" | "gone" = "alive";
    const w = world({
      answer: async () => {
        if (mode === "silent") throw new Error("docker: daemon is not reachable");
        return mode === "alive" ? [worker(7, "ctr000000007")] : [];
      },
    });
    try {
      const reserved = w.reserved(7, [1]);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      // The reads fail while the survivor is still there: nothing decays.
      mode = "silent";
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      assert.equal(w.ends.length, 0, "Docker's silence ends nobody");

      // The reads resume and the survivor is still carried: one appearance, one line.
      mode = "alive";
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      assert.equal(count(w.log, "recognizing surviving worker"), 1, "the same survivor is not recognised twice");
      assert.deepEqual(w.module.survivorKeys(), new Set([reserved.key]));

      // Only now it is really gone: the end is said once, after the episode.
      mode = "gone";
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);
      assert.equal(w.ends.length, 1, "the end is ruled once");
      assert.equal(count(w.log, "confirmed finished by a reliable probe"), 1);
      assert.equal(count(w.log, "liveness unknown ("), 1, "the episode itself was said once");
      assert.equal(count(w.log, "liveness reliable again"), 1, "and closed once");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });

  test("unknown liveness settles nothing: no end, no continuation, no block is spent on Docker's silence", async () => {
    let alive = true;
    const w = world({
      answer: async () => {
        if (!alive) throw new Error("docker: daemon is not reachable");
        return [worker(7, "ctr000000007")];
      },
      continuation: (launchable, attempt) => ({ ...launchable, kind: "recover", attempt }),
    });
    try {
      const reserved = w.reserved(7, [1]);
      const reservations = new Map([[reserved.key, reserved]]);
      await w.module.observe(new Set());
      await w.module.reconcile(reservations);

      alive = false;
      await w.module.observe(new Set());
      await w.module.observe(new Set());
      assert.deepEqual(await w.module.reconcile(reservations), new Set(), "the survivor has not ended: it is unread");
      assert.equal(w.ends.length, 0, "the unreadable answer spends no ruling");
      assert.deepEqual(w.module.takeRecoveries(), [], "and no continuation");
      assert.equal(count(w.log, "confirmed finished by a reliable probe"), 0);
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});

describe("a container whose reservation names no Work", () => {
  test("the hold is said once, and its end once — nothing is invented from the key", async () => {
    let alive = true;
    const w = world({ answer: async () => (alive ? [worker(9, "ctr000000009")] : []) });
    try {
      await w.module.observe(new Set());
      await w.module.reconcile(new Map());
      await w.module.observe(new Set());
      await w.module.reconcile(new Map());

      assert.equal(
        count(w.log, "no reservation that names a Work"),
        1,
        "the hold belongs to an appearance, not to a tick",
      );
      assert.ok(w.log.some((line) => line.includes(`${REPO}#9`)), "the operator gets the key the container carries");
      assert.equal(w.module.carriers().get(`${REPO}#9`)?.[0]?.role, "held");

      alive = false;
      await w.module.observe(new Set());
      await w.module.reconcile(new Map());
      await w.module.observe(new Set());
      await w.module.reconcile(new Map());
      assert.equal(count(w.log, "is gone; its reservation still names no Work"), 1, "the end is said once");
      assert.equal(w.ends.length, 0, "a Work nobody can address is not ruled");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});

describe("the reservations a human must settle", () => {
  test("a hold is said once per appearance, and again only when the reason changes", async () => {
    const w = world();
    try {
      const key = "jira@acme.atlassian.net@10001@Sanmoo/my-tasks";
      w.module.reportHolds([{ key, reason: "has no trustworthy identity (unreadable) — held" }]);
      w.module.reportHolds([{ key, reason: "has no trustworthy identity (unreadable) — held" }]);
      assert.equal(count(w.log, "reserved work"), 1, "a steady reason is said once");

      w.module.reportHolds([{ key, reason: "comes from jira on acme, which the adapter does not serve — held" }]);
      assert.equal(count(w.log, "reserved work"), 2, "a changed reason is a new fact the operator must see");

      w.module.reportHolds([]);
      w.module.reportHolds([{ key, reason: "has no trustworthy identity (unreadable) — held" }]);
      assert.equal(count(w.log, "reserved work"), 3, "a reservation that comes back is a new appearance");
      assert.equal(w.notices.length, 0, "a held reservation asks the operator in the log, not by a notice");
    } finally {
      rmSync(w.workspace, { recursive: true, force: true });
    }
  });
});
