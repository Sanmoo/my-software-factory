import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { DESFECHO_FILENAME } from "./outcome.js";
import { deriveStatus, renderStatus } from "./status.js";
import type { LivenessProbe, LiveWorker } from "./liveness.js";

/**
 * `msf status` (ticket 07 Q7, issue 102): derivation on demand through the
 * port — works with the factory stopped — plus the local registry scan and the
 * read-only liveness probe. Running and Orphaned come from Docker + disk
 * together; the overlap (outcome written, worker still alive) is shown as two
 * truths, never as a fused state.
 */

const REPO = "Sanmoo/my-tasks";

/** No live worker: the factory is stopped — the default every test starts from. */
const NO_WORKERS: LivenessProbe = () => Promise.resolve([]);

const fakeProbe =
  (...workers: LiveWorker[]): LivenessProbe =>
  () =>
    Promise.resolve(workers);

describe("status — derivation on demand + local registry scan", () => {
  let dir: string;
  let layout: WorkspaceLayout;

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

  /** A work dir carrying attempt evidence: the attempt's log, no outcome record. */
  function seedAttempt(number: number, ...attempts: number[]): string {
    const target = workDir(layout, REPO, number);
    mkdirSync(target, { recursive: true });
    for (const attempt of attempts) writeFileSync(join(target, `log-${attempt}.jsonl`), "{}\n", "utf8");
    return target;
  }

  test("eligible works derive on demand through the port — the factory being stopped is the default state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.pool.map((e) => e.ref.number), [1]);
    assert.deepEqual(view.running, [], "no container listed: no live worker");
    assert.deepEqual(view.orphaned, []);
  });

  test("the registry view: reserved-without-attempt / attempts without an outcome / last outcome / archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });

    // Reserved without attempt: the claim landed, the worker has not.
    mkdirSync(workDir(layout, REPO, 1), { recursive: true });
    // An attempt on disk, no outcome record — liveness decides running vs orphaned.
    seedAttempt(4, 1);
    // Last outcome: a concluded attempt.
    mkdirSync(workDir(layout, REPO, 2), { recursive: true });
    writeFileSync(
      join(workDir(layout, REPO, 2), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.registry.reservedWithoutAttempt, [`${REPO}#1`], "the bare reservation is not an orphan");
    assert.deepEqual(view.registry.attemptsWithoutOutcome, [`${REPO}#4`]);
    assert.deepEqual(view.orphaned, [`${REPO}#4`], "no outcome and no live worker: orphaned");
    assert.equal(view.registry.lastOutcome[0]?.key, `${REPO}#2`);
    assert.equal(view.registry.lastOutcome[0]?.record.class, "pr-open");
  });

  test("a live worker makes its work Running — the registry alone cannot say so — with its age and attempt", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(4, 1, 2);

    const view = await deriveStatus(
      tracker,
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#4`, ageMs: 13 * 60_000 }),
    );

    assert.deepEqual(view.running, [{ key: `${REPO}#4`, ageMs: 13 * 60_000, attempt: 2 }]);
    assert.deepEqual(view.orphaned, [], "a live worker is never orphaned");
    const text = renderStatus(view);
    assert.match(text, new RegExp(`running.*\\n\\s+${REPO}#4 \\(13m, attempt 2\\)`));
  });

  test("a work with an outcome written and a live worker shows in running AND last outcome — the overlap, not a fused state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(90, 1);
    writeFileSync(
      join(workDir(layout, REPO, 90), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(
      tracker,
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#90`, ageMs: 2 * 60_000 }),
    );

    assert.deepEqual(view.running?.map((w) => w.key), [`${REPO}#90`]);
    assert.deepEqual(view.registry.lastOutcome.map((e) => e.key), [`${REPO}#90`]);
    assert.deepEqual(view.orphaned, []);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`running[\\s\\S]*${REPO}#90 \\(2m, attempt 1\\)[\\s\\S]*last outcome[\\s\\S]*${REPO}#90 = pr-open \\(attempt 1\\)`));
  });

  test("without Docker the status degrades: liveness unknown, the rest of the answers intact", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    mkdirSync(join(layout.archive, `${REPO}#3-2026-02-01`), { recursive: true });

    const unreachable: LivenessProbe = () => Promise.reject(new Error("docker: command not found"));
    const view = await deriveStatus(tracker, makeConfig(), layout, unreachable);

    assert.equal(view.running, null, "unknown liveness is not a claim of zero workers");
    assert.deepEqual(view.orphaned, [], "an unreachable probe can never label a work orphaned");
    const text = renderStatus(view);
    assert.match(text, /running[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(text, /orphaned[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(text, /pool \(eligible\): 1/);
    assert.match(text, new RegExp(`archived \\(dones\\): 1[\\s\\S]*${REPO}#3-2026-02-01`));
  });

  test("renderStatus answers in the order a human asks: running → orphaned → last outcome → pool → archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 1), { recursive: true }); // reserved, no attempt yet
    seedAttempt(4, 1); // live below
    seedAttempt(5, 1); // orphaned
    const ended = workDir(layout, REPO, 2);
    mkdirSync(ended, { recursive: true });
    writeFileSync(
      join(ended, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );
    mkdirSync(join(layout.archive, `${REPO}#3-2026-02-01`), { recursive: true });

    const view = await deriveStatus(
      tracker,
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#4`, ageMs: 13 * 60_000 }),
    );

    assert.equal(
      renderStatus(view),
      [
        "msf status (derived on demand — the factory may be stopped)",
        "running (a live worker carries the work): 1",
        `  ${REPO}#4 (13m, attempt 1)`,
        "orphaned (attempt ended with no outcome record and no worker alive — the next sweep reconciles): 1",
        `  ${REPO}#5`,
        "reserved without attempt (the claim landed, no attempt evidence on disk): 1",
        `  ${REPO}#1`,
        "last outcome: 1",
        `  ${REPO}#2 = clean-without-pr (attempt 1)`,
        "pool (eligible): 1",
        `  ${REPO}#1`,
        "archived (dones): 1",
        `  ${join(layout.archive, `${REPO}#3-2026-02-01`)}`,
        "reconciliation: none",
      ].join("\n"),
    );
  });

  test("the archived and the pool list one entry per line, capped at 10 with an omission marker", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    for (let number = 1; number <= 12; number += 1) {
      seedIssue(tracker, { repo: REPO, number, labels: [DEFAULT_LABELS.ready] });
      mkdirSync(join(layout.archive, `${REPO}#${number}-2026-02-01`), { recursive: true });
    }
    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);

    const capped = renderStatus(view);
    const archivedLines = capped.split("\n").filter((line) => /^\s+\S+#\d+-2026-02-01$/.test(line));
    assert.equal(archivedLines.length, 10, "ten entries, then the marker");
    assert.match(capped, /archived \(dones\): 12[\s\S]*… and 2 more/);
    assert.match(capped, /pool \(eligible\): 12[\s\S]*… and 2 more/);
    assert.doesNotMatch(capped, /… and 3 more/);
  });

  test("--all lifts every cap — the complete lists on demand", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    for (let number = 1; number <= 12; number += 1) {
      mkdirSync(join(layout.archive, `${REPO}#${number}-2026-02-01`), { recursive: true });
    }
    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);

    const all = renderStatus(view, { all: true });
    const archivedLines = all.split("\n").filter((line) => /^\s+\S+#\d+-2026-02-01$/.test(line));
    assert.equal(archivedLines.length, 12);
    assert.doesNotMatch(all, /more$/);
  });

  test("status writes nothing: the workspace is byte-identical before and after the derivation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    const before = readdirSync(layout.root, { recursive: true });

    await deriveStatus(tracker, makeConfig(), layout, fakeProbe({ key: `${REPO}#4`, ageMs: 60_000 }));

    assert.deepEqual(readdirSync(layout.root, { recursive: true }), before);
  });

  test("an empty workspace and empty pool render a clean, never-crashing status", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /0 eligible|pool \(eligible\): none/);
    assert.match(text, /running \(a live worker carries the work\): none/);
    assert.match(text, /reconciliation: none/);
  });

  test("status reports an unbacked claim: the mark without a reservation, the command and the caveat", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    await tracker.claim({ repo: REPO, number: 10 }, "bot-do-samuca", DEFAULT_LABELS.ready);

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
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

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
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

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.unbackedClaims, []);
    assert.deepEqual(view.unmarkedReservations, []);
    const text = renderStatus(view);
    assert.match(text, /reconciliation: none/);
  });
});
