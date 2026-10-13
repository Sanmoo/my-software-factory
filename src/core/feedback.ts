import { createHash } from "node:crypto";
import type { Continuation, Job, JobState, Trigger } from "./job.js";
import { isConflicting } from "./pr-rules.js";
import type { PrCheck, PrComment, PrFeedback, PrSnapshot, PrThread } from "../pr/port.js";
import type { Comment, TrackerKind } from "../tracker/port.js";
import type { PrRef } from "./result.js";
import { GITHUB_MARKER, JIRA_MARKER } from "./markers.js";

// The triage of PR feedback (issue #21). Pure judgement and state: no I/O here. The admission
// reads the tracker and the PR port, asks this module to judge what came and to plan the
// continuation, and records the outcome of each invocation. This module owns the feedback items
// on the job and the explicit phase of a triage, so the origin of an item is never decided by
// comparing its text: it is carried as a typed kind from the read to the invocation that handles it.

// The prefix that makes a human issue comment a directed reply to the job.
const DIRECTED_PREFIX = "agent:";

// One piece of feedback that reached a job, with the origin that must accompany it. `key`
// identifies the tracker or PR event it came from, so the job can record that it was consumed;
// a terminal reply has no event and no key.
export interface PrCommentItem {
  kind: "pr-comment";
  key: string;
  author: string;
  comment: PrComment["kind"];
  // Short reference to the comment ("revisão 12", "comentário inline 34").
  ref: string;
  body: string;
  thread?: PrThread;
  pr?: string;
}

export interface DirectedReplyItem {
  kind: "directed-reply";
  key?: string;
  origin: "issue" | "terminal";
  message: string;
  // The operator command (reply, resume) that carried it, when there was one.
  command?: string;
  ref?: string;
  author?: string;
}

export interface CheckItem {
  kind: "check";
  key: string;
  name: string;
  id: string;
  // A failing check, or one whose state could not be read (which needs the human's call).
  state: "failing" | "unknown";
  pr?: string;
}

export interface ConflictItem {
  kind: "conflict";
  key: string;
  head: string;
  base: string;
  targetBranch: string;
  pr?: string;
}

export type FeedbackItem = PrCommentItem | DirectedReplyItem | CheckItem | ConflictItem;

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// Identity and revision of a feedback event: the same comment edited later is a new event.
const commentKey = (source: "issue" | "pr", id: string, body: string): string => `${source}:${id}@${digest(body)}`;

const checkKey = (check: PrCheck): string => `pr:check:${check.id}@${check.state.known ? check.state.value : "unknown"}`;

const shortSha = (sha: string): string => sha.slice(0, 7);

// How a PR comment kind is named in the descriptions and references.
const commentLabel = (kind: PrComment["kind"]): string => (kind === "review" ? "revisão" : "comentário");

// Whether a comment carries the factory marker for its tracker. Memory comments answer to both.
export function isFactoryComment(tracker: TrackerKind, body: string): boolean {
  const github = body.includes(GITHUB_MARKER);
  const jira = body.trimStart().startsWith(JIRA_MARKER);
  if (tracker === "github") return github;
  if (tracker === "jira") return jira;
  return github || jira;
}

// The short description of an item: what the logs and the undecidable question show the operator.
// The prompt that renders the items for the agent is the runtime's, not this module's.
export function describeItem(item: FeedbackItem): string {
  switch (item.kind) {
    case "pr-comment": {
      if (item.comment === "inline" && item.thread !== undefined) {
        const { id, path, resolved } = item.thread;
        return `comentário inline de ${item.author} em ${path} (thread ${id}${resolved ? ", resolvido" : ""}): ${item.body}`;
      }
      return `${commentLabel(item.comment)} de ${item.author}: ${item.body}`;
    }
    case "directed-reply":
      return item.message;
    case "check":
      return item.state === "failing" ? `check com falha: ${item.name}` : `check de estado desconhecido: ${item.name}`;
    case "conflict":
      return `PR em conflito com ${item.targetBranch} (head ${item.head}, base ${item.base})`;
  }
}

