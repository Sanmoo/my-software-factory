import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import { githubRepository, githubTicket, jiraTicket, type WorkIdentity } from "../tracker/identity.js";
import {
  RESERVATION_FILENAME,
  readReservation,
  reservationRecordOf,
  reserveWork,
  scanReservations,
} from "./reservation.js";

/**
 * The reservation record on REAL disk: the facts a restart reads back. The
 * test never mocks the filesystem — the workspace is a temp dir and every
 * assertion observes what a fresh reader (a new process's registry read)
 * finds there.
 */

function jiraWork(input: { site: string; stableId: string; key: string; repo: string }): WorkIdentity {
  return {
    ticket: jiraTicket({ site: input.site, stableId: input.stableId, key: input.key }),
    destination: githubRepository(input.repo),
  };
}

describe("reservation record — the Work's persisted source and destination", () => {
  let root: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-reservation-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a reservation persists the ticket source and the destination as separate facts with presentation data", async () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const record = reservationRecordOf(
      work,
      { title: "Add a greeting", url: "https://alpha.atlassian.net/browse/ABC-1" },
      "2026-01-01T00:00:00.000Z",
    );

    const written = reserveWork(layout, record);
    assert.ok(existsSync(join(written.dir, RESERVATION_FILENAME)));

    // A fresh read after a restart: identity, site, stable id, destination and
    // presentation all come from disk, never from any current configuration.
    const read = readReservation(written.dir);
    assert.equal(read.state, "persisted");
    if (read.state !== "persisted") return;
    assert.deepEqual(read.record.ticket, work.ticket);
    assert.deepEqual(read.record.destination, work.destination);
    assert.equal(read.record.presentation.title, "Add a greeting");
    assert.equal(read.record.presentation.url, "https://alpha.atlassian.net/browse/ABC-1");
    assert.equal(read.record.reservedAt, "2026-01-01T00:00:00.000Z");

    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.work, work);
    assert.equal(entries[0]!.reservation.state, "persisted");
  });

  test("re-reserving the same Work keeps the original record — an earlier execution is never overwritten", async () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const first = reserveWork(layout, reservationRecordOf(work, { title: "first" }, "2026-01-01T00:00:00.000Z"));
    assert.equal(first.created, true);

    const second = reserveWork(layout, reservationRecordOf(work, { title: "second" }, "2026-02-02T00:00:00.000Z"));
    assert.equal(second.created, false);
    assert.equal(second.dir, first.dir);

    const read = readReservation(first.dir);
    assert.equal(read.state, "persisted");
    if (read.state !== "persisted") return;
    assert.equal(read.record.reservedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(read.record.presentation.title, "first");
  });

  test("a record that names another Work never takes over an occupied reservation dir", async () => {
    const original = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const dir = (reserveWork(layout, reservationRecordOf(original))).dir;

    // A foreign record inside this dir (a hand edit, a bug, a future key
    // scheme): the reservation must stay the dir key's Work and the conflict
    // must be loud, never an overwrite of the evidence.
    const foreign = jiraWork({ site: "beta.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    writeFileSync(
      join(dir, RESERVATION_FILENAME),
      `${JSON.stringify(reservationRecordOf(foreign), null, 2)}\n`,
      "utf8",
    );

    const scanned = await scanReservations(layout);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]!.reservation.state, "unreadable", "the mismatched record is not presented as this Work's");
    assert.equal(scanned[0]!.anchor.site, "alpha.atlassian.net", "the dir key still anchors the Work");
    assert.equal(scanned[0]!.work, null, "no readable Work is invented from the anchor");

    // Re-reserving reports the unknown and leaves the file untouched: the
    // Work can still be launched, a human decides about the record.
    const retry = reserveWork(layout, reservationRecordOf(original));
    assert.equal(retry.created, false);
    assert.equal(retry.reservation.state, "unreadable");
    assert.equal(
      JSON.parse(readFileSync(join(dir, RESERVATION_FILENAME), "utf8")).ticket.site,
      "beta.atlassian.net",
      "the foreign record was not overwritten",
    );
  });

  test("a renamed Jira key re-reserves the SAME Work: the stable identity decides, the record stays", async () => {
    const before = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const renamed = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-9", repo: "Sanmoo/my-tasks" });

    const first = reserveWork(layout, reservationRecordOf(before, { title: "first" }));
    const second = reserveWork(layout, reservationRecordOf(renamed, { title: "renamed" }));

    assert.equal(second.dir, first.dir, "the readable key is presentation, never identity");
    assert.equal(second.created, false);
    assert.equal((await scanReservations(layout)).length, 1);
  });

  test("an unreadable record is surfaced, never overwritten: the reservation stays visible", async () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const dir = (reserveWork(layout, reservationRecordOf(work))).dir;
    writeFileSync(join(dir, RESERVATION_FILENAME), "{ not json", "utf8");

    const read = readReservation(dir);
    assert.equal(read.state, "unreadable");
    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1, "an unreadable record does not hide the reservation");
    assert.equal(entries[0]!.reservation.state, "unreadable");
    assert.equal(entries[0]!.anchor.stableId, "10001", "the dir key still anchors the Work");
    assert.equal(entries[0]!.work, null);

    // The Work is not blocked by its corrupt record, and the evidence stays.
    const retry = reserveWork(layout, reservationRecordOf(work));
    assert.equal(retry.created, false);
    assert.equal(retry.reservation.state, "unreadable");
    assert.equal(readFileSync(join(dir, RESERVATION_FILENAME), "utf8"), "{ not json");
  });

  test("a one-segment legacy dir is a Work too — its key is the whole name", async () => {
    // A repo name without an owner reaches the registry as a single segment;
    // the same depth-bounded traversal reads it beside the nested ones.
    const flatDir = join(layout.works, "my-tasks#7");
    mkdirSync(flatDir, { recursive: true });

    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.key, "my-tasks#7");
    assert.deepEqual(entries[0]!.work, {
      ticket: githubTicket("my-tasks", 7),
      destination: githubRepository("my-tasks"),
    });
  });

  test("a pre-record GitHub reservation stays readable and usable where it is — no relocation, no migration", async () => {
    // The legacy dir with only attempt evidence: exactly what an existing
    // workspace holds today.
    const legacyDir = join(layout.works, "Sanmoo", "my-tasks#7");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "log-1.jsonl"), "", "utf8");

    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.dir, legacyDir, "the legacy dir is read where it is");
    assert.equal(entry.reservation.state, "absent");
    assert.deepEqual(entry.work, {
      ticket: githubTicket("Sanmoo/my-tasks", 7),
      destination: githubRepository("Sanmoo/my-tasks"),
    });

    // Its first new launch can persist the facts; the dir does not move.
    const written = reserveWork(
      layout,
      reservationRecordOf(entry.work, { url: "https://github.com/Sanmoo/my-tasks/issues/7" }),
    );
    assert.equal(written.dir, legacyDir);
    assert.equal(written.created, true);
    assert.equal((readReservation(legacyDir)).state, "persisted");
  });

  test("a work-like dir nested inside a work is not a reservation of this registry", async () => {
    // A proof's disposable workspace can live under a work's dir and carry its
    // own trabalhos/<repo>#<n> — or a session artifact can be named like a
    // work. Neither is a reservation of THIS workspace (issue 118's sweep bug).
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const dir = (reserveWork(layout, reservationRecordOf(work))).dir;
    const legacyDir = join(layout.works, "Sanmoo", "a#1");
    const nested = join(legacyDir, "proof", "fabrica", "trabalhos", "Sanmoo", "b#2");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(dir, "sessao", "Sanmoo", "c#3"), { recursive: true });

    const entries = await scanReservations(layout);

    assert.deepEqual(
      entries.map((entry) => entry.dir),
      [dir, legacyDir].sort((a, b) => a.localeCompare(b)),
      "only the two real reservations, never a dir nested inside one",
    );
  });

  test("a configuration change routing the same ticket to another repo reserves a SEPARATE Work", async () => {
    const ticket = { site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" };
    const before = jiraWork({ ...ticket, repo: "Sanmoo/my-tasks" });
    const after = jiraWork({ ...ticket, repo: "Sanmoo/other-tasks" });

    const first = reserveWork(layout, reservationRecordOf(before, { title: "before" }));
    const second = reserveWork(layout, reservationRecordOf(after, { title: "after" }));

    assert.notEqual(first.dir, second.dir, "destination is part of the Work identity");
    const entries = await scanReservations(layout);
    assert.equal(entries.length, 2);
    // The old reservation still points at the old destination: configuration
    // never transfers already reserved work.
    const old = entries.find((entry) => entry.dir === first.dir)!;
    assert.ok(old.work !== null);
    assert.equal(old.work.destination.repo, "Sanmoo/my-tasks");
    assert.equal(old.reservation.state, "persisted");
    const oldRecord = readReservation(first.dir);
    assert.equal(oldRecord.state === "persisted" ? oldRecord.record.presentation.title : null, "before");
  });
});
