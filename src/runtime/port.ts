/**
 * The runtime port: how a worker session is born. The real adapter (ticket
 * 12/13) launches Sandcastle Pi sessions in containers; the fake (ticket 11)
 * scripts outcomes without a container.
 */

import type { IssueComment, IssueRef, RepairReason, RequiredCheckResult } from "../tracker/port.js";
import type { LocalWorkFacts } from "../git/port.js";

/**
 * The repair context of a reactivated session (issue 107): why the factory
 * intervened, the remote HEAD observed before intervening (the lease value)
 * and the evidence of the failing required checks. Issue 112 adds what the
 * host found on disk: the local work the round takes over instead of redoing,
 * and the number of the unpublished attempt it resumes (absent on a new round).
 */
export interface RepairMaterial {
  reasons: RepairReason[];
  /** The remote head observed before the intervention — pin the force-with-lease to it. */
  observedHeadSha: string;
  /** The PR's current base branch — the rebase target, never the repo default. */
  baseBranch: string;
  /** The required checks that failed or timed out (evidence to investigate). */
  checks: RequiredCheckResult[];
  /** The work branch as the host found it — commits, uncommitted changes, an
   *  interrupted operation. Absent only when git could not read it. */
  localWork?: LocalWorkFacts;
  /** The attempt this session resumes (issue 112); absent on a fresh round. */
  resuming?: number;
}

/**
 * The material the worker reads at session start (ticket 17, spec story 37):
 * the issue, human issue replies on a blocked retomada, the PR conversation
 * on a feedback round, and the diff of the work branch — every session starts
 * from the relevant context, never from session memory.
 */
export interface WorkerMaterial {
  issue: { title: string; body: string };
  /** Human replies on a blocked issue after the last agent marker; present only on retomada. */
  issueReplies?: IssueComment[];
  /** The open PR linked to the issue and its conversation; absent on a first launch. */
  pr?: { number: number; comments: IssueComment[] };
  /** Diff of the work branch against its base — the branch's memory so far. */
  diff: string;
  /** Present only on a repair round (issue 107). */
  repair?: RepairMaterial;
}

export interface SessionSelection {
  /** "new" starts the session; "resume" reopens the id of the interrupted attempt. */
  mode: "new" | "resume";
  /** The Pi session id, generated and recorded by the factory BEFORE the launch. */
  sessionId: string;
}

export interface WorkRequest {
  ref: IssueRef;
  /** Directory of the work's artifacts: <workspace>/trabalhos/<repo>#<n>/ */
  workDir: string;
  /** The work's branch — the memory of the work; never recreated. */
  branch: string;
  /** The single clone of the target repo: <workspace>/repos/<owner>#<name>/. */
  repoDir: string;
  /** The default branch the work branch was born from — also the PR base. */
  baseBranch: string;
  /** 1st, 2nd... attempt on the same branch. */
  attempt: number;
  /** The session this launch opens: new, or the interrupted attempt's own
   *  (issue 119). The factory ALWAYS sets it — the recorded association is
   *  the recovery contract; only a caller driving the runtime directly (no
   *  factory, no recovery) may omit it and get Pi's own fresh session. */
  session?: SessionSelection;
  /** The material the prompt is built from (ticket 17). */
  material: WorkerMaterial;
  /**
   * This session continues the SAME attempt (ADR 0005): every relaunch of an
   * attempt — a recovery, a model provider retry, the resume after the
   * operator's requested stop — reopens the attempt's native Pi session on the
   * host instead of starting one with reconstructed context. Absent on a fresh
   * attempt.
   */
  resume?: boolean;
}

export interface SessionResult {
  request: WorkRequest;
  /** What the runtime saw the session do — structured facts, never prose. */
  outcome: "pr-open" | "clean-without-pr" | "blocked-self-report" | "abrupt-death";
}

export interface WorkerRuntime {
  launch(request: WorkRequest): Promise<SessionResult>;
  /**
   * Ask the running session of this work to stop (issue #146). The launch
   * promise resolves when the session ended — the cooperative request never
   * abandons it. A request for a work with no session yet is remembered: a
   * launch of that work that starts afterwards ends before it leaves any
   * footprint, so no worker slips through the window between the factory's
   * decision and the session's registration.
   */
  requestStop(ref: IssueRef): void;
  /**
   * Force the session of this work to stop; resolves ONLY when the worker is
   * confirmed gone (Docker is the authority for the real runtime). Rejects
   * with the reason when the end cannot be confirmed.
   */
  forceStop(ref: IssueRef): Promise<void>;
}
