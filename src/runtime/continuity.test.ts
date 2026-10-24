import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { planContinuity, recheckPausedEffects, type ContinuityDeps } from "./continuity.js";
import {
  appendJournalIntent,
  appendJournalStart,
  readEffectJournal,
  readGuardrailState,
  readPause,
  readSessionLinks,
  type PauseReason,
  type PauseRecord,
} from "../work-record/continuity.js";
import { SESSIONS_SUBDIR } from "../layout.js";
import { DEFAULT_LABELS } from "../config.js";
import type { EffectAction } from "./effects.js";
import { seedExtraToolResult, seedSession, seedSessionToolCall, type SeededCallResult } from "../e2e/session-fixtures.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import type { GitWork, LocalWorkFacts, PreparedWork } from "../git/port.js";
import { githubWork } from "../e2e/work-fixtures.js";

/**
 * The host-side continuity contract (issue 119): where a launch comes from,
 * whether an interrupted attempt may be reopened, and what makes the factory
 * pause instead of guessing. Tested at the module's public functions with the
 * REAL artifacts on temp disk and the tracker/git boundaries the loop uses.
 */

const REPO = "Sanmoo/my-tasks";
const NUMBER = 7;
const REF = githubWork(REPO, NUMBER);
const BRANCH = "agent-issue-7";

/** The pause record a recheck reads its cause from (issue 173). */
function pauseUnderRecheck(reason: PauseReason, attempt: number): PauseRecord {
  return {
    version: 1,
    work: REF,
    attempt,
    reason,
    detail: "the interrupted effect is ambiguous",
    at: "2026-01-01T00:00:00.000Z",
  };
}

class FakeGit implements GitWork {
  remoteHead: string | null = null;
  readonly asks: number[] = [];

  async prepareWorkFor(): Promise<PreparedWork> {
    throw new Error("not used");
  }
  async cleanupDoneWorkFor(): Promise<void> {}
  async diffWorkFor(): Promise<string> {
    return "";
  }
  async observeRemoteHeadFor(): Promise<string | null> {
    this.asks.push(1);
    return this.remoteHead;
  }
  async inspectLocalWorkFor(): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

describe("continuity of an interrupted attempt (issue 119)", () => {
  let dir: string;
  let workDir: string;
  let tracker: FakeTrackerAdapter;
  let git: FakeGit;
  let deps: ContinuityDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-continuity-"));
    workDir = join(dir, "trabalhos", "Sanmoo#my-tasks#7");
    mkdirSync(workDir, { recursive: true });
    tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    seedIssue(tracker, { repo: REPO, number: NUMBER, labels: ["agent-claimed"] });
    git = new FakeGit();
    deps = {
      workDir,
      sessionsDir: join(workDir, SESSIONS_SUBDIR),
      work: REF,
      attempt: 2,
      git,
      tickets: tracker,
      pullRequests: tracker,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("guarded dispatch does not hide an ambiguous child call or fabricate either result", async () => {
    const parent = seedSession(workDir, REF, 2);
    const child = seedSession(join(workDir, "sessao", "child"), REF, 2, { sessionId: "22222222-2222-4222-8222-222222222222" });
    seedSessionToolCall(parent, { callId: "delegate", tool: "subagent", command: "", answered: false });
    seedSessionToolCall(child, { callId: "unknown-child", command: "node /tmp/diagnostic.mjs", answered: false });
    appendJournalStart(workDir, { attempt: 2, sessionId: parent.sessionId });
    appendJournalIntent(workDir, { attempt: 2, sessionId: parent.sessionId, callId: "delegate", tool: "subagent", command: "", safety: "unknown", actions: [], delegation: "guarded-v1" });
    appendJournalStart(workDir, { attempt: 2, sessionId: child.sessionId, childOf: parent.sessionId });
    appendJournalIntent(workDir, { attempt: 2, sessionId: child.sessionId, callId: "unknown-child", tool: "bash", command: "node /tmp/diagnostic.mjs", safety: "unknown", actions: [] });
    const blocked = await planContinuity(deps, "resume");
    assert.equal(blocked.decision, "pause");
    if (blocked.decision !== "pause") return;
    assert.equal(blocked.pause.reason, "effect-unsupported");
    assert.equal(blocked.pause.sessionId, child.sessionId);
    assert.equal(readEffectJournal(workDir).results.length, 0);

    seedExtraToolResult(child, "unknown-child", { durationMs: 100, text: "diagnostic finished" });
    const settled = await planContinuity(deps, "resume");
    assert.equal(settled.decision, "launch");
    if (settled.decision !== "launch") return;
    assert.equal(settled.sessionId, parent.sessionId, "the owning session continues");
    assert.deepEqual(readEffectJournal(workDir).results.map((entry) => [entry.sessionId, entry.callId, entry.source]), [[child.sessionId, "unknown-child", "session"]]);
  });

  test("an inaccessible effect journal is unknown, never an empty journal that licenses a restart", async () => {
    seedSession(workDir, REF, 2);
    mkdirSync(join(workDir, "efeitos.jsonl"));
    const result = await planContinuity(deps, "resume");
    assert.equal(result.decision, "pause");
    if (result.decision === "pause") assert.equal(result.pause.reason, "journal-unreadable");
  });

  test("a delegated session without this Work's parent association cannot release continuity", async () => {
    seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: "other-child", childOf: "foreign-parent" });
    const result = await planContinuity(deps, "resume");
    assert.equal(result.decision, "pause");
    if (result.decision === "pause") assert.equal(result.pause.reason, "session-identity");
  });

  /** An interrupted session of the attempt, with its intent on disk. */
  function interruptInsidePush(
    options: { sha?: string; remote?: string | null; journal?: boolean; result?: SeededCallResult } = {},
  ): void {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, {
      callId: "call-push",
      command: "git push origin agent-issue-7",
      answered: options.result !== undefined,
      ...(options.result === undefined ? {} : { result: options.result }),
    });
    if (options.journal !== false) {
      appendJournalIntent(workDir, {
        attempt: 2,
        sessionId: session.sessionId,
        callId: "call-push",
        tool: "bash",
        command: "git push origin agent-issue-7",
        safety: "effect",
        actions: [
          {
            kind: "push",
            key: `push:${BRANCH}@${options.sha ?? "abc123"}`,
            detail: `push branch ${BRANCH}`,
            branch: BRANCH,
            sha: options.sha ?? "abc123",
          },
        ],
      });
    }
    git.remoteHead = options.remote === undefined ? null : options.remote;
  }

