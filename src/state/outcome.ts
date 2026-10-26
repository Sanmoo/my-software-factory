import type { WorkspaceLayout } from "../layout.js";
import type { ModelProviderBudget, RecoveryBudget } from "../config.js";
import type { RepairAttempt } from "../work-record/repair.js";
import { exhaustedReason } from "../pool/recovery.js";
import { exhaustedModelProviderReason } from "../pool/model-provider.js";
import type { ModelProviderFailure } from "../work-record/record.js";
import { describePublication, describeRemoteChange, renderLocalWork } from "./repair-view.js";
import { readWorkEvidence, renderWorkEvidence } from "../work-record/evidence.js";
import type { PauseReason } from "../work-record/continuity.js";
import { effectUnverifiable, knownAttempt } from "../work-record/continuity.js";
import { ownOutcomeRecord, type OutcomeRecord } from "../work-record/outcome.js";
import { pauseMarker } from "../tracker/port.js";

/**
 * The Work record's two small rules and the operator's texts (tickets 04/05;
 * fleshed out by tickets 12-14). The RECORD (desfecho.json, its schema and the
 * "is this record this attempt's?" criterion) is owned by the Work record
 * (`src/work-record/`); the VOCABULARY of what a collection decides
 * is owned by the Work state (ADR-0010, `src/work-state/`).
 *
 * What is left here is neither a ruler nor a policy module: the predicates the
 * fall ruler and the derivation ask of a record (`isRecordedFailure`,
 * `ownWrittenOutcome`, `selfReportedBlocked`) and the comments the factory
 * writes for the operator — blocked, interruption paused, model provider
 * awaited, continuity paused, repair fall. The old second vocabulary
 * (`classifyOutcome`/`OutcomeRuling`) is deleted: ADR-0010's "the outcome ruler
 * is no longer a policy module of its own".
 *
 * The two-rulers contract survives: the worker's ruler (its obligations) lives
 * in the prompt; the factory NEVER reads what the agent wrote in natural
 * language. It reads only structured, verifiable facts — does desfecho.json
 * exist, what is its `class`, is a PR open or merged, which labels the issue
 * carries. Zero natural-language parsing in the critical path.
 */

/**
 * The written failure the ruler counts for CONSECUTIVENESS at launch: a clean
 * end without a PR. A `pr-open` record is a success and resets the count; a
 * self-report is the worker's own stop, not a failure.
 */
export function isRecordedFailure(record: OutcomeRecord | null): boolean {
  return record?.class === "clean-without-pr";
}

/**
 * The attempt's own written outcome, unless it is the blocked self-report the
 * `record-only` ruling handles: the record that lets the fall ruler decide. One
 * rule, shared by collection and by the derivation that
 * settles an unreconciled attempt.
 */
export function ownWrittenOutcome(
  record: OutcomeRecord | null,
  attempt: number,
): OutcomeRecord | null {
  const own = ownOutcomeRecord(record, attempt);
  return own !== null && own.class !== "blocked-self-report" ? own : null;
}

/** The ACTUAL blocked self-report of one attempt — a record left by another
 *  attempt is never the current attempt's self-report. */
export function selfReportedBlocked(record: OutcomeRecord | null, attempt: number): boolean {
  return ownOutcomeRecord(record, attempt)?.class === "blocked-self-report";
}

/** What a comment about one attempt needs: the attempt, its raw record
 *  (possibly another attempt's) and the attempt's evidence. */
export interface AttemptCommentInput {
  attempt: number;
  record: OutcomeRecord | null;
  workDir: string;
  workspace: WorkspaceLayout;
}

/**
 * The blocked comment: the human must SEE why it fell
 * before deciding to resume. The header names the failed attempt; the outcome
 * is the current attempt's own record — a divergent record is named as such
 * instead of being presented as this attempt's outcome. The evidence of the
 * attempt follows, independent of the record.
 */
export async function blockedCommentBody(input: AttemptCommentInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  return (
    `worker blocked after 2 consecutive falls (attempt ${input.attempt}) — ` +
    `${describeOutcome(input)}\n\n${renderWorkEvidence(evidence)}`
  );
}

/** The outcome of the named attempt: another attempt's record is absence here. */
function describeOutcome({ attempt, record }: AttemptCommentInput): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) return `the exact outcome record:\n\n${JSON.stringify(own, null, 2)}`;
  if (record === null) return "interrupted: no outcome record was written for this attempt";
  return (
    "interrupted: no outcome record of its own was written " +
    `(${describeForeignRecord(record.attempt)})`
  );
}

