import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";

import {
  readOutcomeRecord,
  classifyOutcome,
  blockedCommentBody,
  interruptionPausedCommentBody,
  DESFECHO_FILENAME,
} from "./outcome.js";
import { DEFAULT_RECOVERY_POLICY } from "../config.js";

/** A layout outside the filesystem — the evidence probes it and answers absent. */
const FAKE_WORKSPACE: WorkspaceLayout = {
  root: "/nowhere",
  repos: "/nowhere/repos",
  works: "/nowhere/trabalhos",
  archive: "/nowhere/archive",
};

/**
 * Factory building the structured facts the ruler reads: the outcome
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
    issueClosed: false,
    workDir: "/nowhere/trabalhos/Sanmoo/a#1",
    workspace: FAKE_WORKSPACE,
    ...overrides,
  };
}

describe("outcome — the factory's ruler reads only structured facts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-outcome-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the artifact contract is desfecho.json, in PT-BR on disk", () => {
    assert.equal(DESFECHO_FILENAME, "desfecho.json");
  });

  test("an outcome record on disk parses into the structured schema", async () => {
    writeFileSync(
      join(dir, DESFECHO_FILENAME),
      JSON.stringify({
        class: "pr-open",
        attempt: 1,
        pr: { repo: "Sanmoo/a", number: 12, branch: "agent-issue-3" },
      }),
      "utf8",
    );

    const record = await readOutcomeRecord(dir);

    assert.ok(record);
    assert.equal(record.class, "pr-open");
    assert.equal(record.attempt, 1);
  });

  test("the absence of the record is the fact 'no-outcome' (null, no error)", async () => {
    const record = await readOutcomeRecord(dir);
    assert.equal(record, null);
  });

  test("a record that breaks the schema is invalid — never interpreted as prose", async () => {
    writeFileSync(join(dir, DESFECHO_FILENAME), JSON.stringify({ class: "whatever" }), "utf8");
    const record = await readOutcomeRecord(dir);
    assert.equal(record, null);
  });

  test("a corrupt record is treated as absent (no-outcome), not a crash", async () => {
    writeFileSync(join(dir, DESFECHO_FILENAME), "{not json", "utf8");
    const record = await readOutcomeRecord(dir);
    assert.equal(record, null);
  });
});

describe("the ruler — six classes, decided transitions (ticket 13)", () => {
  describe("class 1 — outcome record says pr-open: the claim is held, awaiting the human", () => {
    test("a pr-open record with the PR confirmed open stays reserved", async () => {
      const ruling = await classifyOutcome(
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
    test("a clean-without-pr record falls and releases on the 1st consecutive fall", async () => {
      const ruling = await classifyOutcome(
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
    test("the 2nd consecutive fall blocks with a comment", async () => {
      const record = { class: "clean-without-pr" as const, attempt: 2 };
      const ruling = await classifyOutcome(facts({ record, attempt: 2, consecutiveFall: true }));
      assert.equal(ruling.decision, "block");
      assert.equal(ruling.because, "fall-second");
      assert.match(ruling.comment, /clean-without-pr/);
      assert.match(ruling.comment, /"attempt": 2/);
    });
  });

  describe("class 4 — NO outcome record: an interruption, never a failure (issue 123)", () => {
    test("an absent record interrupts the attempt — no release, no block, no fall counted", async () => {
      const ruling = await classifyOutcome(facts({ record: null, consecutiveFall: false }));
      assert.equal(ruling.decision, "interrupt");
      assert.equal(ruling.because, "no-outcome");
    });

    test("an absent record never blocks, even after a previous failure — the interruption is not the 2nd fall", async () => {
      const ruling = await classifyOutcome(
        facts({ record: null, consecutiveFall: true, attempt: 3 }),
      );
      assert.equal(ruling.decision, "interrupt");
    });

    test("a record of another attempt is absent for this attempt: an interruption, not a fall", async () => {
      const ruling = await classifyOutcome(
        facts({
          record: { class: "clean-without-pr", attempt: 1 },
          attempt: 3,
          consecutiveFall: true,
        }),
      );
      assert.equal(ruling.decision, "interrupt", "the other attempt's failure is history, never this one's");
    });
  });

  describe("class 5 — PR already existing on the issue: reserved, no fall recorded", () => {
    test("an open PR turns even a fall record into a reserve — no fall recorded, no consecutiveness", async () => {
      const ruling = await classifyOutcome(
        facts({
          record: { class: "clean-without-pr", attempt: 3 },
          prOpen: true,
          consecutiveFall: true,
          attempt: 3,
        }),
      );
      assert.equal(ruling.decision, "reserve");
      assert.equal(ruling.because, "pr-open");
    });

    test("an open PR turns even an absent record into a reserve —never a fall", async () => {
      const ruling = await classifyOutcome(
        facts({ prOpen: true, consecutiveFall: true }),
      );
      assert.equal(ruling.decision, "reserve");
      assert.equal(ruling.because, "pr-open");
    });
  });

  describe("class 6 — blocked self-report (marker + label already posted): the factory only records it", () => {
    test("a blocked-self-report record is record-only — no transition, no relaunch", async () => {
      const ruling = await classifyOutcome(
        facts({
          record: { class: "blocked-self-report", attempt: 1 },
          blockedLabelOnIssue: true,
        }),
      );
      assert.equal(ruling.decision, "record-only");
      assert.equal(ruling.because, "blocked-self-report");
    });

    test("the blocked label alone (record lost) is still a self-report — a structured label fact", async () => {
      const ruling = await classifyOutcome(
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

  test("prose is never read: an unknown record class is treated as absent (an interruption)", async () => {
    // readOutcomeRecord rejected it already — the ruler never even sees it.
    const ruling = await classifyOutcome(facts({ record: null, consecutiveFall: true }));
    assert.equal(ruling.decision, "interrupt");
  });

  describe("ticket 14 — the terminal state is read at the act too", () => {
    test("an issue closed (done by linkage while the claim was held) ends the work: archive, no release, no fall", async () => {
      // The human merged while a feedback round was still in flight: the issue
      // is terminal — the claim ends, artifacts are archived, nothing falls.
      const ruling = await classifyOutcome(
        facts({ record: { class: "pr-open", attempt: 2 }, attempt: 2, issueClosed: true }),
      );
      assert.equal(ruling.decision, "done");
      assert.equal(ruling.because, "issue-closed");
    });

    test("issue closed wins over everything — even a fall without PR", async () => {
      const ruling = await classifyOutcome(
        facts({ record: null, consecutiveFall: true, issueClosed: true }),
      );
      assert.equal(ruling.decision, "done");
    });
  });

  describe("the blocked comment carries the exact outcome (the desfecho, verbatim)", () => {
    test("a recorded failure embeds the exact record JSON", async () => {
      const record = {
        class: "clean-without-pr" as const,
        attempt: 2,
        paths: { log: "log-2.jsonl" },
      };
      const comment = await blockedCommentBody({
        attempt: 2,
        record,
        workDir: "/nowhere/trabalhos/Sanmoo/a#1",
        workspace: FAKE_WORKSPACE,
      });
      assert.match(comment, /2 consecutive falls/i);
      assert.ok(comment.includes(JSON.stringify(record, null, 2)), "the exact desfecho JSON is embedded");
    });

    test("an interruption is described as an interruption, never as a fall", async () => {
      const comment = await blockedCommentBody({
        attempt: 3,
        record: null,
        workDir: "/nowhere/trabalhos/Sanmoo/a#1",
        workspace: FAKE_WORKSPACE,
      });
      assert.match(comment, /attempt 3/);
      assert.match(comment, /interrupted: no outcome record was written/);
      assert.ok(!comment.includes("abrupt fall"), "an interruption is never called an abrupt fall");
    });
  });
});

describe("issue 103 — the outcome record belongs to an attempt; the comment points at the evidence", () => {
  let root: string;
  let layout: WorkspaceLayout;
  const ref = { repo: "Sanmoo/my-tasks", number: 91 };
  const relativeDir = "trabalhos/Sanmoo/my-tasks#91";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-outcome-103-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The attempt's real dir in the workspace — the evidence lives there. */
  function makeWorkDir(): string {
    const dir = workDir(layout, ref.repo, ref.number);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const factsFor = (
    attemptDir: string,
    overrides: Partial<Parameters<typeof classifyOutcome>[0]> = {},
  ) => facts({ workDir: attemptDir, workspace: layout, ...overrides });

  test("a record of another attempt is absent for this attempt: an old blocked-self-report without the current label is not record-only", async () => {
    const dir = makeWorkDir();
    const record = { class: "blocked-self-report" as const, attempt: 1 };

    const second = await classifyOutcome(factsFor(dir, { record, attempt: 3, consecutiveFall: true }));
    assert.equal(second.decision, "interrupt", "the current attempt was interrupted, not failed");
    assert.equal(second.because, "no-outcome");
  });

  test("the pause comment names the interrupted attempt and explains the divergent record; the old JSON is not embedded", async () => {
    const dir = makeWorkDir();
    writeFileSync(join(dir, "log-3.jsonl"), "{}\n", "utf8");

    const comment = await interruptionPausedCommentBody({
      attempt: 3,
      policy: DEFAULT_RECOVERY_POLICY,
      record: { class: "blocked-self-report", attempt: 1, paths: { log: "log-1.jsonl" } },
      workDir: dir,
      workspace: layout,
    });

    assert.match(comment, /attempt 3 was interrupted and the recovery budget is exhausted/);
    assert.match(comment, /interrupted: no outcome record of its own was written/);
    assert.match(comment, /the record on disk belongs to attempt 1/);
    assert.ok(
      !comment.includes('"class": "blocked-self-report"'),
      "the old record is never presented as this attempt's outcome",
    );
  });

  test("a valid record of the current attempt keeps its treatment — JSON preserved, evidence appended", async () => {
    const dir = makeWorkDir();
    writeFileSync(join(dir, "log-2.jsonl"), "{}\n", "utf8");
    const record = { class: "clean-without-pr" as const, attempt: 2, paths: {} };

    const ruling = await classifyOutcome(factsFor(dir, { record, attempt: 2, consecutiveFall: true }));

    assert.equal(ruling.decision, "block");
    assert.match(ruling.comment, /2 consecutive falls \(attempt 2\) — the exact outcome record:/);
    assert.ok(ruling.comment.includes(JSON.stringify(record, null, 2)), "the record's JSON is preserved");
    assert.match(ruling.comment, /trabalhos\/Sanmoo\/my-tasks#91\/log-2\.jsonl — present/);
    assert.match(ruling.comment, /trabalhos\/Sanmoo\/my-tasks#91\/sessao\/sandcastle-2\.log — absent/);
  });

  test("without paths the three locations still show, all relative to the named workspace", async () => {
    const dir = makeWorkDir();
    const comment = await interruptionPausedCommentBody({
      attempt: 3,
      policy: DEFAULT_RECOVERY_POLICY,
      record: null,
      workDir: dir,
      workspace: layout,
    });

    for (const path of [
      `${relativeDir}/`,
      `${relativeDir}/log-3.jsonl`,
      `${relativeDir}/sessao/sandcastle-3.log`,
    ]) {
      assert.ok(comment.includes(path), `${path} is shown`);
    }
    assert.match(comment, /relative to the factory workspace on the host/);
    assert.match(comment, /workspace of msf\.yaml/);
    assert.ok(!comment.includes(root), "no absolute host path is shown");
  });

  test("an unverifiable location stays in the pause comment — a query error is not absence", async () => {
    // A self-referential symlink: the query fails, the location is unknown.
    symlinkSync("sessao", join(makeWorkDir(), "sessao"));

    const comment = await interruptionPausedCommentBody({
      attempt: 3,
      policy: DEFAULT_RECOVERY_POLICY,
      record: null,
      workDir: workDir(layout, ref.repo, ref.number),
      workspace: layout,
    });

    assert.match(
      comment,
      /trabalhos\/Sanmoo\/my-tasks#91\/sessao\/sandcastle-3\.log — could not be verified/,
    );
  });

  test("the tracker facts keep their existing priority over a divergent record", async () => {
    const dir = makeWorkDir();
    const record = { class: "blocked-self-report" as const, attempt: 1 };

    assert.equal(
      (await classifyOutcome(factsFor(dir, { record, attempt: 3, blockedLabelOnIssue: true }))).decision,
      "record-only",
    );
    assert.equal(
      (await classifyOutcome(factsFor(dir, { record, attempt: 3, prOpen: true }))).decision,
      "reserve",
    );
    assert.equal(
      (await classifyOutcome(factsFor(dir, { record, attempt: 3, issueClosed: true }))).decision,
      "done",
    );
  });

  test("the old record stays on disk as history — preparing the comment never deletes or rewrites it", async () => {
    const dir = makeWorkDir();
    const onDisk = { class: "blocked-self-report" as const, attempt: 1 };
    writeFileSync(join(dir, DESFECHO_FILENAME), JSON.stringify(onDisk), "utf8");
    writeFileSync(join(dir, "log-3.jsonl"), "{}\n", "utf8");

    await classifyOutcome(
      factsFor(dir, {
        record: await readOutcomeRecord(dir),
        attempt: 3,
        consecutiveFall: true,
      }),
    );

    assert.deepEqual(await readOutcomeRecord(dir), onDisk, "history reading still sees the old record");
  });
});
