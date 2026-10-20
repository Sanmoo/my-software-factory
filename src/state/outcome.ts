import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceLayout } from "../layout.js";
import type { RepairAttempt } from "../pool/repair.js";
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

/**
 * The umbrella classification of a collection, no matter how the record got
 * there: `abrupt-fall` is written by no one — its fact IS the absence, so it
 * never appears in the artifact vocabulary, only in the ruler's reasoning.
 */
export type ObservedClass = OutcomeClass | "abrupt-fall";

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
  /** Class 2: fall without PR, 1st consecutive — release (claimed→ready; the branch stays). */
  | { decision: "release"; because: "fall-first" }
  /** Class 3/4: fall without PR, 2nd consecutive — blocked + comment carrying this
   *  attempt's outcome (or its explicit absence) and the attempt's evidence. */
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
  /** The registry's fact from launch time: the previous attempt on this branch also fell. */
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
 * The factory's ruler (ticket 13), applied at collection (loop) on structured
 * facts alone. Priority is the vocabulary of the six classes:
 *   1/5. PR open → reserve, no fall recorded (pre-existing PR included);
 *   6. blocked self-report → only recorded (the worker posted marker + label);
 *   then any end without PR is the one fall (ticket 05 Q1): absent record =
 *   abrupt fall — 1st consecutive → release, 2nd consecutive → blocked + comment.
 *
 * The record is consulted only when it belongs to the collected attempt (issue
 * 103): a crash never inherits the previous attempt's verdict — its own
 * absence is the abrupt fall.
 */
export async function classifyOutcome(facts: OutcomeFacts): Promise<OutcomeRuling> {
  if (facts.issueClosed) return { decision: "done", because: "issue-closed" };
  if (facts.prOpen) return { decision: "reserve", because: "pr-open" };
  if (isBlockedSelfReport(facts)) return { decision: "record-only", because: "blocked-self-report" };

  // Fall without PR — clean or abrupt, the ruler is a single one.
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
function ownOutcomeRecord(record: OutcomeRecord | null, attempt: number): OutcomeRecord | null {
  return record !== null && record.attempt === attempt ? record : null;
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

/** What a blocked comment needs from the ruler's facts — the attempt that
 *  fell, its raw record (possibly another attempt's) and its evidence. */
type BlockedCommentInput = Pick<
  OutcomeFacts,
  "attempt" | "record" | "workDir" | "workspace"
>;

/**
 * The blocked comment (ticket 05 Q7; issue 103): the human must SEE why it fell
 * before deciding to resume. The header names the fallen attempt; the outcome
 * is the current attempt's own record — a divergent record is named as such
 * instead of being presented as this fall's outcome. The evidence of the
 * attempt follows, independent of the record.
 */
export async function blockedCommentBody(input: BlockedCommentInput): Promise<string> {
  const evidence = await readWorkEvidence(input.workspace, input.workDir, input.attempt);
  return (
    `worker blocked after 2 consecutive falls (attempt ${input.attempt}) — ` +
    `${describeOutcome(input)}\n\n${renderWorkEvidence(evidence)}`
  );
}

/** The outcome of the named attempt: another attempt's record is absence here. */
function describeOutcome({ attempt, record }: BlockedCommentInput): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) return `the exact outcome record:\n\n${JSON.stringify(own, null, 2)}`;
  if (record === null) return "abrupt fall: no outcome record was written";
  return (
    "abrupt fall: no outcome record was written " +
    `(the record on disk belongs to attempt ${record.attempt})`
  );
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
 * normal end (its own record exists) or an abrupt fall — whose own record is
 * absent, with an older attempt's record named as history, never as this
 * attempt's outcome (issue 103's rule, reused here).
 */
function describeRepairEnding(record: OutcomeRecord | null, attempt: number): string {
  const own = ownOutcomeRecord(record, attempt);
  if (own !== null) {
    return `ended normally (its outcome record says "${own.class}") but nothing reached the remote`;
  }
  if (record === null) return "fell abruptly: no outcome record was written";
  return (
    "fell abruptly: no outcome record of its own was written " +
    `(the record on disk belongs to attempt ${record.attempt})`
  );
}

/**
 * Read the outcome record of a work. Returns null when the record is absent,
 * invalid or corrupt — absence is itself the class "abrupt fall"
 * (dead process, restart, garbage), and the ruler applies from there.
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
