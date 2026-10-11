import { refKey, type IssueRef, type Known } from "../tracker/port.js";
import type { CheckState, ReviewState } from "../pr/port.js";
import type { PrRef } from "./result.js";

// Job states (R04, R05, R08, R09, R12). `running` is the only state that holds a slot:
// the slot is reserved before the claim, and released by every other state.
export const JOB_STATES = [
  "running",
  "waiting-for-help",
  "waiting-for-pr",
  "interrupted",
  "intervention-required",
  "done",
] as const;
export type JobState = (typeof JOB_STATES)[number];

// Requests that re-admit a job whose claim the factory already holds (P02).
export type Continuation = "resume" | "correction";

export interface Job {
  key: string; // identity: tracker + project + issue id (see refKey)
  ref: IssueRef;
  repository: string; // configured repository of the project; concurrency key (R05)
  state: JobState;
  reason?: string;
  question?: string;
  context?: string;
  pr?: PrRef;
  // Last PR observation by polling (R11). Kept across states; it never changes the state.
  prStatus?: PrStatus;
  pending?: Continuation;
  log: string[];
}

export interface PrStatus {
  checks: Known<CheckState>;
  review: Known<ReviewState>;
}

// The branch the implementation of an issue works on and that its PR must have as head.
// The runner creates it with this name; the PR validation checks it (R08).
export const jobBranch = (ref: IssueRef): string => `msf/${ref.id}`;

export interface TransitionDetails {
  message: string;
  reason?: string;
  question?: string;
  context?: string;
  pr?: PrRef;
}

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  running: ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required", "done"],
  "waiting-for-help": ["running", "interrupted", "intervention-required", "done"],
  "waiting-for-pr": ["running", "interrupted", "intervention-required", "done"],
  interrupted: ["running"],
  "intervention-required": ["running"],
  done: [],
};

export const holdsSlot = (state: JobState): boolean => state === "running";

export function newJob(options: { ref: IssueRef; repository: string }): Job {
  return {
    key: refKey(options.ref),
    ref: options.ref,
    repository: options.repository,
    state: "running",
    log: [],
  };
}

// Returns a new job; the input is never mutated. Illegal transitions throw.
export function transitionJob(job: Job, to: JobState, details: TransitionDetails): Job {
  if (!TRANSITIONS[job.state].includes(to)) {
    throw new Error(`transição inválida de ${job.state} para ${to}`);
  }
  const next: Job = { ...job, state: to, log: [...job.log, details.message] };
  delete next.reason;
  delete next.question;
  delete next.context;
  delete next.pending;
  if (to === "running") {
    // Resuming keeps the PR reference: the PR stays the one tracked by this job.
    return next;
  }
  if (details.reason !== undefined) next.reason = details.reason;
  if (details.question !== undefined) next.question = details.question;
  if (details.context !== undefined) next.context = details.context;
  if (details.pr !== undefined) next.pr = details.pr;
  return next;
}

// Adds a log line without a state change (for example, an iteration starting).
export function appendLog(job: Job, message: string): Job {
  return { ...job, log: [...job.log, message] };
}

// Stores the latest PR observation without a state change. A message is logged only when
// given, so polls that see no change leave the log alone.
export function recordPrStatus(job: Job, status: PrStatus, message?: string): Job {
  const next: Job = { ...job, prStatus: status };
  return message === undefined ? next : { ...next, log: [...job.log, message] };
}
