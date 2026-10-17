import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { readLaunchFacts, scanRegistry } from "./registry.js";

/**
 * The registry (pool/registry.ts, ticket 13): reads back the per-work
 * artifacts the runtime wrote on real disk — desfecho.json (absent = abrupt
 * fall), log-<n>.jsonl, sessao/ — and derives the launch facts (attempt
 * number + consecutiveness of falls) and the status view.
 */

describe("registry — reading the artifacts back (launch facts)", () => {
  let dir: string;
  let workDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-registry-"));
    workDir = join(ensureWorkspace(join(dir, "ws")).works, "Sanmoo/a#3");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a work never launched: attempt 1, no prior fall", async () => {
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 1, previousFall: false });
  });

  test("the desfecho of the previous attempt numbers the next one and tells consecutiveness", async () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 2, previousFall: true });
  });

  test("a previous outcome that was not a fall (PR open) resets the consecutiveness but keeps counting attempts", async () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 2 }),
      "utf8",
    );
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 3, previousFall: false });
  });

  test("a previous attempt that wrote logs but no desfecho: it died abruptly — attempt counts, previous fall is true", async () => {
    mkdirSync(join(workDir, "sessao"), { recursive: true });
    writeFileSync(
      join(workDir, "log-1.jsonl"),
      '{"event":"session-start","attempt":1}\n',
      "utf8",
    );
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 2, previousFall: true });
  });

  test("an empty work dir (no attempt evidence): attempt 1, no prior fall", async () => {
    mkdirSync(workDir, { recursive: true });
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 1, previousFall: false });
  });

  test("the attempt number falls back to the highest log when the record is stale-less", async () => {
    mkdirSync(workDir, { recursive: true });
    for (const n of [1, 2, 3]) {
      writeFileSync(join(workDir, `log-${n}.jsonl`), "{}\n", "utf8");
    }
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 4, previousFall: true });
  });
});

describe("registry — the status view (worked on by msf status, factory stopped)", () => {
  let layout: WorkspaceLayout;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "msf-registry-status-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  test("in flight = work dir without desfecho; last outcome = with desfecho; archivo = dones", async () => {
    // In flight: an attempt started, no outcome record yet.
    const flying = join(layout.works, "Sanmoo/a#3");
    mkdirSync(flying, { recursive: true });

    // Last outcome: a concluded attempt, record on disk.
    const ended = join(layout.works, "Sanmoo/b#7");
    mkdirSync(ended, { recursive: true });
    writeFileSync(
      join(ended, DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    // Done (archived on done — a later ticket's move; the registry reads it).
    const done = join(layout.archive, "Sanmoo/a#3-2026-02-01");
    mkdirSync(done, { recursive: true });

    const view = await scanRegistry(layout);

    assert.deepEqual(view.inFlight, ["Sanmoo/a#3"]);
    assert.equal(view.lastOutcome.length, 1);
    assert.equal(view.lastOutcome[0]?.key, "Sanmoo/b#7");
    assert.equal(view.lastOutcome[0]?.record.class, "pr-open");
    assert.equal(view.lastOutcome[0]?.workDir, ended);
    assert.deepEqual(view.archived, [done]);
  });

  test("a workspace that was never created (status before any run) reads empty", async () => {
    const view = await scanRegistry(join("/nowhere/nonexistent-msf-ws"));
    assert.deepEqual(view.inFlight, []);
    assert.deepEqual(view.lastOutcome, []);
    assert.deepEqual(view.archived, []);
  });

  test("a corrupt record does not lie about status: it is an abrupt fall (last outcome shows it absent... in flight)", async () => {
    const corrupt = join(layout.works, "Sanmoo/c#9");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, DESFECHO_FILENAME), "{not json", "utf8");

    const view = await scanRegistry(layout);
    // The invalid record is treated as absent — the abrupt fall class — the
    // status shows the work still in flight rather than a fake outcome.
    assert.deepEqual(view.inFlight, ["Sanmoo/c#9"]);
    assert.deepEqual(view.lastOutcome, []);
  });
});
