import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { planContinuity, recheckPausedEffects, type ContinuityDeps } from "./continuity.js";
import {
  appendJournalIntent,
  appendJournalStart,
  readGuardrailState,
  readSessionLinks,
} from "./continuity-artifacts.js";
import { SESSIONS_SUBDIR } from "../layout.js";
import { DEFAULT_LABELS } from "../config.js";
import type { EffectAction } from "./effects.js";
import { seedSession, seedSessionToolCall } from "../e2e/session-fixtures.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import type { GitWork, LocalWorkFacts, PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";

/**
 * The host-side continuity contract (issue 119): where a launch comes from,
 * whether an interrupted attempt may be reopened, and what makes the factory
 * pause instead of guessing. Tested at the module's public functions with the
 * REAL artifacts on temp disk and the tracker/git boundaries the loop uses.
 */

const REF: IssueRef = { repo: "Sanmoo/my-tasks", number: 7 };
const BRANCH = "agent-issue-7";

class FakeGit implements GitWork {
  remoteHead: string | null = null;
  readonly asks: number[] = [];

  async prepareWork(): Promise<PreparedWork> {
    throw new Error("not used");
  }
  async cleanupDoneWork(): Promise<void> {}
  async diffWork(): Promise<string> {
    return "";
  }
  async observeRemoteHead(): Promise<string | null> {
    this.asks.push(1);
    return this.remoteHead;
  }
  async inspectLocalWork(): Promise<LocalWorkFacts> {
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
    seedIssue(tracker, { repo: REF.repo, number: REF.number, labels: ["agent-claimed"] });
    git = new FakeGit();
    deps = {
      workDir,
      sessionsDir: join(workDir, SESSIONS_SUBDIR),
      ref: REF,
      attempt: 2,
      git,
      tracker,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An interrupted session of the attempt, with its intent on disk. */
  function interruptInsidePush(options: { sha?: string; remote?: string | null; journal?: boolean } = {}): void {
    const session = seedSession(workDir, REF, 2);
    appendJournalStart(workDir, { attempt: 2, sessionId: session.sessionId });
    seedSessionToolCall(session, { callId: "call-push", command: "git push origin agent-issue-7", answered: false });
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
      work: { repo: REF.repo, number: REF.number },
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
    tracker.seedPullRequest({ repo: REF.repo, number: 7, headBranch: BRANCH });
    tracker.addPrComment({ repo: REF.repo, prNumber: 7 }, "bot", body);

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

    tracker.seedPullRequest({ repo: REF.repo, number: 7, headBranch: BRANCH });
    interruptedPr("call-pr-2");
    const realized = await planContinuity(deps, "resume");
    assert.equal(realized.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`pr:${BRANCH}`], "realized", "the PR on the branch is the effect");

    tracker.seedPullRequest({ repo: REF.repo, number: 7, headBranch: "someone-elses-branch" });
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

    await tracker.blockClaim(REF, DEFAULT_LABELS);
    interruptedLabel("call-label-2");
    const realized = await planContinuity(deps, "resume");
    assert.equal(realized.decision, "launch");
    assert.equal(readGuardrailState(workDir)?.verdicts[`label:7:${label}`], "realized");

    // An issue that cannot be read is never read as "the label is missing".
    deps.tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
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
    const unresolved = await recheckPausedEffects(deps);
    assert.equal(unresolved.resolved, false);
    assert.equal(unresolved.pause?.reason, "effect-ambiguous");

    git.remoteHead = "abc123";
    const resolved = await recheckPausedEffects(deps);
    assert.equal(resolved.resolved, true);
  });
});

/** The same digest the classifier uses; independent helper for the expectation. */
function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
