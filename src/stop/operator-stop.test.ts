import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_RECOVERY_BUDGET } from "../config.js";
import { ensureWorkspace, workDir } from "../layout.js";
import { consumeRecovery, readRecoveryLedger } from "../pool/recovery.js";
import { githubRepository, githubTicket, workIdentity } from "../tracker/identity.js";
import { workKeyOf } from "../pool/work-key.js";
import type { LiveWorker } from "../state/liveness.js";
import {
  beginOperatorStop,
  reconcileUnconfirmedStops,
  stopConfirmed,
  type StopAdmission,
  type StopDeps,
} from "./operator-stop.js";

/**
 * The operator's stop tested at ITS seam (issue #186, stories 4/5): the module
 * is fed the launches, a fake probe and a fake runtime, so escalation,
 * confirmation and the recovery refund are exercised directly — no factory run,
 * no routed worker.
 */

const WORK = workIdentity(githubTicket("Sanmoo/stop-seam", 7), githubRepository("Sanmoo/stop-seam"));
const KEY = workKeyOf(WORK);

/** A worker of {@link KEY} as Docker would list it. */
function liveWorker(): LiveWorker {
  return { key: KEY, containerId: "c0ffee", ageMs: 1_000 };
}

interface Harness {
  dir: string;
  root: string;
  admissions: StopAdmission[];
  requested: string[];
  forced: string[];
  /** What the ledger said when the runtime was asked to stop the worker. */
  evidenceAtRequest: Array<string | null>;
  deps: StopDeps;
  cleanup: () => void;
}

/**
 * A workspace with one reserved work. `probe` is a function of the call count,
 * so a test can model a worker that dies only when it is forced; `force` models
 * the runtime's forced end.
 */
function harness(options: {
  probe: (call: number) => LiveWorker[];
  force?: (key: string) => Promise<void>;
  settled?: () => Promise<void>;
  escalated?: () => { readonly promise: Promise<void>; dispose: () => void };
  cooperativeMs?: number;
}): Harness {
  const root = mkdtempSync(join(tmpdir(), "msf-stop-seam-"));
  const workspace = ensureWorkspace(root);
  const dir = workDir(workspace, "Sanmoo/stop-seam", 7);
  const requested: string[] = [];
  const forced: string[] = [];
  const evidenceAtRequest: Array<string | null> = [];
  let calls = 0;
  const admission: StopAdmission = {
    work: WORK,
    dir,
    attempt: 2,
    launched: true,
    recoveryIndex: null,
  };
  const deps: StopDeps = {
    workspace,
    runtime: {
      requestStop: () => {
        requested.push(KEY);
        // Read synchronously, inside the request: the evidence of the stop must
        // ALREADY be on disk when the worker is asked to end.
        evidenceAtRequest.push(
          JSON.parse(readFileSync(join(dir, "recuperacao.json"), "utf8")).lastStop?.kind ?? null,
        );
      },
      forceStop: async (work) => {
        forced.push(workKeyOf(work));
        await options.force?.(workKeyOf(work));
      },
    },
    probe: async () => {
      calls += 1;
      return options.probe(calls);
    },
    survivors: () => [],
    isCarried: () => false,
    launchesSettled: options.settled ?? (() => Promise.resolve()),
    escalation:
      options.escalated ?? (() => ({ promise: new Promise<void>(() => {}), dispose: () => {} })),
    cooperativeMs: options.cooperativeMs ?? 0,
    log: () => {},
  };
  return {
    dir,
    root,
    admissions: [admission],
    requested,
    forced,
    evidenceAtRequest,
    deps,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the evidence of the stop is persisted before the worker is asked, and the recovery it cancels is returned", async () => {
  const h = harness({ probe: () => [] });
  try {
    const grant = await consumeRecovery(h.dir, DEFAULT_RECOVERY_BUDGET, 2);
    assert.equal(grant.decision, "recover");
    const admission = h.admissions[0]!;
    admission.launched = false;
    admission.recoveryIndex = grant.decision === "recover" ? grant.consumed - 1 : null;

    const report = await beginOperatorStop(h.admissions, h.deps);

    assert.deepEqual(h.requested, [KEY], "the cooperative request reaches the in-flight launch");
    assert.deepEqual(h.evidenceAtRequest, ["stop-requested"], "the evidence lands BEFORE the request");
    const ledger = await readRecoveryLedger(h.dir);
    assert.equal(ledger.consumed, 0, "the cancelled admission's recovery is returned");
    assert.equal(ledger.events.length, 0);
    assert.deepEqual(ledger.lastStop?.kind, "stop-requested");
    assert.deepEqual(report, { forced: [], unconfirmed: [], unreadBecause: null });
    assert.equal(stopConfirmed(report), true);
  } finally {
    h.cleanup();
  }
});

