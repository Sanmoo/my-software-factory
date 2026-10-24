/**
 * Continuity of an interrupted attempt: which Pi session the next
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
import { branchOfWork } from "../git/port.js";
import { workIdentityKey, type WorkIdentity } from "../tracker/identity.js";
import type { PullRequestTracker, TicketTracker } from "../tracker/expanded-port.js";
import { AGENT_MARKER } from "../tracker/port.js";
import { classifyCommand, type EffectAction } from "./effects.js";
import { eventLogName } from "./attempt-logs.js";
import { pendingCallRecovery, readCallRecoveries, recoveryForIntent, recoveryConsumption } from "./call-recovery.js";
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
  type EffectJournal,
  type EffectVerdict,
  type GuardrailState,
  type JournalIntent,
  type JournalResult,
  type PauseReason,
  type PauseRecord,
} from "./continuity-artifacts.js";
import {
  findSessionFile,
  inspectSessionFile,
  sessionToolCalls,
  sessionToolResults,
  type SessionInspection,
  type SessionToolResult,
} from "./session-log.js";

export interface ContinuityDeps {
  workDir: string;
  sessionsDir: string;
  /** The Work whose attempt is being continued: its ticket source and destination. */
  work: WorkIdentity;
  attempt: number;
  git: GitWork;
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
  now?: () => Date;
}

export type ContinuityPlan =
  | { decision: "launch"; mode: "new" | "resume"; sessionId: string; intactEntries: number }
  | { decision: "pause"; pause: PauseRecord };

export interface RecheckResult {
  /** Nothing the pause doubted is still there: the paused work may continue. */
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

  const retry = pendingCallRecovery(deps.workDir, deps.work);
  if (retry !== undefined && (mode !== "resume" || deps.attempt !== retry.attempt)) {
    return { decision: "pause", pause: pauseOf(deps, "effect-unsupported", "the authorized call retry must continue its own attempt and session", retry.sessionId) };
  }
  if (mode === "new") return startFirstSession(deps, effects.verdicts);

  const facts = readSessionFacts(deps);
  if (!facts.readable) {
    switch (facts.cause) {
      case "association-missing":
        // A claim whose worker never started (a death between the claim and the
        // spawn) leaves ZERO attempt evidence: there is no session to lose, so
        // the SAME attempt legitimately creates its first session. A legacy
        // attempt that left any evidence but no association is a different
        // case: its session cannot be identified and the work pauses.
        return firstSessionOrPause(
          deps,
          effects.verdicts,
          "link-missing",
          `${facts.detail} — a fresh session would be a new execution, not a continuation`,
        );
      case "session-file-missing":
        // The association exists but the file does not. A session Pi never
        // started leaves no log, no journal record and no session file: nothing
        // can be lost, so the SAME attempt starts its first session. Once any
        // evidence exists (the session ran), its absence pauses the work.
        return firstSessionOrPause(deps, effects.verdicts, "session-missing", facts.detail, facts.sessionId);
      case "association-unreadable":
        return { decision: "pause", pause: pauseOf(deps, "session-identity", facts.detail) };
      case "session-identity":
        return { decision: "pause", pause: pauseOf(deps, "session-identity", facts.detail, facts.sessionId) };
      case "session-unreadable":
        return { decision: "pause", pause: pauseOf(deps, "session-unreadable", facts.detail, facts.sessionId) };
      case "journal-unreadable":
        return {
          decision: "pause",
          pause: pauseOf(deps, "journal-unreadable", `${facts.detail} — it cannot prove which effects were attempted`, facts.sessionId),
        };
    }
  }

  if (retry !== undefined && (retry.executorSessionId ?? retry.sessionId) !== facts.sessionId) {
    return { decision: "pause", pause: pauseOf(deps, "session-identity", "the retry's owning session changed; inspect the call again", retry.sessionId) };
  }

  // Every non-safe call the session ran must be accounted for before it is
  // reopened: the same rule the recheck of a paused work applies.
  const doubt = missingIntentDoubt(deps, facts.sessionId, facts.file, facts.inspection, facts.journal);
  if (doubt !== null) return { decision: "pause", pause: doubt };

  writeGuardrailState(deps.workDir, guardrailState(deps, "resume", facts.sessionId, effects.verdicts));
  return { decision: "launch", mode: "resume", sessionId: facts.sessionId, intactEntries: facts.inspection.intactEntries };
}

/**
 * Re-read the doubt a persisted pause names — the operator's answer when it
 * answered one, and the normal cycle afterwards (issue 173). An answer is
 * orientation, never confirmation that an effect did not happen: what settles
 * the pause is a fresh read of the real state, and nothing else.
 */
