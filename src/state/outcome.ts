import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceLayout } from "../layout.js";
import type { RecoveryPolicy } from "../config.js";
import type { RepairAttempt } from "../pool/repair.js";
import { exhaustedReason } from "../pool/recovery.js";
import { describePublication, describeRemoteChange, renderLocalWork } from "./repair-view.js";
import { readWorkEvidence, renderWorkEvidence } from "./evidence.js";

/**
 * The factory's ruler (state/outcome.ts) — classification of outcomes and
 * tracker transitions (tickets 04/05; fleshed out by tickets 12-14).
 *
 * The two-rulers contract: the worker's ruler (its obligations) lives in the
 * prompt; the factory's ruler (this module) NEVER reads what the agent wrote
 * in natural language. It reads only structured, verifiable facts:
 *   - does desfecho.json exist? what is its `class` field?
 *   - is there an open PR on the issue? (port)
 *   - labels? author of the last comment? (port)
 * The contract between the two sides is the artifact schema below. Zero
 * natural-language parsing in the critical path.
 */

/** Disk name is a taken decision (tickets 05/10) and stays in PT-BR. */
export const DESFECHO_FILENAME = "desfecho.json";

/** The class field of the outcome record — vocabulary of ticket 05. */
export type OutcomeClass =
  /** The work ended with an open PR: stays reserved, waiting for the human. */
  | "pr-open"
  /** The worker self-reported blocked (marker + label) and exited. */
  | "blocked-self-report"
  /** Clean end without an open PR — still a fall, per the single ruler. */
  | "clean-without-pr";

/**
 * Schema of desfecho.json — the artifact contract between the two rulers.
 * The factory validates this schema; it never interprets text.
 */
export interface OutcomeRecord {
  class: OutcomeClass;
  /** Attempt number of this session (1st, 2nd... on the same branch). */
  attempt: number;
  /** Present when class is "pr-open". */
  pr?: {
    repo: string;
    number: number;
    branch: string;
  };
  /** Paths of artifacts of this attempt, when the session recorded them. */
  paths?: Record<string, string>;
}

/** The ruled transition of a collection, decided in state/, executed by the loop. */
export type OutcomeRuling =
  /** The terminal state reached while the claim was held (the human's merge
   * closed the issue mid-flight — ticket 14): archive the artifacts, no
   * release, no fall. */
  | { decision: "done"; because: "issue-closed" }
  /** Classes 1 and 5: PR open (by record or by pre-existence) — stays
   * reserved awaiting the human; a fall is never recorded, the claim is held. */
  | { decision: "reserve"; because: "pr-open" }
  /** Class 6: blocked self-report — the worker already posted the marker + label; the factory only records it. */
  | { decision: "record-only"; because: "blocked-self-report" }
  /** The attempt wrote no outcome record: an INTERRUPTION, not a failure
   * (issue 123). The loop absorbs it with the recovery budget; the attempt
   * keeps its number and never enters the fall ruler. */
  | { decision: "interrupt"; because: "no-outcome" }
  /** A written failure/abandon without PR, 1st consecutive — release
   * (claimed→ready; the branch stays). */
  | { decision: "release"; because: "fall-first" }
  /** A written failure/abandon without PR, 2nd consecutive — blocked + comment
   *  carrying this attempt's outcome and its evidence. */
  | { decision: "block"; because: "fall-second"; comment: string };

/** The structured facts the ruler reads — no prose, ever (the two-rulers
 *  contract). The block branch also probes the attempt's evidence locations
 *  read-only; a failed query degrades to "could not be verified", never to a
 *  different decision. */
export interface OutcomeFacts {
  /** desfecho.json as read from disk; it may belong to an EARLIER attempt. */
  record: OutcomeRecord | null;
  /** The port's fact: an open PR linked to the issue (recorded now or pre-existing). */
  prOpen: boolean;
  /** The port's fact: the blocked label is on the issue (the worker's self-report). */
  blockedLabelOnIssue: boolean;
  /** The registry's fact from launch time: the previous attempt on this branch
   *  also ended in a written failure. Interruptions never set it (issue 123). */
  consecutiveFall: boolean;
  /** The attempt being collected (the registry's launch fact) — names the fall in the
   *  blocked comment, and owns the record: a record of another attempt is absent here. */
  attempt: number;
  /** The port's fact: the issue itself is closed — the terminal state was reached while this claim was held (ticket 14). */
  issueClosed: boolean;
  /** The attempt's dir as the runtime/registry used it — the same dir the evidence probes. */
  workDir: string;
  /** The workspace the dir lives in — the base of the shown evidence paths. */
  workspace: WorkspaceLayout;
}

/**
 * The factory's ruler (ticket 13; amended by issue 123), applied at collection
 * (loop) on structured facts alone. Priority is the vocabulary of the classes:
 *   1/5. PR open → reserve, no fall recorded (pre-existing PR included);
 *   6. blocked self-report → only recorded (the worker posted marker + label);
 *   4. no own record → INTERRUPTION: the recovery budget absorbs it and the
 *      same attempt is relaunched — never the fall ruler (issue 123);
 *   2/3. a written failure/abandon without PR: 1st consecutive → release,
 *      2nd consecutive → blocked + comment.
 *
 * The record is consulted only when it belongs to the collected attempt (issue
 * 103): a crash never inherits the previous attempt's verdict — its own
 * absence is an interruption, not a failure.
 */
