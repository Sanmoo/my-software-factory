/**
 * The runtime port: how a worker session is born. The real adapter (ticket
 * 12/13) launches Sandcastle Pi sessions in containers; the fake (ticket 11)
 * scripts outcomes without a container.
 */

import type { IssueComment, RepairReason, RequiredCheckResult } from "../tracker/port.js";
import type { WorkIdentity } from "../tracker/identity.js";
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
  /** The request's ticket content: the ticket's title and body as usable text. */
  ticket: { title: string; body: string };
  /** Human replies on a blocked ticket after the last agent marker; present only on retomada. */
  ticketReplies?: IssueComment[];
  /** The open PR linked to the work and its conversation; absent on a first launch. */
  pr?: { number: number; comments: IssueComment[] };
  /** Diff of the work branch against its base — the branch's memory so far. */
  diff: string;
  /** Present only on a repair round (issue 107). */
  repair?: RepairMaterial;
  /** Explicit operator consent, never a result of the interrupted call. */
  callRetry?: { id: string; command: string; cwd: string; reason: string; tool?: string; input?: string; sourceSessionId?: string };
}

export interface SessionSelection {
  /** "new" starts the session; "resume" reopens the id of the interrupted attempt. */
  mode: "new" | "resume";
  /** The Pi session id, generated and recorded by the factory BEFORE the launch. */
  sessionId: string;
}

export interface WorkRequest {
  /** What the worker is doing: the ticket that requests it AND the repository
   *  that receives the code. The two are never collapsed into one issue number. */
  work: WorkIdentity;
  /** Directory of the work's artifacts: <workspace>/trabalhos/<work key>/. */
  workDir: string;
  /** The work's branch — the memory of the work; never recreated. */
  branch: string;
  /** The single clone of the destination: <workspace>/repos/<owner>#<name>/. */
  repoDir: string;
  /** The default branch the work branch was born from — also the PR base. */
  baseBranch: string;
  /** 1st, 2nd... attempt on the same branch. */
  attempt: number;
  /** The session this launch opens: new, or the interrupted attempt's own
   *  (issue 119). The factory ALWAYS sets it — the recorded association is
   *  the recovery contract. Every relaunch of an attempt (a recovery, a model
   *  provider retry, the resume after the operator's requested stop) arrives
   *  here as `resume` with the id of ITS attempt; never a session chosen by
   *  mtime or by being the only file found. Only a caller driving the runtime
   *  directly (no factory, no recovery) may omit it and get Pi's own fresh
   *  session — such a session has no association, pauses a later recovery, and
   *  carries no guardrail state, so the guardrail refuses its external effects. */
  session?: SessionSelection;
  /** The material the prompt is built from (ticket 17). */
  material: WorkerMaterial;
}

export interface SessionResult {
  request: WorkRequest;
  /** What the runtime saw the session do — structured facts, never prose. */
  outcome: "pr-open" | "clean-without-pr" | "blocked-self-report" | "abrupt-death";
}

/**
 * One work of a retrospective window, as the round's agent reads it (issue
 * 141): where the evidence lives inside the container, what the work ended as
 * and when — never the work's issue body or diff, which the round does not
 * change.
 */
export interface RetroWorkInput {
  /** The registry key (the work's identity on disk) the report names. */
  key: string;
  repo: string;
  /** The work's artifacts as mounted read-only inside the round's container. */
  evidencePath: string;
  archived: boolean;
  outcome: "pr-open" | "clean-without-pr" | "blocked-self-report";
  attempt: number;
  /** ISO 8601 finish time (the outcome record's mtime). */
  completedAt: string;
}

/**
 * The retro-specific launch shape (issue 141, ADR 0006): a factory job, not a
 * Work — no claim, no branch, no outcome record. The round reads a window of
 * finished works and writes a report plus a result record; its model and
 * language are the round's, never the worker's by accident.
 */
export interface RetroRequest {
  /** The round id — also the report and result file names' prefix. */
  round: string;
  model: string;
  /** The one language of the round (report and every filed item). */
  language: string;
  account: string;
  /** Where factory-axis improvement items are filed; target-repo items go to
   *  the repo concerned. */
  factoryItemsDestination: string;
  works: RetroWorkInput[];
  /** Host paths the round writes (report and result record). */
  reportPath: string;
  resultPath: string;
  /** The same paths as mounted read-write inside the container. */
  reportContainerPath: string;
  resultContainerPath: string;
  /** The factual summary of the window, drawn from the operational records. */
  summary: string;
  /** The factory-owned, versioned analysis instructions. */
  instructions: string;
  instructionsVersion: string;
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
  requestStop(work: WorkIdentity): void;
  /**
   * Force the session of this work to stop; resolves ONLY when the worker is
   * confirmed gone (Docker is the authority for the real runtime). Rejects
   * with the reason when the end cannot be confirmed.
   */
  forceStop(work: WorkIdentity): Promise<void>;
  /**
   * Run one retrospective round (issue 141). It is not a Work: no claim, no
   * slot, no branch, no outcome record — the round writes its report and
   * result record and ends, and the factory reads those artifacts back: the
   * round's word about what it produced is never a fact.
   */
  launchRetro(request: RetroRequest): Promise<void>;
}
