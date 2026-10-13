import { refKey, type IssueRef, type Known } from "../tracker/port.js";
import type { Workspace } from "../runtime/runner.js";
import type { CheckState, Mergeability, ReviewState } from "../pr/port.js";
import type { PrRef } from "./result.js";
import type { Feedback } from "./feedback.js";

// Job states. `running` is the only state that holds a slot:
// the slot is reserved before the claim, and released by every other state.
export const JOB_STATES = [
  "running",
  "waiting-for-help",
  "waiting-for-pr",
  "interrupted",
  "intervention-required",
  "done",
  "released",
] as const;
export type JobState = (typeof JOB_STATES)[number];

// Requests that re-admit a job whose claim the factory already holds.
export type Continuation = "resume" | "correction";

// Why a continuation of a job was asked for (issue #15, decisions 19-21): the operational reason,
// not the technical kind of the invocation. A trigger is kept from the moment its feedback is
// taken until the invocation it motivates starts, so a wait for a slot never hides it.
export type TriggerReason = "resposta-humana" | "feedback-pr" | "check-falhou" | "conflito-pr" | "retomada-manual";

export interface Trigger {
  reason: TriggerReason;
  // Where it came from: terminal, issue, pr, operador.
  origin: string;
  // Short reference to the event: a comment, a review, a check id, a command id.
  ref?: string;
  author?: string;
  // The pull request, as "#14", when the feedback concerns one.
  pr?: string;
  check?: string;
  // Id of the operator command (reply, resume) that caused it.
  command?: string;
}

export interface Job {
  key: string; // identity: tracker + project + issue id (see refKey)
  ref: IssueRef;
  repository: string; // configured repository of the project; concurrency key
  state: JobState;
  reason?: string;
  question?: string;
  context?: string;
  pr?: PrRef;
  // Session and area reported by the runner; a resume continues them.
  workspace?: Workspace;
  // Keys of tracker and PR feedback already taken by this job, as `source:id@revision`.
  // An event is consumed once: its id and revision are recorded so it never repeats.
  consumed?: string[];
  // Last PR observation by polling. Kept across states; it never changes the state.
  prStatus?: PrStatus;
  pending?: Continuation;
  // The feedback items of the job and the phase of its triage (issue #21). Owned and changed only by
  // the feedback module; the causes of a continuation are derived from it, never stored in parallel.
  feedback?: Feedback;
  // When the external merge of the linked PR was first detected; it is announced only once.
  mergeDetected?: string;
  log: string[];
}

export interface PrStatus {
  checks: Known<CheckState>;
  review: Known<ReviewState>;
  mergeable: Known<Mergeability>;
}

// Letters, digits, "_", "-" and "/" stand for themselves. Any other UTF-16 unit is written as "%"
// and four hex digits: "%" is a legal character in a Git ref, so a segment never starts with an
// illegal character, and the fixed width keeps the encoding injective.
const encodeRefPart = (text: string): string =>
  text.replace(/[^A-Za-z0-9_/-]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

// The branch the implementation of an issue works on and that its PR must have as head.
// It is derived from the job identity (tracker, project, issue id), so the same issue
// number in two projects gives two branches. The runner creates it; the PR check expects it.
export const jobBranch = (ref: IssueRef): string =>
  `msf/${encodeRefPart(ref.tracker)}/${encodeRefPart(ref.project)}/${encodeRefPart(ref.id)}`;

export interface TransitionDetails {
  message: string;
  reason?: string;
  question?: string;
  context?: string;
  pr?: PrRef;
}

// `released` is the operator ending the tracking of a job that is not running: the
// claim is removed, the record keeps area, session and PR, and nothing else is changed.
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  running: ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required", "done"],
  // A resume that cannot continue the session asks for help again.
  "waiting-for-help": ["running", "waiting-for-help", "interrupted", "intervention-required", "done", "released"],
  // Undecidable feedback on the PR is a help request to the human.
  "waiting-for-pr": ["running", "waiting-for-help", "interrupted", "intervention-required", "done", "released"],
  interrupted: ["running", "waiting-for-help", "released"],
  "intervention-required": ["running", "released"],
  done: [],
  released: [],
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
  // Resuming keeps the PR reference: the PR stays the one tracked by this job. The feedback items
  // are not touched here: their lifecycle belongs to the feedback module.
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
