import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { ensureWorkspace, workDir } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { DESFECHO_FILENAME } from "./outcome.js";
import { deriveStatus, renderStatus } from "./status.js";

/**
 * `msf status` derivation (ticket 07 Q7, wired by ticket 13): derivation on
 * demand through the port — works with the factory stopped — plus the local
 * registry scan. No IPC: the artifacts of ticket 05 are the interface.
 */

const REPO = "Sanmoo/my-tasks";

describe("status — derivation on demand + local registry scan", () => {
  let dir: string;
  let layout: ReturnType<typeof ensureWorkspace>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-status-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  test("eligible works derive on demand through the port — the factory being stopped is the default state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.deepEqual(view.pool.map((e) => e.ref.number), [1]);
  });

  test("the registry view: reserved-without-attempt / in flight (attempt evidence) / last outcome / archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });

    // Reserved without a recorded attempt: the claim landed, the worker has not.
    mkdirSync(workDir(layout, REPO, 1), { recursive: true });
    // In flight: attempt evidence on disk (a log), no outcome record.
    const flying = workDir(layout, REPO, 4);
    mkdirSync(flying, { recursive: true });
    writeFileSync(join(flying, "log-1.jsonl"), "{}\n", "utf8");
    // Last outcome: a concluded attempt.
    mkdirSync(workDir(layout, REPO, 2), { recursive: true });
    writeFileSync(
      join(workDir(layout, REPO, 2), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.deepEqual(view.registry.reservedWithoutAttempt, [`${REPO}#1`], "the bare reservation is not in flight");
    assert.deepEqual(view.registry.inFlight, [`${REPO}#4`], "the recorded attempt is in flight");
    assert.equal(view.registry.lastOutcome[0]?.key, `${REPO}#2`);
    assert.equal(view.registry.lastOutcome[0]?.record.class, "pr-open");
  });

  test("renderStatus shows the answers in human order, distinguishing reserved-without-attempt from in flight", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 1), { recursive: true }); // reserved, no attempt yet
    const flying = workDir(layout, REPO, 4);
    mkdirSync(flying, { recursive: true });
    writeFileSync(join(flying, "log-1.jsonl"), "{}\n", "utf8"); // in flight
    const ended = workDir(layout, REPO, 2);
    mkdirSync(ended, { recursive: true });
    writeFileSync(
      join(ended, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );
    const done = join(layout.archive, `${REPO}#3-2026-02-01`);
    mkdirSync(done, { recursive: true });

    const view = await deriveStatus(tracker, makeConfig(), layout);
    const text = renderStatus(view);

    assert.match(text, /pool.*1 eligible/s);
    assert.match(text, new RegExp(`reserved without recorded attempt.*${REPO}#1`));
    assert.match(text, new RegExp(`in flight.*${REPO}#4`));
    assert.match(text, new RegExp(`last outcome.*${REPO}#2.*clean-without-pr`));
    assert.match(text, new RegExp(`archived.*${REPO}#3-2026-02-01`));
  });

  test("an empty workspace and empty pool render a clean, never-crashing status", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(tracker, makeConfig(), layout);
    const text = renderStatus(view);
    assert.match(text, /0 eligible/);
    assert.match(text, /none/);
    assert.match(text, /reconciliation: none/);
  });

  test("status reports an unbacked claim: the mark without a reservation, the command and the caveat", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    await tracker.claim({ repo: REPO, number: 10 }, "bot-do-samuca", DEFAULT_LABELS.ready);

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.equal(view.unbackedClaims.length, 1);
    assert.match(view.unbackedClaims[0]!.command, /gh issue edit 10 --repo Sanmoo\/my-tasks/);

    const text = renderStatus(view);
    assert.match(text, /unbacked claim: Sanmoo\/my-tasks#10/);
    assert.match(text, /another factory or workspace may hold this claim/);
    assert.match(text, /gh issue edit 10/);
  });

  test("status reports an unmarked reservation as a fact only — the dir is there, the tracker is silent", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 11, labels: [] });
    mkdirSync(workDir(layout, REPO, 11), { recursive: true });

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.equal(view.unmarkedReservations.length, 1);

    const text = renderStatus(view);
    assert.match(text, /unmarked reservation: Sanmoo\/my-tasks#11/);
    assert.match(text, /no factory mark/);
    assert.doesNotMatch(text, /gh issue edit 11/);
  });

  test("a claimed issue with a reservation and a released reservation are never reported", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 12, labels: [DEFAULT_LABELS.claimed] });
    mkdirSync(workDir(layout, REPO, 12), { recursive: true });
    seedIssue(tracker, { repo: REPO, number: 13, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 13), { recursive: true });

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.deepEqual(view.unbackedClaims, []);
    assert.deepEqual(view.unmarkedReservations, []);
    const text = renderStatus(view);
    assert.match(text, /reconciliation: none/);
  });
});
