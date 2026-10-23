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
  callKey,
  clearPause,
  readEffectJournal,
  readPause,
  readSessionLinks,
} from "./continuity-artifacts.js";

/**
 * The continuity artifacts as files (issue 119): the association a recovery
 * selects from, the journal whose missing result is the interrupted window,
 * and the pause that survives a restart. A record this version cannot read is
 * reported absent, never repaired into an invented fact.
 */

const REF = { repo: "Sanmoo/my-tasks", number: 7 };

describe("the continuity artifacts (issue 119)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-continuity-artifacts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePause(record: unknown): void {
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
    writePause({ ...validPause(), sessionId: "s-1", announced: true });
    const pause = readPause(dir);
    assert.equal(pause?.attempt, 2);
    assert.equal(pause?.reason, "session-missing");
    assert.equal(pause?.sessionId, "s-1");
    assert.equal(pause?.announced, true);
  });

  test("a pause naming a reason this version does not know is absent, not guessed", () => {
    writePause({ ...validPause(), reason: "something-from-a-newer-factory" });
    assert.equal(readPause(dir), null, "an unknown reason is not narrowed into a known one");
  });

  test("a pause without its attempt is absent: a fabricated attempt matches no work", () => {
    const { attempt: _dropped, ...withoutAttempt } = validPause();
    writePause(withoutAttempt);
    assert.equal(readPause(dir), null);
    writePause({ ...validPause(), attempt: 0 });
    assert.equal(readPause(dir), null);
  });

  test("clearing keeps the resolved pause as evidence beside the work", () => {
    writePause(validPause());
    clearPause(dir);
    assert.equal(readPause(dir), null);
    assert.match(readFileSync(join(dir, `${PAUSE_FILENAME}.resolved`), "utf8"), /session-missing/);
  });

  test("a link is selected by its exact (work, attempt), never by being the newest", () => {
    appendSessionLink(dir, { version: 1, work: REF, attempt: 1, round: 1, mode: "new", sessionId: "a1", at: "" });
    appendSessionLink(dir, { version: 1, work: REF, attempt: 2, round: 1, mode: "new", sessionId: "b1", at: "" });
    appendSessionLink(dir, { version: 1, work: { repo: REF.repo, number: 8 }, attempt: 2, round: 1, mode: "new", sessionId: "other-work", at: "" });
    const links = readSessionLinks(dir);
    assert.equal(links.intact, true);
    assert.deepEqual(
      links.links.map((link) => link.sessionId),
      ["a1", "b1", "other-work"],
    );
  });

  test("an unparseable association line marks the journal not intact", () => {
    appendSessionLink(dir, { version: 1, work: REF, attempt: 1, round: 1, mode: "new", sessionId: "a1", at: "" });
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
    assert.notEqual(callKey("round-1", "call-1"), callKey("round-2", "call-1"));
  });

  test("a journal whose last write was interrupted is not intact", () => {
    appendJournalStart(dir, { attempt: 2, sessionId: "s-1" });
    writeFileSync(join(dir, "efeitos.jsonl"), '{"type":"intent"', { encoding: "utf8", flag: "a" });
    assert.equal(readEffectJournal(dir).intact, false);
  });
});
