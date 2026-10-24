import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { githubWork } from "../e2e/work-fixtures.js";
import {
  EMPTY_REPAIR_CYCLE,
  PAUSE_FILENAME,
  WorkRecordError,
  emptyLedger,
  emptyModelProviderLedger,
  openWorkRecord,
  readPause,
  type PauseRecord,
  type RepairCycle,
} from "./index.js";

/**
 * The Work record's interface (issue 187): one owner for the complete on-disk
 * record of a Work — its files, their schemas and the cross-references that
 * bind them. A part the record cannot read is reported as the doubt it is, and
 * a write that would break a cross-reference is refused before any file is
 * touched.
 */

const WORK = githubWork("Sanmoo/my-tasks", 7);
const AT = "2026-01-01T00:00:00.000Z";

function pauseOf(attempt: number, overrides: Partial<PauseRecord> = {}): PauseRecord {
  return {
    version: 1,
    work: WORK,
    attempt,
    reason: "session-missing",
    detail: "the recorded session is gone",
    at: AT,
    ...overrides,
  };
}

function repairCycleOf(attempt: RepairCycle["attempt"]): RepairCycle {
  return { usedRounds: 1, lastEvidence: "sig", consecutiveFalls: 0, attempt };
}

describe("the Work record — one owner for the whole on-disk record", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-work-record-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = () => openWorkRecord(dir);

  test("an empty work dir reads as the honest initial record — no fact is invented", async () => {
    const snapshot = await record().read();

    assert.equal(snapshot.attempt, null, "nothing on disk numbers an attempt");
    assert.equal(snapshot.outcome, null);
    assert.equal(snapshot.ownOutcome, null);
    assert.equal(snapshot.pause, null);
    assert.deepEqual(snapshot.sessionLinks, { intact: true, links: [] });
    assert.deepEqual(snapshot.journal, { intact: true, sessions: [], intents: [], results: [], pending: [] });
    assert.equal(snapshot.guardrail, null);
    assert.deepEqual(snapshot.recovery, emptyLedger());
    assert.deepEqual(snapshot.modelProvider, emptyModelProviderLedger());
    assert.deepEqual(snapshot.repair, EMPTY_REPAIR_CYCLE);
    assert.deepEqual(snapshot.attempts, []);
  });

  test("a part the record cannot read is reported as a doubt, never repaired into a fact", async () => {
    writeFileSync(join(dir, PAUSE_FILENAME), "{not json", "utf8");
    const paused = await record().read();
    assert.equal(paused.pause?.reason, "record-unreadable");
    assert.equal(readPause(dir)?.attempt, 0, "no attempt is invented for the unreadable pause");

    writeFileSync(join(dir, "sessao-vinculos.jsonl"), '{"version":1,"work":\n', "utf8");
    assert.equal((await record().read()).sessionLinks.intact, false);

    writeFileSync(join(dir, "efeitos.jsonl"), '{"type":"intent"', "utf8");
    assert.equal((await record().read()).journal.intact, false, "an incomplete journal is not an empty one");

    writeFileSync(join(dir, "desfecho.json"), '{"class":"not-a-class","attempt":2}', "utf8");
    const outcome = await record().read();
    assert.equal(outcome.outcome, null, "an unreadable outcome is absence, never a guessed class");
    assert.equal(outcome.attempt, null);

    writeFileSync(join(dir, "reparo.json"), '{"usedRounds":"many"}', "utf8");
    assert.deepEqual((await record().read()).repair, { ...EMPTY_REPAIR_CYCLE }, "an unreadable cycle is the honest initial one");
  });

  test("every part written through the interface is read back through it", async () => {
    const pending = record();
    await pending.write({ part: "outcome", record: { class: "clean-without-pr", attempt: 1 } });
    await pending.write({ part: "pause", pause: pauseOf(2) });
    await pending.write({
      part: "session-link",
      link: { version: 1, work: WORK, attempt: 2, round: 1, sessionId: "s-2", at: AT },
    });
    await pending.write({ part: "journal-start", entry: { attempt: 2, sessionId: "s-2" } });
    await pending.write({
      part: "journal-intent",
      entry: {
        attempt: 2,
        sessionId: "s-2",
        callId: "call-1",
        tool: "bash",
        command: "git push origin agent-issue-7",
        safety: "effect",
        actions: [],
      },
    });
    await pending.write({ part: "journal-result", entry: { attempt: 2, sessionId: "s-2", callId: "call-1", ok: true } });
    await pending.write({
      part: "guardrail-state",
      state: { version: 1, attempt: 2, sessionId: "s-2", mode: "resume", verdicts: {}, at: AT },
    });
    await pending.write({
      part: "recovery",
      ledger: { ...emptyLedger(), attempt: 2, lastStop: { kind: "stop-requested", attempt: 2, at: AT } },
    });
    await pending.write({ part: "model-provider", ledger: { ...emptyModelProviderLedger(), attempt: 2 } });
    await pending.write({
      part: "repair",
      cycle: repairCycleOf({
        evidence: "sig",
        attempt: 2,
        observedHeadSha: "abc123",
        remoteHeadSha: null,
        publication: "published",
        localWork: null,
      }),
    });
    await pending.write({ part: "attempt-event", attempt: 2, event: { event: "session-start" } });

    const snapshot = await pending.read();
    assert.equal(snapshot.attempt, 2);
    assert.equal(snapshot.outcome?.class, "clean-without-pr");
    assert.equal(snapshot.ownOutcome, null, "the outcome of attempt 1 is history, not attempt 2's");
    assert.equal(snapshot.pause?.attempt, 2);
    assert.deepEqual(snapshot.sessionLinks.links.map((link) => [link.attempt, link.round, link.sessionId]), [[2, 1, "s-2"]]);
    assert.deepEqual(snapshot.journal.pending, []);
    assert.deepEqual(snapshot.journal.results.map((result) => result.callId), ["call-1"]);
    assert.equal(snapshot.guardrail?.sessionId, "s-2");
    assert.deepEqual(snapshot.recovery.lastStop, { kind: "stop-requested", attempt: 2, at: AT });
    assert.equal(snapshot.modelProvider.attempt, 2);
    assert.equal(snapshot.repair.attempt?.observedHeadSha, "abc123");
    assert.deepEqual(snapshot.attempts, [2]);
  });

  test("a pause names its Attempt: the record refuses one that names none, and writes nothing", async () => {
    await assert.rejects(
      record().write({ part: "pause", pause: pauseOf(0) }),
      WorkRecordError,
      "a pause without an attempt cannot be persisted",
    );
    const { work: _work, ...withoutWork } = pauseOf(2);
    await assert.rejects(
      record().write({ part: "pause", pause: withoutWork }),
      WorkRecordError,
      "a pause without its Work cannot be persisted",
    );
    assert.equal(readPause(dir), null, "the refused pauses left no file behind");
  });

  test("a session link names its round: the record refuses one that names none", async () => {
    await assert.rejects(
      record().write({
        part: "session-link",
        link: { version: 1, work: WORK, attempt: 2, round: 0, sessionId: "s-2", at: AT },
      }),
      WorkRecordError,
    );
    assert.deepEqual((await record().read()).sessionLinks.links, []);
  });

  test("an outcome settles the pause of its own attempt — and only that one", async () => {
    const pending = record();
    await pending.write({ part: "pause", pause: pauseOf(2) });

    await pending.write({ part: "outcome", record: { class: "clean-without-pr", attempt: 1 } });
    assert.equal((await pending.read()).pause?.attempt, 2, "another attempt's outcome leaves the pause waiting");

    await pending.write({ part: "outcome", record: { class: "blocked-self-report", attempt: 2 } });
    assert.equal(readPause(dir), null, "the attempt's own outcome settled the persisted pause");
    assert.equal((await pending.read()).pause, null);
  });

  test("a pause the record advanced past is history, not the pause that still waits", async () => {
    const pending = record();
    await pending.write({ part: "pause", pause: pauseOf(1) });
    await pending.write({ part: "outcome", record: { class: "clean-without-pr", attempt: 2 } });

    assert.equal(readPause(dir)?.attempt, 1, "the raw pause still says what it said");
    assert.equal((await pending.read()).pause, null, "the advanced attempt leaves the pause history");
  });

  test("stop facts name the attempt: the record refuses a ledger whose stop names none", async () => {
    await assert.rejects(
      record().write({
        part: "recovery",
        ledger: { ...emptyLedger(), lastStop: { kind: "interruption", attempt: 0, at: AT } },
      }),
      WorkRecordError,
    );
    await assert.rejects(
      record().write({
        part: "recovery",
        ledger: { ...emptyLedger(), events: [{ index: 0, waitMs: 1_000, attempt: 0, at: AT }] },
      }),
      WorkRecordError,
      "a recovery event names the attempt it continued",
    );
    assert.equal((await record().read()).recovery.lastStop, null);
  });

  test("a repair attempt names its evidence and the head it observed", async () => {
    const attempt = {
      evidence: "sig",
      attempt: 2,
      observedHeadSha: "abc123",
      remoteHeadSha: null,
      publication: "unknown" as const,
      localWork: null,
    };
    await assert.rejects(
      record().write({ part: "repair", cycle: repairCycleOf({ ...attempt, evidence: "" }) }),
      WorkRecordError,
      "a repair attempt without its evidence cannot be attributed",
    );
    await assert.rejects(
      record().write({ part: "repair", cycle: repairCycleOf({ ...attempt, observedHeadSha: "" }) }),
      WorkRecordError,
      "a repair attempt without the observed head has no lease",
    );
    assert.deepEqual((await record().read()).repair, { ...EMPTY_REPAIR_CYCLE });
  });
});