  test("a new launch records the association BEFORE the worker starts", async () => {
    const plan = await planContinuity(deps, "new");
    assert.equal(plan.decision, "launch");
    if (plan.decision !== "launch") return;
    assert.equal(plan.mode, "new");

    const links = readSessionLinks(workDir).links;
    assert.equal(links.length, 1);
    assert.deepEqual(links[0], {
      version: 1,
      work: REF,
      attempt: 2,
      round: 1,
      sessionId: plan.sessionId,
      at: "2026-01-01T00:00:00.000Z",
    });
    const state = readGuardrailState(workDir);
    assert.equal(state?.sessionId, plan.sessionId);
    assert.equal(state?.mode, "new");
  });

  test("with several attempts and rounds on disk, the recovery reopens ONLY the association of its own attempt", async () => {
    const older = seedSession(workDir, REF, 1, { sessionId: "11111111-1111-1111-1111-111111111111" });
    const wrongRound = seedSession(workDir, REF, 2, { round: 1, sessionId: "22222222-2222-2222-2222-222222222222" });
    const selected = seedSession(workDir, REF, 2, { round: 2, sessionId: "33333333-3333-3333-3333-333333333333" });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch");
    if (plan.decision !== "launch") return;
    assert.equal(plan.mode, "resume");
    assert.equal(plan.sessionId, selected.sessionId);
    assert.notEqual(plan.sessionId, older.sessionId);
    assert.notEqual(plan.sessionId, wrongRound.sessionId);
    assert.equal(readGuardrailState(workDir)?.mode, "resume");
  });

