import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { githubRepository, githubTicket, workIdentity } from "../tracker/identity.js";
import { openWorkRecord } from "./record.js";

/**
 * The Work record tested at its own seam (issue #186, stories 6/8/9): the
 * interface is the subject — the files, their schemas and the cross references
 * — with no factory, no worker and no ledger policy involved.
 */

const WORK = workIdentity(githubTicket("Sanmoo/record-seam", 3), githubRepository("Sanmoo/record-seam"));

function withRecord(body: (record: ReturnType<typeof openWorkRecord>) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "msf-record-seam-"));
    try {
      await body(openWorkRecord(join(root, "trabalhos", "Sanmoo/record-seam#3")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "the outcome record is written and read through one interface, and another attempt's record is never this one's",
  withRecord(async (record) => {
    record.writeOutcome({ class: "clean-without-pr", attempt: 2 });

    assert.deepEqual(await record.outcome(), { class: "clean-without-pr", attempt: 2 });
    assert.deepEqual(await record.ownOutcome(2), { class: "clean-without-pr", attempt: 2 });
    assert.equal(await record.ownOutcome(1), null, "a record left by attempt 2 is not attempt 1's outcome");
  }),
);

test(
  "a session association names its attempt and round, and reads back as the one the recovery reopens",
  withRecord(async (record) => {
    record.associateSession({
      version: 1,
      work: WORK,
      attempt: 4,
      round: 2,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      at: "2026-01-01T00:00:00.000Z",
    });

    const { intact, links } = record.sessions();
    assert.equal(intact, true);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.attempt, 4);
    assert.equal(links[0]!.round, 2);
    assert.equal(links[0]!.sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(record.sessionsDir, join(record.dir, "sessao"));
  }),
);

test(
  "the outcome of an attempt settles its pause, and a pause that names no attempt is the doubt it is",
  withRecord(async (record) => {
    record.writePause({
      version: 1,
      work: WORK,
      attempt: 3,
      reason: "effect-ambiguous",
      detail: "push of the work branch",
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(record.pausedAttempt(), 3);

    record.settle(3);
    assert.equal(record.pause(), null, "the settled attempt's pause is history");
  }),
);

test(
  "a pause naming a LATER attempt is not settled by this attempt's end",
  withRecord(async (record) => {
    record.writePause({
      version: 1,
      work: WORK,
      attempt: 5,
      reason: "session-missing",
      detail: "no session file",
      at: "2026-01-01T00:00:00.000Z",
    });

    record.settle(4);
    assert.equal(record.pausedAttempt(), 5, "a later attempt still waits for the operator");
  }),
);

test(
  "the worker's stop request is part of the record and stays bound to its session",
  withRecord(async (record) => {
    record.requestStop("session-a");
    assert.equal(record.stopRequested("session-a"), true);
    assert.equal(record.stopRequested("session-b"), false, "a stop never reaches another session");
    record.clearStopRequest();
    assert.equal(record.stopRequested("session-a"), false);
  }),
);
