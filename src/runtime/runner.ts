import type { IssueRef, Known } from "../tracker/port.js";

// Runner port (R07, R08). The admission hands the runner a pointer to the job and the
// effective iteration limit; the runner returns what its iteration produced.
export type RunKind = "new" | "resume" | "correction";

// The Pi session and the Git area a job keeps between invocations (R06, P03). The runner
// reports it; the admission records it on the job so a later resume can continue it.
export interface Workspace {
  session: string;
  area: string;
}

// What a continuation invocation receives: the session and area to continue, and the
// operator replies (R09) that this invocation delivers.
// The two invocations of the triage of PR feedback (issue #21).
export type TriageStep = "list" | "apply";

export interface ContinuationContext {
  workspace: Workspace;
  replies: string[];
  // The correction answers a conflict of the PR with its target branch (issue #19).
  conflict?: boolean;
  // The triage of PR feedback (issue #21): "list" is the correction that numbers the items of new human
  // comments and asks the operator, changing no code; "apply" is the resume that applies only what the
  // operator chose, together with the failing checks and the conflict held back by the triage.
  triage?: TriageStep;
}

// What an implementation invocation knows about its issue: the title and body as the tracker
// gave them, bounded in size (see core/issue-context.ts). The body is unknown when it was not read.
export interface IssueContext {
  title: string;
  body: Known<string>;
}

export interface RunnerContext {
  jobId: string;
  ref: IssueRef;
  // The configured repository of the job's project. A Jira key can serve several projects, so
  // the ref alone does not say which repository the job belongs to.
  repository: string;
  // Identifies this invocation in events and logs (issue #15).
  invocation?: string;
  kind: RunKind;
  iteration: number;
  maxIterations: number;
  // Present only for resume and correction invocations.
  continuation?: ContinuationContext;
  // Ids of the operator commands whose replies this invocation carries, so the runner can report
  // their delivery by id (issue #15). Replies from the tracker have no command id and are not listed.
  replyCommands?: string[];
  // Present only for the implementation (new) invocation.
  issue?: IssueContext;
}

// `finished` carries the structured results found in the final output of an iteration
// (zero, one or several). `continue` is an iteration that ended without a final result,
// so the admission may start another iteration within the limit. `workspace`, when the
// runner knows it, identifies the session and area of that iteration.
export type RunnerOutput =
  | { kind: "finished"; results: unknown[]; workspace?: Workspace }
  | { kind: "continue"; workspace?: Workspace };

export interface Runner {
  run(context: RunnerContext): Promise<RunnerOutput>;
  // Why the triage of PR feedback cannot run for this job (the skill it needs is not available), or
  // undefined when it can. A runner without the method has nothing to check (issue #21).
  triageUnavailable?(job: { ref: IssueRef; repository: string }): Promise<string | undefined>;
}
