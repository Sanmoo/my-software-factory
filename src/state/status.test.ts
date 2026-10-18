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
      repos: [REPO],
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  test("eligible works derive on demand through the port — the factory being stopped is the default state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.deepEqual(view.pool.map((e) => e.ref.number), [1]);
  });

  test("the registry view: in flight (no desfecho) / last outcome (with desfecho) / archived (dones)", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });

    // In flight: an attempt up, no outcome record (orphan if the run is down).
    mkdirSync(workDir(layout, REPO, 1), { recursive: true });
    // Last outcome: a concluded attempt.
    mkdirSync(workDir(layout, REPO, 2), { recursive: true });
    writeFileSync(
      join(workDir(layout, REPO, 2), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(tracker, makeConfig(), layout);
    assert.deepEqual(view.registry.inFlight, [`${REPO}#1`]);
    assert.equal(view.registry.lastOutcome[0]?.key, `${REPO}#2`);
    assert.equal(view.registry.lastOutcome[0]?.record.class, "pr-open");
  });

  test("renderStatus shows the three answers in human order: pool, in flight, last outcome, archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 1), { recursive: true });
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
    assert.match(text, new RegExp(`in flight.*${REPO}#1`));
    assert.match(text, new RegExp(`last outcome.*${REPO}#2.*clean-without-pr`));
    assert.match(text, new RegExp(`archived.*${REPO}#3-2026-02-01`));
  });

  test("an empty workspace and empty pool render a clean, never-crashing status", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(tracker, makeConfig(), layout);
    const text = renderStatus(view);
    assert.match(text, /0 eligible/);
    assert.match(text, /none/);
  });
});
