import { createHash } from "node:crypto";
import type { Continuation, Job, JobState } from "./job.js";
import type { PrCheck, PrFeedback } from "../pr/port.js";
import type { Comment, TrackerKind } from "../tracker/port.js";
import { GITHUB_MARKER, JIRA_MARKER } from "./markers.js";

// Feedback that reaches a job (R09, R10, CA11, CA12). Pure judgement: no I/O here. The
// admission reads the tracker and the PR port, applies these rules, and persists the result.
// Feedback never widens scope and never decides merge or deploy: it only reactivates the job
// (as a reply or a correction) and is delivered to the next invocation as text.

// The prefix that makes a human issue comment a directed reply to the job (CA11).
const DIRECTED_PREFIX = "agent:";

// One piece of directed input. `key` identifies the tracker or PR event it came from, so the
// job can record that it was consumed; terminal replies have no event and no key.
export interface FeedbackInput {
  key?: string;
  message: string;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// Identity and revision of a feedback event: the same comment edited later is a new event (R10).
const commentKey = (source: "issue" | "pr", id: string, body: string): string => `${source}:${id}@${digest(body)}`;

const checkKey = (check: PrCheck): string => `pr:check:${check.id}@${check.state.known ? check.state.value : "unknown"}`;

// Whether a comment carries the factory marker for its tracker (R10). Memory comments answer to both.
export function isFactoryComment(tracker: TrackerKind, body: string): boolean {
  const github = body.includes(GITHUB_MARKER);
  const jira = body.trimStart().startsWith(JIRA_MARKER);
  if (tracker === "github") return github;
  if (tracker === "jira") return jira;
  return github || jira;
}

// A human issue comment without marker that starts with `agent:` is a directed reply (CA11).
// Anything else is conversation between people and is not feedback.
export function directedReply(tracker: TrackerKind, comment: Comment): { key: string; message: string } | undefined {
  if (comment.isBot || isFactoryComment(tracker, comment.body)) return undefined;
  const text = comment.body.trim();
  if (!text.startsWith(DIRECTED_PREFIX)) return undefined;
  const message = text.slice(DIRECTED_PREFIX.length).trim();
  if (message === "") return undefined;
  return { key: commentKey("issue", comment.id, comment.body), message };
}

export interface PrJudgement {
  // New feedback that calls for a response or a correction (or, when undecidable, is for the human).
  inputs: FeedbackInput[];
  // Set when the factory cannot decide by its rules and a person must decide (R10).
  undecidable?: string;
}

// Human reviews and comments are all feedback on the PR; the factory's own posts and bots are not
// (R10). A failing check calls for correction: only required checks when the branch protection has
// any, otherwise any failing check (R10). Checks whose state or required flag cannot be read make the
// case undecidable when a failing check is among the new items.
export function judgePrFeedback(feedback: PrFeedback, consumed: ReadonlySet<string>): PrJudgement {
  const inputs: FeedbackInput[] = [];
  for (const comment of feedback.comments) {
    if (comment.isBot || isFactoryComment("github", comment.body)) continue;
    const key = commentKey("pr", comment.id, comment.body);
    if (consumed.has(key)) continue;
    const label = comment.kind === "review" ? "revisão" : "comentário";
    const text = comment.body.trim() === "" ? "(sem texto)" : comment.body.trim();
    inputs.push({ key, message: `${label} de ${comment.author}: ${text}` });
  }

  const suspects = feedback.checks
    .filter((check) => !check.state.known || check.state.value === "failing")
    .filter((check) => !consumed.has(checkKey(check)));
  const blind = suspects.length > 0 && feedback.checks.some((check) => !check.state.known || !check.required.known);
  const requiredExist = feedback.checks.some((check) => check.required.known && check.required.value);
  const triggering = blind
    ? suspects
    : suspects.filter((check) => !requiredExist || (check.required.known && check.required.value));
  for (const check of triggering) {
    const text = check.state.known ? `check com falha: ${check.name}` : `check de estado desconhecido: ${check.name}`;
    inputs.push({ key: checkKey(check), message: text });
  }

  if (!blind) return { inputs };
  return {
    inputs,
    undecidable: "não é possível dizer, pelas regras da factory, se o check exige correção (estado ou obrigatoriedade desconhecidos)",
  };
}

// What directed input does in each state: the continuation it requests (if any) and the log wording.
const EFFECT_OF_STATE: Partial<Record<JobState, { pending?: Continuation; log: string }>> = {
  "waiting-for-help": { pending: "resume", log: "reativação quando houver vaga" },
  "waiting-for-pr": { pending: "correction", log: "correção solicitada; aguarda vaga" },
  running: { log: "pendente para a próxima invocação" },
  interrupted: { log: "pendente para a próxima invocação" },
};

// Result of giving directed input to a job. `reason` says why the state cannot take input; the
// caller decides how to report it.
export type ReceiveOutcome = { job: Job } | { reason: string };

// Directed input has one effect whatever its source (CA11): the terminal reply and a tracker
// `agent:` comment both come through here. A job waiting for help is reactivated as a reply when a
// slot is free; a job waiting for PR becomes a correction; an active or interrupted job keeps the
// input for its next invocation (R09). Consumed keys are recorded so the same event never repeats.
export function receiveFeedback(job: Job, inputs: FeedbackInput[], origin: string): ReceiveOutcome {
  if (inputs.length === 0) return { job };
  const effect = EFFECT_OF_STATE[job.state];
  if (effect === undefined) return { reason: `não se aplica ao estado ${job.state}` };
  const log = inputs.map((input) => `${origin}; ${effect.log}: ${input.message}`);
  const consumed = inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
  return {
    job: {
      ...job,
      ...(effect.pending === undefined ? {} : { pending: effect.pending }),
      replies: [...(job.replies ?? []), ...inputs.map((input) => input.message)],
      consumed: [...(job.consumed ?? []), ...consumed],
      log: [...job.log, ...log],
    },
  };
}