export async function classifyOutcome(facts: OutcomeFacts): Promise<OutcomeRuling> {
  if (facts.issueClosed) return { decision: "done", because: "issue-closed" };
  if (facts.prOpen) return { decision: "reserve", because: "pr-open" };
  if (isBlockedSelfReport(facts)) return { decision: "record-only", because: "blocked-self-report" };

  // No outcome record of this attempt: an interruption, never a failure.
  if (ownOutcomeRecord(facts.record, facts.attempt) === null) {
    return { decision: "interrupt", because: "no-outcome" };
  }

  // A written failure/abandon without PR — the fall ruler applies.
  if (facts.consecutiveFall) {
    return {
      decision: "block",
      because: "fall-second",
      comment: await blockedCommentBody(facts),
    };
  }
  return { decision: "release", because: "fall-first" };
}

/**
 * The record OF THIS ATTEMPT: a record left by another attempt is absent for
 * the current attempt's classification and diagnosis (issue 103) — the old
 * file survives on disk as history and serves numbering/reconciliation, but
 * it never decides this attempt's transition.
 */
export function ownOutcomeRecord(record: OutcomeRecord | null, attempt: number): OutcomeRecord | null {
  return record !== null && record.attempt === attempt ? record : null;
}

/**
 * The written failure the ruler counts for CONSECUTIVENESS at launch: a clean
 * end without a PR. A `pr-open` record is a success and resets the count; a
 * self-report is the worker's own stop, not a failure (issue 123).
 */
export function recordedFailure(record: OutcomeRecord | null): boolean {
  return record?.class === "clean-without-pr";
}

/**
 * The record that ends an attempt as a failure/abandon for the ruler: its own
 * record, unless it is the blocked self-report the `record-only` ruling
 * handles. One rule, shared by collection and by the derivation that settles
 * an unreconciled failure (issue 123).
 */
export function recordSettlesFailure(
  record: OutcomeRecord | null,
  attempt: number,
): OutcomeRecord | null {
  const own = ownOutcomeRecord(record, attempt);
  return own !== null && own.class !== "blocked-self-report" ? own : null;
}

/** The ACTUAL blocked self-report of one attempt — a record left by another
 *  attempt is never the current attempt's self-report (issue 103). */
export function selfReportedBlocked(record: OutcomeRecord | null, attempt: number): boolean {
  return ownOutcomeRecord(record, attempt)?.class === "blocked-self-report";
}

/** A self-report is the current attempt's record class, or the label — both structured facts. */
function isBlockedSelfReport(facts: OutcomeFacts): boolean {
  return facts.blockedLabelOnIssue || selfReportedBlocked(facts.record, facts.attempt);
}

/** What a comment about one attempt needs from the ruler's facts — the
 *  attempt, its raw record (possibly another attempt's) and its evidence. */
type AttemptCommentInput = Pick<
  OutcomeFacts,
  "attempt" | "record" | "workDir" | "workspace"
>;

type BlockedCommentInput = AttemptCommentInput;

/**
 * The blocked comment (ticket 05 Q7; issue 103): the human must SEE why it fell
 * before deciding to resume. The header names the failed attempt; the outcome
 * is the current attempt's own record — a divergent record is named as such
 * instead of being presented as this attempt's outcome. The evidence of the
 * attempt follows, independent of the record.
 */
export async function blockedCommentBody(input: BlockedCommentInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  return (
    `worker blocked after 2 consecutive failed attempts (attempt ${input.attempt}) — ` +
    `${describeOutcome(input)}\n\n${renderWorkEvidence(evidence)}`
  );
}

/** The outcome of the named attempt: another attempt's record is absence here. */
function describeOutcome({ attempt, record }: BlockedCommentInput): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) return `the exact outcome record:\n\n${JSON.stringify(own, null, 2)}`;
  if (record === null) return "interrupted: no outcome record was written for this attempt";
  return (
    "interrupted: no outcome record of its own was written " +
    `(the record on disk belongs to attempt ${record.attempt})`
  );
}

/** What the pause of an exhausted recovery budget needs: the interrupted
 *  attempt, the configured allowance and the attempt's evidence. */
export interface InterruptionPausedInput extends AttemptCommentInput {
  policy: RecoveryPolicy;
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
    `attempt ${input.attempt} was interrupted and ${exhaustedReason(input.policy)} — ` +
    "no attempt was consumed.";
  return [header, describeOutcome(input), "", renderWorkEvidence(evidence)].join("\n\n");
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
 * The block comment of a Repair that stopped without publishing (issue 112).
 * It names the attempt that actually fell, the abrupt end and the divergent
 * record on disk — never presenting an older attempt's outcome as this one's —
 * plus the publication verdict, the preserved local work and the attempt's own
 * evidence paths (#103's contract, reused verbatim).
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
 * older attempt's record named as history, never as this attempt's outcome
 * (issue 103's rule, reused here). The repair ledger, not the attempt ruler,
 * counts this end (issue 112/123).
 */
function describeRepairEnding(record: OutcomeRecord | null, attempt: number): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) {
    return `ended normally (its outcome record says "${own.class}") but nothing reached the remote`;
  }
  if (record === null) return "ended without an outcome record";
  return (
    "ended without an outcome record of its own " +
    `(the record on disk belongs to attempt ${record.attempt})`
  );
}

/**
 * Read the outcome record of a work. Returns null when the record is absent,
 * invalid or corrupt. Absence is the FACT "no-outcome" — an interruption of
 * the attempt, never a failure of it (issue 123) — and the recovery budget,
 * never the fall ruler, answers it.
 */
export async function readOutcomeRecord(workDir: string): Promise<OutcomeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(workDir, DESFECHO_FILENAME), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isOutcomeRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record["class"] !== "string") return false;
  if (!["pr-open", "blocked-self-report", "clean-without-pr"].includes(record["class"])) {
    return false;
  }
  if (typeof record["attempt"] !== "number") return false;
  return true;
}
