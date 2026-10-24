import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  PAUSE_FILENAME,
  appendJournalIntent,
  appendJournalResult,
  appendJournalStart,
  appendSessionLink,
  clearPause,
  linkForAttempt,
  nextRound,
  pauseWaits,
  readEffectJournal,
  readPause,
  readSessionLinks,
  writePause,
} from "./continuity-artifacts.js";
import { githubWork } from "../e2e/work-fixtures.js";

/**
 * The continuity artifacts as files (issue 119): the association a recovery
 * selects from, the journal whose missing result is the interrupted window,
 * and the pause that survives a restart. A record this version cannot read is
 * reported absent, never repaired into an invented fact.
 */

const REF = githubWork("Sanmoo/my-tasks", 7);

describe("the continuity artifacts (issue 119)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-continuity-artifacts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePauseFile(record: unknown): void {
    writeFileSync(join(dir, PAUSE_FILENAME), JSON.stringify(record), "utf8");
  }

  function validPause(): Record<string, unknown> {
    return {
      version: 1,
      work: REF,
      attempt: 2,
      reason: "session-missing",
      detail: "the recorded session is gone",
      at: "2026-01-01T00:00:00.000Z",
    };
  }

  test("a complete pause is read back with its facts", () => {
    writePauseFile({ ...validPause(), sessionId: "s-1", announced: true });
    const pause = readPause(dir);
    assert.equal(pause?.attempt, 2);
    assert.equal(pause?.reason, "session-missing");
    assert.equal(pause?.sessionId, "s-1");
    assert.equal(pause?.announced, true);
  });

  test("a pause naming a reason this version does not know still waits — as an unreadable record", () => {
    writePauseFile({ ...validPause(), reason: "something-from-a-newer-factory" });
    const pause = readPause(dir);
    assert.equal(pause?.reason, "record-unreadable", "the doubt is reported, never narrowed into a known reason");
    assert.match(pause?.detail ?? "", /could not be read/);
  });

  test("a pause that cannot be read waits for whichever attempt is current", () => {
    for (const broken of [{ ...validPause(), attempt: undefined }, { ...validPause(), attempt: 0 }, { ...validPause(), version: 2 }]) {
      writePauseFile(broken);
      const pause = readPause(dir);
      assert.ok(pause, JSON.stringify(broken));
      assert.equal(pause.reason, "record-unreadable");
      assert.equal(pause.attempt, 0, "no attempt is invented for the record");
      // The record itself is the doubt: it waits on every attempt instead of
      // letting the work fall back to a recovery the record forbade.
      assert.equal(pauseWaits(pause, 1), true);
      assert.equal(pauseWaits(pause, 7), true);
    }
    // A readable pause waits only on its own attempt.
    writePauseFile(validPause());
    const readable = readPause(dir)!;
    assert.equal(pauseWaits(readable, 2), true);
    assert.equal(pauseWaits(readable, 3), false, "an older attempt's pause is history");
  });

  test("rewriting an unreadable pause copies the original aside instead of overwriting it", () => {
    writeFileSync(join(dir, PAUSE_FILENAME), "{not json", "utf8");
    writePause(dir, {
      version: 1,
      work: REF,
      attempt: 2,
      reason: "session-missing",
      detail: "the recorded session is gone",
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(readPause(dir)?.reason, "session-missing");
    assert.equal(
      readFileSync(join(dir, `${PAUSE_FILENAME}.unreadable`), "utf8"),
      "{not json",
      "the corrupt evidence is preserved for the operator",
    );
  });

  test("clearing keeps the resolved pause as evidence beside the work", () => {
    writePauseFile(validPause());
    clearPause(dir);
    assert.equal(readPause(dir), null);
    assert.match(readFileSync(join(dir, `${PAUSE_FILENAME}.resolved`), "utf8"), /session-missing/);
  });

  test("a link is selected by its exact (work, attempt), never by being the newest", () => {
    appendSessionLink(dir, { version: 1, work: REF, attempt: 1, round: 1, sessionId: "a1", at: "" });
    appendSessionLink(dir, { version: 1, work: REF, attempt: 2, round: 1, sessionId: "b1", at: "" });
    appendSessionLink(dir, { version: 1, work: githubWork("Sanmoo/my-tasks", 8), attempt: 2, round: 1, sessionId: "other-work", at: "" });
    // The LAST round of the attempt is the one a recovery continues; the newest
    // line on disk belongs to another work and is never chosen.
    appendSessionLink(dir, { version: 1, work: REF, attempt: 2, round: 2, sessionId: "b2", at: "" });
    const links = readSessionLinks(dir);
    assert.equal(links.intact, true);
    assert.equal(linkForAttempt(links.links, REF, 2)?.sessionId, "b2");
    assert.equal(linkForAttempt(links.links, REF, 1)?.sessionId, "a1");
    assert.equal(linkForAttempt(links.links, REF, 3), null, "no association, no guess");
    assert.equal(nextRound(links.links, REF, 2), 3, "the next launch of attempt 2 is round 3");
  });

  test("a workspace written before the expansion stays readable as a GitHub Work", () => {
    // The pre-#127 file named the work as `{repo, number}`. Reading it is a
    // compatibility contract: the association is not discarded or guessed.
    writeFileSync(
      join(dir, "sessao-vinculos.jsonl"),
      `${JSON.stringify({ version: 1, work: { repo: "Sanmoo/my-tasks", number: 7 }, attempt: 2, round: 1, sessionId: "legacy", at: "" })}\n`,
      "utf8",
    );
    const links = readSessionLinks(dir);
    assert.equal(links.intact, true);
    assert.deepEqual(links.links[0]?.work, REF);
    assert.equal(linkForAttempt(links.links, REF, 2)?.sessionId, "legacy");
  });

  test("a legacy pause record names its Work instead of being discarded", () => {
    writeFileSync(
      join(dir, PAUSE_FILENAME),
      JSON.stringify({
        version: 1,
        work: { repo: "Sanmoo/my-tasks", number: 7 },
        attempt: 2,
        reason: "session-missing",
        detail: "legacy pause",
        at: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    assert.deepEqual(readPause(dir)?.work, REF);
  });

  test("an unparseable association line marks the journal not intact", () => {
    appendSessionLink(dir, { version: 1, work: REF, attempt: 1, round: 1, sessionId: "a1", at: "" });
    writeFileSync(join(dir, "sessao-vinculos.jsonl"), '{"version":1,"work":\n', { encoding: "utf8", flag: "a" });
    assert.equal(readSessionLinks(dir).intact, false);
  });

  test("an intent with no result is pending; its result closes the window", () => {
    appendJournalStart(dir, { attempt: 2, sessionId: "s-1" });
    appendJournalIntent(dir, {
      attempt: 2,
      sessionId: "s-1",
      callId: "call-1",
      tool: "bash",
      command: "git push origin agent-issue-7",
      safety: "effect",
      actions: [{ kind: "push", key: "push:agent-issue-7@abc", detail: "push", branch: "agent-issue-7", sha: "abc" }],
    });
    const open = readEffectJournal(dir);
    assert.equal(open.intact, true);
    assert.deepEqual(
      open.pending.map((intent) => intent.callId),
      ["call-1"],
    );

    appendJournalResult(dir, { attempt: 2, sessionId: "s-1", callId: "call-1", ok: true });
    assert.deepEqual(readEffectJournal(dir).pending, []);
  });

  test("a call id from another round does not answer this one's intent", () => {
    appendJournalIntent(dir, {
      attempt: 2,
      sessionId: "round-1",
      callId: "call-1",
      tool: "bash",
      command: "git push origin agent-issue-7",
      safety: "effect",
      actions: [],
    });
    appendJournalResult(dir, { attempt: 2, sessionId: "round-2", callId: "call-1", ok: true });
    const journal = readEffectJournal(dir);
    assert.deepEqual(
      journal.pending.map((intent) => intent.sessionId),
      ["round-1"],
      "pairing is scoped to the session that issued the call",
    );
  });

  test("a journal whose last write was interrupted is not intact", () => {
    appendJournalStart(dir, { attempt: 2, sessionId: "s-1" });
    writeFileSync(join(dir, "efeitos.jsonl"), '{"type":"intent"', { encoding: "utf8", flag: "a" });
    assert.equal(readEffectJournal(dir).intact, false);
  });
});
