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

import type { ExpandedGitWork } from "../git/port.js";
import { branchOfWork } from "../git/port.js";
import { type WorkIdentity } from "../tracker/identity.js";
import type { PullRequestTracker, TicketTracker } from "../tracker/expanded-port.js";
import { AGENT_MARKER } from "../tracker/port.js";
import { classifyCommand, type EffectAction } from "./effects.js";
import { eventLogName } from "./attempt-logs.js";
import {
  appendJournalResult,
  appendSessionLink,
  callKey,
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
  /** The Work whose attempt is being continued: its ticket source and destination. */
  work: WorkIdentity;
  attempt: number;
  git: ExpandedGitWork;
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
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
  const link = linkForAttempt(links.links, deps.work, deps.attempt);
  if (link === null) {
    // A claim whose worker never started (a death between the claim and the
    // spawn) leaves ZERO attempt evidence: there is no session to lose, so the
    // SAME attempt legitimately creates its first session. A legacy attempt
    // that left any evidence but no association is a different case: its
    // session cannot be identified and the work pauses.
    return firstSessionOrPause(
      deps,
      effects.verdicts,
      "link-missing",
      `attempt ${deps.attempt} has no recorded Pi session — a fresh session would be a new execution, not a continuation`,
    );
  }

  const file = findSessionFile(deps.sessionsDir, link.sessionId);
  if (file === null) {
    // The association exists but the file does not. A session Pi never started
    // leaves no log, no journal record and no session file: nothing can be
    // lost, so the SAME attempt starts its first session. Once any evidence
    // exists (the session ran), its absence pauses the work.
    return firstSessionOrPause(
      deps,
      effects.verdicts,
      "session-missing",
      `the session ${link.sessionId} recorded for attempt ${deps.attempt} is not on disk`,
      link.sessionId,
    );
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

  // Paired with the journal's own rule (`callKey`), scoped to the session
  // being resumed: a `call-1` from an earlier round of the same attempt is not
  // evidence for THIS round's call, and would hide a call nobody journaled.
  const intentsByCall = new Map(
    journal.intents
      .filter((intent) => intent.sessionId === link.sessionId)
      .map((intent) => [callKey(intent.sessionId, intent.callId), intent]),
  );
  for (const call of sessionToolCalls(file, inspection.intactEntries)) {
    if (call.tool !== "bash") continue;
    const safety = classifyCommand(call.command);
    if (safety.safety === "safe") continue;
    if (!intentsByCall.has(callKey(link.sessionId, call.callId))) {
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
 * No session to continue. When the attempt left ZERO evidence it never reached
 * a worker (a death between the claim and the spawn): nothing can be lost, so
 * the SAME attempt legitimately starts its first session. Once any evidence
 * exists, the session that ran cannot be identified and the work pauses.
 */
function firstSessionOrPause(
  deps: ContinuityDeps,
  verdicts: Record<string, EffectVerdict>,
  reason: PauseReason,
  detail: string,
  sessionId?: string,
): ContinuityPlan {
  if (hasAttemptEvidence(deps)) return { decision: "pause", pause: pauseOf(deps, reason, detail, sessionId) };
  return startFirstSession(deps, verdicts);
}

/**
 * The attempt's FIRST session: the association is recorded before the worker
 * starts, so the very next recovery can only pick THIS session.
 *
 * The guardrail state is written here too, and it is not optional: the
 * in-container guardrail refuses every effect it cannot prove local while that
 * state is missing (it cannot tell a resumption from a first run). Every
 * FACTORY launch path comes through here or `planContinuity`'s resume branch,
 * both of which write it before the runtime is asked to launch; a caller
 * driving the runtime directly gets an unguarded session by that contract.
 */
function startFirstSession(deps: ContinuityDeps, verdicts: Record<string, EffectVerdict>): ContinuityPlan {
  const links = readSessionLinks(deps.workDir);
  const sessionId = randomUUID();
  appendSessionLink(deps.workDir, {
    version: 1,
    work: deps.work,
    attempt: deps.attempt,
    round: nextRound(links.links, deps.work, deps.attempt),
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
  const branch = action.branch ?? branchOfWork(deps.work);
  if (branch !== branchOfWork(deps.work)) {
    return { verdict: "unknown", detail: `only ${branchOfWork(deps.work)} is observable from the factory` };
  }
  const remote = await deps.git.observeRemoteHeadFor(deps.work);
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
  const feedback = await deps.pullRequests.readPullRequestFeedback({ work: deps.work, pullRequest: null });
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
    const feedback = await deps.pullRequests.readPullRequestFeedback({ work: deps.work, pullRequest: null });
    if (!feedback.known) return { verdict: "unknown", detail: "the PR conversation could not be read" };
    if (feedback.value.pr !== null && feedback.value.pr.number !== action.number) {
      return { verdict: "unknown", detail: `the work's PR is #${feedback.value.pr.number}, not #${action.number}` };
    }
    bodies.push(...feedback.value.comments.map((comment) => comment.body), ...feedback.value.reviews.map((comment) => comment.body));
  } else {
    const comments = await deps.tickets.readTicketComments(deps.work.ticket);
    if (!comments.known) return { verdict: "unknown", detail: "the ticket conversation could not be read" };
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
  const { ticket } = deps.work;
  // Labels are a GitHub issue command: a non-GitHub source has no GitHub issue
  // to read, so the effect cannot be reconciled from the factory's side.
  if (ticket.provider !== "github") {
    return {
      verdict: "unknown",
      detail: `the the work's source is ${ticket.provider}:${ticket.site}, so a GitHub label read cannot establish this effect`,
    };
  }
  if (action.number !== ticket.number) {
    return { verdict: "unknown", detail: `the work's issue is #${ticket.number}, not #${action.number}` };
  }
  const issue = await deps.tickets.readTicket(ticket);
  if (!issue.known) return { verdict: "unknown", detail: "the issue labels could not be read" };
  return issue.value.labels.includes(action.label) ? { verdict: "realized" } : { verdict: "absent" };
}

/** The agent marker is presentation; the body the action asked for is the fact. */
function normalizeComment(body: string): string {
  return body.replaceAll(AGENT_MARKER, "").replace(/\s+/g, " ").trim();
}

/**
 * What the next session's guardrail enforces. The verdicts of the ATTEMPT's
 * earlier launches are carried forward: an effect the factory once PROVED
 * realized stays realized, and a later restart of the same attempt must not
 * lose that fact just because the call that produced it was also carrying an
 * effect proven absent (a per-call result cannot express the difference). A
 * new attempt starts from nothing: its work may legitimately redo what the
 * previous attempt published.
 */
function guardrailState(
  deps: ContinuityDeps,
  mode: "new" | "resume",
  sessionId: string,
  verdicts: Record<string, EffectVerdict>,
): GuardrailState {
  const previous = readGuardrailState(deps.workDir);
  const carried = previous !== null && previous.attempt === deps.attempt ? previous.verdicts : {};
  return { version: 1, attempt: deps.attempt, sessionId, mode, verdicts: { ...carried, ...verdicts }, at: nowIso(deps) };
}

function pauseOf(deps: ContinuityDeps, reason: PauseReason, detail: string, sessionId?: string): PauseRecord {
  return {
    version: 1,
    work: deps.work,
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
