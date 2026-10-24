import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { archiveDoneWorkFor, parseWorkKey, readLaunchFacts, scanRegistry } from "./registry.js";
import { readPause, writePause } from "../runtime/continuity-artifacts.js";
import { githubRepository, githubTicket, type WorkIdentity } from "../tracker/identity.js";
import { scanReservations } from "./reservation.js";

/**
 * The registry (pool/registry.ts): reads back the
 * per-work artifacts the runtime wrote on real disk — desfecho.json (absent =
 * an interruption, never a failure), log-<n>.jsonl, sessao/ and
 * recuperacao.json — and derives the launch facts (attempt number + the
 * recorded-failure consecutiveness) and the status view.
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

  test("a previous attempt that wrote logs but no desfecho was INTERRUPTED: a new claim numbers the next attempt, but it is not a fall", async () => {
    mkdirSync(join(workDir, "sessao"), { recursive: true });
    writeFileSync(
      join(workDir, "log-1.jsonl"),
      '{"event":"session-start","attempt":1}\n',
      "utf8",
    );
    // A claim path means the operator explicitly released the work: the next
    // claim consumes a new attempt, as today. The interruption itself never
    // feeds the fall ruler.
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 2, previousFall: false });
  });

  test("a recovery continues the interrupted attempt: the SAME number, never a new one", async () => {
    mkdirSync(join(workDir, "sessao"), { recursive: true });
    writeFileSync(join(workDir, "log-1.jsonl"), "{}\n", "utf8");
    writeFileSync(join(workDir, "log-2.jsonl"), "{}\n", "utf8");
    writeFileSync(
      join(workDir, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );

    const read = await readLaunchFacts(workDir, 2);
    assert.deepEqual(
      read,
      { attempt: 2, previousFall: true },
      "attempt 2 continues; the recorded failure of attempt 1 stays the only fall fact",
    );
  });

  test("a legacy work dir is read as it stands: the old record is neither rewritten nor reinterpreted", async () => {
    mkdirSync(workDir, { recursive: true });
    const legacy = { class: "clean-without-pr", attempt: 1 };
    writeFileSync(join(workDir, DESFECHO_FILENAME), JSON.stringify(legacy), "utf8");
    writeFileSync(join(workDir, "log-2.jsonl"), "{}\n", "utf8");

    const read = await readLaunchFacts(workDir);

    assert.deepEqual(read, { attempt: 3, previousFall: true }, "the old failure still numbers the next attempt");
    assert.deepEqual(
      JSON.parse(readFileSync(join(workDir, DESFECHO_FILENAME), "utf8")),
      legacy,
      "reading the history never rewrites the record",
    );
  });

  test("an empty work dir (no attempt evidence): attempt 1, no prior fall", async () => {
    mkdirSync(workDir, { recursive: true });
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 1, previousFall: false });
  });

  test("the attempt number falls back to the highest log when there is no record — and it is not a fall", async () => {
    mkdirSync(workDir, { recursive: true });
    for (const n of [1, 2, 3]) {
      writeFileSync(join(workDir, `log-${n}.jsonl`), "{}\n", "utf8");
    }
    const read = await readLaunchFacts(workDir);
    assert.deepEqual(read, { attempt: 4, previousFall: false });
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
    assert.deepEqual(view.attemptsWithoutOwnOutcome, [
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
    assert.deepEqual(view.attemptsWithoutOwnOutcome, []);
    assert.deepEqual(view.reservedWithoutAttempt, []);
    assert.deepEqual(view.lastOutcome, []);
    assert.deepEqual(view.archived, []);
  });

  test("a corrupt record does not lie about status: it reads as absent — no outcome of its own, the dir stays a bare reservation", async () => {
    const corrupt = join(layout.works, "Sanmoo/c#9");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, DESFECHO_FILENAME), "{not json", "utf8");

    const view = await scanRegistry(layout);
    // The invalid record is treated as absent and, with no attempt evidence,
    // the dir is a bare reservation — never a fake outcome.
    assert.deepEqual(view.reservedWithoutAttempt, ["Sanmoo/c#9"]);
    assert.deepEqual(view.attemptsWithoutOwnOutcome, []);
    assert.deepEqual(view.lastOutcome, []);
  });
});

describe("workspace registry — the reservations on disk and the done archive", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  /** The Work a GitHub issue of the destination repo names. */
  const workOf = (repo: string, number: number): WorkIdentity => ({
    ticket: githubTicket(repo, number),
    destination: githubRepository(repo),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-registry14-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("scanReservations: every trabalhos/<repo>#<n> dir becomes a Work — the factory's memory of what it launched", async () => {
    mkdirSync(join(layout.works, "Sanmoo", "a#1"), { recursive: true });
    mkdirSync(join(layout.works, "Sanmoo", "my-tasks#12"), { recursive: true });
    // A dir that is not a work (the repo's nested path itself) is not a work.
    mkdirSync(join(layout.works, "Sanmoo", "b"), { recursive: true });

    const reserved = await scanReservations(layout);

    assert.deepEqual(
      reserved.map((entry) => entry.key).sort(),
      ["Sanmoo/a#1", "Sanmoo/my-tasks#12"],
    );
    for (const entry of reserved) {
      assert.ok(existsSync(entry.dir), "the dir is handed over — launches and archiving need it");
      assert.equal(entry.work?.ticket.provider, "github", "a legacy GitHub dir names its own ticket");
    }
  });

  test("scanReservations: a workspace never created reads empty", async () => {
    assert.deepEqual(await scanReservations(join("/nowhere/nonexistent-msf-ws")), []);
  });

  test("parseWorkKey: the dir name is <repo>#<n> with the repo keeping its slash", () => {
    assert.deepEqual(parseWorkKey("Sanmoo/my-tasks#12"), { repo: "Sanmoo/my-tasks", number: 12 });
    assert.equal(parseWorkKey("no-number"), null);
  });

  test("archiveDoneWorkFor MOVES the work dir into arquivo/<work key>-<date> — nothing is deleted", async () => {
    const src = join(layout.works, "Sanmoo", "a#1");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, DESFECHO_FILENAME), JSON.stringify({ class: "pr-open", attempt: 1 }), "utf8");
    writeFileSync(join(src, "log-1.jsonl"), "{}\n", "utf8");

    const dest = await archiveDoneWorkFor(layout, workOf("Sanmoo/a", 1));
    assert.ok(dest, "the archive path is returned");

    assert.ok(!existsSync(src), "the work dir left trabalhos");
    assert.ok(existsSync(dest), "the artifacts live in the archive now");
    assert.match(dest, /arquivo\/Sanmoo\/a#1-\d{4}-\d{2}-\d{2}$/, "the archive name carries the done date");
    assert.ok(existsSync(join(dest, DESFECHO_FILENAME)), "the desfecho survived the move");
    assert.ok(existsSync(join(dest, "log-1.jsonl")), "the logs survived the move");
    const view = await scanRegistry(layout);
    assert.deepEqual(view.archived, [dest]);
  });

  test("scanRegistry carries a pause's own attempt beside the attempt the ledger evidences — read-only (issue 175)", async () => {
    const paused = join(layout.works, "Sanmoo/a#5");
    mkdirSync(paused, { recursive: true });
    writeFileSync(join(paused, "log-4.jsonl"), "{}\n", "utf8");
    writePause(paused, {
      version: 1,
      work: workOf("Sanmoo/a", 5),
      attempt: 5,
      reason: "effect-ambiguous",
      detail: "the push may or may not have landed",
      at: "2026-02-01T00:00:00.000Z",
    });

    const view = await scanRegistry(layout);

    assert.deepEqual(
      view.continuityPauses.map((entry) => ({ key: entry.key, planned: entry.pause.attempt, evidenced: entry.lastAttempt })),
      [{ key: "Sanmoo/a#5", planned: 5, evidenced: 4 }],
      "the planned attempt is the record's; the evidenced one is the ledger's — both are read, neither is written",
    );
    assert.equal(readPause(paused)?.attempt, 5, "the scan leaves the record exactly as it found it");
  });

  test("archiveDoneWorkFor of a work with no dir is a no-op (nothing to archive)", async () => {
    const dest = await archiveDoneWorkFor(layout, workOf("Sanmoo/a", 42));
    assert.equal(dest, null);
  });

  test("archiveDoneWorkFor twice on the same day never collides (the second gets a fresh name)", async () => {
    const src = join(layout.works, "Sanmoo", "a#2");
    mkdirSync(src, { recursive: true });
    const first = await archiveDoneWorkFor(layout, workOf("Sanmoo/a", 2));
    assert.ok(first);
    mkdirSync(src, { recursive: true }); // a second run's artifacts for the same work
    const second = await archiveDoneWorkFor(layout, workOf("Sanmoo/a", 2));
    assert.ok(second, "the second archive also happens");
    assert.notEqual(first, second, "a unique dest, never the same dir");
    const view = await scanRegistry(layout);
    assert.equal(view.archived.length, 2, "both archive entries exist");
  });
});
