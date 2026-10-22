/**
 * Continuity of an interrupted attempt (issue 119): which Pi session the next
 * launch opens, whether it may be reopened at all, and what the operator is
 * told when it may not.
 *
 * A recovery continues the SAME attempt by reopening the session recorded for
 * it — never the newest file, never a session found by mtime, never a fresh
 * session with reconstructed context. Before letting a resumed session run,
 * every effect an interruption left open is reconciled against the real state
 * (the remote branch and the tracker): realized effects must not be repeated,
 * absent ones may be, and an ambiguous or unreconcilable one pauses the work
 * and asks the operator — absence of confirmation is never read as absence of
 * effect.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GitWork } from "../git/port.js";
import { workBranchName } from "../git/port.js";
import type { IssueRef, TrackerPort } from "../tracker/port.js";
import { AGENT_MARKER } from "../tracker/port.js";
import { classifyCommand, type EffectAction } from "./effects.js";
import { eventLogName } from "./attempt-logs.js";
import {
  appendJournalResult,
  appendSessionLink,
  linkForAttempt,
  nextRound,
  readEffectJournal,
  readGuardrailState,
  readSessionLinks,
  writeGuardrailState,
  type EffectVerdict,
  type GuardrailState,
  type PauseReason,
  type PauseRecord,
} from "./continuity-artifacts.js";
import { findSessionFile, inspectSessionFile, sessionToolCalls } from "./session-log.js";

export interface ContinuityDeps {
  workDir: string;
  sessionsDir: string;
  ref: IssueRef;
  attempt: number;
  branch: string;
  git: GitWork;
  tracker: TrackerPort;
  now?: () => Date;
}

export type ContinuityPlan =
  | { decision: "launch"; mode: "new" | "resume"; sessionId: string; intactEntries: number }
  | { decision: "pause"; pause: PauseRecord };

export interface RecheckResult {
  /** Every open effect is settled: the paused work may start a new round. */
  resolved: boolean;
  pause: PauseRecord | null;
}

/**
 * Decide the launch: a NEW session (with its association written BEFORE the
 * worker starts) or the RESUME of the exact session the interrupted attempt
 * carries — or the pause that asks for help instead of pretending.
 *
 * The open effects are reconciled on BOTH paths: a new orientation round on a
 * work whose earlier effect is unresolved must not proceed blind either.
 */