// Why the item reactivates the job, for the observability of the continuation. Derived from the
// typed item, never from its text.
export function feedbackCause(item: FeedbackItem): Trigger {
  switch (item.kind) {
    case "pr-comment":
      return { reason: "feedback-pr", origin: "pr", ref: item.ref, author: item.author, pr: item.pr };
    case "directed-reply":
      return { reason: "resposta-humana", origin: item.origin, ref: item.ref, author: item.author, command: item.command };
    case "check":
      return { reason: "check-falhou", origin: "pr", check: item.name, ref: item.id, pr: item.pr };
    case "conflict":
      return { reason: "conflito-pr", origin: "pr", ref: `conflito ${item.head}..${item.base}`, pr: item.pr };
  }
}

// A human issue comment without marker that starts with `agent:` is a directed reply.
// Anything else is conversation between people and is not feedback.
export function directedReply(tracker: TrackerKind, comment: Comment): DirectedReplyItem | undefined {
  if (comment.isBot || isFactoryComment(tracker, comment.body)) return undefined;
  const text = comment.body.trim();
  if (!text.startsWith(DIRECTED_PREFIX)) return undefined;
  const message = text.slice(DIRECTED_PREFIX.length).trim();
  if (message === "") return undefined;
  return {
    kind: "directed-reply",
    key: commentKey("issue", comment.id, comment.body),
    origin: "issue",
    message,
    ref: `comentário ${comment.id}`,
    author: comment.author,
  };
}

// A conflict of the PR with its target branch calls for a correction. It is judged on the
// pair of head and base commits the PR is read at: that pair is taken once, so a correction that did
// not move the head does not repeat, while a new conflicting pair calls for it again. Unknown
// mergeability is no verdict: it is neither a conflict nor its absence, and the next poll reads it again.
export function judgeConflict(pr: PrSnapshot, consumed: ReadonlySet<string>): ConflictItem | undefined {
  if (!isConflicting(pr.mergeable)) return undefined;
  const key = `pr:conflict:${pr.headSha}@${pr.baseSha}`;
  if (consumed.has(key)) return undefined;
  return {
    kind: "conflict",
    key,
    head: shortSha(pr.headSha),
    base: shortSha(pr.baseSha),
    targetBranch: pr.baseBranch,
    pr: `#${pr.ref.number}`,
  };
}

export interface PrJudgement {
  // New feedback that calls for a response or a correction (or, when undecidable, is for the human).
  inputs: FeedbackItem[];
  // Set when the factory cannot decide by its rules and a person must decide.
  undecidable?: string;
}

// How a comment is referenced on its own, without its text.
function commentRef(comment: PrComment): string {
  if (comment.kind === "inline" && comment.thread !== undefined) return `comentário inline ${comment.id}`;
  return `${commentLabel(comment.kind)} ${comment.id}`;
}

// Human comments are all feedback on the PR, one item per comment: conversation, inline and the
// body of a review. A review with an empty body is only the envelope of its comments, and the
// factory's own posts and bots are not feedback: the marker is checked on each comment,
// so a marked inline reply inside an unmarked review triggers nothing. A comment in a resolved
// thread counts. A read that did not cover every comment is not the absence of feedback: it is
// undecidable. A failing check calls for correction: only required checks when the branch protection has
// any, otherwise any failing check. Checks whose state or required flag cannot be read make the
// case undecidable when a failing check is among the new items.
export function judgePrFeedback(feedback: PrFeedback, consumed: ReadonlySet<string>, pr?: PrRef): PrJudgement {
  const prLabel = pr === undefined ? undefined : `#${pr.number}`;
  const inputs: FeedbackItem[] = [];
  for (const comment of feedback.comments) {
    const text = comment.body.trim();
    if (text === "" || comment.isBot || isFactoryComment("github", comment.body)) continue;
    const key = commentKey("pr", comment.id, comment.body);
    if (consumed.has(key)) continue;
    inputs.push({
      kind: "pr-comment",
      key,
      author: comment.author,
      comment: comment.kind,
      ref: commentRef(comment),
      body: text,
      ...(comment.thread === undefined ? {} : { thread: comment.thread }),
      pr: prLabel,
    });
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
    inputs.push({
      kind: "check",
      key: checkKey(check),
      name: check.name,
      id: check.id,
      state: check.state.known ? "failing" : "unknown",
      pr: prLabel,
    });
  }

  const reasons = [
    ...(feedback.incomplete === undefined ? [] : [feedback.incomplete]),
    ...(blind ? ["não é possível dizer, pelas regras da factory, se o check exige correção (estado ou obrigatoriedade desconhecidos)"] : []),
  ];
  return reasons.length === 0 ? { inputs } : { inputs, undecidable: reasons.join("; ") };
}