export async function recheckPausedEffects(deps: ContinuityDeps, paused: PauseRecord): Promise<RecheckResult> {
  const effects = await settleOpenEffects(deps);
  if (!effects.settled) return { resolved: false, pause: effects.pause };
  // An effect the state could not confirm is settled BY that reconciliation,
  // which already read the attempt's transcript (`sessionEvidenceFor`). The
  // other doubts keep a read of their own: the transcript for missing evidence,
  // the attempt's session and journal for a session cause. A
  // `record-unreadable` pause is not rechecked at all (the loop asks
  // `recheckablePause` first): its doubt is the record itself.
  if (paused.reason === "tool-evidence-missing") {
    const doubt = toolEvidenceDoubt(deps);
    if (doubt !== null) return { resolved: false, pause: doubt };
  }
  if (SESSION_DOUBT_CAUSES.has(paused.reason)) {
    const facts = readSessionFacts(deps);
    // A doubt still there is not a resolution: the pause names the cause THIS
    // read found, never the one the record was written with — the disk may have
    // moved from that doubt to another (a journal readable again under a session
    // that no longer is), and a stale reason would hide the real one.
    if (!facts.readable) {
      return {
        resolved: false,
        pause: pauseOf(deps, SESSION_DOUBT_REASONS[facts.cause], facts.detail, facts.sessionId),
      };
    }
    const doubt = missingIntentDoubt(deps, facts.sessionId, facts.file, facts.inspection, facts.journal);
    if (doubt !== null) return { resolved: false, pause: doubt };
  }
  return { resolved: true, pause: null };
}

/** The pause causes whose doubt is the attempt's own session, or the journal
 *  that proves the guardrail ran: the facts the resume plan reads before it may
 *  reopen the session. */
const SESSION_DOUBT_CAUSES: ReadonlySet<PauseReason> = new Set<PauseReason>([
  "link-missing",
  "session-missing",
  "session-identity",
  "session-unreadable",
  "journal-unreadable",
]);

/** Why the attempt's session cannot be read — one cause per read, so a caller
 *  turns it into the pause reason that names ITS doubt. */
type SessionDoubt =
  | "association-unreadable"
  | "association-missing"
  | "session-file-missing"
  | "session-identity"
  | "session-unreadable"
  | "journal-unreadable";

type SessionFacts =
  | {
      readable: true;
      sessionId: string;
      file: string;
      inspection: SessionInspection;
      journal: EffectJournal;
    }
  | { readable: false; cause: SessionDoubt; detail: string; sessionId?: string };

/** The pause reason each read cause names — the same pairs the resume plan
 *  turns its read into. */
const SESSION_DOUBT_REASONS: Readonly<Record<SessionDoubt, PauseReason>> = {
  "association-unreadable": "session-identity",
  "association-missing": "link-missing",
  "session-file-missing": "session-missing",
  "session-identity": "session-identity",
  "session-unreadable": "session-unreadable",
  "journal-unreadable": "journal-unreadable",
};

/**
 * One read of the attempt's continuation facts: the session its association
 * names, that file's inspection, and the effect journal that proves the session
 * ran under the guardrail — or the single cause that stops the read. The resume
 * plan, the tool-evidence recheck and the recheck of a session cause all read
 * here, so no two of them can disagree about what the disk says.
 */
function readSessionFacts(deps: ContinuityDeps): SessionFacts {
  const links = readSessionLinks(deps.workDir);
  if (!links.intact) {
    return { readable: false, cause: "association-unreadable", detail: "the session-association journal is unreadable" };
  }
  const link = linkForAttempt(links.links, deps.work, deps.attempt);
  if (link === null) {
    return { readable: false, cause: "association-missing", detail: `attempt ${deps.attempt} has no recorded Pi session` };
  }
  const file = findSessionFile(deps.sessionsDir, link.sessionId);
  if (file === null) {
    return {
      readable: false,
      cause: "session-file-missing",
      detail: `the session ${link.sessionId} recorded for attempt ${deps.attempt} is not on disk`,
      sessionId: link.sessionId,
    };
  }
  const inspection = inspectSessionFile(file, link.sessionId);
  if (inspection.status === "identity-mismatch" || inspection.status === "missing") {
    return {
      readable: false,
      cause: "session-identity",
      detail: inspection.detail ?? "the session identity does not match",
      sessionId: link.sessionId,
    };
  }
  if (inspection.status === "unreadable") {
    return {
      readable: false,
      cause: "session-unreadable",
      detail: inspection.detail ?? "the session history is unreadable",
      sessionId: link.sessionId,
    };
  }
  const journal = readEffectJournal(deps.workDir);
  if (!journal.intact) {
    return {
      readable: false,
      cause: "journal-unreadable",
      detail: "the effect journal has an incomplete or unparseable entry",
      sessionId: link.sessionId,
    };
  }
  return { readable: true, sessionId: link.sessionId, file, inspection, journal };
}

