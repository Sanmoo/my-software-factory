import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { ensureWorkspace, workDir } from "../layout.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "./fake-runtime.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import type { WorkRequest } from "./port.js";

describe("fake runtime — worker launches with scripted outcomes", () => {
  let workspaceRoot: string;
  let layout: ReturnType<typeof ensureWorkspace>;
  let tracker: FakeTrackerAdapter;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "msf-runtime-"));
    layout = ensureWorkspace(workspaceRoot);
    tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(tracker, { repo: "Sanmoo/a", number: 3 });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeRuntime(script: ScriptedOutcome[]): FakeWorkerRuntime {
    return new FakeWorkerRuntime({ outcomes: script, tracker });
  }

  const request = (dir: string): WorkRequest => ({
    ref: { repo: "Sanmoo/a", number: 3 },
    workDir: dir,
    branch: "agent-issue-3",
    repoDir: "/clones/Sanmoo#a",
    baseBranch: "main",
    attempt: 1,
    material: {
      issue: { title: "issue #3", body: "" },
      diff: "",
    },
  });

  test("records every launch for assertions", async () => {
    const runtime = makeRuntime([]);
    await runtime.launch(request(join(layout.works, "x-1")));
    assert.equal(runtime.launched.length, 1);
    assert.equal(runtime.launched[0]?.ref.number, 3);
  });

  test("scripted pr-open: writes the outcome record and opens the PR via the tracker", async () => {
    const runtime = makeRuntime(["pr-open"]);
    const dir = workDir(layout, "Sanmoo/a", 3);

    const result = await runtime.launch(request(dir));

    assert.equal(result.outcome, "pr-open");
    const record = JSON.parse(readFileSync(join(dir, DESFECHO_FILENAME), "utf8"));
    assert.equal(record.class, "pr-open");
    const feedback = await tracker.readPrFeedback({ repo: "Sanmoo/a", number: 3 });
    assert.ok(feedback.known && feedback.value.pr !== null);
  });

  test("scripted clean-without-pr: record written, no PR opened", async () => {
    const runtime = makeRuntime(["clean-without-pr"]);
    const dir = workDir(layout, "Sanmoo/a", 3);

    const result = await runtime.launch(request(dir));

    assert.equal(result.outcome, "clean-without-pr");
    const record = JSON.parse(readFileSync(join(dir, DESFECHO_FILENAME), "utf8"));
    assert.equal(record.class, "clean-without-pr");
    const feedback = await tracker.readPrFeedback({ repo: "Sanmoo/a", number: 3 });
    assert.ok(feedback.known && feedback.value.pr === null);
  });

  test("scripted blocked-self-report: record carries the blocked class", async () => {
    const runtime = makeRuntime(["blocked-self-report"]);
    const dir = workDir(layout, "Sanmoo/a", 3);

    await runtime.launch(request(dir));

    const record = JSON.parse(readFileSync(join(dir, DESFECHO_FILENAME), "utf8"));
    assert.equal(record.class, "blocked-self-report");
  });

  test("scripted abrupt-death: no outcome record at all — its absence is the class", async () => {
    const runtime = makeRuntime(["abrupt-death"]);
    const dir = workDir(layout, "Sanmoo/a", 3);

    const result = await runtime.launch(request(dir));

    assert.equal(result.outcome, "abrupt-death");
    assert.ok(!existsSync(join(dir, DESFECHO_FILENAME)));
  });

  test("outcomes are consumed in script order, then the last repeats", async () => {
    const runtime = makeRuntime(["pr-open", "abrupt-death"]);
    const dirA = workDir(layout, "Sanmoo/a", 1);
    const dirB = workDir(layout, "Sanmoo/a", 2);
    const dirC = workDir(layout, "Sanmoo/a", 3);

    const first = await runtime.launch(request(dirA));
    const second = await runtime.launch(request(dirB));
    const third = await runtime.launch(request(dirC));

    assert.equal(first.outcome, "pr-open");
    assert.equal(second.outcome, "abrupt-death");
    assert.equal(third.outcome, "abrupt-death");
  });

  // ---- ticket 13: the per-work artifacts the runtime writes ----

  describe("per-work artifacts on real disk (ticket 13)", () => {
    test("every launch writes the session dir and the attempt's event log", async () => {
      const runtime = makeRuntime(["pr-open"]);
      const dir = workDir(layout, "Sanmoo/a", 3);

      await runtime.launch(request(dir));

      assert.ok(existsSync(join(dir, "sessao")), "the session dir is written at launch");
      assert.ok(existsSync(join(dir, "log-1.jsonl")), "log-<n>.jsonl for attempt n");
      const log = readFileSync(join(dir, "log-1.jsonl"), "utf8");
      assert.match(log, /"event":"session-start"/);
    });

    test("a scripted end appends the session-end event to the attempt's log", async () => {
      const runtime = makeRuntime(["clean-without-pr"]);
      const dir = workDir(layout, "Sanmoo/a", 3);

      await runtime.launch(request(dir));

      const log = readFileSync(join(dir, "log-1.jsonl"), "utf8");
      assert.match(log, /"event":"session-start"/);
      assert.match(log, /"event":"session-end"/);
      assert.match(log, /clean-without-pr/);
    });

    test("an abrupt death leaves only the start line — the log records that the attempt began and never ended", async () => {
      const runtime = makeRuntime(["abrupt-death"]);
      const dir = workDir(layout, "Sanmoo/a", 3);

      await runtime.launch(request(dir));

      const log = readFileSync(join(dir, "log-1.jsonl"), "utf8");
      assert.match(log, /"event":"session-start"/);
      assert.doesNotMatch(log, /"event":"session-end"/);
      assert.ok(!existsSync(join(dir, DESFECHO_FILENAME)));
    });

    test("each attempt gets its own log file (log-<attempt>.jsonl)", async () => {
      const runtime = makeRuntime(["clean-without-pr", "clean-without-pr"]);
      const dir = workDir(layout, "Sanmoo/a", 3);

      await runtime.launch({ ...request(dir), attempt: 1 });
      await runtime.launch({ ...request(dir), attempt: 2 });

      assert.ok(existsSync(join(dir, "log-1.jsonl")));
      assert.ok(existsSync(join(dir, "log-2.jsonl")));
    });
  });
});
