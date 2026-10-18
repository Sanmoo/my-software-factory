/**
 * The runtime port: how a worker session is born. The real adapter (ticket
 * 12/13) launches Sandcastle Pi sessions in containers; the fake (ticket 11)
 * scripts outcomes without a container.
 */

import type { IssueComment, IssueRef } from "../tracker/port.js";

/**
 * The material the worker reads at session start (ticket 17, spec story 37):
 * the issue, the PR conversation when one exists (a feedback round), and the
 * diff of the work branch — every session (new, resume or feedback) starts
 * from the whole context, never from session memory.
 */
export interface WorkerMaterial {
  issue: { title: string; body: string };
  /** The open PR linked to the issue and its conversation; absent on a first launch. */
  pr?: { number: number; comments: IssueComment[] };
  /** Diff of the work branch against its base — the branch's memory so far. */
  diff: string;
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
  /** The material the prompt is built from (ticket 17). */
  material: WorkerMaterial;
}

export interface SessionResult {
  request: WorkRequest;
  /** What the runtime saw the session do — structured facts, never prose. */
  outcome: "pr-open" | "clean-without-pr" | "blocked-self-report" | "abrupt-death";
}

export interface WorkerRuntime {
  launch(request: WorkRequest): Promise<SessionResult>;
}
