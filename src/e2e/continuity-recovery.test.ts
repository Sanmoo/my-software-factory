import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { runOnce, type LoopDeps } from "../loop.js";
import { type GitWork, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { readGuardrailState, readPause } from "../runtime/continuity-artifacts.js";
import { appendJournalIntent, appendJournalStart, appendSessionLink } from "../runtime/continuity-artifacts.js";
import { readRecoveryLedger } from "../pool/recovery.js";
import { seedSession, seedSessionToolCall } from "./session-fixtures.js";
import type { IssueRef } from "../tracker/port.js";

/**
 * e2e of issue 119 on the operational cycle: a recovery continues the SAME
 * attempt by reopening ITS persisted session, and when it cannot prove the
 * continuation safe the work pauses for the operator — persisted, without
 * spending a recovery, without repeating the request every cycle, and without
 * stopping the other works. The artifacts are real files; the tracker and git
 * boundaries are the adapters the rest of the suite uses.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements GitWork {
  remoteHead: string | null = null;
  diff = "diff --git a/x b/x";
  readonly prepared: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: `agent-issue-${ref.number}`,
      baseBranch: "main",
      branchCreated: false,
      branchOnOrigin: true,
    };
  }
  async cleanupDoneWork(): Promise<void> {}
  async diffWork(): Promise<string> {
    return this.diff;
  }
  async observeRemoteHead(): Promise<string | null> {
    return this.remoteHead;
  }
  async inspectLocalWork(): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

describe("e2e: continuity of the interrupted attempt (issue 119)", () => {
  let dir: string;
  let layout: WorkspaceLayout;
  let tracker: FakeTrackerAdapter;
  let git: FakeGitWork;
  let runtime: FakeWorkerRuntime;
  let notifier: FakeNotifier;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-continuity-"));
    layout = ensureWorkspace(join(dir, "ws"));
    tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    git = new FakeGitWork();
    notifier = new FakeNotifier();
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(concurrency = 1): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function deps(cfg = config()): LoopDeps {
    runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open", "pr-open", "pr-open"] });
    return {
      config: cfg,
      tracker,
      runtime,
      git,
      workspace: layout,
      log: (line) => logs.push(line),
      notifier,
      wait: async () => {},
    };
  }

  /** The durable footprint of an interrupted attempt 2 whose session exists. */
  function interruptedAttempt2(options: { pending?: "push" | "unknown"; remote?: string | null } = {}): {
    session: ReturnType<typeof seedSession>;
    ref: IssueRef;
    dir: string;
  } {
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-end","attempt":1}\n', "utf8");
    writeFileSync(join(target, "desfecho.json"), JSON.stringify({ class: "clean-without-pr", attempt: 1 }), "utf8");
    writeFileSync(join(target, "log-2.jsonl"), '{"event":"session-start","attempt":2}\n', "utf8");

    const session = seedSession(target, ref, 2);
    const callId = options.pending === "push" ? "call-push" : "call-unknown";
    const command = options.pending === "push" ? "git push origin agent-issue-7" : "curl -X POST https://example.com";
    seedSessionToolCall(session, { callId, command, answered: false });
    appendJournalStart(target, { attempt: 2, sessionId: session.sessionId });

    if (options.pending === "push") {
      const sha = "abc123";
      appendJournalIntent(target, {
        attempt: 2,
        sessionId: session.sessionId,
        callId,
        tool: "bash",
        command,
        safety: "effect",
        actions: [{ kind: "push", key: `push:agent-issue-7@${sha}`, detail: "push branch agent-issue-7", branch: "agent-issue-7", sha }],
      });
      git.remoteHead = options.remote === undefined ? sha : options.remote;
    } else if (options.pending === "unknown") {
      appendJournalIntent(target, {
        attempt: 2,
        sessionId: session.sessionId,
        callId,
        tool: "bash",
        command,
        safety: "unknown",
        actions: [],
        reason: "curl is not a proven-local command",
      });
    }
    return { session, ref, dir: target };
  }

  async function labelsOf(number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known);
    return issue.value.labels;
  }

  async function issueComments(number: number): Promise<string[]> {
    const comments = await tracker.readComments({ repo: REPO, number });
    assert.ok(comments.known);
    return comments.value.map((comment) => comment.body);
  }

  /** The factory's own comments only — the human's answer is not spam. */
  async function agentComments(number: number): Promise<string[]> {
    return (await issueComments(number)).filter((body) => body.includes("<!-- msf:agent -->"));
  }

  test("a recovery reopens the attempt's OWN session, keeps the attempt and the branch, and reuses its progress", async () => {
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "abc123" });
    const cfg = config();
    const result = await runOnce(deps(cfg));

    assert.equal(result.launched.length, 1);
    const request = result.launched[0]!.request;
    assert.equal(request.attempt, 2, "the SAME attempt continues");
    assert.equal(request.branch, "agent-issue-7", "the branch is preserved");
    assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId });

    // The runtime really reopened the file it was given (the fake appends a
    // continuation entry): progress stays in the same session.
    assert.equal(runtime.resumed.length, 1);
    assert.equal(runtime.resumed[0]?.session?.sessionId, session.sessionId);
    const content = readFileSync(session.file, "utf8");
    assert.match(content, /continue attempt 2/);

    // The realized effect was handed to the guardrail as realized.
    assert.equal(
      readGuardrailState(workDir(layout, REPO, 7))?.verdicts["push:agent-issue-7@abc123"],
      "realized",
    );

    // One recovery was spent on the same attempt, and the new record is attempt 2's.
    const ledger = await readRecoveryLedger(workDir(layout, REPO, 7));
    assert.equal(ledger.attempt, 2);
    assert.equal(ledger.consumed, 1);
    const record = JSON.parse(readFileSync(join(workDir(layout, REPO, 7), "desfecho.json"), "utf8"));
    assert.equal(record.attempt, 2);
    assert.equal(record.class, "pr-open");
    assert.ok(ref.number === 7);
  });

  test("without a recorded session the work pauses for help: no attempt, no recovery, evidence preserved", async () => {
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    // A legacy attempt: logs exist, no association — the factory must not guess.
    writeFileSync(join(target, "log-2.jsonl"), '{"event":"session-start","attempt":2}\n', "utf8");
    writeFileSync(
      join(target, "sessao-vinculos.jsonl"),
      `${JSON.stringify({ version: 1, work: ref, attempt: 1, round: 1, mode: "new", sessionId: "other-attempt", at: NOW })}\n`,
      "utf8",
    );

    const cfg = config();
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 0, "no blind relaunch");
    assert.equal(runtime.launched.length, 0);
    assert.equal(readPause(target)?.reason, "link-missing");
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), true, "the operator is asked on the issue");
    const comments = await issueComments(7);
    assert.equal(comments.length, 1, "one help request");
    assert.match(comments[0] ?? "", /cannot be continued safely/);
    assert.match(comments[0] ?? "", /no attempt was consumed/);

    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.consumed, 0, "a continuity pause spends no recovery");
    assert.equal(readdirSync(target).includes("log-2.jsonl"), true, "the evidence is preserved");

    // A restart (another sweep) does not repeat the request and still launches nothing.
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal((await issueComments(7)).length, 1, "no comment spam across cycles/restart");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0);
  });

  test("a pause persisted before its block landed is announced on the next cycle — once", async () => {
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-start","attempt":1}\n', "utf8");
    // The factory died after persisting the pause: the label swap never landed.
    writeFileSync(
      join(target, "pausa.json"),
      JSON.stringify({
        version: 1,
        work: { repo: REPO, number: 7 },
        attempt: 1,
        reason: "session-missing",
        detail: "the recorded session is gone",
        at: NOW,
      }),
      "utf8",
    );

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0, "the persisted pause keeps the work out of every launch");
    assert.equal(sweep.reserved.find((entry) => entry.state === "continuity-paused")?.attempt, 1);
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0);
    assert.ok(
      logs.some((line) => line.includes("paused for help") && line.includes("session-missing")),
      "the diagnosis names the pause",
    );
    // The death landed before the block and the request: the operator is told now.
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), true, "the block lands on the next cycle");
    assert.equal((await agentComments(7)).length, 1, "and exactly one help request");
    assert.equal(readPause(target)?.announced, true);

    // Once announced, a restart neither blocks again nor repeats the request.
    const restart = await runOnce(deps(config()));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, 1, "no second request");
  });

  test("an interrupted command with no reconciliation pauses; another eligible work keeps progressing", async () => {
    interruptedAttempt2({ pending: "unknown" });
    seedIssue(tracker, { repo: REPO, number: 8, createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });

    const cfg = config(1);
    const sweep = await runOnce(deps(cfg));

    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-unsupported");
    assert.deepEqual(
      runtime.launched.map((request) => request.ref.number),
      [8],
      "the paused work does not stop the factory",
    );
    const issue7 = await tracker.readIssue({ repo: REPO, number: 7 });
    assert.ok(issue7.known && issue7.value.labels.includes(DEFAULT_LABELS.blocked));
  });

  test("the operator's answer does not authorize a replay: the facts are read again, and only a settled effect starts a new round", async () => {
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "def456" });
    const cfg = config();
    const first = await runOnce(deps(cfg));
    assert.equal(first.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-ambiguous");
    const asked = (await agentComments(7)).length;

    // The human answers — the effect is still ambiguous: the work stays paused,
    // no new attempt, no new session, no repeated request.
    tracker.addComment(ref, "operator", "I did not push anything, check again.");
    git.remoteHead = "def456";
    const answered = await runOnce(deps(cfg));
    assert.equal(answered.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-ambiguous");
    assert.equal(
      (await agentComments(7)).length,
      asked + 1,
      "the answer gets ONE reply saying the facts are still unsettled — not a request per cycle",
    );

    // A restart with no further answer changes nothing: no launch, no comment.
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, asked + 1);

    // The facts change AND the operator says so (the remote now proves the
    // push): the next round is a NEW session with the CURRENT orientation.
    tracker.addComment(ref, "operator", "I pushed it; the head is abc123.");
    git.remoteHead = "abc123";
    git.diff = "diff --git a/current b/current";
    const resolved = await runOnce(deps(cfg));
    assert.equal(resolved.launched.length, 1);
    const request = resolved.launched[0]!.request;
    assert.equal(request.session?.mode, "new", "a new orientation round, not a blind replay of the old session");
    assert.notEqual(request.session?.sessionId, session.sessionId);
    assert.equal(request.attempt, 3, "the human answer opens the next attempt");
    assert.deepEqual(request.material.issueReplies?.map((comment) => comment.body), ["I pushed it; the head is abc123."]);
    assert.equal(request.material.diff, "diff --git a/current b/current", "the current diff, not the old one");
    assert.equal(readPause(workDir(layout, REPO, 7)), null, "the resolved pause is cleared");
  });

  test("an effect proven absent may run once: the session is reopened with the absent verdict", async () => {
    const { session } = interruptedAttempt2({ pending: "push", remote: null });
    const sweep = await runOnce(deps(config()));
    assert.equal(sweep.launched.length, 1);
    assert.equal(sweep.launched[0]?.request.session?.sessionId, session.sessionId);
    assert.equal(
      readGuardrailState(workDir(layout, REPO, 7))?.verdicts["push:agent-issue-7@abc123"],
      "absent",
    );
  });

  test("later human feedback is a NEW round with the current orientation, never a continuation of the old session", async () => {
    // Attempt 1 finished with a PR: the session that opened it still exists
    // on disk and its association is recorded for attempt 1.
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-end","attempt":1}\n', "utf8");
    writeFileSync(join(target, "desfecho.json"), JSON.stringify({ class: "pr-open", attempt: 1 }), "utf8");
    const oldSession = seedSession(target, ref, 1);
    tracker.seedPullRequest({ repo: REPO, number: 7, headBranch: "agent-issue-7" });
    git.diff = "diff --git a/current b/current";

    tracker.addPrComment({ repo: REPO, prNumber: 7 }, "operator", "please use the new helper");
    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 1);
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 2, "the human's feedback opens the next attempt");
    assert.equal(request.session?.mode, "new", "a feedback round is not a resumed execution");
    assert.notEqual(request.session?.sessionId, oldSession.sessionId);
    assert.equal(request.material.diff, "diff --git a/current b/current", "the current diff, not the old one");
    assert.deepEqual(
      request.material.pr?.comments.map((comment) => comment.body),
      ["please use the new helper"],
      "the current PR conversation is the orientation; the old history is only context",
    );
  });

  test("an unreadable session pauses and is not overwritten to look usable", async () => {
    const { session } = interruptedAttempt2({ pending: "push", remote: "abc123" });
    const before = readFileSync(session.file, "utf8");
    writeFileSync(session.file, `${before}not-json-inside\n${before.split("\n")[1]}\n`, "utf8");
    const corrupted = readFileSync(session.file, "utf8");

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "session-unreadable");
    assert.equal(readFileSync(session.file, "utf8"), corrupted, "the original state is preserved as evidence");
    const comments = await issueComments(7);
    assert.match(comments.at(-1) ?? "", /session history is unreadable/);
  });
});