// The feedback state of a job, owned and changed only by this module. `pending` holds items not yet
// delivered to an invocation; `held` the items of a triage batch that wait for the operator's choice
// (every item that is not a PR comment); `phase` is the explicit phase of a triage; `manual` is a
// manual resume asked by the operator, a continuation cause that is not feedback.
export type TriagePhase = "listing" | "awaiting-choice";

export interface Feedback {
  pending: FeedbackItem[];
  held: FeedbackItem[];
  phase?: TriagePhase;
  manual?: { command?: string };
}

const EMPTY_FEEDBACK: Feedback = { pending: [], held: [] };

const isPrComment = (item: FeedbackItem): item is PrCommentItem => item.kind === "pr-comment";
const isDirectedReply = (item: FeedbackItem): item is DirectedReplyItem => item.kind === "directed-reply";

// Whether a batch of feedback has a human comment of the PR, and so goes through the triage before any
// change of code (issue #21). Failing checks, conflict and directed replies do not call for one.
export const needsTriage = (items: readonly FeedbackItem[]): boolean => items.some(isPrComment);

// Whether a triage has started and has not concluded.
export const triageInProgress = (job: Job): boolean => job.feedback?.phase !== undefined;

const manualCauses = (feedback: Feedback | undefined): Trigger[] =>
  feedback?.manual === undefined
    ? []
    : [{
      reason: "retomada-manual",
      origin: feedback.manual.command === undefined ? "operador" : "terminal",
      ...(feedback.manual.command === undefined ? {} : { command: feedback.manual.command, ref: `comando ${feedback.manual.command}` }),
    }];