export async function planContinuity(deps: ContinuityDeps, mode: "new" | "resume"): Promise<ContinuityPlan> {
  const effects = await settleOpenEffects(deps);
  if (!effects.settled) return { decision: "pause", pause: effects.pause };

  if (mode === "new") return startFirstSession(deps, effects.verdicts);

  const links = readSessionLinks(deps.workDir);
  if (!links.intact) {
    return {
      decision: "pause",
      pause: pauseOf(deps, "session-identity", "the session-association journal is unreadable"),
    };
  }
  const link = linkForAttempt(links.links, { repo: deps.ref.repo, number: deps.ref.number }, deps.attempt);
  if (link === null) {
    // A claim whose worker never started (a death between the claim and the
    // spawn) leaves ZERO attempt evidence: there is no session to lose, so the
    // SAME attempt legitimately creates its first session. A legacy attempt
    // that left any evidence but no association is a different case: its
    // session cannot be identified and the work pauses.
    if (!hasAttemptEvidence(deps)) return startFirstSession(deps, effects.verdicts);
    return {
      decision: "pause",
      pause: pauseOf(
        deps,
        "link-missing",
        `attempt ${deps.attempt} has no recorded Pi session — a fresh session would be a new execution, not a continuation`,
      ),
    };
  }

  const file = findSessionFile(deps.sessionsDir, link.sessionId);
  if (file === null) {
    // The association exists but the file does not. A session Pi never started
    // leaves no log, no journal record and no session file: nothing can be
    // lost, so the SAME attempt starts its first session. Once any evidence
    // exists (the session ran), its absence pauses the work.
    if (!hasAttemptEvidence(deps)) return startFirstSession(deps, effects.verdicts);
    return {
      decision: "pause",
      pause: pauseOf(deps, "session-missing", `the session ${link.sessionId} recorded for attempt ${deps.attempt} is not on disk`, link.sessionId),
    };
  }
  const inspection = inspectSessionFile(file, link.sessionId);
  if (inspection.status === "identity-mismatch" || inspection.status === "missing") {
    return {
      decision: "pause",
      pause: pauseOf(deps, "session-identity", inspection.detail ?? "the session identity does not match", link.sessionId),
    };
  }
  if (inspection.status === "unreadable") {
    return {
      decision: "pause",
      pause: pauseOf(deps, "session-unreadable", inspection.detail ?? "the session history is unreadable", link.sessionId),
    };
  }

  const journal = readEffectJournal(deps.workDir);
  if (!journal.intact) {
    return {
      decision: "pause",
      pause: pauseOf(
        deps,
        "journal-unreadable",
        "the effect journal has an incomplete or unparseable entry — it cannot prove which effects were attempted",
        link.sessionId,
      ),
    };
  }

  // A discarded tail is only safe when the journal proves the session ran
  // under the guardrail: every effectful call records its intent before it
  // executes, so the tail cannot hide one that this journal does not know.
  if (inspection.status === "partial" && !journal.sessions.some((entry) => entry.sessionId === link.sessionId)) {
    return {
      decision: "pause",
      pause: pauseOf(
        deps,
        "tool-evidence-missing",
        `the session ends with an incomplete entry and no guardrail record proves what the discarded tail could have run`,
        link.sessionId,
      ),
    };
  }

  const intentsByCall = new Map(journal.intents.map((intent) => [intent.callId, intent]));
  for (const call of sessionToolCalls(file, inspection.intactEntries)) {
    if (call.tool !== "bash") continue;
    const safety = classifyCommand(call.command);
    if (safety.safety === "safe") continue;
    if (!intentsByCall.has(call.callId)) {
      return {
        decision: "pause",
        pause: pauseOf(
          deps,
          "tool-evidence-missing",
          `the session records a ${safety.safety} bash call ${call.callId} with no guardrail intent — its effect cannot be established`,
          link.sessionId,
        ),
      };
    }
  }

  writeGuardrailState(deps.workDir, guardrailState(deps, "resume", link.sessionId, effects.verdicts));
  return { decision: "launch", mode: "resume", sessionId: link.sessionId, intactEntries: inspection.intactEntries };
}

/**
 * The operator answered a paused work: verify the facts again before any
 * mutation. The answer is orientation, never confirmation that an effect did
 * not happen — what settled the pause is a fresh read of the real state.
 */
export async function recheckPausedEffects(deps: ContinuityDeps): Promise<RecheckResult> {
  const effects = await settleOpenEffects(deps);
  return effects.settled ? { resolved: true, pause: null } : { resolved: false, pause: effects.pause };
}

/**
 * The attempt's FIRST session: the association is recorded before the worker
 * starts, so the very next recovery can only pick THIS session. Used for a new
 * launch and for a claim whose worker never started (nothing can be lost).
 */
function startFirstSession(deps: ContinuityDeps, verdicts: Record<string, EffectVerdict>): ContinuityPlan {
  const links = readSessionLinks(deps.workDir);
  const sessionId = randomUUID();
  appendSessionLink(deps.workDir, {
    version: 1,
    work: { repo: deps.ref.repo, number: deps.ref.number },
    attempt: deps.attempt,
    round: nextRound(links.links, { repo: deps.ref.repo, number: deps.ref.number }, deps.attempt),
    mode: "new",
    sessionId,
    at: nowIso(deps),
  });
  writeGuardrailState(deps.workDir, guardrailState(deps, "new", sessionId, verdicts));
  return { decision: "launch", mode: "new", sessionId, intactEntries: 0 };
}