/**
 * The `tool-evidence-missing` doubt, re-read from the attempt's own session:
 * the pause stands unless every non-safe call the transcript records is either
 * journaled or proven never to have run. A session that cannot be read now is
 * the doubt itself, not a resolution.
 */
function toolEvidenceDoubt(deps: ContinuityDeps): PauseRecord | null {
  const facts = readSessionFacts(deps);
  if (!facts.readable) {
    return pauseOf(
      deps,
      "tool-evidence-missing",
      `${facts.detail} — the calls the attempt ran cannot be read`,
      facts.sessionId,
    );
  }
  return missingIntentDoubt(deps, facts.sessionId, facts.file, facts.inspection, facts.journal);
}

/**
 * The non-safe calls the session's intact prefix records with no journal
 * intent — its effect cannot be established, so the work pauses. Shared by the
 * resume plan and the recheck of an existing pause, so the two can never
 * disagree about what the transcript proves.
 */
function missingIntentDoubt(
  deps: ContinuityDeps,
  sessionId: string,
  file: string,
  inspection: SessionInspection,
  journal: EffectJournal,
): PauseRecord | null {
  // A discarded tail is only safe when the journal proves the session ran
  // under the guardrail: every effectful call records its intent before it
  // executes, so the tail cannot hide one that this journal does not know.
  if (inspection.status === "partial" && !journal.sessions.some((entry) => entry.sessionId === sessionId)) {
    return pauseOf(
      deps,
      "tool-evidence-missing",
      `the session ends with an incomplete entry and no guardrail record proves what the discarded tail could have run`,
      sessionId,
    );
  }
  // Paired with the journal's own rule (`callKey`), scoped to the session
  // being resumed: a `call-1` from an earlier round of the same attempt is not
  // evidence for THIS round's call, and would hide a call nobody journaled.
  const intentsByCall = new Map(
    journal.intents
      .filter((intent) => intent.sessionId === sessionId)
      .map((intent) => [callKey(intent.sessionId, intent.callId), intent]),
  );
  const results = sessionToolResults(file, inspection.intactEntries);
  // A call Pi REFUSED before executing it never reaches the guardrail, so it has
  // no intent by construction; Pi records no `durationMs` for a call that did not
  // run (it does for one that ran, even when the tool failed). Pausing on such a
  // call would keep a resumed session stuck on evidence the guardrail itself
  // produced — a repeated push it correctly blocked, forever.
  const refusedBeforeExecution = new Set(
    results.filter((result) => result.isError && result.durationMs === null).map((result) => result.callId),
  );
  for (const call of sessionToolCalls(file, inspection.intactEntries)) {
    if (call.tool !== "bash") continue;
    const safety = classifyCommand(call.command);
    if (safety.safety === "safe") continue;
    if (intentsByCall.has(callKey(sessionId, call.callId))) continue;
    if (refusedBeforeExecution.has(call.callId)) continue;
    return pauseOf(
      deps,
      "tool-evidence-missing",
      `the session records a ${safety.safety} bash call ${call.callId} with no guardrail intent — its effect cannot be established`,
      sessionId,
    );
  }
  return null;
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

function checkDelegatedSessions(deps: ContinuityDeps, journal: EffectJournal): PauseRecord | null {
  const children = journal.sessions.filter((entry) => entry.childOf !== undefined);
  if (children.length === 0) return null;
  const links = readSessionLinks(deps.workDir);
  if (!links.intact) return pauseOf(deps, "link-missing", "the session-association journal is unreadable");
  const identity = workIdentityKey(deps.work);
  for (const child of children) {
    const bound = links.links.some((link) => link.sessionId === child.childOf &&
      link.attempt === child.attempt && workIdentityKey(link.work) === identity);
    if (!bound || children.some((other) => other.sessionId === child.sessionId &&
      (other.childOf !== child.childOf || other.attempt !== child.attempt))) {
      return pauseOf(deps, "session-identity", "a delegated session has no unambiguous association with this Work", child.sessionId);
    }
    const file = findSessionFile(deps.sessionsDir, child.sessionId);
    if (file === null) continue; // No transcript yet: the required guardrail still journals before every effect.
    const inspection = inspectSessionFile(file, child.sessionId);
    if (inspection.status !== "intact" && inspection.status !== "partial") {
      return pauseOf(deps, "session-unreadable", "the delegated session cannot be inspected", child.sessionId);
    }
    const doubt = missingIntentDoubt(deps, child.sessionId, file, inspection, journal);
    if (doubt !== null) return doubt;
  }
  return null;
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
  const childDoubt = checkDelegatedSessions(deps, journal);
  if (childDoubt !== null) return { settled: false, pause: childDoubt };
  let recoveries: ReturnType<typeof readCallRecoveries>;
  try {
    recoveries = readCallRecoveries(deps.workDir);
    pendingCallRecovery(deps.workDir, deps.work);
  } catch (error) {
    return { settled: false, pause: pauseOf(deps, "journal-unreadable", reasonOf(error)) };
  }
  const verdicts: Record<string, EffectVerdict> = {};
  const closedResults = new Map(journal.results.map((result) => [callKey(result.sessionId, result.callId), result]));
  // What a session's guardrail was already handed for THIS attempt: an effect
  // proven there is settled, and a since-moved remote is not a new doubt.
  const state = readGuardrailState(deps.workDir);
  const known = state !== null && state.attempt === deps.attempt ? state.verdicts : {};
  for (const intent of openCallsOf(journal, closedResults, known)) {
    const closed = closedResults.get(callKey(intent.sessionId, intent.callId));
    // The call may have ENDED without the guardrail's `tool_result` hook ever
    // running (Pi only calls it for an executed tool): a refusal or an error
    // after the intent leaves the journal open while the attempt's own session
    // holds the terminal result. Before treating the intent as unresolvable,
    // read that evidence and complete the journal with it. A conclusion already
    // recorded is not read again — what is missing then is the verdict.
    const evidence: SessionEvidence =
      closed === undefined ? sessionEvidenceFor(deps, intent) : { kind: "none", detail: "the conclusion is recorded" };
    if (intent.actions.length === 0) {
      if (intent.delegation === "guarded-v1" && evidence.kind !== "result") {
        // Dispatch itself is not an external effect. Every admitted child's
        // effects are reconciled separately below; no terminal result is invented.
        continue;
      }
      const authorization = recoveryForIntent(recoveries, intent);
      if (authorization !== undefined && evidence.kind !== "result") {
        // Consent accepts uncertainty, never invents the original result.
        // The consuming retry remains an independent intent below.
        recoveryConsumption(journal, authorization);
        continue;
      }
      if (evidence.kind !== "result") {
        return {
          settled: false,
          pause: pauseOf(
            deps,
            "effect-unsupported",
            `an interrupted call (${intent.command}) has no reliable reconciliation: ` +
              `${intent.reason ?? "its effect cannot be classified"}; ${evidence.detail}`,
            intent.sessionId,
          ),
        };
      }
      appendSessionResult(deps, intent, evidence.result);
      continue;
    }
    // A recognized effect is released only by a verdict about the real state —
    // never by the fact that the call's outcome is known. This runs for a
    // pending intent AND for one already closed from the session: an ambiguous
    // effect keeps the work paused until a fresh read proves it, and a recheck
    // never duplicates the conclusion it already persisted.
    for (const action of intent.actions) {
      const settled = await reconcileAction(deps, action);
      if (settled.verdict === "unknown") {
        if (evidence.kind === "result") appendSessionResult(deps, intent, evidence.result);
        return {
          settled: false,
          pause: pauseOf(deps, "effect-ambiguous", `${action.detail}: ${settled.detail}`, intent.sessionId),
        };
      }
      verdicts[action.key] = settled.verdict;
    }
    if (closed !== undefined) continue;
    // A terminal result says how the CALL ended, never what it did to the
    // world: the verdicts above stay the host's, and an observed error is
    // recorded as such instead of being read as absence.
    if (evidence.kind === "result") {
      appendSessionResult(deps, intent, evidence.result);
      continue;
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

/**
 * The intents this pass must look at: the ones with no result (the window an
 * interruption left open) and the ones a SESSION already closed. The second
 * kind matters because a session result is a conclusion about the call, not a
 * verdict about the world: while its recognized effects have no verdict, the
 * work stays paused — and a result the guardrail or the host wrote is not
 * re-examined here, because that writer already reconciled the effect.
 */
function openCallsOf(
  journal: EffectJournal,
  closedResults: ReadonlyMap<string, JournalResult>,
  knownVerdicts: Readonly<Record<string, EffectVerdict>>,
): JournalIntent[] {
  return journal.intents.filter((intent) => {
    const closed = closedResults.get(callKey(intent.sessionId, intent.callId));
    if (closed === undefined) return true;
    if (closed.source !== "session" || intent.actions.length === 0) return false;
    // Already proven to a session's guardrail: asking the real state again
    // would read a remote that moved after the proof as a fresh doubt.
    return intent.actions.some((action) => knownVerdicts[action.key] === undefined);
  });
}

/** The journal result of a call the session's own transcript concluded. The
 *  observed success/error and the evidence it came from are both kept, so a
 *  later audit can tell this repair from a callback that reported the call. */
function appendSessionResult(
  deps: ContinuityDeps,
  intent: JournalIntent,
  result: SessionToolResult,
): void {
  appendJournalResult(deps.workDir, {
    attempt: intent.attempt,
    sessionId: intent.sessionId,
    callId: intent.callId,
    ok: !result.isError,
    source: "session",
    evidenceAt: result.timestamp,
  });
}

/** What the attempt's session says about an open intent: the terminal result Pi
 *  persisted for that exact call, or why the transcript cannot supply one. */
type SessionEvidence = { kind: "result"; result: SessionToolResult } | { kind: "none"; detail: string };

/**
 * The terminal result the attempt's OWN session records for an open intent.
 * Correlation is by identity alone — never by a similar command, the closest
 * time, the newest file or "a result exists":
 *   - the intent's attempt must be associated with exactly the session the
 *     intent names (`linkForAttempt` is scoped to the Work, so another work's
 *     session proves nothing);
 *   - that session file must exist and be intact, identity included: a
 *     discarded tail proves nothing;
 *   - the prefix must hold exactly ONE call with the intent's id, and its tool
 *     and recorded command must equal the intent's;
 *   - that call must be answered by exactly ONE terminal result naming the
 *     same tool. Duplicated or conflicting results are ambiguity, not evidence.
 */
function sessionEvidenceFor(deps: ContinuityDeps, intent: JournalIntent): SessionEvidence {
  const links = readSessionLinks(deps.workDir);
  if (!links.intact) return { kind: "none", detail: "the session-association journal is unreadable" };
  const link = linkForAttempt(links.links, deps.work, intent.attempt);
  if (link === null) return { kind: "none", detail: `attempt ${intent.attempt} has no recorded Pi session` };
  const child = readEffectJournal(deps.workDir).sessions.some((entry) =>
    entry.sessionId === intent.sessionId && entry.attempt === intent.attempt && entry.childOf === link.sessionId);
  if (link.sessionId !== intent.sessionId && !child) {
    return {
      kind: "none",
      detail: `the intent belongs to session ${intent.sessionId}, not to the one attempt ${intent.attempt} is associated with`,
    };
  }
  const file = findSessionFile(deps.sessionsDir, intent.sessionId);
  if (file === null) return { kind: "none", detail: `the session ${intent.sessionId} is not on disk` };
  const inspection = inspectSessionFile(file, intent.sessionId);
  if (inspection.status !== "intact") {
    return { kind: "none", detail: `the session history is ${inspection.status}` };
  }
  const calls = sessionToolCalls(file, inspection.intactEntries).filter((call) => call.callId === intent.callId);
  if (calls.length !== 1) {
    return {
      kind: "none",
      detail:
        calls.length === 0
          ? "the session records no call with that id"
          : "the session records more than one call with that id",
    };
  }
  const call = calls[0]!;
  if (call.tool !== intent.tool) return { kind: "none", detail: `the session records tool ${call.tool} for that call` };
  if (call.command !== intent.command) {
    return { kind: "none", detail: "the session records a different command for that call" };
  }
  const results = sessionToolResults(file, inspection.intactEntries).filter((result) => result.callId === intent.callId);
  if (results.length !== 1) {
    return {
      kind: "none",
      detail:
        results.length === 0
          ? "the session records no terminal result for the call"
          : "the session records more than one terminal result for the call",
    };
  }
  const result = results[0]!;
  if (result.tool !== intent.tool) {
    return { kind: "none", detail: `the terminal result names tool ${result.tool}, not ${intent.tool}` };
  }
  return { kind: "result", result };
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
      detail: `the work's source is ${ticket.provider}:${ticket.site}, so a GitHub label read cannot establish this effect`,
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
  return { version: 1, generation: randomUUID(), attempt: deps.attempt, sessionId, mode, verdicts: { ...carried, ...verdicts }, at: nowIso(deps) };
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
