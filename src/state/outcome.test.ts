import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";

import { DESFECHO_FILENAME, readOutcomeRecord } from "../work-record/outcome.js";
import {
  blockedCommentBody,
  interruptionPausedCommentBody,
  isRecordedFailure,
  ownWrittenOutcome,
  continuityPausedCommentBody,
} from "./outcome.js";
import { DEFAULT_RECOVERY_BUDGET } from "../config.js";

/** A layout outside the filesystem — the evidence probes it and answers absent. */
const FAKE_WORKSPACE: WorkspaceLayout = {
  root: "/nowhere",
  repos: "/nowhere/repos",
  works: "/nowhere/trabalhos",
  archive: "/nowhere/archive",
  retros: "/nowhere/retros",
};

describe("outcome — the record contract, no prose ever", () => {
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

describe("the record's own rules and the comments they feed (tickets 05/13/123)", () => {
  test("a pr-open record is the attempt's own written outcome but never a failure (issue 123)", () => {
    const record = { class: "pr-open" as const, attempt: 1 };

    assert.equal(
      ownWrittenOutcome(record, 1),
      record,
      "the fall ruler applies to an own written outcome that is not a self-report",
    );
    assert.equal(isRecordedFailure(record), false, "a success settles no failure stop in the diagnosis");
    assert.equal(isRecordedFailure({ class: "clean-without-pr", attempt: 1 }), true);
    assert.equal(isRecordedFailure({ class: "blocked-self-report", attempt: 1 }), false);
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

  test("the pause comment names the interrupted attempt and explains the divergent record; the old JSON is not embedded", async () => {
    const dir = makeWorkDir();
    writeFileSync(join(dir, "log-3.jsonl"), "{}\n", "utf8");

    const comment = await interruptionPausedCommentBody({
      attempt: 3,
      budget: DEFAULT_RECOVERY_BUDGET,
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

    const comment = await blockedCommentBody({ attempt: 2, record, workDir: dir, workspace: layout });

    assert.match(comment, /2 consecutive falls \(attempt 2\) — the exact outcome record:/);
    assert.ok(comment.includes(JSON.stringify(record, null, 2)), "the record's JSON is preserved");
    assert.match(comment, /trabalhos\/Sanmoo\/my-tasks#91\/log-2\.jsonl — present/);
    assert.match(comment, /trabalhos\/Sanmoo\/my-tasks#91\/sessao\/sandcastle-2\.log — absent/);
  });

  test("without paths the three locations still show, all relative to the named workspace", async () => {
    const dir = makeWorkDir();
    const comment = await interruptionPausedCommentBody({
      attempt: 3,
      budget: DEFAULT_RECOVERY_BUDGET,
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
      budget: DEFAULT_RECOVERY_BUDGET,
      record: null,
      workDir: workDir(layout, ref.repo, ref.number),
      workspace: layout,
    });

    assert.match(
      comment,
      /trabalhos\/Sanmoo\/my-tasks#91\/sessao\/sandcastle-3\.log — could not be verified/,
    );
  });

  test("the old record stays on disk as history — preparing the comment never deletes or rewrites it", async () => {
    const dir = makeWorkDir();
    const onDisk = { class: "blocked-self-report" as const, attempt: 1 };
    writeFileSync(join(dir, DESFECHO_FILENAME), JSON.stringify(onDisk), "utf8");
    writeFileSync(join(dir, "log-3.jsonl"), "{}\n", "utf8");

    await blockedCommentBody({
      attempt: 3,
      record: await readOutcomeRecord(dir),
      workDir: dir,
      workspace: layout,
    });

    assert.deepEqual(await readOutcomeRecord(dir), onDisk, "history reading still sees the old record");
  });
});

describe("issue 174 — the continuity pause asks for evidence the factory verifies", () => {
  const PAUSE_ID = "6f1c9a2e-1c1f-4f6b-9a1b-2f0f0b7c1111";
  const input = (overrides: Partial<Parameters<typeof continuityPausedCommentBody>[0]> = {}) => ({
    attempt: 2,
    evidencedAttempt: 2,
    reason: "effect-ambiguous" as const,
    id: PAUSE_ID,
    detail: "push branch agent-issue-7: the remote branch is at def456, not at the intended abc123",
    workDir: "/nowhere/trabalhos/Sanmoo/a#1",
    workspace: FAKE_WORKSPACE,
    ...overrides,
  });

  test("the request carries the pause identity and says what settles it — never an internal position", async () => {
    const comment = await continuityPausedCommentBody(input());

    assert.ok(comment.includes(`<!-- msf:pause:${PAUSE_ID} -->`), "the request is identifiable");
    assert.match(comment, /attempt 2 cannot be continued safely/);
    assert.match(comment, /no attempt was consumed/);
    assert.match(comment, /the pushed commit, the comment, the label/, "the evidence the resolver reads is named");
    assert.match(comment, /resolve the situation on the tracker/);
    assert.doesNotMatch(comment, /after the marker/, "the operator cannot see an internal marker");
  });

  test("an unverifiable effect says the factory cannot verify it and will not replay it", async () => {
    for (const reason of ["effect-unsupported", "effect-ambiguous", "tool-evidence-missing"] as const) {
      const comment = await continuityPausedCommentBody(input({ reason }));
      assert.match(comment, /cannot verify what that command did/, reason);
      assert.match(comment, /will not replay it/, reason);
      assert.match(comment, /a generic answer cannot authorize a retry/, reason);
      assert.match(comment, /never proof that an effect did not happen/, reason);
    }
  });

  test("a cause that is not an effect does not promise more than it can", async () => {
    const comment = await continuityPausedCommentBody(input({ reason: "session-missing" }));

    assert.match(comment, /the recorded session is gone/);
    assert.match(comment, /the facts are read again before any new round/i);
    assert.doesNotMatch(comment, /will not replay it/, "no replay promise where no effect is at stake");
  });

  test("a planned attempt that never started is not presented as the blocked one", async () => {
    const comment = await continuityPausedCommentBody(input({ attempt: 3, evidencedAttempt: 2 }));

    assert.match(comment, /the interrupted attempt 2 cannot be continued safely/);
    assert.match(comment, /the planned attempt 3 was never started/);
    assert.match(comment, /no attempt was consumed/);
    assert.doesNotMatch(comment, /attempt 3 cannot be continued safely/, "a phantom attempt is never blamed");
  });

  test("an attempt the record never named is not printed as attempt 0", async () => {
    const comment = await continuityPausedCommentBody(input({ attempt: 0, evidencedAttempt: 0 }));

    assert.match(comment, /this work's current attempt cannot be continued safely/);
    assert.doesNotMatch(comment, /attempt 0/);
  });
});