/** What the pause of an exhausted recovery budget needs: the interrupted
 *  attempt, the configured allowance and the attempt's evidence. */
export interface InterruptionPausedInput extends AttemptCommentInput {
  budget: RecoveryBudget;
}

/**
 * The block comment of an interruption whose recovery budget ran out (issue
 * 123): the attempt was NOT a failure — no attempt was consumed — but the
 * factory will not relaunch it forever. It names the configured value and
 * backoff (the operator can adjust them) and the attempt's own evidence.
 */
export async function interruptionPausedCommentBody(input: InterruptionPausedInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  const header =
    `attempt ${input.attempt} was interrupted and ${exhaustedReason(input.budget)} — ` +
    "no attempt was consumed.";
  return [header, describeOutcome(input), "", renderWorkEvidence(evidence)].join("\n\n");
}

/** What the awaiting model provider needs: the failure, the budget spent and
 *  the attempt's evidence. */
export interface ModelProviderAwaitingInput {
  attempt: number;
  failure: ModelProviderFailure;
  budget: ModelProviderBudget;
  workDir: string;
  workspace: WorkspaceLayout;
}

/** What the continuity pause says to the operator. */
export interface ContinuityPausedInput {
  attempt: number;
  /** The last attempt the disk evidences (the attempt ledger): the launch path
   *  numbers the NEXT attempt before any evidence of it exists, and that
   *  planned number must never be presented as an interrupted one. */
  evidencedAttempt: number;
  reason: PauseReason;
  /** The occurrence's identity, carried into the comment. */
  id: string;
  detail: string;
  sessionId?: string;
  workDir: string;
  workspace: WorkspaceLayout;
}

/**
 * The help request of an exhausted model provider budget: the
 * attempt ended by a model provider failure, the factory stopped retrying, and
 * the work is
 * NOT blocked — it waits for the operator. It names the model provider's own
 * message
 * and the configured allowance, and says how to go on (raise the budget, or
 * answer on the issue to resume with a new attempt).
 */
export async function modelProviderAwaitingCommentBody(input: ModelProviderAwaitingInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  const header =
    `attempt ${input.attempt} ended by a model provider failure and ${exhaustedModelProviderReason(input.budget)} — ` +
    "the work is NOT blocked and no attempt was consumed.";
  return [
    header,
    `last model provider error: ${input.failure.message}`,
    "The factory stops retrying this attempt until an operator acts: raise model-provider.max-retries in msf.yaml, " +
      "or answer on this issue to resume.",
    "",
    renderWorkEvidence(evidence),
  ].join("\n\n");
}

/**
 * The block comment of a continuity pause: the interrupted attempt
 * cannot be continued safely — its session is missing, unreadable or of the
 * wrong identity, or an external effect stayed ambiguous — so the factory
 * stopped instead of relaunching. The reason and the attempt's evidence are
 * shown; the session file is never rewritten or deleted to look usable, and
 * no attempt was consumed.
 *
 * The request is honest about what it can offer: it names the
 * attempt that is REALLY blocked (a planned attempt that never started is said
 * to be exactly that), and it asks for the evidence the resolver actually
 * reads — never for an answer at an internal position in the conversation.
 */
export async function continuityPausedCommentBody(input: ContinuityPausedInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  return [
    pauseMarker(input.id),
    blockedAttemptSentence(input.attempt, input.evidencedAttempt, input.reason),
    input.detail,
    ...(input.sessionId === undefined ? [] : [`session: ${input.sessionId}`]),
    "",
    pauseAsk(input.reason),
    "",
    describeOutcome({ attempt: input.attempt, record: null, workDir: input.workDir, workspace: input.workspace }),
    "",
    renderWorkEvidence(evidence),
  ].join("\n");
}

/**
 * The attempt the operator must reason about. A pause written by the launch
 * path names the attempt it was about to open; when the disk evidences a
 * lower one, that planned attempt was never started and claiming it cannot be
 * continued would be a fabricated fact. An attempt the record
 * never named is said so, not printed as "attempt 0".
 */
function blockedAttemptSentence(attempt: number, evidencedAttempt: number, reason: PauseReason): string {
  const known = knownAttempt(attempt);
  const evidenced = knownAttempt(evidencedAttempt);
  const why = describePauseReason(reason);
  if (known !== null && evidenced !== null && known > evidenced) {
    return (
      `the interrupted attempt ${evidenced} cannot be continued safely (${why}) — ` +
      `the planned attempt ${known} was never started; no attempt was consumed and nothing was relaunched.`
    );
  }
  const named = known === null ? "this work's current attempt" : `attempt ${known}`;
  return `${named} cannot be continued safely (${why}) — no attempt was consumed and nothing was relaunched.`;
}

