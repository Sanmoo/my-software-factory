import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { archiveDoneWork, parseWorkKey, readLaunchFacts, scanRegistry, scanReservedWorks } from "./registry.js";

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

  test("reserved-without-attempt = bare dir; attempts without outcome = dir with attempt evidence; last outcome = with desfecho; archivo = dones", async () => {
    // Reserved without attempt: the claim landed, the worker has not.
    const bare = join(layout.works, "Sanmoo/a#3");
    mkdirSync(bare, { recursive: true });

    // An attempt started (evidence on disk), no outcome record yet.
    const unconcluded = join(layout.works, "Sanmoo/d#4");
    mkdirSync(unconcluded, { recursive: true });
    writeFileSync(join(unconcluded, "log-1.jsonl"), "{}\n", "utf8");

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

    assert.deepEqual(view.reservedWithoutAttempt, ["Sanmoo/a#3"]);
    assert.deepEqual(view.attemptsWithoutOutcome, [
      { key: "Sanmoo/d#4", attempt: 1, recordedAttempt: null },
    ]);
    assert.equal(view.lastOutcome.length, 1);
    assert.equal(view.lastOutcome[0]?.key, "Sanmoo/b#7");
    assert.equal(view.lastOutcome[0]?.record.class, "pr-open");
    assert.equal(view.lastOutcome[0]?.workDir, ended);
    assert.deepEqual(view.archived, [done]);
  });

  test("a workspace that was never created (status before any run) reads empty", async () => {
    const view = await scanRegistry(join("/nowhere/nonexistent-msf-ws"));
    assert.deepEqual(view.attemptsWithoutOutcome, []);
    assert.deepEqual(view.reservedWithoutAttempt, []);
    assert.deepEqual(view.lastOutcome, []);
    assert.deepEqual(view.archived, []);
  });

  test("a corrupt record does not lie about status: it is an abrupt fall (last outcome shows it absent... reserved without attempt)", async () => {
    const corrupt = join(layout.works, "Sanmoo/c#9");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, DESFECHO_FILENAME), "{not json", "utf8");

    const view = await scanRegistry(layout);
    // The invalid record is treated as absent — the abrupt fall class — and
    // with no attempt evidence the dir is a bare reservation, never a fake outcome.
    assert.deepEqual(view.reservedWithoutAttempt, ["Sanmoo/c#9"]);
    assert.deepEqual(view.attemptsWithoutOutcome, []);
    assert.deepEqual(view.lastOutcome, []);
  });
});

describe("registry — the derivation's reserved-works scan and the done archive (ticket 14)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-registry14-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("scanReservedWorks: every trabalhos/<repo>#<n> dir becomes a ref — the factory's memory of what it launched", async () => {
    mkdirSync(join(layout.works, "Sanmoo", "a#1"), { recursive: true });
    mkdirSync(join(layout.works, "Sanmoo", "my-tasks#12"), { recursive: true });
    // A dir that is not a work (the repo's nested path itself) is not a work.
    mkdirSync(join(layout.works, "Sanmoo", "b"), { recursive: true });

    const reserved = await scanReservedWorks(layout);

    assert.deepEqual(
      reserved.map((r) => r.ref).sort((x, y) => x.repo.localeCompare(y.repo) || x.number - y.number),
      [
        { repo: "Sanmoo/a", number: 1 },
        { repo: "Sanmoo/my-tasks", number: 12 },
      ],
    );
    for (const entry of reserved) {
      assert.ok(existsSync(entry.dir), "the dir is handed over — launches and archiving need it");
    }
  });

  test("scanReservedWorks: a workspace never created reads empty", async () => {
    assert.deepEqual(await scanReservedWorks(join("/nowhere/nonexistent-msf-ws")), []);
  });

  test("parseWorkKey: the dir name is <repo>#<n> with the repo keeping its slash", () => {
    assert.deepEqual(parseWorkKey("Sanmoo/my-tasks#12"), { repo: "Sanmoo/my-tasks", number: 12 });
    assert.equal(parseWorkKey("no-number"), null);
  });

  test("archiveDoneWork MOVES the work dir into arquivo/<repo>#<n>-<date> — nothing is deleted", async () => {
    const src = join(layout.works, "Sanmoo", "a#1");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, DESFECHO_FILENAME), JSON.stringify({ class: "pr-open", attempt: 1 }), "utf8");
    writeFileSync(join(src, "log-1.jsonl"), "{}\n", "utf8");

    const dest = await archiveDoneWork(layout, { repo: "Sanmoo/a", number: 1 });
    assert.ok(dest, "the archive path is returned");

    assert.ok(!existsSync(src), "the work dir left trabalhos");
    assert.ok(existsSync(dest), "the artifacts live in the archive now");
    assert.match(dest, /arquivo\/Sanmoo\/a#1-\d{4}-\d{2}-\d{2}$/, "the archive name carries the done date");
    assert.ok(existsSync(join(dest, DESFECHO_FILENAME)), "the desfecho survived the move");
    assert.ok(existsSync(join(dest, "log-1.jsonl")), "the logs survived the move");
    const view = await scanRegistry(layout);
    assert.deepEqual(view.archived, [dest]);
  });

  test("archiveDoneWork of a work with no dir is a no-op (nothing to archive)", async () => {
    const dest = await archiveDoneWork(layout, { repo: "Sanmoo/a", number: 42 });
    assert.equal(dest, null);
  });

  test("archiveDoneWork twice on the same day never collides (the second gets a fresh name)", async () => {
    const src = join(layout.works, "Sanmoo", "a#2");
    mkdirSync(src, { recursive: true });
    const first = await archiveDoneWork(layout, { repo: "Sanmoo/a", number: 2 });
    assert.ok(first);
    mkdirSync(src, { recursive: true }); // a second run's artifacts for the same work
    const second = await archiveDoneWork(layout, { repo: "Sanmoo/a", number: 2 });
    assert.ok(second, "the second archive also happens");
    assert.notEqual(first, second, "a unique dest, never the same dir");
    const view = await scanRegistry(layout);
    assert.equal(view.archived.length, 2, "both archive entries exist");
  });
});