// Records a manual resume (or correction asked by hand) on the job, so the derived causes say why even
// when it carries no item of feedback of its own.
export function noteManualResume(job: Job, command?: string): Job {
  const feedback = job.feedback ?? EMPTY_FEEDBACK;
  return { ...job, feedback: { ...feedback, manual: command === undefined ? {} : { command } } };
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

// Directed input has one effect whatever its source: the terminal reply and a tracker
// `agent:` comment both come through here. A job waiting for help is reactivated as a reply when a
// slot is free; a job waiting for PR becomes a correction; an active or interrupted job keeps the
// input for its next invocation. Consumed keys are recorded so the same event never repeats.
export function receiveFeedback(job: Job, inputs: FeedbackItem[], origin: string): ReceiveOutcome {
  if (inputs.length === 0) return { job };
  const effect = EFFECT_OF_STATE[job.state];
  if (effect === undefined) return { reason: `não se aplica ao estado ${job.state}` };
  const feedback = job.feedback ?? EMPTY_FEEDBACK;
  const log = inputs.map((input) => `${origin}; ${effect.log}: ${describeItem(input)}`);
  const consumed = inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
  return {
    job: {
      ...job,
      ...(effect.pending === undefined ? {} : { pending: effect.pending }),
      feedback: { ...feedback, pending: [...feedback.pending, ...inputs] },
      consumed: [...(job.consumed ?? []), ...consumed],
      log: [...job.log, ...log],
    },
  };
}

// The plan of one continuation invocation, as a union by step (issue #21). `continue` carries the
// items of a resume or correction with no triage; `list` the comments the triage numbers and the
// directed replies it delivers as the operator's guidance; `apply` the operator's choice and the
// items the triage held back.
export type ContinuationPlan =
  | { step: "continue"; items: FeedbackItem[] }
  | { step: "list"; comments: FeedbackItem[]; replies: FeedbackItem[] }
  | { step: "apply"; choice: FeedbackItem[]; retained: FeedbackItem[] };

export type PlanStep = ContinuationPlan["step"];

export interface PlannedContinuation {
  // The job with whatever the plan consumes already taken from its feedback state.
  job: Job;
  plan: ContinuationPlan;
  // The causes of this invocation, derived from the items (plus a manual resume when there was one).
  causes: Trigger[];
}

// The plan consumes the pending items: it takes them into the invocation and moves them out of the
// way, except the PR comments of a listing, which stay pending so a triage that did not conclude can
// redo the listing with them.
export function planContinuation(job: Job, kind: Continuation): PlannedContinuation {
  const feedback = job.feedback ?? EMPTY_FEEDBACK;
  const manual = manualCauses(feedback);
  const listing = (pending: FeedbackItem[], held: FeedbackItem[]): PlannedContinuation => {
    const comments = pending.filter(isPrComment);
    const retained = [...held, ...pending.filter((item) => !isPrComment(item))];
    return {
      job: { ...job, feedback: { pending: comments, held: retained, phase: "listing" } },
      plan: { step: "list", comments, replies: retained.filter(isDirectedReply) },
      causes: [...[...comments, ...retained].map(feedbackCause), ...manual],
    };
  };
  if (feedback.phase === undefined && needsTriage(feedback.pending)) {
    return listing(feedback.pending, feedback.held);
  }
  // A triage that did not reach the operator's choice: the resume redoes the listing, with the
  // comments that are still pending and the retained items still held.
  if (kind === "resume" && feedback.phase === "listing") {
    return listing(feedback.pending, feedback.held);
  }
  if (kind === "resume" && feedback.phase === "awaiting-choice") {
    const choice = feedback.pending.filter((item) => !isPrComment(item));
    const retained = feedback.held;
    return {
      job: { ...job, feedback: undefined },
      plan: { step: "apply", choice, retained },
      causes: [...[...choice, ...retained].map(feedbackCause), ...manual],
    };
  }
  const items = feedback.pending;
  return {
    job: job.feedback === undefined ? job : { ...job, feedback: undefined },
    plan: { step: "continue", items },
    causes: [...items.map(feedbackCause), ...manual],
  };
}

// The causes of the pending continuation of a job, before it is planned: used to say why an
// invocation waits for a slot. Derived from the items, never from a parallel trigger list.
export function continuationCauses(job: Job): Trigger[] {
  const feedback = job.feedback;
  if (feedback === undefined) return [];
  return [...[...feedback.pending, ...feedback.held].map(feedbackCause), ...manualCauses(feedback)];
}

// The `string[]` the runner port receives in this ticket. The typed plan is the source; the runtime
// will render the items itself in the next ticket.
export function planTexts(plan: ContinuationPlan): string[] {
  switch (plan.step) {
    case "continue":
      return plan.items.map(describeItem);
    case "list":
      return [...plan.comments, ...plan.replies].map(describeItem);
    case "apply":
      return [...plan.choice, ...plan.retained].map(describeItem);
  }
}

// Whether the invocation must rebase the branch: a conflict it carries.
export function planConflict(plan: ContinuationPlan): boolean {
  const items = plan.step === "continue" ? plan.items : plan.step === "apply" ? plan.retained : [];
  return items.some((item) => item.kind === "conflict");
}

// The operator commands whose replies this invocation carries, so the runner can report their
// delivery by id (issue #15). Directed replies from the tracker have no command id. Only the
// operator's choice is new in `apply`: a retained reply was already delivered by the listing.
export function planCommands(plan: ContinuationPlan): string[] {
  const items = plan.step === "continue" ? plan.items : plan.step === "list" ? [...plan.comments, ...plan.replies] : plan.choice;
  return items.flatMap((item) => (isDirectedReply(item) && item.command !== undefined ? [item.command] : []));
}

export function planTriage(plan: ContinuationPlan): "list" | "apply" | undefined {
  return plan.step === "continue" ? undefined : plan.step;
}

// How the invocation a listing started ended: with the help request that opens the choice, or
// without a valid outcome, in which case the phase stays `listing` for the resume to redo it.
export type TriageOutcome = "help" | "incomplete" | "complete";

// The outcome of an invocation, applied to the triage phase. A listing that reached its help request
// moves to `awaiting-choice`; one that ended interrupted or invalid stays `listing`; every other
// invocation ends the triage and clears its feedback.
export function recordTriageOutcome(job: Job, step: PlanStep | undefined, outcome: TriageOutcome): Job {
  const feedback = job.feedback;
  if (feedback === undefined || step === undefined) return job;
  if (step === "list" && feedback.phase === "listing") {
    return outcome === "help" ? { ...job, feedback: { ...feedback, phase: "awaiting-choice" } } : job;
  }
  return { ...job, feedback: undefined };
}

// A resume while the triage waits for the operator's choice is refused, with a message the operator
// can copy: the triage ends only with the answer to its list.
export function resumeRefusal(job: Job): string | undefined {
  if (job.feedback?.phase !== "awaiting-choice") return undefined;
  return "a triagem do feedback do PR aguarda a escolha do operador; responda com reply … nenhum (ou a escolha) em vez de resume";
}
