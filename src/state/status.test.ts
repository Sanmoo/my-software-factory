import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, DEFAULT_RECOVERY_BUDGET, type Config, DEFAULT_LIVENESS_POLICY} from "../config.js";
import { DESFECHO_FILENAME } from "./outcome.js";
import { writeRepairCycle } from "../pool/repair.js";
import { consumeRecovery, recordFailure } from "../pool/recovery.js";
import { deriveStatus, type Liveness, type StatusView } from "./status.js";
import { renderStatus } from "./status-render.js";
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

/** The known liveness of a view: the tests that assert the states never expect unknown. */
function known(view: StatusView): Extract<Liveness, { state: "known" }> {
  if (view.liveness.state !== "known") assert.fail("the probe answered — liveness is known");
  return view.liveness;
}

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
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
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
    assert.deepEqual(
      known(view),
      { state: "known", running: [], duplicates: [], orphaned: [] },
      "no container listed: no live worker",
    );
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
    assert.deepEqual(view.registry.attemptsWithoutOwnOutcome, [
      { key: `${REPO}#4`, attempt: 1, recordedAttempt: null },
    ]);
    assert.deepEqual(
      known(view).orphaned,
      [{ key: `${REPO}#4`, attempt: 1, recordedAttempt: null }],
      "no outcome and no live worker: orphaned",
    );
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
      fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 }),
    );

    assert.deepEqual(known(view).running, [
      { key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000, attempt: 2 },
    ]);
    assert.deepEqual(known(view).orphaned, [], "a live worker is never orphaned");
    const text = renderStatus(view);
    assert.match(
      text,
      new RegExp(`running.*\\n\\s+${REPO}#4 \\(13m, attempt 2, container aaaa00000004\\)`),
    );
  });

  test("two containers of one work show as two workers and a duplicate diagnosis — never hidden by the work", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(4, 1);

    const view = await deriveStatus(
      tracker,
      makeConfig(),
      layout,
      fakeProbe(
        { key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 },
        { key: `${REPO}#4`, containerId: "bbbb00000004", ageMs: 2 * 60_000 },
      ),
    );

    const knownView = known(view);
    assert.deepEqual(knownView.duplicates, [{ key: `${REPO}#4`, containers: 2 }], "the multiplicity is a fact");
    assert.deepEqual(knownView.running.map((worker) => worker.containerId), ["aaaa00000004", "bbbb00000004"]);
    assert.deepEqual(knownView.orphaned, [], "a work with two live workers is not orphaned");
    const text = renderStatus(view);
    assert.match(text, /duplicate workers \(more than one container for the same work — a human decision is needed\): 1/);
    assert.match(text, new RegExp(`${REPO}#4 — 2 containers carry this work`), "the human sees the count");
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
      fakeProbe({ key: `${REPO}#90`, containerId: "bbbb00000090", ageMs: 2 * 60_000 }),
    );

    assert.deepEqual(known(view).running.map((worker) => worker.key), [`${REPO}#90`]);
    assert.deepEqual(view.registry.lastOutcome.map((e) => e.key), [`${REPO}#90`]);
    assert.deepEqual(known(view).orphaned, []);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`running[\\s\\S]*${REPO}#90 \\(2m, attempt 1, container bbbb00000090\\)[\\s\\S]*last outcome[\\s\\S]*${REPO}#90 = pr-open \\(attempt 1\\)`));
  });

  test("a live worker whose work dir is gone shows no attempt number — the registry never invents one", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(
      tracker,
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#77`, containerId: "cccc00000077", ageMs: 5 * 60_000 }),
    );

    assert.deepEqual(known(view).running, [
      { key: `${REPO}#77`, containerId: "cccc00000077", ageMs: 5 * 60_000, attempt: null },
    ]);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`${REPO}#77 \\(5m, container cccc00000077\\)`));
    assert.doesNotMatch(text, /attempt 0/);
  });

  test("without Docker the status degrades: liveness unknown, the rest of the answers intact", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    mkdirSync(join(layout.archive, `${REPO}#3-2026-02-01`), { recursive: true });

    const unreachable: LivenessProbe = () => Promise.reject(new Error("docker: command not found"));
    const view = await deriveStatus(tracker, makeConfig(), layout, unreachable);

    assert.deepEqual(
      view.liveness,
      { state: "unknown" },
      "unknown liveness is not a claim of zero workers, and never labels a work orphaned",
    );
    const text = renderStatus(view);
    assert.match(text, /running[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(text, /orphaned[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(
      text,
      /interrupted attempts without their own outcome \(Running or Orphaned — only Docker can tell\): 1\n\s+Sanmoo\/my-tasks#4 \(attempt 1 was interrupted — no outcome record on disk\)/,
      "the registry-only view is still complete — the works are named, just not classified",
    );
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
      fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 }),
    );

    assert.equal(
      renderStatus(view),
      [
        "msf status (derived on demand — the factory may be stopped)",
        "running (worker alive): 1",
        `  ${REPO}#4 (13m, attempt 1, container aaaa00000004)`,
        "duplicate workers (more than one container for the same work — a human decision is needed): none",
        "orphaned (attempt interrupted — no outcome record of its own, no worker alive): 1",
        `  ${REPO}#5 (attempt 1 was interrupted — no outcome record on disk)`,
        "reserved without attempt (the claim landed, no attempt evidence on disk): 1",
        `  ${REPO}#1`,
        "recovery (the last stop: an interruption absorbed by its budget, or a failure that consumed the attempt): none",
        "repair (unpublished attempts, local work, pending reconciliation): none",
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

  test("a fallen attempt is named even when an older outcome record sits on disk (issue 112)", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const dir = seedAttempt(20, 1, 2);
    writeFileSync(
      join(dir, DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);

    // The record is attempt 1's history: attempt 2 is the current, fallen one.
    assert.deepEqual(known(view).orphaned, [
      { key: `${REPO}#20`, attempt: 2, recordedAttempt: 1 },
    ]);
    assert.deepEqual(view.registry.lastOutcome.map((entry) => entry.record.attempt), [1]);
    const text = renderStatus(view);
    assert.match(text, /#20 \(attempt 2 was interrupted — the record on disk is attempt 1's — history, not this attempt's\)/);
    assert.match(text, /last outcome: 1[\s\S]*#20 = pr-open \(attempt 1\)/);
    assert.doesNotMatch(text, /attempt 2 was interrupted[^\n]*pr-open/, "history is never presented as the current result");
  });

  test("the repair section exposes the unpublished attempt, its local work and the pending reconciliation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const dir = seedAttempt(21, 1, 2);
    await writeRepairCycle(dir, {
      usedRounds: 1,
      lastEvidence: `${REPO}#21|abc123|conflicts|`,
      consecutiveFalls: 1,
      attempt: {
        evidence: `${REPO}#21|abc123|conflicts|`,
        attempt: 2,
        observedHeadSha: "abc123",
        remoteHeadSha: null,
        publication: "pending",
        localWork: {
          headSha: "def456789012",
          commits: 2,
          uncommitted: true,
          operationInProgress: "rebase",
        },
      },
    });

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(text, /repair \(unpublished attempts, local work, pending reconciliation\): 1/);
    assert.match(
      text,
      /#21 \(rounds 1\/2; falls 1\/2; attempt 2: publication not verified yet \(reconciliation pending\); local work: 2 commits on the branch, HEAD def456789012, uncommitted changes, a rebase in progress; evidence: reservation trabalhos\/Sanmoo\/my-tasks#21\/ present, event log trabalhos\/Sanmoo\/my-tasks#21\/log-2\.jsonl present, sandcastle log trabalhos\/Sanmoo\/my-tasks#21\/sessao\/sandcastle-2\.log absent\)/,
      "the diagnosis names the attempt's own evidence paths, present or absent (story 32)",
    );
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
  });

  test("the repair evidence reports an unverifiable location as such, never as absent", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const dir = seedAttempt(23, 1, 2);
    // A file where the attempt's session dir should be: the probe cannot look
    // inside it (ENOTDIR is absence; a permission error is "could not be verified").
    writeFileSync(join(dir, "sessao"), "not a dir", "utf8");
    await writeRepairCycle(dir, {
      usedRounds: 1,
      lastEvidence: `${REPO}#23|abc123|conflicts|`,
      consecutiveFalls: 0,
      attempt: {
        evidence: `${REPO}#23|abc123|conflicts|`,
        attempt: 2,
        observedHeadSha: "abc123",
        remoteHeadSha: null,
        publication: "pending",
        localWork: null,
      },
    });

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /event log trabalhos\/Sanmoo\/my-tasks#23\/log-2\.jsonl present/);
    assert.match(text, /sandcastle log trabalhos\/Sanmoo\/my-tasks#23\/sessao\/sandcastle-2\.log absent/);
  });

  test("the recovery section says whether the last stop was an interruption or a failure (issue 123)", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    // #30: interrupted twice — two recoveries consumed, the attempt kept.
    const interrupted = seedAttempt(30, 2);
    const now = () => new Date("2026-01-01T00:00:00Z");
    await consumeRecovery(interrupted, DEFAULT_RECOVERY_BUDGET, 2, now);
    await consumeRecovery(interrupted, DEFAULT_RECOVERY_BUDGET, 2, now);
    // #31: a written failure — the attempt was consumed.
    const failed = seedAttempt(31, 1);
    await recordFailure(failed, 1, "clean-without-pr", now);

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(
      text,
      /recovery \(the last stop: an interruption absorbed by its budget, or a failure that consumed the attempt\): 2/,
    );
    assert.match(
      text,
      /#30 \(attempt 2: last stop was an interruption — no attempt consumed; 2\/3 recoveries \(waits 1s\/4s\/16s\)\)/,
      "the interruption names the consumed recoveries and the configured backoff",
    );
    assert.match(
      text,
      /#31 \(attempt 1: last stop was a failure \(clean-without-pr\) — the attempt was consumed\)/,
    );
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
  });

  test("a legacy work dir without a recovery ledger shows no recovery line — nothing is invented", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const dir = seedAttempt(32, 1);
    writeFileSync(
      join(dir, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(view.registry.recovery, []);
    assert.match(
      renderStatus(view),
      /recovery \(the last stop: an interruption absorbed by its budget, or a failure that consumed the attempt\): none/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, DESFECHO_FILENAME), "utf8")).class,
      "clean-without-pr",
      "the legacy record is untouched",
    );
  });

  test("a legacy reparo.json is read as it stands: rounds counted, no attempt or fall invented", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const dir = seedAttempt(22, 1);
    writeFileSync(
      join(dir, "reparo.json"),
      JSON.stringify({ usedRounds: 1, lastEvidence: `${REPO}#22|abc123|conflicts|` }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /#22 \(rounds 1\/2; falls 0\/2\)/, "the legacy cycle is shown without invented facts");
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

  test("status writes nothing: the workspace tree is unchanged before and after the derivation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    const before = readdirSync(layout.root, { recursive: true });

    await deriveStatus(tracker, makeConfig(), layout, fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 60_000 }));

    assert.deepEqual(readdirSync(layout.root, { recursive: true }), before);
  });

  test("an empty workspace and empty pool render a clean, never-crashing status", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(tracker, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /pool \(eligible\): none/);
    assert.match(text, /running \(worker alive\): none/);
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
