import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readOutcomeRecord,
  classifyOutcome,
  blockedCommentBody,
  DESFECHO_FILENAME,
} from "./outcome.js";

/**
 * Factory building the six structured facts the ruler reads: the outcome
 * record (or its absence), the PR fact and the label fact from the port, and
 * the consecutiveness fact from the registry. Nothing else — zero prose.
 */
function facts(overrides: Partial<Parameters<typeof classifyOutcome>[0]> = {}) {
  return {
    record: null,
    prOpen: false,
    blockedLabelOnIssue: false,
    consecutiveFall: false,
    attempt: 1,
    ...overrides,
  };
}

describe("outcome — the factory's ruler reads only structured facts", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "msf-outcome-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("the artifact contract is desfecho.json, in PT-BR on disk", () => {
    assert.equal(DESFECHO_FILENAME, "desfecho.json");
  });

  test("an outcome record on disk parses into the structured schema", async () => {
    writeFileSync(
      join(workDir, DESFECHO_FILENAME),
      JSON.stringify({
        class: "pr-open",
        attempt: 1,
        pr: { repo: "Sanmoo/a", number: 12, branch: "agent-issue-3" },
      }),
      "utf8",
    );

    const record = await readOutcomeRecord(workDir);

    assert.ok(record);
    assert.equal(record.class, "pr-open");
    assert.equal(record.attempt, 1);
  });

  test("the absence of the record is itself the class 'abrupt fall' (null, no error)", async () => {
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });

  test("a record that breaks the schema is invalid — never interpreted as prose", async () => {
    writeFileSync(join(workDir, DESFECHO_FILENAME), JSON.stringify({ class: "whatever" }), "utf8");
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });

  test("a corrupt record is treated as absent (abrupt fall), not a crash", async () => {
    writeFileSync(join(workDir, DESFECHO_FILENAME), "{not json", "utf8");
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });
});

describe("the ruler — six classes, decided transitions (ticket 13)", () => {
  describe("class 1 — outcome record says pr-open: the claim is held, awaiting the human", () => {
    test("a pr-open record with the PR confirmed open stays reserved", () => {
      const ruling = classifyOutcome(
        facts({
          record: { class: "pr-open", attempt: 1 },
          prOpen: true,
        }),
      );
      assert.equal(ruling.decision, "reserve");
      assert.equal(ruling.because, "pr-open");
    });
  });

  describe("class 2 — fall without PR, 1st consecutive: release (claimed→ready; branch stays)", () => {
    test("a clean-without-pr record falls and releases on the 1st consecutive fall", () => {
      const ruling = classifyOutcome(
        facts({
          record: { class: "clean-without-pr", attempt: 1 },
          consecutiveFall: false,
        }),
      );
      assert.equal(ruling.decision, "release");
      assert.equal(ruling.because, "fall-first");
    });
  });

  describe("class 3 — fall without PR, 2nd consecutive: blocked + comment with the exact outcome", () => {
    test("the 2nd consecutive fall blocks with a comment", () => {
      const record = { class: "clean-without-pr" as const, attempt: 2 };
      const ruling = classifyOutcome(facts({ record, consecutiveFall: true }));
      assert.equal(ruling.decision, "block");
      assert.equal(ruling.because, "fall-second");
      assert.match(ruling.comment, /clean-without-pr/);
      assert.match(ruling.comment, /\"attempt\"\: 2/);
    });
  });

  describe("class 4 — NO outcome record: abrupt fall, the same ruler as 2/3", () => {
    test("an absent record is a fall — the 1st releases", () => {
      const ruling = classifyOutcome(facts({ record: null, consecutiveFall: false }));
      assert.equal(ruling.decision, "release");
      assert.equal(ruling.because, "fall-first");
    });

    test("an absent record after a previous fall blocks, with the abrupt class in the comment", () => {
      const ruling = classifyOutcome(
        facts({ record: null, consecutiveFall: true, attempt: 3 }),
      );
      assert.equal(ruling.decision, "block");
      assert.equal(ruling.because, "fall-second");
      assert.match(ruling.comment, /attempt 3/);
      assert.match(ruling.comment, /no outcome record/i);
    });
  });

  describe("class 5 — PR already existing on the issue: reserved, no fall recorded", () => {
    test("an open PR turns even a fall record into a reserve — no fall recorded, no consecutiveness", () => {
      const ruling = classifyOutcome(
        facts({
          record: { class: "clean-without-pr", attempt: 3 },
          prOpen: true,
          consecutiveFall: true,
        }),
      );
      assert.equal(ruling.decision, "reserve");
      assert.equal(ruling.because, "pr-open");
    });

    test("an open PR turns even an absent record into a reserve —never a fall", () => {
      const ruling = classifyOutcome(
        facts({ prOpen: true, consecutiveFall: true }),
      );
      assert.equal(ruling.decision, "reserve");
      assert.equal(ruling.because, "pr-open");
    });
  });

  describe("class 6 — blocked self-report (marker + label already posted): the factory only records it", () => {
    test("a blocked-self-report record is record-only — no transition, no relaunch", () => {
      const ruling = classifyOutcome(
        facts({
          record: { class: "blocked-self-report", attempt: 1 },
          blockedLabelOnIssue: true,
        }),
      );
      assert.equal(ruling.decision, "record-only");
      assert.equal(ruling.because, "blocked-self-report");
    });

    test("the blocked label alone (record lost) is still a self-report — a structured label fact", () => {
      const ruling = classifyOutcome(
        facts({
          record: null,
          blockedLabelOnIssue: true,
          consecutiveFall: false,
        }),
      );
      assert.equal(ruling.decision, "record-only");
      assert.equal(ruling.because, "blocked-self-report");
    });
  });

  test("prose is never read: an unknown record class is treated as absent (abrupt fall)", () => {
    // readOutcomeRecord rejected it already — the ruler never even sees it.
    const ruling = classifyOutcome(facts({ record: null, consecutiveFall: true }));
    assert.equal(ruling.decision, "block");
  });

  describe("the blocked comment carries the exact outcome (the desfecho, verbatim)", () => {
    test("a recorded fall embeds the exact record JSON", () => {
      const record = {
        class: "clean-without-pr" as const,
        attempt: 2,
        paths: { log: "log-2.jsonl" },
      };
      const comment = blockedCommentBody(record);
      assert.match(comment, /2 consecutive falls/i);
      assert.ok(comment.includes(JSON.stringify(record, null, 2)), "the exact desfecho JSON is embedded");
    });

    test("an abrupt fall embeds a structured statement of absence", () => {
      const comment = blockedCommentBody(null, 3);
      assert.match(comment, /attempt 3/);
      assert.match(comment, /no outcome record/i);
    });
  });
});