/** What would actually move the work, and what an answer cannot prove. */
function pauseAsk(reason: PauseReason): string {
  const limit = effectUnverifiable(reason)
    ? "The factory cannot verify what that command did, so it will not replay it: a generic answer " +
      "cannot authorize a retry. "
    : "";
  return (
    limit +
    "Reply with the concrete evidence the factory verifies — the pushed commit, the comment, the label — " +
    "or resolve the situation on the tracker. The facts are read again before any new round; " +
    "a free-form answer is orientation, never proof that an effect did not happen."
  );
}

/** The pause reasons in the operator's words. */
function describePauseReason(reason: PauseReason): string {
  switch (reason) {
    case "link-missing":
      return "no session is associated with this attempt";
    case "session-missing":
      return "the recorded session is gone";
    case "session-unreadable":
      return "the session history is unreadable";
    case "session-identity":
      return "the session identity does not match this attempt";
    case "journal-unreadable":
      return "the effect journal cannot prove what the interrupted session attempted";
    case "effect-unsupported":
      return "an interrupted command has no reliable reconciliation";
    case "effect-ambiguous":
      return "an interrupted external effect is ambiguous";
    case "tool-evidence-missing":
      return "the session records a mutating call the guardrail never journaled";
    case "record-unreadable":
      return "the persisted pause cannot be read, so the factory keeps waiting instead of recovering";
  }
}

/** What the repair-fall comment needs: the fallen attempt and the reason the
 *  factory stopped, never the worker's prose. */
export interface RepairFallCommentInput {
  /** Two consecutive falls, or a concurrent change the attempt did not produce. */
  cause: "consecutive-falls" | "concurrent-change";
  prNumber: number;
  consecutiveFalls: number;
  attempt: RepairAttempt;
  /** desfecho.json as read from disk — it may belong to an EARLIER attempt. */
  record: OutcomeRecord | null;
  workDir: string;
  workspace: WorkspaceLayout;
}

/**
 * The block comment of a Repair that stopped without publishing.
 * It names the attempt that actually fell, the abrupt end and the divergent
 * record on disk — never presenting an older attempt's outcome as this one's —
 * plus the publication verdict, the preserved local work and the attempt's own
 * evidence paths (the same contract, reused verbatim).
 */
export async function repairFallComment(input: RepairFallCommentInput): Promise<string> {
  const { attempt } = input;
  const evidence = await readWorkEvidence(input.workspace, input.workDir, attempt.attempt);
  const ending = describeRepairEnding(input.record, attempt.attempt);
  const header =
    input.cause === "concurrent-change"
      ? `automatic repair stopped: the remote branch ${describeRemoteChange(attempt.remoteHeadSha)} ` +
        `(a concurrent change the repair attempt did not produce), so the factory will not publish ` +
        `over it — PR #${input.prNumber}.`
      : `automatic repair stopped after ${input.consecutiveFalls} consecutive repair attempts ended ` +
        `without publishing PR #${input.prNumber}: the impediment that reactivated the repair is still ` +
        `unresolved on the current HEAD.`;
  return [
    header,
    ``,
    `attempt ${attempt.attempt} ${ending}.`,
    `publication: ${describePublication(attempt.publication)}; ` +
      `local work preserved: ${renderLocalWork(attempt.localWork)}.`,
    ``,
    input.cause === "concurrent-change"
      ? "The branch, the PR and the local work stay for a human to reconcile: nothing was pushed, reset or discarded. A human decision is needed."
      : "The branch and the PR stay; a human decision, authorization or fix is needed before another attempt.",
    ``,
    renderWorkEvidence(evidence),
  ].join("\n");
}

/**
 * How the attempt ended without publishing, from the record facts alone: a
 * normal end (its own record exists) or an end with no record at all, with an
 * older attempt's record named as history, never as this attempt's outcome. The
 * repair ledger, not the attempt ruler,
 * counts this end.
 */
function describeRepairEnding(record: OutcomeRecord | null, attempt: number): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) {
    return `ended normally (its outcome record says "${own.class}") but nothing reached the remote`;
  }
  if (record === null) return "ended without an outcome record";
  return (
    "ended without an outcome record of its own " +
    `(${describeForeignRecord(record.attempt)})`
  );
}

/**
 * The one rendering of the history fact "the record on disk is another
 * attempt's", so the operator's wording cannot drift apart.
 */
export function describeForeignRecord(attempt: number): string {
  return `the record on disk belongs to attempt ${attempt}`;
}