test("the second signal ends the cooperative window and forces what remains", async () => {
  let alive = true;
  let escalate: () => void = () => {};
  const escalation = new Promise<void>((resolve) => {
    escalate = resolve;
  });
  const h = harness({
    // The worker is alive until it is forced: the probe only answers empty after.
    probe: () => (alive ? [liveWorker()] : []),
    force: async () => {
      alive = false;
    },
    // The launch never settles on its own: only the escalation can end the window.
    settled: () => new Promise<void>(() => {}),
    escalated: () => ({ promise: escalation, dispose: () => {} }),
    cooperativeMs: 60_000,
  });
  try {
    const stopping = beginOperatorStop(h.admissions, h.deps);
    escalate();
    const report = await stopping;

    assert.deepEqual(h.forced, [KEY], "the forced stop is what ends the surviving worker");
    assert.deepEqual(report.forced, [KEY]);
    assert.equal(report.unconfirmed.length, 0);
    assert.equal(stopConfirmed(report), true);
  } finally {
    h.cleanup();
  }
});

test("a worker that survives the forced stop is persisted unconfirmed, and the sweep holds it by the same reading", async () => {
  const h = harness({
    // Docker always lists the worker: forcing it did not prove it gone.
    probe: () => [liveWorker()],
    force: async () => {},
  });
  try {
    const report = await beginOperatorStop(h.admissions, h.deps);

    assert.deepEqual(report.unconfirmed, [{ key: KEY, because: "a worker of this work is still alive" }]);
    assert.equal(stopConfirmed(report), false);
    const ledger = await readRecoveryLedger(h.dir);
    assert.equal(ledger.lastStop?.kind, "stop-unconfirmed");

    // The sweep reads the SAME verdict: while Docker still lists the worker the
    // work stays held, and nothing is relaunched over it.
    const held = await reconcileUnconfirmedStops({
      works: [{ dir: h.dir, work: WORK }],
      inFlight: new Set(),
      observation: { state: "known", workers: [liveWorker()] },
    });
    assert.deepEqual(held.resumed, []);
    assert.equal(held.held.length, 1);
    assert.equal(held.held[0]!.because, "a worker of this work is still alive");
    assert.equal((await readRecoveryLedger(h.dir)).lastStop?.kind, "stop-unconfirmed");

    // A reliable zero promotes it to the requested stop the resume spends nothing on.
    const resumed = await reconcileUnconfirmedStops({
      works: [{ dir: h.dir, work: WORK }],
      inFlight: new Set(),
      observation: { state: "known", workers: [] },
    });
    assert.deepEqual(resumed.resumed, [{ key: KEY, attempt: 2 }]);
    assert.equal((await readRecoveryLedger(h.dir)).lastStop?.kind, "stop-requested");
  } finally {
    h.cleanup();
  }
});

test("an unreadable probe is uncertainty, never an empty factory", async () => {
  const h = harness({
    probe: () => {
      throw new Error("docker did not answer");
    },
  });
  try {
    const report = await beginOperatorStop(h.admissions, h.deps);

    assert.equal(report.unconfirmed.length, 1, "a known worker is never LOST to an unreadable probe");
    assert.match(report.unconfirmed[0]!.because, /could not be read/);
    assert.match(report.unreadBecause ?? "", /docker did not answer/);
    assert.equal(stopConfirmed(report), false);
  } finally {
    h.cleanup();
  }
});
