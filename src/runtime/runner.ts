import type { IssueRef, Known } from "../tracker/port.js";
import type { ContinuationPlan } from "../core/feedback.js";

// Runner port. The admission hands the runner a pointer to the job and the
// effective iteration limit; the runner returns what its iteration produced.
export type RunKind = "new" | "resume" | "correction";

// The Pi session and the Git area a job keeps between invocations. The runner
// reports it; the admission records it on the job so a later resume can continue it.
export interface Workspace {
  session: string;
  area: string;
}

// What a continuation invocation receives: the session and area to continue, and the typed plan of
// what this invocation delivers (issue #21). The plan is a union by step (`continue` | `list` |
// `apply`) of the core: the runtime renders it and derives the conflict and the operator commands
// from its items, never from a parallel field. The two invocations of the triage of PR feedback
// are the `list` and `apply` steps of the plan.

export interface ContinuationContext {
  workspace: Workspace;
  plan: ContinuationPlan;
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
  // Present only for resume and correction invocations. It carries the typed plan; the ids of the
  // operator commands whose replies it delivers are derived from its items (issue #15).
  continuation?: ContinuationContext;
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
  // Why the runtime profile of this job cannot be reproduced (a required item is missing, broken, cyclic or
  // outside the allowed roots), or undefined when it can. Asked before a job is claimed and before a continuation
  // starts: a blocked job gets no container (ADR 0002). A runner without the method has no profile to check.
  runtimeBlocker?(job: { ref: IssueRef; repository: string }): Promise<string | undefined>;
  // Why the triage of PR feedback cannot run for this job (the skill it needs is not available), or
  // undefined when it can. A runner without the method has nothing to check (issue #21).
  triageUnavailable?(job: { ref: IssueRef; repository: string }): Promise<string | undefined>;
}
