import type { IssueRef } from "../tracker/port.js";

// Runner port (R07, R08). The admission hands the runner a pointer to the job and the
// effective iteration limit; the runner returns what its iteration produced.
export type RunKind = "new" | "resume" | "correction";

export interface RunnerContext {
  jobId: string;
  ref: IssueRef;
  kind: RunKind;
  iteration: number;
  maxIterations: number;
  // Operator text for a resume or correction (a reply or feedback). Optional and additive.
  note?: string;
}

// `finished` carries the structured results found in the final output of an iteration
// (zero, one or several). `continue` is an iteration that ended without a final result,
// so the admission may start another iteration within the limit.
export type RunnerOutput =
  | { kind: "finished"; results: unknown[] }
  | { kind: "continue" };

export interface Runner {
  run(context: RunnerContext): Promise<RunnerOutput>;
}