type SettledEffects =
  | { settled: true; verdicts: Record<string, EffectVerdict> }
  | { settled: false; pause: PauseRecord };

/**
 * Reconcile every intent that has no result — the window an interruption left
 * open — plus every intent an earlier unresolved round left behind. The
 * verdicts are what the next session's guardrail enforces, and the settled
 * intents get their result recorded: an effect already reconciled is not asked
 * again (a later restart must not read a since-moved remote as a new doubt).
 */
async function settleOpenEffects(deps: ContinuityDeps): Promise<SettledEffects> {
  const journal = readEffectJournal(deps.workDir);
  if (!journal.intact) {
    return { settled: false, pause: pauseOf(deps, "journal-unreadable", "the effect journal is incomplete or unparseable") };
  }
  const verdicts: Record<string, EffectVerdict> = {};
  for (const intent of journal.pending) {
    if (intent.safety === "unknown") {
      return {
        settled: false,
        pause: pauseOf(
          deps,
          "effect-unsupported",
          `an interrupted call (${intent.command}) has no reliable reconciliation: ${intent.reason ?? "its effect cannot be classified"}`,
          intent.sessionId,
        ),
      };
    }
    for (const action of intent.actions) {
      const settled = await reconcileAction(deps, action);
      if (settled.verdict === "unknown") {
        return {
          settled: false,
          pause: pauseOf(deps, "effect-ambiguous", `${action.detail}: ${settled.detail}`, intent.sessionId),
        };
      }
      verdicts[action.key] = settled.verdict;
    }
    appendJournalResult(deps.workDir, {
      attempt: intent.attempt,
      sessionId: intent.sessionId,
      callId: intent.callId,
      ok: intent.actions.every((action) => verdicts[action.key] === "realized"),
    });
  }
  return { settled: true, verdicts };
}

type Reconciled = { verdict: "realized" | "absent" } | { verdict: "unknown"; detail: string };

/** Ask the real state whether one effect happened. Unknown is never absent. */
async function reconcileAction(deps: ContinuityDeps, action: EffectAction): Promise<Reconciled> {
  try {
    if (action.kind === "push") return await reconcilePush(deps, action);
    if (action.kind === "pr") return await reconcilePr(deps, action);
    if (action.kind === "comment") return await reconcileComment(deps, action);
    return await reconcileLabel(deps, action);
  } catch (error) {
    return { verdict: "unknown", detail: `the external state could not be read (${reasonOf(error)})` };
  }
}

async function reconcilePush(deps: ContinuityDeps, action: EffectAction): Promise<Reconciled> {
  const branch = action.branch ?? workBranchName(deps.ref.number);
  if (branch !== workBranchName(deps.ref.number)) {
    return { verdict: "unknown", detail: `only ${workBranchName(deps.ref.number)} is observable from the factory` };
  }
  const remote = await deps.git.observeRemoteHead(deps.ref);
  if (remote === null) return { verdict: "absent" };
  if (action.sha !== undefined && remote === action.sha) return { verdict: "realized" };
  return {
    verdict: "unknown",
    detail: action.sha === undefined
      ? `the remote branch exists at ${remote} but the interrupted call did not record which commit it pushed`
      : `the remote branch is at ${remote}, not at the intended ${action.sha}`,
  };
}

async function reconcilePr(deps: ContinuityDeps, action: EffectAction): Promise<Reconciled> {
  const feedback = await deps.tracker.readPrFeedback(deps.ref);
  if (!feedback.known) return { verdict: "unknown", detail: "the PR state could not be read" };
  const pr = feedback.value.pr;
  if (pr === null) return { verdict: "absent" };
  if (action.branch !== undefined && pr.headBranch === action.branch) return { verdict: "realized" };
  return {
    verdict: "unknown",
    detail: `PR #${pr.number} exists on ${pr.headBranch}, which does not prove this action's effect`,
  };
}