  test("a legacy attempt with evidence but no association pauses instead of inventing a session", async () => {
    appendJournalStart(workDir, { attempt: 2, sessionId: "unknown" });
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "link-missing");
    assert.equal(plan.pause.attempt, 2);
  });

  test("an attempt whose worker never started creates its FIRST session under the same attempt", async () => {
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch");
    if (plan.decision !== "launch") return;
    assert.equal(plan.mode, "new");
    assert.equal(readSessionLinks(workDir).links[0]?.attempt, 2);
  });

  test("a recorded session that is gone pauses; the association is not rewritten", async () => {
    seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: "11111111-2222-3333-4444-000000000002" });
    // Evidence that the session RAN (its log), while its file disappeared.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(workDir, "log-2.jsonl"), "{}\n", "utf8");
    rmSync(join(workDir, SESSIONS_SUBDIR, "--fake-worker--"), { recursive: true, force: true });

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "session-missing");
    assert.equal(readSessionLinks(workDir).links.length, 1, "the association is preserved as evidence");
  });

  test("a session whose header names another id pauses on identity", async () => {
    const session = seedSession(workDir, REF, 2, { shortId: "11111111-2222-3333-4444-000000000002" });
    // The file keeps its name but its header belongs to another session.
    const content = readFileSync(session.file, "utf8").split("\n");
    content[0] = JSON.stringify({ type: "session", version: 3, id: "another-session", cwd: "/x", timestamp: "" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(session.file, content.join("\n"), "utf8");

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "session-identity");
  });

  test("a pending effect the host proves REALIZED is handed to the session as such — it must not be repeated", async () => {
    interruptInsidePush({ sha: "abc123", remote: "abc123" });
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
  });

  test("a realized effect stays realized across rounds even when its call also carried an absent one", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, {
      callId: "call-both",
      command: `git push origin ${BRANCH} && gh pr create --head ${BRANCH}`,
      answered: false,
    });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: "call-both",
      tool: "bash",
      command: `git push origin ${BRANCH} && gh pr create --head ${BRANCH}`,
      safety: "effect",
      actions: [
        { kind: "push", key: `push:${BRANCH}@abc123`, detail: `push branch ${BRANCH}`, branch: BRANCH, sha: "abc123" },
        { kind: "pr", key: `pr:${BRANCH}`, detail: `open PR from ${BRANCH}`, branch: BRANCH },
      ],
    });
    git.remoteHead = "abc123";

    const first = await planContinuity(deps, "resume");
    assert.equal(first.decision, "launch");
    const firstState = readGuardrailState(workDir);
    assert.equal(firstState?.verdicts[`push:${BRANCH}@abc123`], "realized");
    assert.equal(firstState?.verdicts[`pr:${BRANCH}`], "absent");

    // A second interruption, later: the next launch's verdicts must still
    // carry the push proven realized (the per-call result cannot say it).
    const later = seedSession(workDir, REF, 2, { round: 2, sessionId: "99999999-9999-9999-9999-999999999999" });
    appendJournalStart(workDir, { attempt: 2, sessionId: later.sessionId });
    seedSessionToolCall(later, { callId: "call-later", command: `gh issue comment 7 --body "done"`, answered: false });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: later.sessionId,
      callId: "call-later",
      tool: "bash",
      command: `gh issue comment 7 --body "done"`,
      safety: "effect",
      actions: [{ kind: "comment", key: "comment:issue:7:abc", detail: "comment on issue #7", target: "issue", number: 7, body: "done" }],
    });

    const second = await planContinuity(deps, "resume");
    assert.equal(second.decision, "launch", JSON.stringify(second));
    const secondState = readGuardrailState(workDir);
    assert.equal(secondState?.verdicts[`push:${BRANCH}@abc123`], "realized", "the realized push is never lost");
    assert.equal(secondState?.verdicts["comment:issue:7:abc"], "absent");

    // A NEW attempt starts from nothing: it may legitimately publish again.
    const nextAttempt = await planContinuity({ ...deps, attempt: 3 }, "new");
    assert.equal(nextAttempt.decision, "launch");
    assert.deepEqual(readGuardrailState(workDir)?.verdicts, {}, "the previous attempt's verdicts do not follow");
  });

  test("a reconciled intent keeps its result: a later restart does not re-ask the real state", async () => {
    interruptInsidePush({ sha: "abc123", remote: "abc123" });
    const first = await planContinuity(deps, "resume");
    assert.equal(first.decision, "launch");
    assert.equal(git.asks.length, 1);

    // The remote moves after the interruption (the resumed session published
    // more). The settled push must not read as a new doubt.
    git.remoteHead = "def456";
    const second = await planContinuity(deps, "resume");
    assert.equal(second.decision, "launch");
    assert.equal(git.asks.length, 1, "an effect already reconciled is not asked again");
  });

  test("a pending effect proven ABSENT may be done once; the verdict says so", async () => {
    interruptInsidePush({ sha: "abc123", remote: null });
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "absent");
  });

  test("a remote head that does not prove the push pauses: ambiguity is not absence", async () => {
    interruptInsidePush({ sha: "abc123", remote: "def456" });
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-ambiguous");
    assert.match(plan.pause.detail, /def456/);
  });

  test("a pending call whose effect cannot be reconciled pauses without a relaunch", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-x", command: "curl -X POST https://example.com", answered: false });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: "call-x",
      tool: "bash",
      command: "curl -X POST https://example.com",
      safety: "unknown",
      actions: [],
      reason: "curl is not a proven-local command",
    });

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.match(plan.pause.detail, /curl/);
  });

  test("an unreadable journal pauses: it cannot prove what was attempted", async () => {
    seedSession(workDir, REF, 2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(workDir, "efeitos.jsonl"), '{"type":"intent"', "utf8");
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "journal-unreadable");
  });

  test("a mutating call the guardrail never journaled pauses: the prefix cannot be shown safe", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-ghost", command: "git push origin agent-issue-7", answered: true });

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "tool-evidence-missing");

    // The recheck reads the SAME rule (issue 173): a call that ran and failed is
    // still missing its intent, so the pause stands.
    const kept = await recheckPausedEffects(deps, plan.pause);
    assert.equal(kept.resolved, false);
    assert.equal(kept.pause?.reason, "tool-evidence-missing");

    // Pi refused the call BEFORE executing it (an error result with no
    // duration): the transcript proves the tool did not run, and the pause the
    // factory wrote from an earlier read settles on its own.
    seedSessionToolCall(session, {
      callId: "call-ghost",
      command: "git push origin agent-issue-7",
      answered: true,
      result: { isError: true, text: "msf continuity guardrail: realized before the interruption" },
    });
    const settled = await recheckPausedEffects(deps, plan.pause);
    assert.equal(settled.resolved, true, JSON.stringify(settled.pause));
  });

  test("an interruption inside a provably local call is continued: there is nothing to reconcile", async () => {
    // The guardrail journals only what can reach outside the worktree, so a
    // safe call leaves no intent — and its absence must NOT be read as an
    // unexplained mutation. This is the "comprovadamente seguro pode
    // prosseguir" half of the issue's criterion: pausing here would refuse
    // every legitimate recovery.
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-read", command: "git status && rg -n continuity src", answered: false });

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    if (plan.decision !== "launch") return;
    assert.equal(plan.mode, "resume");
    assert.equal(plan.sessionId, session.sessionId);
    assert.deepEqual(readGuardrailState(workDir)?.verdicts, {}, "a local call produces no effect to reconcile");
  });

  test("a partial tail under the guardrail's record is usable; without it, it pauses", async () => {
    const session = seedSession(workDir, REF, 2);
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(session.file, `${readFileSync(session.file, "utf8")}{"type":"message","id":"cut`, "utf8");

    const withoutRecord = await planContinuity(deps, "resume");
    assert.equal(withoutRecord.decision, "pause");
    if (withoutRecord.decision !== "pause") return;
    assert.equal(withoutRecord.pause.reason, "tool-evidence-missing");

    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    const withRecord = await planContinuity(deps, "resume");
    assert.equal(withRecord.decision, "launch");
    assert.equal(readFileSync(session.file, "utf8").endsWith('{"type":"message","id":"cut'), true, "the original file is never rewritten");
  });

  test("an earlier round's call id is not evidence for this round's call", async () => {
    // `call-1` repeats across a session's rounds. An intent journaled by the
    // PREVIOUS session says nothing about the current one: a mutating call the
    // guardrail never journaled here would otherwise look accounted for.
    const earlier = seedSession(workDir, REF, 2, { round: 1, sessionId: "11111111-2222-3333-4444-000000000002" });
    appendJournalStart(workDir, { attempt: 2, sessionId: earlier.sessionId });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: earlier.sessionId,
      callId: "call-1",
      tool: "bash",
      command: "git push origin agent-issue-7",
      safety: "effect",
      actions: [{ kind: "push", key: "push:agent-issue-7@abc", detail: "push", branch: "agent-issue-7", sha: "abc" }],
    });

    const current = seedSession(workDir, REF, 2, { round: 2, sessionId: "11111111-2222-3333-4444-000000000022" });
    appendJournalStart(workDir, { attempt: 2, sessionId: current.sessionId });
    seedSessionToolCall(current, { callId: "call-1", command: "git push origin agent-issue-7", answered: true });

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "tool-evidence-missing");
    assert.equal(plan.pause.sessionId, current.sessionId, "the CURRENT round is the one whose evidence is missing");
  });

  test("an interrupted comment is reconciled against the PR conversation, not against a mock", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    const body = "addressed the feedback";
    seedSessionToolCall(session, { callId: "call-comment", command: `gh pr comment 7 --body "${body}"`, answered: false });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: "call-comment",
      tool: "bash",
      command: `gh pr comment 7 --body "${body}"`,
      safety: "effect",
      actions: [{ kind: "comment", key: `comment:pr:7:${digestOf(body)}`, detail: "comment on PR #7", target: "pr", number: 7, body }],
    });
    tracker.seedPullRequest({ repo: REPO, number: 7, headBranch: BRANCH });
    tracker.addPrComment({ repo: REPO, prNumber: 7 }, "bot", body);

    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`comment:pr:7:${digestOf(body)}`], "realized");
  });

  /** An interrupted effect of the attempt, journaled before it ran. Each call
   *  is its own interruption (a distinct call id), so the phases below are
   *  separate windows rather than one reconciliation repeated. */
  function interruptInside(action: { callId: string; command: string; entry: EffectAction }): void {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: action.callId, command: action.command, answered: false });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: action.callId,
      tool: "bash",
      command: action.command,
      safety: "effect",
      actions: [action.entry],
    });
  }

  test("an interrupted PR creation is reconciled against the tracker: none is absent, the branch is realized, another branch is ambiguous", async () => {
    const interruptedPr = (callId: string): void =>
      interruptInside({
        callId,
        command: `gh pr create --head ${BRANCH}`,
        entry: { kind: "pr", key: `pr:${BRANCH}`, detail: `open PR from ${BRANCH}`, branch: BRANCH },
      });

    interruptedPr("call-pr-1");
    const absent = await planContinuity(deps, "resume");
    assert.equal(absent.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`pr:${BRANCH}`], "absent", "no PR exists: it may be opened once");

    tracker.seedPullRequest({ repo: REPO, number: 7, headBranch: BRANCH });
    interruptedPr("call-pr-2");
    const realized = await planContinuity(deps, "resume");
    assert.equal(realized.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`pr:${BRANCH}`], "realized", "the PR on the branch is the effect");

    tracker.seedPullRequest({ repo: REPO, number: 7, headBranch: "someone-elses-branch" });
    interruptedPr("call-pr-3");
    const ambiguous = await planContinuity(deps, "resume");
    assert.equal(ambiguous.decision, "pause");
    if (ambiguous.decision !== "pause") return;
    assert.equal(ambiguous.pause.reason, "effect-ambiguous");
    assert.match(ambiguous.pause.detail, /someone-elses-branch/);
  });

  test("an interrupted label change is reconciled against the issue's labels: missing is absent, present is realized, unreadable pauses", async () => {
    const label = "agent-blocked";
    const interruptedLabel = (callId: string): void =>
      interruptInside({
        callId,
        command: `gh issue edit 7 --add-label ${label}`,
        entry: { kind: "label", key: `label:7:${label}`, detail: `add label ${label} to issue #7`, number: 7, label },
      });

    interruptedLabel("call-label-1");
    const absent = await planContinuity(deps, "resume");
    assert.equal(absent.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`label:7:${label}`], "absent", "the label is not there: it may be added once");

    await tracker.blockTicketClaim(REF.ticket, DEFAULT_LABELS);
    interruptedLabel("call-label-2");
    const realized = await planContinuity(deps, "resume");
    assert.equal(realized.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`label:7:${label}`], "realized");

    // An issue that cannot be read is never read as "the label is missing".
    const unreadableTracker = new FakeTrackerAdapter({ workerAccount: "bot" });
    deps.tickets = unreadableTracker;
    deps.pullRequests = unreadableTracker;
    interruptedLabel("call-label-3");
    const unreadable = await planContinuity(deps, "resume");
    assert.equal(unreadable.decision, "pause");
    if (unreadable.decision !== "pause") return;
    assert.equal(unreadable.pause.reason, "effect-ambiguous");
  });

  test("the recheck resolves a pause only when a fresh read settles the effect", async () => {
    interruptInsidePush({ sha: "abc123", remote: null });
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "launch", "absent is allowed once");

    // A new interruption left a pending push the remote does not prove.
    const session = seedSession(workDir, REF, 2, { round: 2, sessionId: "99999999-9999-9999-9999-999999999999" });
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-2", command: "git push origin agent-issue-7", answered: false });
    appendJournalIntent(workDir, {
      attempt: 2,
      sessionId: session.sessionId,
      callId: "call-2",
      tool: "bash",
      command: "git push origin agent-issue-7",
      safety: "effect",
      actions: [{ kind: "push", key: `push:${BRANCH}@abc123`, detail: "push", branch: BRANCH, sha: "abc123" }],
    });
    git.remoteHead = "def456";
    const unresolved = await recheckPausedEffects(deps, pauseUnderRecheck("effect-ambiguous", 2));
    assert.equal(unresolved.resolved, false);
    assert.equal(unresolved.pause?.reason, "effect-ambiguous");

    git.remoteHead = "abc123";
    const resolved = await recheckPausedEffects(deps, pauseUnderRecheck("effect-ambiguous", 2));
    assert.equal(resolved.resolved, true);
  });

  test("a recheck names the cause the disk now holds, not the reason the pause was written with", async () => {
    // The record was written while the journal could not be read. The journal is
    // readable again, so that doubt is gone — but the session it can now read is
    // not, and THAT is the cause the operator must see. Keeping the old reason
    // would hide a real change of cause behind a doubt this read disproved.
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    writeFileSync(session.file, "{not-json}{\n", "utf8");

    const kept = await recheckPausedEffects(deps, pauseUnderRecheck("journal-unreadable", 2));

    assert.equal(kept.resolved, false, "a session that cannot be read settles nothing");
    assert.equal(kept.pause?.reason, "session-unreadable", "the real cause, not the stale journal-unreadable");
    assert.equal(kept.pause?.sessionId, session.sessionId, "the identity of the session it could not read is kept");
    assert.match(kept.pause?.detail ?? "", /not a session header/, "the detail is the fresher read's");
    assert.equal(readPause(workDir), null, "a recheck never writes a pause of its own");

    // And nothing is launched over a history the factory cannot read.
    const plan = await planContinuity(deps, "resume");
    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "session-unreadable");
    assert.equal(readGuardrailState(workDir), null, "no guardrail state is written for a session it cannot reopen");
  });

  /** The journaled intent of a call the interruption left without a result. */
  function journalOpenCall(call: {
    sessionId: string;
    callId: string;
    command: string;
    attempt?: number;
  }): void {
    appendJournalIntent(workDir, {
      attempt: call.attempt ?? 2,
      sessionId: call.sessionId,
      callId: call.callId,
      tool: "bash",
      command: call.command,
      safety: "unknown",
      actions: [],
      reason: "curl is not a proven-local command",
    });
  }

  function sessionFileOf(sessionId: string): string {
    return join(workDir, SESSIONS_SUBDIR, "--fake-worker--", `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  }

  /** The attempt's session carrying one call and the terminal result Pi
   *  persisted for it, with the intent journaled and no journal result. */
  function refusedCall(options: { callId?: string; command?: string; result: SeededCallResult }): {
    sessionId: string;
    callId: string;
    command: string;
  } {
    const callId = options.callId ?? "call-refused";
    const command = options.command ?? "curl -X POST https://example.com";
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId, command, answered: true, result: options.result });
    journalOpenCall({ sessionId: session.sessionId, callId, command });
    return { sessionId: session.sessionId, callId, command };
  }

  test("an observed refusal of an unclassifiable call closes the intent and the work continues", async () => {
    // The gap of the reported incident: the guardrail journaled the intent, the
    // call was refused AFTER it, and Pi persisted the terminal error in the
    // session the journal never received. Pausing for help over a conclusion the
    // session already holds is what trapped the operator.
    const call = refusedCall({
      result: { isError: true, text: "msf continuity guardrail: realized before the interruption" },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    const journal = readEffectJournal(workDir);
    assert.deepEqual(journal.pending, [], "the gap is closed durably");
    assert.deepEqual(
      journal.results.map(({ callId, ok, source, evidenceAt }) => ({ callId, ok, source, evidenceAt })),
      [{ callId: call.callId, ok: false, source: "session", evidenceAt: "2026-01-01T00:00:02.000Z" }],
      "the observed error and the evidence it came from are both preserved",
    );
  });

  test("an observed success closes the intent with success, never with a verdict about the world", async () => {
    const call = refusedCall({ result: { isError: false, text: "ok", durationMs: 12 } });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    const [result] = readEffectJournal(workDir).results;
    assert.equal(result?.callId, call.callId);
    assert.equal(result?.ok, true);
    assert.equal(result?.source, "session");
  });

  test("a genuinely missing result keeps the pause, and says the session was consulted", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    // The session holds the call; nothing says how it ended.
    seedSessionToolCall(session, { callId: "call-open", command: "curl -X POST https://example.com", answered: false });
    journalOpenCall({ sessionId: session.sessionId, callId: "call-open", command: "curl -X POST https://example.com" });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause");
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.match(plan.pause.detail, /curl -X POST/);
    assert.match(plan.pause.detail, /session records no terminal result/, "the operator learns the session was checked");
    assert.deepEqual(
      readEffectJournal(workDir).pending.map((intent) => intent.callId),
      ["call-open"],
      "absence is not fabricated into a result",
    );
  });

  test("a call's observed error is not absence: the conclusion persists and the ambiguous effect keeps the pause", async () => {
    interruptInsidePush({ sha: "abc123", remote: "def456", result: { isError: true, text: "exited 1" } });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-ambiguous", "the remote, not the error, decides absence");
    assert.match(plan.pause.detail, /def456/);
    assert.deepEqual(
      readEffectJournal(workDir).results.map(({ callId, ok, source }) => ({ callId, ok, source })),
      [{ callId: "call-push", ok: false, source: "session" }],
      "the observed conclusion is persisted despite the ambiguous effect",
    );

    // A recheck reads the world again and appends nothing: the effect is still
    // ambiguous, so the pause stays and no result is duplicated.
    const unresolved = await recheckPausedEffects(deps, plan.pause);
    assert.equal(unresolved.resolved, false);
    assert.equal(unresolved.pause?.reason, "effect-ambiguous");
    assert.equal(readEffectJournal(workDir).results.length, 1, "one conclusion, never a duplicate");

    // The facts change: the remote now proves the push. The recheck resolves and
    // the next session's guardrail carries the verdict it needs.
    git.remoteHead = "abc123";
    const resolved = await recheckPausedEffects(deps, plan.pause);
    assert.equal(resolved.resolved, true);
    assert.equal(readEffectJournal(workDir).results.length, 1, "still one conclusion");
    const launch = await planContinuity(deps, "resume");
    assert.equal(launch.decision, "launch", JSON.stringify(launch));
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
  });

  test("a realized effect closed from the session keeps the observed error: conclusion and verdict are separate", async () => {
    interruptInsidePush({ sha: "abc123", remote: "abc123", result: { isError: true, text: "exited 1" } });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
    const [result] = readEffectJournal(workDir).results;
    assert.equal(result?.ok, false, "the call's observed outcome is preserved, not overwritten by the verdict");
    assert.equal(result?.source, "session");
  });

  test("an effect proven to the guardrail is not re-asked when the remote moves afterwards", async () => {
    // The conclusion came from the session, the verdict from the host's read.
    // Once the launch wrote it, a later recovery of the same attempt must not
    // read a since-moved (or vanished) remote as a new doubt — the session
    // result alone would keep this intent examinable forever.
    interruptInsidePush({ sha: "abc123", remote: "abc123", result: { isError: true, text: "exited 1" } });

    const first = await planContinuity(deps, "resume");
    assert.equal(first.decision, "launch", JSON.stringify(first));
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
    const asks = git.asks.length;

    git.remoteHead = "def456";
    const second = await planContinuity(deps, "resume");
    assert.equal(second.decision, "launch", JSON.stringify(second));
    assert.equal(git.asks.length, asks, "an effect already proven is not asked again");
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized", "the verdict is not overwritten");
    assert.equal(readEffectJournal(workDir).results.length, 1, "one conclusion, never a duplicate");

    // The session-closed intent is not re-examined any more, so it cannot pause
    // the work on a remote that merely moved.
    git.remoteHead = null;
    const third = await planContinuity(deps, "resume");
    assert.equal(third.decision, "launch", JSON.stringify(third));
    assert.equal(git.asks.length, asks);
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
  });

  test("a result from another session of the attempt is not evidence for this one", async () => {
    // Round 1 holds the result; the attempt's current session is round 2 and the
    // intent was journaled there. The session id is the identity, not the order.
    const earlier = seedSession(workDir, REF, 2, { round: 1, sessionId: "11111111-2222-3333-4444-000000000002" });
    const current = seedSession(workDir, REF, 2, { round: 2, sessionId: "11111111-2222-3333-4444-000000000022" });
    appendJournalStart(workDir, { attempt: 2, sessionId: current.sessionId });
    journalOpenCall({ sessionId: current.sessionId, callId: "call-x", command: "curl -X POST https://example.com" });
    seedSessionToolCall(earlier, {
      callId: "call-x",
      command: "curl -X POST https://example.com",
      answered: true,
      result: { isError: false },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.deepEqual(readEffectJournal(workDir).pending.map((intent) => intent.callId), ["call-x"]);
  });

  test("a result from another attempt's session is not evidence", async () => {
    const session = seedSession(workDir, REF, 2);
    seedSessionToolCall(session, {
      callId: "call-x",
      command: "curl -X POST https://example.com",
      answered: true,
      result: { isError: false },
    });
    // The intent claims attempt 3, which has no session association at all.
    journalOpenCall({ sessionId: session.sessionId, callId: "call-x", command: "curl -X POST https://example.com", attempt: 3 });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
  });

  test("a similar command under another call id is not evidence", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    journalOpenCall({ sessionId: session.sessionId, callId: "call-1", command: "curl -X POST https://example.com/a" });
    seedSessionToolCall(session, {
      callId: "call-2",
      command: "curl -X POST https://example.com/a",
      answered: true,
      result: { isError: false },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.deepEqual(readEffectJournal(workDir).pending.map((intent) => intent.callId), ["call-1"]);
  });

  test("a result whose call ran another tool is not evidence", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    journalOpenCall({ sessionId: session.sessionId, callId: "call-x", command: "curl -X POST https://example.com" });
    seedSessionToolCall(session, {
      callId: "call-x",
      command: "curl -X POST https://example.com",
      answered: true,
      tool: "subagent",
      result: { isError: false, tool: "subagent" },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
  });

  test("an answered marker without Pi's outcome is not evidence: the unclassifiable call still pauses", async () => {
    const call = refusedCall({ result: { omitOutcome: true } });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.deepEqual(
      readEffectJournal(workDir).pending.map((intent) => intent.callId),
      [call.callId],
      "a marker that never states the outcome is not a conclusion",
    );
  });

  test("an answered marker without Pi's outcome is not evidence for an effect either: the host decides", async () => {
    interruptInsidePush({ sha: "abc123", remote: "abc123", result: { omitOutcome: true } });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    assert.equal(readGuardrailState(workDir)?.verdicts[`push:${BRANCH}@abc123`], "realized");
    const [result] = readEffectJournal(workDir).results;
    assert.equal(result?.ok, true, "the host's reconciliation, not the marker, closed it");
    assert.equal(result?.source, undefined, "and no session provenance is claimed for it");
  });

  test("duplicated terminal results are not evidence", async () => {
    const call = refusedCall({ result: { isError: false } });
    seedExtraToolResult({ sessionId: call.sessionId, file: sessionFileOf(call.sessionId) }, call.callId, {
      isError: true,
      text: "a second, conflicting answer",
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.match(plan.pause.detail, /more than one terminal result/);
  });

  test("free text, an answered marker and a synthetic entry are not a terminal result", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-x", command: "curl -X POST https://example.com", answered: false });
    const markers = [
      {
        type: "message",
        id: "human-note",
        parentId: null,
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: "the call answered ok" },
      },
      // An answered/compatibility marker that is not Pi's own transcript entry.
      { type: "toolResult", toolCallId: "call-x", isError: false, answered: true },
    ];
    writeFileSync(session.file, `${markers.map((marker) => JSON.stringify(marker)).join("\n")}\n`, { encoding: "utf8", flag: "a" });
    journalOpenCall({ sessionId: session.sessionId, callId: "call-x", command: "curl -X POST https://example.com" });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
  });

  test("a session whose history is not intact proves nothing", async () => {
    const call = refusedCall({ result: { isError: false } });
    const file = sessionFileOf(call.sessionId);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"message","id":"cut`, "utf8");

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    assert.deepEqual(readEffectJournal(workDir).pending.map((intent) => intent.callId), [call.callId]);
  });

  test("another intent still open keeps the pause: one closed call does not authorize the rest", async () => {
    const call = refusedCall({ result: { isError: false } });
    journalOpenCall({ sessionId: call.sessionId, callId: "call-second", command: "curl -X POST https://example.com/second" });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "effect-unsupported");
    const journal = readEffectJournal(workDir);
    assert.deepEqual(journal.pending.map((intent) => intent.callId), ["call-second"], "the resolvable one is already closed");
    assert.deepEqual(journal.results.map((result) => result.callId), [call.callId]);
  });

  test("a call Pi refused before execution is not missing evidence: the resumed session continues", async () => {
    // The guardrail refused the repeat BEFORE writing any intent, and Pi pinned
    // an error result with no duration because the tool never ran. Pausing here
    // would keep a resumed session stuck on evidence the guardrail itself made.
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, {
      callId: "call-blocked",
      command: "git push origin agent-issue-7",
      answered: true,
      result: { isError: true, text: "msf continuity guardrail: realized before the interruption" },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "launch", JSON.stringify(plan));
    if (plan.decision !== "launch") return;
    assert.equal(plan.mode, "resume");
  });

  test("a call that ran and then failed without an intent is still missing evidence", async () => {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, {
      callId: "call-ran",
      command: "git push origin agent-issue-7",
      answered: true,
      // A recorded duration proves the tool executed: its effect is unaccounted for.
      result: { isError: true, text: "exited 1", durationMs: 900 },
    });

    const plan = await planContinuity(deps, "resume");

    assert.equal(plan.decision, "pause", JSON.stringify(plan));
    if (plan.decision !== "pause") return;
    assert.equal(plan.pause.reason, "tool-evidence-missing");
  });
});

/** The same digest the classifier uses; independent helper for the expectation. */
function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
