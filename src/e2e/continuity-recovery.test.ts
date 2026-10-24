import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
} from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { runOnce, SweepEngine, type LoopDeps } from "../loop.js";
import { type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { launchedNumber } from "./work-fixtures.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { readEffectJournal, readGuardrailState, readPause } from "../runtime/continuity-artifacts.js";
import { appendJournalIntent, appendJournalStart } from "../runtime/continuity-artifacts.js";
import { humanCommentsForPause } from "../state/derive.js";
import { readRecoveryLedger } from "../pool/recovery.js";
import { seedExtraToolResult, seedSession, seedSessionToolCall, type SeededCallResult } from "./session-fixtures.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
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

class FakeGitWork implements LegacyGitWork {
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
      workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      retro: { ...DEFAULT_RETRO },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function deps(cfg = config()): LoopDeps {
    runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open", "pr-open", "pr-open"] });
    return {
      config: cfg,
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(git),
      workspace: layout,
      log: (line) => logs.push(line),
      notifier,
      wait: async () => {},
    };
  }

  /** The durable footprint of an interrupted attempt 2 whose session exists.
   *  `result` is what Pi persisted for the pending call: absent leaves the
   *  journal gap — a pending intent with no result — the incident reported. */
  function interruptedAttempt2(
    options: {
      pending?: "push" | "unknown";
      command?: string;
      remote?: string | null;
      labels?: string[];
      result?: SeededCallResult;
    } = {},
  ): {
    session: ReturnType<typeof seedSession>;
    ref: IssueRef;
    dir: string;
  } {
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, {
      repo: REPO,
      number: 7,
      createdAt: NOW,
      labels: options.labels ?? [DEFAULT_LABELS.claimed],
    });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-end","attempt":1}\n', "utf8");
    writeFileSync(join(target, "desfecho.json"), JSON.stringify({ class: "clean-without-pr", attempt: 1 }), "utf8");
    writeFileSync(join(target, "log-2.jsonl"), '{"event":"session-start","attempt":2}\n', "utf8");

    const session = seedSession(target, ref, 2);
    const callId = options.pending === "push" ? "call-push" : "call-unknown";
    const command = options.command ?? (options.pending === "push" ? "git push origin agent-issue-7" : "curl -X POST https://example.com");
    seedSessionToolCall(session, {
      callId,
      command,
      answered: options.result !== undefined,
      ...(options.result === undefined ? {} : { result: options.result }),
    });
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

  test("an unreadable pause keeps the work waiting instead of spending a recovery", async () => {
    // The record says "wait" and cannot be read. Falling back to a recovery
    // would spend the budget and post a second help request for a pause the
    // operator was already asked about — so the doubt itself keeps the work
    // parked, and the corrupt evidence is preserved for inspection.
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-start","attempt":1}\n', "utf8");
    writeFileSync(join(target, "pausa.json"), '{not a record', "utf8");

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0, "no recovery on a record it could not read");
    assert.equal(runtime.launched.length, 0);
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, "no recovery was spent");
    assert.equal(readFileSync(join(target, "pausa.json.unreadable"), "utf8"), "{not a record", "evidence preserved");
    const comments = await agentComments(7);
    assert.equal(comments.length, 1, "the operator is asked once");
    assert.match(comments[0] ?? "", /keeps waiting instead of recovering/);
    // The record could not name its attempt; the factory knows it by now and
    // says so, instead of printing a fabricated "attempt 0".
    assert.match(comments[0] ?? "", /attempt 1 cannot be continued safely/);
    assert.doesNotMatch(comments[0] ?? "", /attempt 0/);
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), true);

    // The record was rewritten as a real, announced pause: a restart asks nothing.
    const restart = await runOnce(deps(config()));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, 1, "no repeated request, no repeated recovery");
  });

  test("a pause persisted before its block landed is announced on the next cycle — once", async () => {
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
      logs.some((line) => line.includes("paused (link-missing)")),
      "the diagnosis names the pause the disk now gives (the attempt has no recorded session at all)",
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
    await runOnce(deps(cfg));

    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-unsupported");
    assert.deepEqual(
      runtime.launched.map(launchedNumber),
      [8],
      "the paused work does not stop the factory",
    );
    const issue7 = await tracker.readIssue({ repo: REPO, number: 7 });
    assert.ok(issue7.known && issue7.value.labels.includes(DEFAULT_LABELS.blocked));
  });

  test("a refusal Pi persisted for the interrupted call closes the journal gap and the work recovers without asking", async () => {
    // The incident's shape: the intent was journaled, the call was refused AFTER
    // it, and the journal never got the result the session holds. The operator
    // is not asked anything — the evidence is read and the same attempt continues.
    const { session } = interruptedAttempt2({
      pending: "unknown",
      result: { isError: true, text: "msf continuity guardrail: realized before the interruption" },
    });
    const target = workDir(layout, REPO, 7);
    const evidence = readFileSync(session.file, "utf8");
    const cfg = config();

    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 1, "the work continues instead of pausing");
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 2, "the SAME attempt");
    assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId }, "ITS own session");
    assert.equal(runtime.resumed[0]?.session?.sessionId, session.sessionId, "the runtime reopened that file");

    assert.equal(readPause(target), null, "no pause was written");
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), false, "the operator was not asked");
    assert.deepEqual(await agentComments(7), []);

    const journal = readEffectJournal(target);
    assert.deepEqual(journal.pending, [], "the gap is closed durably");
    assert.deepEqual(
      journal.results.map(({ callId, ok, source, evidenceAt }) => ({ callId, ok, source, evidenceAt })),
      [{ callId: "call-unknown", ok: false, source: "session", evidenceAt: "2026-01-01T00:00:02.000Z" }],
      "the observed error is preserved with the evidence it came from",
    );
    assert.equal(journal.intents.length, 1, "the original intent stays as written");
    assert.equal(readFileSync(session.file, "utf8").startsWith(evidence), true, "the session is evidence, never rewritten");
    assert.equal((await readRecoveryLedger(target)).consumed, 1, "closing the gap spends no extra grant");

    // A restart (another sweep) duplicates neither the result, the launch nor a comment.
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal(readEffectJournal(target).results.length, 1, "one result, no duplicate");
    assert.deepEqual(await agentComments(7), []);
  });

  test("an observed error is not absence: the conclusion is kept, the effect stays ambiguous and no answer releases it", async () => {
    // The push's conclusion is known (it errored) but that proves nothing about
    // the remote: the reconciliation reads the real state, finds another head,
    // and the work waits. The conclusion is persisted; the effect is not
    // released — not even by a human answer.
    const { ref } = interruptedAttempt2({ pending: "push", remote: "def456", result: { isError: true, text: "exited 1" } });
    const target = workDir(layout, REPO, 7);
    const cfg = config();

    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 0, "no blind relaunch");
    assert.equal(readPause(target)?.reason, "effect-ambiguous");
    assert.deepEqual(
      readEffectJournal(target).results.map(({ callId, ok, source }) => ({ callId, ok, source })),
      [{ callId: "call-push", ok: false, source: "session" }],
      "the observed error is persisted once, with its provenance",
    );
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), true, "the operator is asked");

    const asked = (await agentComments(7)).length;
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, asked, "no repeated request");

    // A human answer is orientation, never authorization: the effect is still
    // ambiguous, so the work stays paused and nothing is relaunched.
    tracker.addComment(ref, "operator", "I did not push anything.");
    const answered = await runOnce(deps(cfg));
    assert.equal(answered.launched.length, 0, "the answer does not release an unreconciled effect");
    assert.equal(readPause(target)?.reason, "effect-ambiguous");
    assert.equal(readEffectJournal(target).results.length, 1, "still exactly one conclusion");

    // A NEW answer plus facts that prove the push: the pause resolves and the
    // verdict reaches the next session's guardrail.
    tracker.addComment(ref, "operator", "It is pushed; the head is abc123.");
    git.remoteHead = "abc123";
    const resolved = await runOnce(deps(cfg));
    assert.equal(resolved.launched.length, 1, "a fresh read that proves the effect releases the work");
    assert.equal(readPause(target), null);
    assert.equal(readGuardrailState(target)?.verdicts["push:agent-issue-7@abc123"], "realized");
  });

  test("an observed success closes the call while the host's verdict stays about the world", async () => {
    const { session } = interruptedAttempt2({
      pending: "push",
      remote: "abc123",
      result: { isError: false, text: "To ../remote", durationMs: 320 },
    });

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 1, JSON.stringify(sweep.launched.map((entry) => entry.request.session)));
    assert.equal(sweep.launched[0]?.request.session?.sessionId, session.sessionId);
    assert.equal(readGuardrailState(workDir(layout, REPO, 7))?.verdicts["push:agent-issue-7@abc123"], "realized");
    const [result] = readEffectJournal(workDir(layout, REPO, 7)).results;
    assert.equal(result?.ok, true);
    assert.equal(result?.source, "session");
  });

  test("a call the session never concluded keeps the pause, saying the session was consulted", async () => {
    interruptedAttempt2({ pending: "unknown" });
    const target = workDir(layout, REPO, 7);

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0);
    assert.equal(readPause(target)?.reason, "effect-unsupported");
    assert.match(readPause(target)?.detail ?? "", /session records no terminal result/);
    assert.deepEqual(
      readEffectJournal(target).pending.map((intent) => intent.callId),
      ["call-unknown"],
      "no result is fabricated from an absence",
    );
  });

  test("another pending intent keeps the pause even when one call is closed", async () => {
    const { session, dir } = interruptedAttempt2({
      pending: "unknown",
      result: { isError: true, text: "refused by the harness" },
    });
    seedSessionToolCall(session, { callId: "call-second", command: "curl -X PUT https://example.com/b", answered: false });
    appendJournalIntent(dir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: "call-second",
      tool: "bash",
      command: "curl -X PUT https://example.com/b",
      safety: "unknown",
      actions: [],
      reason: "curl is not a proven-local command",
    });

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0, "one closed call does not authorize the rest");
    const journal = readEffectJournal(dir);
    assert.deepEqual(journal.results.map((result) => result.callId), ["call-unknown"], "the resolvable one is closed");
    assert.deepEqual(journal.pending.map((intent) => intent.callId), ["call-second"]);
  });

  test("conflicting duplicate results are not evidence: the work keeps waiting", async () => {
    const { session } = interruptedAttempt2({
      pending: "unknown",
      result: { isError: true, text: "refused by the harness" },
    });
    seedExtraToolResult(session, "call-unknown", { isError: false, text: "answered" });

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-unsupported");
    assert.deepEqual(readEffectJournal(workDir(layout, REPO, 7)).pending.map((intent) => intent.callId), ["call-unknown"]);
  });

  test("the operator's answer does not authorize a replay: the facts are read again, and only a settled effect starts a new round", async () => {
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "def456" });
    const cfg = config();
    const first = await runOnce(deps(cfg));
    assert.equal(first.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-ambiguous");
    const asked = (await agentComments(7)).length;

    // The human answers — the effect is still ambiguous: the work stays paused,
    // no new attempt, no new session, and NOTHING is repeated. The question was
    // already asked; an answer that resolves nothing adds no information
    // (issue 174 removed the "your answer was read" reply).
    tracker.addComment(ref, "operator", "I did not push anything, check again.");
    git.remoteHead = "def456";
    const answered = await runOnce(deps(cfg));
    assert.equal(answered.launched.length, 0);
    assert.equal(readPause(workDir(layout, REPO, 7))?.reason, "effect-ambiguous");
    assert.equal((await agentComments(7)).length, asked, "no repeated question, no 'still ambiguous' reply");

    // A restart with no further answer changes nothing: no launch, no comment.
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, asked);

    // The facts change (the remote now proves the push): the next round is a
    // NEW session with the CURRENT orientation, and the answer already given is
    // still there — the operator does not repeat it.
    tracker.addComment(ref, "operator", "I pushed it; the head is abc123.");
    git.remoteHead = "abc123";
    git.diff = "diff --git a/current b/current";
    const resolved = await runOnce(deps(cfg));
    assert.equal(resolved.launched.length, 1);
    const request = resolved.launched[0]!.request;
    assert.equal(request.session?.mode, "new", "a new orientation round, not a blind replay of the old session");
    assert.notEqual(request.session?.sessionId, session.sessionId);
    assert.equal(request.attempt, 3, "the human answer opens the next attempt");
    assert.deepEqual(
      request.material.ticketReplies?.map((comment) => comment.body),
      ["I did not push anything, check again.", "I pushed it; the head is abc123."],
      "both answers answer the SAME request; neither is discarded",
    );
    assert.equal(request.material.diff, "diff --git a/current b/current", "the current diff, not the old one");
    assert.equal(readPause(workDir(layout, REPO, 7)), null, "the resolved pause is cleared");
  });

  test("issue 174 — the answer survives an inconclusive recheck, a later factory comment and a restart; a changed cause posts one diagnostic", async () => {
    const { ref } = interruptedAttempt2({ pending: "push", remote: "def456" });
    seedIssue(tracker, { repo: REPO, number: 8, createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    const cfg = config(2);
    const target = workDir(layout, REPO, 7);
    const journal = readFileSync(join(target, "efeitos.jsonl"), "utf8");

    // 1. The pause request: one comment, one notification, the blocked label.
    const first = await runOnce(deps(cfg));
    assert.equal(first.launched.length, 1, "the other work keeps progressing");
    assert.equal(launchedNumber(first.launched[0]!.request), 8);
    const request = readPause(target);
    assert.equal(request?.reason, "effect-ambiguous");
    assert.ok(request?.id, "the occurrence has a stable identity");
    const marked = `<!-- msf:pause:${request!.id!} -->`;
    assert.ok((await agentComments(7))[0]?.includes(marked), "the request carries the occurrence's identity");
    assert.equal((await agentComments(7)).length, 1, "one request");
    // The pause notified once (the other work's launch notified too).
    const notified = notifier.notifications.length;
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.blocked]);

    // 2. The human answers; the recheck is inconclusive: nothing new is posted.
    tracker.addComment(ref, "operator", "I pushed the commit abc123, it may not be visible to you.");
    const answered = await runOnce(deps(cfg));
    assert.equal(answered.launched.length, 0, "no launch while the evidence is unresolved");
    assert.equal((await agentComments(7)).length, 1, "the question is not asked again");
    assert.equal(notifier.notifications.length, notified, "no repeated notification");

    // 3. More sweeps and a later factory comment about the SAME pause: the
    //    answer stays bound to the request, never to the last factory voice.
    for (let sweep = 0; sweep < 2; sweep += 1) {
      const later = await runOnce(deps(cfg));
      assert.equal(later.launched.length, 0);
      assert.equal((await agentComments(7)).length, 1, `sweep ${sweep}: no repeated request`);
    }
    await tracker.comment(ref, `${marked}\nthe pause is still current`);
    const afterComment = await runOnce(deps(cfg));
    assert.equal(afterComment.launched.length, 0, "the answer is still bound after a later factory comment");
    assert.equal((await agentComments(7)).length, 2, "only the factory's own later comment is new");
    assert.equal(notifier.notifications.length, notified, "a factory comment is not a new help request");
    assert.equal((await readRecoveryLedger(target)).consumed, 0, "pausing and rechecking spend no recovery");

    // A restart reads the same artifacts: same identity, same binding.
    const restarted = await runOnce(deps(cfg));
    assert.equal(restarted.launched.length, 0);
    assert.equal((await agentComments(7)).length, 2);
    assert.equal(readPause(target)?.id, request?.id, "the identity survives a restart");
    assert.equal(readPause(target)?.announced, true);

    // 4. A REAL cause change (the journal can no longer be read): exactly one
    //    diagnostic, carrying the same identity, so the prior answer still
    //    answers the same request.
    writeFileSync(join(target, "efeitos.jsonl"), "{\"type\":\"intent\",\"seq\":99", "utf8");
    const changed = await runOnce(deps(cfg));
    assert.equal(changed.launched.length, 0);
    assert.equal((await agentComments(7)).length, 3, "a changed cause is worth exactly one diagnostic");
    assert.ok((await agentComments(7))[2]?.includes(marked), "the diagnostic keeps the occurrence's identity");
    assert.equal(readPause(target)?.reason, "journal-unreadable");
    assert.equal(readPause(target)?.id, request?.id);
    assert.equal(notifier.notifications.length, notified + 1, "the new diagnosis is announced once");

    // Nothing new: the diagnostic is not repeated either.
    const again = await runOnce(deps(cfg));
    assert.equal(again.launched.length, 0);
    assert.equal((await agentComments(7)).length, 3);
    assert.equal(notifier.notifications.length, notified + 1);

    // 5. The facts settle: the journal is readable again and the remote proves
    //    the push. The preserved answer orients the new round — no repetition.
    writeFileSync(join(target, "efeitos.jsonl"), journal, "utf8");
    git.remoteHead = "abc123";
    git.diff = "diff --git a/current b/current";
    const resolved = await runOnce(deps(cfg));
    assert.equal(resolved.launched.length, 1, "the settlement allows the new round");
    const launched = resolved.launched[0]!.request;
    assert.equal(launched.attempt, 3);
    assert.equal(launched.session?.mode, "new");
    assert.deepEqual(
      launched.material.ticketReplies?.map((comment) => comment.body),
      ["I pushed the commit abc123, it may not be visible to you."],
      "the answer given to the request is still available to the resume",
    );
    assert.equal(readPause(target), null, "the pause clears on the evidence, not on the answer");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.claimed], "the retomada took the block back off");
  });

  test("issue 174 — a pause announced before occurrences had identities is not asked again after the upgrade", async () => {
    const LEGACY_AT = "2025-12-31T23:00:00.000Z";
    const { ref } = interruptedAttempt2({
      pending: "push",
      remote: "def456",
      labels: [DEFAULT_LABELS.blocked],
    });
    const target = workDir(layout, REPO, 7);
    // The pause as the PREVIOUS version left it: the request landed (announced),
    // the record carries no identity and its comment carries no marker — there
    // was none to carry.
    writeFileSync(
      join(target, "pausa.json"),
      JSON.stringify({
        version: 1,
        work: ref,
        attempt: 2,
        reason: "effect-ambiguous",
        detail: "the push of agent-issue-7 is ambiguous",
        at: LEGACY_AT,
        announced: true,
      }),
      "utf8",
    );
    await tracker.comment(ref, "the interrupted attempt 2 cannot be continued safely (effect-ambiguous)");
    tracker.addComment(ref, "operator", "I pushed abc123; check again.");

    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 0, "the answer re-reads the facts; it authorizes no replay");
    assert.ok(
      logs.some((line) => line.includes("paused (effect-ambiguous)")),
      "the answer really resumed the pause and was re-read — the work is not parked unanswered",
    );
    const upgraded = readPause(target);
    assert.equal(upgraded?.reason, "effect-ambiguous");
    assert.equal(upgraded?.announced, true);
    assert.equal(upgraded?.id, undefined, "the legacy occurrence gains no identity no comment can carry");
    assert.equal(upgraded?.at, LEGACY_AT, "it keeps the moment the operator was asked");
    assert.equal((await agentComments(7)).length, 1, "the request is already on the issue: it is not repeated");
    assert.equal(notifier.notifications.length, 0, "and nothing is notified again");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.blocked], "only the block is re-asserted");
    assert.equal(await readRecoveryLedger(target).then((ledger) => ledger.consumed), 0, "no recovery is spent");

    const comments = await tracker.readComments(ref);
    assert.ok(comments.known);
    assert.deepEqual(
      humanCommentsForPause(comments.value, upgraded!).map((comment) => comment.body),
      ["I pushed abc123; check again."],
      "the answer given to the legacy request still answers this occurrence",
    );

    // Restarting changes nothing: the same answer keeps resuming the same
    // pause, and neither the question nor the notification is repeated.
    const restart = await runOnce(deps(config()));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, 1, "a restart does not ask again either");
    assert.equal(notifier.notifications.length, 0);
    assert.equal(readPause(target)?.id, undefined);
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

  // ---- issue 173: a persisted pause is re-evaluated by the normal cycle ----

  /** The pause the factory announced for work 7, written as the real artifact.
   *  `attempt` is the number the launch PLANNED, which may differ from the last
   *  attempt the disk evidences (issue 175). */
  function persistAnnouncedPause(
    ref: IssueRef,
    attempt: number,
    id: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const target = workDir(layout, REPO, 7);
    writeFileSync(
      join(target, "pausa.json"),
      JSON.stringify({
        version: 1,
        work: ref,
        attempt,
        reason: "effect-ambiguous",
        detail: "the push of agent-issue-7 is ambiguous",
        at: NOW,
        id,
        announced: true,
        ...overrides,
      }),
      "utf8",
    );
    return target;
  }

  test("issue 173 — an announced pause the session now settles clears on its own and continues the SAME attempt", async () => {
    const { session } = interruptedAttempt2({ pending: "push", remote: "def456" });
    const target = workDir(layout, REPO, 7);
    const cfg = config();

    // 1. The pause: announced, blocked, one request, nothing launched.
    const paused = await runOnce(deps(cfg));
    assert.equal(paused.launched.length, 0);
    assert.equal(readPause(target)?.reason, "effect-ambiguous");
    assert.equal(readPause(target)?.announced, true);
    assert.equal((await agentComments(7)).length, 1, "the operator is asked once");
    const notified = notifier.notifications.length;

    // 2. The real state now proves the push — no human comment anywhere.
    git.remoteHead = "abc123";
    const resolved = await runOnce(deps(cfg));

    assert.equal(resolved.launched.length, 1, "the settled pause releases the work in the same cycle");
    const request = resolved.launched[0]!.request;
    assert.equal(request.attempt, 2, "the SAME attempt continues");
    assert.equal(request.branch, "agent-issue-7", "the branch is preserved");
    assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId }, "ITS own session");
    assert.equal(runtime.resumed[0]?.session?.sessionId, session.sessionId, "the runtime reopened that file");

    // The pause is resolved on disk, not only in memory.
    assert.equal(readPause(target), null, "no pause is current any more");
    assert.equal(existsSync(join(target, "pausa.json.resolved")), true, "the record is kept as resolved evidence");
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), false, "the block left with the pause");
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.claimed), true);
    assert.equal((await agentComments(7)).length, 1, "no new question, no new diagnostic");
    assert.equal(notifier.notifications.length, notified, "nothing is notified again");
    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.attempt, 2);
    assert.equal(ledger.consumed, 1, "the existing recovery ruler charged the relaunch it granted");

    // 3. Nothing duplicates — not after the relaunch, not after a restart.
    const results = readEffectJournal(target).results.length;
    const restart = await runOnce(deps(cfg));
    assert.equal(restart.launched.length, 0);
    assert.equal((await agentComments(7)).length, 1);
    assert.equal(notifier.notifications.length, notified);
    assert.equal(readEffectJournal(target).results.length, results, "the conclusion is never written twice");
    assert.equal(readPause(target), null, "a resolved pause never comes back");
  });

  test("issue 173 — a pause settled under a human answer is a NEW round that keeps it, spending no recovery", async () => {
    const PAUSE_ID = "6f1c9a2e-1c1f-4f6b-9a1b-2f0f0b7c1111";
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "def456" });
    const target = persistAnnouncedPause(ref, 2, PAUSE_ID, { sessionId: session.sessionId });
    await tracker.comment(ref, `<!-- msf:pause:${PAUSE_ID} -->\nattempt 2 cannot be continued safely (effect-ambiguous)`);
    tracker.addComment(ref, "operator", "I pushed abc123; check again.");

    git.remoteHead = "abc123";
    const sweep = await runOnce(deps(config()));

    assert.equal(sweep.launched.length, 1, "the settled pause releases the work");
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 3, "the human answer opens the next attempt");
    assert.equal(request.session?.mode, "new", "a human-oriented round, not a blind replay of the old session");
    assert.notEqual(request.session?.sessionId, session.sessionId);
    assert.deepEqual(
      request.material.ticketReplies?.map((comment) => comment.body),
      ["I pushed abc123; check again."],
      "the preserved answer orients the round",
    );
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, "a resume round spends no recovery");
    assert.equal(readPause(target), null, "the pause is resolved");
    assert.equal((await agentComments(7)).length, 1, "the request already on the issue is not repeated");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.claimed], "the retomada swapped the block off");
  });

  test("issue 173 — a pause that named the PLANNED attempt still resolves and continues from the evidenced one", async () => {
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    // Attempt 5 is the last one the disk evidences; the launch that paused had
    // planned attempt 6 (no log, no session of its own).
    writeFileSync(join(target, "log-5.jsonl"), '{"event":"session-end","attempt":5}\n', "utf8");
    const session = seedSession(target, ref, 5);
    seedSessionToolCall(session, { callId: "call-push", command: "git push origin agent-issue-7", answered: false });
    appendJournalIntent(target, {
      attempt: 5,
      sessionId: session.sessionId,
      callId: "call-push",
      tool: "bash",
      command: "git push origin agent-issue-7",
      safety: "effect",
      actions: [{ kind: "push", key: "push:agent-issue-7@abc123", detail: "push branch agent-issue-7", branch: "agent-issue-7", sha: "abc123" }],
    });
    persistAnnouncedPause(ref, 6, "11111111-1111-4111-8111-111111111111");
    const paused = readPause(target);
    const cfg = config();

    // 1. Still unproven: the pause stands with the fresher diagnosis of this
    //    read — same occurrence, same announcement — and nothing is asked.
    git.remoteHead = "def456";
    const waiting = await runOnce(deps(cfg));
    assert.equal(waiting.launched.length, 0);
    const kept = readPause(target);
    assert.equal(kept?.reason, "effect-ambiguous");
    assert.equal(kept?.id, paused?.id, "the occurrence keeps its identity");
    assert.equal(kept?.at, paused?.at, "and the moment the operator was asked");
    assert.equal(kept?.announced, true);
    assert.match(kept?.detail ?? "", /def456/, "the persisted diagnosis is the fresher one");
    assert.equal((await agentComments(7)).length, 0, "nothing is asked again");
    assert.deepEqual(readEffectJournal(target).pending.map((intent) => intent.callId), ["call-push"]);

    // 2. The remote proves the evidenced attempt's push: the pause resolves and
    //    the planned attempt 6 — which never had a session — starts its own.
    git.remoteHead = "abc123";
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 1);
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 6, "the attempt the pause named is the one that continues");
    assert.equal(request.session?.mode, "new", "attempt 6 never created a session: it starts its first");
    assert.notEqual(request.session?.sessionId, session.sessionId);
    assert.equal(readFileSync(session.file, "utf8").includes(session.sessionId), true, "the evidenced session is preserved");
    assert.equal(readPause(target), null, "the pause is resolved");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.claimed], "the block left with the pause");

    const concluded = readEffectJournal(target).results;
    assert.equal(concluded.length, 1, "exactly one conclusion, for the call that was open");
    assert.equal(concluded[0]?.attempt, 5, "the conclusion names the attempt the intent belonged to");
    assert.equal(concluded[0]?.ok, true);
    const ledger = await readRecoveryLedger(target);
    assert.equal(ledger.attempt, 6);
    assert.equal(ledger.consumed, 1, "the launch obeyed the existing recovery ruler");
    assert.equal(ledger.events.length, 1, "one grant, written by the launch — never a fabricated entry");
    assert.equal(ledger.lastFallAttempt, null, "no fall is invented to justify the relaunch");
  });

  test("issue 173 — a paused call the transcript proves never ran is settled by the normal cycle", async () => {
    // The pause was written from a read that did not yet hold the call's
    // refusal: a non-safe call with no guardrail intent is, on its own, a doubt
    // the factory cannot answer. The transcript's terminal refusal — an error
    // with no duration, the shape only a call that never ran has — settles it.
    const { session } = interruptedAttempt2({});
    const target = workDir(layout, REPO, 7);
    const cfg = config();

    const paused = await runOnce(deps(cfg));
    assert.equal(paused.launched.length, 0);
    assert.equal(readPause(target)?.reason, "tool-evidence-missing");
    const asked = (await agentComments(7)).length;
    assert.equal(asked, 1, "the missing evidence is reported once");

    seedSessionToolCall(session, {
      callId: "call-unknown",
      command: "curl -X POST https://example.com",
      answered: true,
      result: { isError: true, text: "msf continuity guardrail: realized before the interruption" },
    });
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 1, "the same rule the resume plan applies settles the pause");
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 2, "the SAME attempt continues");
    assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId }, "ITS own session");
    assert.equal(readPause(target), null, "the pause is resolved");
    assert.equal((await agentComments(7)).length, asked, "no new question is asked");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 1, "the recovery ruler applies");
  });

  test("issue 173 — a partial session tail needs the guardrail's record before the pause may clear", async () => {
    // The session ends with an incomplete entry: its discarded tail is safe
    // only when the journal proves the session ran under the guardrail. Without
    // that record the recheck must not read the intact prefix as if the tail
    // could have run nothing.
    const ref: IssueRef = { repo: REPO, number: 7 };
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-2.jsonl"), '{"event":"session-start","attempt":2}\n', "utf8");
    const session = seedSession(target, ref, 2);
    writeFileSync(session.file, `${readFileSync(session.file, "utf8")}{"type":"message","id":"cut`, "utf8");
    persistAnnouncedPause(ref, 2, "6f1c9a2e-1c1f-4f6b-9a1b-2f0f0b7c1222", {
      reason: "tool-evidence-missing",
      detail: "the calls the attempt ran cannot be read",
    });
    const paused = readPause(target);
    const cfg = config();
    assert.ok(paused?.id !== undefined, "the occurrence keeps its identity");

    // 1. No guardrail record for this session: the intact prefix proves nothing
    //    about the tail, so the pause stands — with the fresher detail of THIS
    //    read, on the same occurrence, and nothing asked again.
    const waiting = await runOnce(deps(cfg));

    assert.equal(waiting.launched.length, 0, "no launch without the guardrail's proof");
    const kept = readPause(target);
    assert.equal(kept?.reason, "tool-evidence-missing", "a same-reason recheck never changes the cause");
    assert.equal(kept?.id, paused.id, "the occurrence keeps its identity");
    assert.equal(kept?.at, paused.at, "and the moment the operator was asked");
    assert.equal(kept?.announced, true, "the request still stands as announced");
    assert.match(kept?.detail ?? "", /discarded tail/, "the persisted diagnosis is the fresher one");
    assert.equal(existsSync(join(target, "efeitos.jsonl")), false, "the recheck writes no journal");
    assert.equal((await agentComments(7)).length, 0, "the announced pause is not asked again");
    assert.match(logs.join("\n"), /paused \(tool-evidence-missing\).*pausa\.json/, "the compact diagnostic points at the fresh evidence");

    // 2. The session-start proves the guardrail ran: the intact prefix has no
    //    unjournaled non-safe call, so the normal cycle settles the pause.
    appendJournalStart(target, { attempt: 2, sessionId: session.sessionId });
    const settled = await runOnce(deps(cfg));

    assert.equal(settled.launched.length, 1, "the guardrail's record releases the work");
    assert.deepEqual(settled.launched[0]!.request.session, { mode: "resume", sessionId: session.sessionId });
    assert.equal(readPause(target), null, "the pause is resolved");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.claimed], "the block left with the pause");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 1, "the recovery ruler applies");
  });

  test("continuity logs keep multiline commands on disk and report only changes across ticks", async () => {
    const script = "cat > /tmp/probe <<\u0027EOF\u0027\nSENSITIVE_SCRIPT_BODY\nEOF\nnode /tmp/probe";
    const interrupted = interruptedAttempt2({ pending: "unknown", command: script });
    const target = persistAnnouncedPause(interrupted.ref, 2, "logging-pause", { reason: "effect-unsupported", sessionId: interrupted.session.sessionId });
    const engine = new SweepEngine(deps());
    for (let tick = 0; tick < 4; tick += 1) { await engine.deriveAndAct(); await engine.settle(); }
    const paused = () => logs.filter((line) => line.includes("continuity of") && line.includes("paused ("));
    assert.equal(paused().length, 1, "one diagnostic, not one per tick");
    assert.ok(paused()[0]!.includes("msf recover"));
    assert.ok(paused()[0]!.includes("pausa.json"));
    assert.ok(logs.every((line) => !line.includes("SENSITIVE_SCRIPT_BODY") && !line.includes("/tmp/probe")), "no raw command in any operational log");
    assert.ok(readPause(target)!.detail.includes(script), "full diagnosis is preserved");
    writeFileSync(join(target, "efeitos.jsonl"), "{partial", "utf8");
    await engine.deriveAndAct();
    await engine.deriveAndAct();
    assert.equal(paused().length, 2, "a changed cause is reported once");
    assert.ok(paused()[1]!.includes("journal-unreadable"));
    assert.ok(paused().every((line) => !line.includes("\n")));
    const restarted = new SweepEngine(deps());
    await restarted.deriveAndAct();
    assert.equal(paused().length, 3, "a restart reports the current pause once");
  });

  test("issue 173 — without a terminal result the pause stands sweep after sweep, spending nothing", async () => {
    interruptedAttempt2({ pending: "unknown" });
    seedIssue(tracker, { repo: REPO, number: 8, createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    const target = workDir(layout, REPO, 7);
    const cfg = config();

    const first = await runOnce(deps(cfg));
    assert.equal(first.launched.length, 1, "the other work keeps progressing");
    assert.equal(launchedNumber(first.launched[0]!.request), 8);
    const asked = (await agentComments(7)).length;
    assert.equal(asked, 1, "the operator is asked once");
    const notified = notifier.notifications.length;
    const pause = readPause(target);
    assert.equal(pause?.reason, "effect-unsupported");
    const journal = readFileSync(join(target, "efeitos.jsonl"), "utf8");

    for (const round of ["sweep", "restart"]) {
      const again = await runOnce(deps(cfg));
      assert.equal(again.launched.length, 0, `${round}: no launch without evidence`);
      assert.equal((await agentComments(7)).length, asked, `${round}: the question is not repeated`);
      assert.equal(notifier.notifications.length, notified, `${round}: nothing is notified again`);
      assert.equal(readPause(target)?.reason, "effect-unsupported", `${round}: the pause stands`);
      assert.equal(readPause(target)?.id, pause?.id, `${round}: the occurrence keeps its identity`);
      assert.equal(readFileSync(join(target, "efeitos.jsonl"), "utf8"), journal, `${round}: the journal is untouched`);
      assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, `${round}: no recovery is spent`);
    }
  });

  test("issue 173 — a session that became unreadable keeps the pause and preserves the evidence", async () => {
    const { session } = interruptedAttempt2({ pending: "push", remote: "def456" });
    const target = workDir(layout, REPO, 7);
    const cfg = config();
    await runOnce(deps(cfg));
    const asked = (await agentComments(7)).length;

    // The transcript the recheck would read can no longer be read: that is the
    // doubt itself, never a resolution nor a reason to write over it.
    writeFileSync(session.file, "{not-json}{\n", "utf8");
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 0, "no relaunch on evidence it cannot read");
    assert.equal(runtime.launched.length, 0);
    assert.equal((await agentComments(7)).length, asked, "the question is not repeated");
    assert.equal(readPause(target)?.reason, "effect-ambiguous", "the pause stands as it was");
    assert.equal(readFileSync(session.file, "utf8"), "{not-json}{\n", "the unreadable history is preserved as evidence");
    assert.deepEqual(readEffectJournal(target).pending.map((intent) => intent.callId), ["call-push"]);
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0);
  });

  test("issue 173 — a settled pause still obeys the recovery ruler: an exhausted budget asks for help", async () => {
    const PAUSE_ID = "22222222-2222-4222-8222-222222222222";
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "def456", labels: [DEFAULT_LABELS.blocked] });
    const target = persistAnnouncedPause(ref, 2, PAUSE_ID, { sessionId: session.sessionId });
    await tracker.comment(ref, `<!-- msf:pause:${PAUSE_ID} -->\nattempt 2 cannot be continued safely (effect-ambiguous)`);
    const cfg = { ...config(), recovery: { ...DEFAULT_RECOVERY_BUDGET, maxRecoveries: 0, waitsMs: [0, 0, 0] } };

    git.remoteHead = "abc123";
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 0, "a resolved pause never becomes a silent launch");
    assert.equal(runtime.launched.length, 0);
    const comments = await agentComments(7);
    assert.equal(comments.length, 2, "the existing pause-help ruler asks once, naming the budget");
    assert.match(comments[1] ?? "", /was interrupted and the recovery budget is exhausted/);
    assert.equal(readPause(target), null, "the continuity pause was resolved, not recreated");
    assert.equal(existsSync(join(target, "pausa.json.resolved")), true);
    assert.equal((await labelsOf(7)).includes(DEFAULT_LABELS.blocked), true, "the human is asked on the issue");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, "an exhausted budget spends nothing");
  });

  test("issue 173 — a worker that may still be alive blocks the re-evaluation: no journal write, no launch", async () => {
    interruptedAttempt2({ pending: "push", remote: "def456" });
    const target = workDir(layout, REPO, 7);
    const cfg = config();
    await runOnce(deps(cfg));
    git.remoteHead = "abc123";
    const journal = readFileSync(join(target, "efeitos.jsonl"), "utf8");
    const pause = readFileSync(join(target, "pausa.json"), "utf8");

    // Docker cannot rule the worker out: the answer is unknown, so nothing may
    // presume it stopped.
    const blind = await runOnce({
      ...deps(cfg),
      probe: () => Promise.reject(new Error("docker: daemon is not reachable")),
    });
    assert.equal(blind.launched.length, 0);
    assert.equal(readFileSync(join(target, "efeitos.jsonl"), "utf8"), journal, "a possibly-live worker's journal is not written");
    assert.equal(readFileSync(join(target, "pausa.json"), "utf8"), pause, "the pause is untouched");

    // A live container for the work: the same answer, even with a reliable probe.
    const survivor = await runOnce({
      ...deps(cfg),
      probe: async () => [{ key: `${REPO}#7`, containerId: "c-7", ageMs: 60_000 }],
    });
    assert.equal(survivor.launched.length, 0, "no substitute is launched over a live worker");
    assert.equal(readFileSync(join(target, "efeitos.jsonl"), "utf8"), journal);
    assert.equal(readPause(target)?.reason, "effect-ambiguous", "the pause survives the survivor");
  });

  test("issue 173 — a session-missing pause whose session is on disk again resolves in the normal cycle", async () => {
    const PAUSE_ID = "33333333-3333-4333-8333-333333333333";
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "abc123", labels: [DEFAULT_LABELS.blocked] });
    const target = persistAnnouncedPause(ref, 2, PAUSE_ID, {
      reason: "session-missing",
      detail: "the session recorded for attempt 2 is not on disk",
      sessionId: session.sessionId,
    });
    const cfg = config();

    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 1, "the session it doubted is readable: the normal cycle settles the pause");
    const request = sweep.launched[0]!.request;
    assert.equal(request.attempt, 2, "the SAME attempt continues");
    assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId }, "ITS own session is reopened");
    assert.equal(readPause(target), null, "the pause is resolved on its own evidence");
    assert.deepEqual(await labelsOf(7), [DEFAULT_LABELS.claimed], "the block left with the pause");
    assert.equal((await agentComments(7)).length, 0, "the operator is not asked again");
    assert.equal(notifier.notifications.length, 0, "and nothing is notified");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 1, "the existing recovery ruler applies");
  });

  test("issue 173 — a journal-unreadable pause whose journal is readable again resolves", async () => {
    const PAUSE_ID = "44444444-4444-4444-8444-444444444444";
    const { ref } = interruptedAttempt2({ pending: "push", remote: "abc123", labels: [DEFAULT_LABELS.blocked] });
    const target = workDir(layout, REPO, 7);
    const journal = readFileSync(join(target, "efeitos.jsonl"), "utf8");
    writeFileSync(join(target, "efeitos.jsonl"), '{"type":"intent","seq":99', "utf8");
    persistAnnouncedPause(ref, 2, PAUSE_ID, {
      reason: "journal-unreadable",
      detail: "the effect journal cannot prove what the interrupted session attempted",
    });
    const cfg = config();

    // 1. Still unreadable: the settle step keeps the pause, which persists the
    //    fresher diagnosis on the same occurrence and asks nothing.
    const waiting = await runOnce(deps(cfg));
    assert.equal(waiting.launched.length, 0);
    const kept = readPause(target);
    assert.equal(kept?.reason, "journal-unreadable");
    assert.equal(kept?.id, PAUSE_ID, "the occurrence keeps its identity");
    assert.match(kept?.detail ?? "", /incomplete or unparseable/);
    assert.equal((await agentComments(7)).length, 0, "nothing is asked again");

    // 2. Readable again: the same checks run on the facts it can now prove.
    writeFileSync(join(target, "efeitos.jsonl"), journal, "utf8");
    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 1, "the journal proves the effects settled: the pause resolves");
    assert.equal(sweep.launched[0]!.request.attempt, 2, "the SAME attempt continues");
    assert.equal(readPause(target), null);
    assert.equal((await agentComments(7)).length, 0, "no new comment either way");
    assert.equal(notifier.notifications.length, 0);
  });

  test("issue 173 — a session that is still unreadable keeps its pause, naming the cause the disk now gives", async () => {
    const PAUSE_ID = "55555555-5555-4555-8555-555555555555";
    const { session, ref } = interruptedAttempt2({ pending: "push", remote: "abc123", labels: [DEFAULT_LABELS.blocked] });
    const target = persistAnnouncedPause(ref, 2, PAUSE_ID, {
      reason: "session-missing",
      detail: "the session recorded for attempt 2 is not on disk",
      sessionId: session.sessionId,
    });
    writeFileSync(session.file, "{not-json}{\n", "utf8");
    const cfg = config();

    const sweep = await runOnce(deps(cfg));

    assert.equal(sweep.launched.length, 0, "a history it cannot read is the doubt itself, never a resolution");
    assert.equal(runtime.launched.length, 0);
    const kept = readPause(target);
    assert.equal(kept?.reason, "session-unreadable", "the session is on disk again and unreadable: the real cause, not the stale one");
    assert.equal(kept?.id, PAUSE_ID, "the same occurrence");
    assert.equal(kept?.at, NOW, "and the moment the operator was asked stays");
    assert.match(kept?.detail ?? "", /not a session header|unreadable/, "the fresher read is persisted honestly");
    const comments = await agentComments(7);
    assert.equal(comments.length, 1, "a real change of cause is worth exactly one diagnostic");
    assert.ok(comments[0]?.includes(`<!-- msf:pause:${PAUSE_ID} -->`), "the diagnostic keeps the occurrence's identity");
    assert.equal(readFileSync(session.file, "utf8"), "{not-json}{\n", "the unreadable history is preserved as evidence");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, "no recovery is spent");
  });

  test("issue 173 — a record the factory cannot read is never re-checked into a resolution", async () => {
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });
    const target = workDir(layout, REPO, 7);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "log-1.jsonl"), '{"event":"session-start","attempt":1}\n', "utf8");
    writeFileSync(join(target, "pausa.json"), "{not a record", "utf8");
    const cfg = config();

    const first = await runOnce(deps(cfg));
    assert.equal(first.launched.length, 0, "nothing is launched from a record it cannot read");
    assert.equal(readPause(target)?.reason, "record-unreadable", "the doubt survives as itself");
    const asked = (await agentComments(7)).length;
    const notified = notifier.notifications.length;

    const second = await runOnce(deps(cfg));

    assert.equal(second.launched.length, 0, "a record-unreadable pause is never auto-cleared");
    assert.equal(readPause(target)?.reason, "record-unreadable");
    assert.equal(existsSync(join(target, "pausa.json")), true, "the record still waits");
    assert.equal((await agentComments(7)).length, asked, "and it is never asked again");
    assert.equal(notifier.notifications.length, notified, "and nothing is notified again");
    assert.equal(await readRecoveryLedger(target).then((value) => value.consumed), 0, "no recovery is spent");
  });
});