async function reconcileComment(deps: ContinuityDeps, action: EffectAction): Promise<Reconciled> {
  if (action.body === undefined || action.number === undefined || action.target === undefined) {
    return { verdict: "unknown", detail: "the comment's number and body were not recorded" };
  }
  const bodies: string[] = [];
  if (action.target === "pr") {
    const feedback = await deps.tracker.readPrFeedback(deps.ref);
    if (!feedback.known) return { verdict: "unknown", detail: "the PR conversation could not be read" };
    if (feedback.value.pr !== null && feedback.value.pr.number !== action.number) {
      return { verdict: "unknown", detail: `the work's PR is #${feedback.value.pr.number}, not #${action.number}` };
    }
    bodies.push(...feedback.value.comments.map((comment) => comment.body), ...feedback.value.reviews.map((comment) => comment.body));
  } else {
    const comments = await deps.tracker.readComments(deps.ref);
    if (!comments.known) return { verdict: "unknown", detail: "the issue conversation could not be read" };
    bodies.push(...comments.value.map((comment) => comment.body));
  }
  const wanted = normalizeComment(action.body);
  const found = bodies.some((body) => normalizeComment(body) === wanted);
  return found ? { verdict: "realized" } : { verdict: "absent" };
}

async function reconcileLabel(deps: ContinuityDeps, action: EffectAction): Promise<Reconciled> {
  if (action.label === undefined || action.number === undefined) {
    return { verdict: "unknown", detail: "the label change was not recorded completely" };
  }
  if (action.number !== deps.ref.number) {
    return { verdict: "unknown", detail: `the work's issue is #${deps.ref.number}, not #${action.number}` };
  }
  const issue = await deps.tracker.readIssue(deps.ref);
  if (!issue.known) return { verdict: "unknown", detail: "the issue labels could not be read" };
  return issue.value.labels.includes(action.label) ? { verdict: "realized" } : { verdict: "absent" };
}

/** The agent marker is presentation; the body the action asked for is the fact. */
function normalizeComment(body: string): string {
  return body.replaceAll(AGENT_MARKER, "").replace(/\s+/g, " ").trim();
}

/**
 * What the next session's guardrail enforces. The verdicts of every earlier
 * launch are carried forward: an effect the factory once PROVED realized is
 * realized for good, and a later restart must not lose that fact just because
 * the call that produced it was also carrying an effect proven absent (a
 * per-call result cannot express the difference).
 */
function guardrailState(
  deps: ContinuityDeps,
  mode: "new" | "resume",
  sessionId: string,
  verdicts: Record<string, EffectVerdict>,
): GuardrailState {
  const previous = readGuardrailState(deps.workDir)?.verdicts ?? {};
  return { version: 1, attempt: deps.attempt, sessionId, mode, verdicts: { ...previous, ...verdicts }, at: nowIso(deps) };
}

function pauseOf(deps: ContinuityDeps, reason: PauseReason, detail: string, sessionId?: string): PauseRecord {
  return {
    version: 1,
    work: { repo: deps.ref.repo, number: deps.ref.number },
    attempt: deps.attempt,
    reason,
    detail,
    at: nowIso(deps),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/**
 * Does THIS attempt carry evidence that it ever reached a worker? Zero
 * evidence means no session can be lost (the claim never reached a spawn) and
 * the attempt legitimately starts its first session. Only the attempt's own
 * artifacts count — its event log, written before the session, and the
 * guardrail's record of it; another attempt's session proves nothing about
 * this one.
 */
function hasAttemptEvidence(deps: ContinuityDeps): boolean {
  if (existsSync(join(deps.workDir, eventLogName(deps.attempt)))) return true;
  return readEffectJournal(deps.workDir).sessions.some((entry) => entry.attempt === deps.attempt);
}

function nowIso(deps: ContinuityDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
