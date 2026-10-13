import assert from "node:assert/strict";
import test from "node:test";
import { newJob, type Job } from "../src/core/job.js";
import {
  continuationCauses, describeItem, feedbackCause, needsTriage, noteManualResume, planCommands, planConflict,
  planContinuation, receiveFeedback, recordTriageOutcome, resumeRefusal, triageInProgress,
  type CheckItem, type ConflictItem, type DirectedReplyItem, type FeedbackItem, type PrCommentItem,
} from "../src/core/feedback.js";
import type { IssueRef } from "../src/tracker/port.js";

// The triage module (issue #21) through its public interface: receive items, plan the continuation,
// record the outcome. Pure functions over the job and the typed items, without any I/O.

const REF: IssueRef = { tracker: "memory", project: "acme/app", id: "1" };
const job = (state: Job["state"] = "waiting-for-pr"): Job => ({ ...newJob({ ref: REF, repository: "acme/app" }), state });

const comment = (overrides: Partial<PrCommentItem> = {}): PrCommentItem => ({
  kind: "pr-comment", key: "pr:PRR_1@abc", author: "ana", comment: "review", ref: "revisão PRR_1", body: "troque o nome", ...overrides,
});
const reply = (overrides: Partial<DirectedReplyItem> = {}): DirectedReplyItem => ({
  kind: "directed-reply", origin: "terminal", message: "1", ...overrides,
});
const check = (overrides: Partial<CheckItem> = {}): CheckItem => ({
  kind: "check", key: "pr:check:T@failing", name: "test", id: "T", state: "failing", ...overrides,
});
const conflict = (overrides: Partial<ConflictItem> = {}): ConflictItem => ({
  kind: "conflict", key: "pr:conflict:h1@b1", head: "h1", base: "b1", targetBranch: "main", ...overrides,
});

// A job that received the items, as the admission leaves it after reading the PR.
const received = (items: FeedbackItem[], state: Job["state"] = "waiting-for-pr"): Job => {
  const outcome = receiveFeedback(job(state), items, "feedback do PR recebido");
  if ("reason" in outcome) throw new Error(outcome.reason);
  return outcome.job;
};

const outcomeOf = (current: Job, items: FeedbackItem[], state: Job["state"] = "waiting-for-help"): Job => {
  const outcome = receiveFeedback({ ...current, state }, items, "resposta recebida");
  if ("reason" in outcome) throw new Error(outcome.reason);
  return outcome.job;
};

test("each item kind has a short description that carries its provenance", () => {
  assert.equal(describeItem(comment()), "revisão de ana: troque o nome");
  assert.equal(describeItem(comment({ comment: "comment", ref: "comentário IC_2", body: "e a doc" })), "comentário de ana: e a doc");
  assert.equal(
    describeItem(comment({ comment: "inline", ref: "comentário inline PRRC_1", body: "troque", thread: { id: "PRRT_1", path: "README.md", resolved: false } })),
    "comentário inline de ana em README.md (thread PRRT_1): troque",
  );
  assert.equal(
    describeItem(comment({ comment: "inline", thread: { id: "PRRT_1", path: "README.md", resolved: true } })),
    "comentário inline de ana em README.md (thread PRRT_1, resolvido): troque o nome",
  );
  assert.equal(describeItem(reply({ message: "Pode seguir" })), "Pode seguir");
  assert.equal(describeItem(check()), "check com falha: test");
  assert.equal(describeItem(check({ state: "unknown", name: "deploy" })), "check de estado desconhecido: deploy");
  assert.equal(describeItem(conflict()), "PR em conflito com main (head h1, base b1)");
});

test("the cause of an item is derived from its kind, never from its text", () => {
  const fromComment = feedbackCause(comment({ pr: "#9" }));
  assert.equal(fromComment.reason, "feedback-pr");
  assert.equal(fromComment.origin, "pr");
  assert.equal(fromComment.ref, "revisão PRR_1");
  assert.equal(fromComment.author, "ana");
  assert.equal(fromComment.pr, "#9");

  const fromReply = feedbackCause(reply({ origin: "issue", ref: "comentário c1", author: "ana", command: "cmd-1" }));
  assert.equal(fromReply.reason, "resposta-humana");
  assert.equal(fromReply.origin, "issue");
  assert.equal(fromReply.command, "cmd-1");

  const fromCheck = feedbackCause(check({ pr: "#9" }));
  assert.equal(fromCheck.reason, "check-falhou");
  assert.equal(fromCheck.check, "test");
  assert.equal(fromCheck.ref, "T");

  const fromConflict = feedbackCause(conflict());
  assert.equal(fromConflict.reason, "conflito-pr");
  assert.equal(fromConflict.ref, "conflito h1..b1");
});

test("only a human comment of the PR calls for the triage", () => {
  assert.equal(needsTriage([comment()]), true);
  assert.equal(needsTriage([check(), conflict(), reply()]), false);
  assert.equal(needsTriage([]), false);
});

test("receiving items keeps them pending with their type and marks them consumed", () => {
  const receivedJob = received([comment(), check()]);
  assert.equal(receivedJob.pending, "correction");
  assert.deepEqual(receivedJob.feedback?.pending.map((item) => item.kind), ["pr-comment", "check"]);
  assert.equal(receivedJob.feedback?.phase, undefined);
  assert.deepEqual(receivedJob.consumed, ["pr:PRR_1@abc", "pr:check:T@failing"]);
  assert.match(receivedJob.log.join("\n"), /revisão de ana: troque o nome/);
});

test("feedback for a state that takes no input is refused with a reason", () => {
  const outcome = receiveFeedback(job("done"), [check()], "feedback do PR recebido");
  assert.ok("reason" in outcome);
});

test("a batch with a human comment is planned as a listing: comments numbered, retained items held", () => {
  const receivedJob = received([
    comment(),
    check(),
    conflict(),
    reply({ message: "olhe a doc", origin: "issue", key: "issue:c9@x", ref: "comentário c9", author: "ana" }),
  ]);
  const { job: planned, plan, causes } = planContinuation(receivedJob, "correction");

  assert.equal(plan.step, "list");
  if (plan.step !== "list") return;
  assert.deepEqual(plan.comments.map(describeItem), ["revisão de ana: troque o nome"]);
  assert.deepEqual(plan.replies.map(describeItem), ["olhe a doc"], "a directed reply is the operator's guidance, not a comment to number");
  assert.equal(plan.step, "list");
  assert.equal(planned.feedback?.phase, "listing");
  assert.deepEqual(planned.feedback?.pending.map((item) => item.kind), ["pr-comment"], "the comment stays pending so a failed listing can be redone");
  assert.deepEqual(planned.feedback?.held.map((item) => item.kind), ["check", "conflict", "directed-reply"]);
  assert.deepEqual(causes.map((cause) => cause.reason), ["feedback-pr", "check-falhou", "conflito-pr", "resposta-humana"]);
  assert.equal(planConflict(plan), false, "the listing does not rebase");
});

test("a batch without a human comment is planned as a continuation that carries its items", () => {
  const { job: planned, plan, causes } = planContinuation(received([check(), conflict()]), "correction");

  assert.equal(plan.step, "continue");
  if (plan.step !== "continue") return;
  assert.deepEqual(plan.items.map((item) => item.kind), ["check", "conflict"]);
  assert.equal(planConflict(plan), true);
  assert.equal(planned.feedback, undefined);
  assert.deepEqual(causes.map((cause) => cause.reason), ["check-falhou", "conflito-pr"]);
});

test("a listing that did not reach the help request stays in `listing` and the resume redoes it, without apply", () => {
  const first = planContinuation(received([comment(), check()]), "correction");
  const interrupted = recordTriageOutcome(first.job, "list", "incomplete");

  assert.equal(interrupted.feedback?.phase, "listing", "an interrupted listing does not open the choice");
  assert.deepEqual(interrupted.feedback?.held.map((item) => item.kind), ["check"]);

  const again = planContinuation(noteManualResume(interrupted), "resume");
  assert.equal(again.plan.step, "list", "the resume redoes the listing, never applies");
  if (again.plan.step === "list") {
    assert.deepEqual(again.plan.comments.map(describeItem), ["revisão de ana: troque o nome"], "the comment is listed again");
  }
  assert.deepEqual(again.job.feedback?.held.map((item) => item.kind), ["check"], "the retained item stays retained");
});

test("a listing that reached the help request waits for the choice; the answer is applied with the retained items", () => {
  const first = planContinuation(received([comment(), check(), conflict()]), "correction");
  const waiting = recordTriageOutcome(first.job, "list", "help");
  assert.equal(waiting.feedback?.phase, "awaiting-choice");

  const answered = outcomeOf(waiting, [reply({ message: "1; 2: responda que X", command: "cmd-1" })]);
  const { job: applied, plan, causes } = planContinuation(answered, "resume");

  assert.equal(plan.step, "apply");
  if (plan.step !== "apply") return;
  assert.deepEqual(plan.choice.map(describeItem), ["1; 2: responda que X"]);
  assert.deepEqual(plan.retained.map((item) => item.kind), ["check", "conflict"]);
  assert.equal(planConflict(plan), true);
  assert.deepEqual(planCommands(plan), ["cmd-1"]);
  assert.equal(applied.feedback, undefined, "the choice concludes the triage");
  assert.deepEqual(causes.map((cause) => cause.reason), ["resposta-humana", "check-falhou", "conflito-pr"]);
});

test("a resume is refused while the triage waits for the choice, with a copyable message", () => {
  const awaiting = { ...received([comment()]), state: "waiting-for-help" as const, feedback: { pending: [comment()], held: [], phase: "awaiting-choice" as const } };
  assert.equal(triageInProgress(awaiting), true);
  assert.match(resumeRefusal(awaiting) ?? "", /reply … nenhum/);
  assert.equal(resumeRefusal(received([check()])), undefined);
});

test("a directed reply whose text equals a check's description is not matched with the check", () => {
  const colliding = reply({ message: "check com falha: test", origin: "issue", key: "issue:c9@x" });
  const receivedJob = received([comment(), check(), colliding]);
  const { job: planned, plan } = planContinuation(receivedJob, "correction");

  assert.equal(plan.step, "list");
  if (plan.step !== "list") return;
  assert.deepEqual(plan.comments.map((item) => item.kind), ["pr-comment"], "the check is not delivered as a comment");
  assert.deepEqual(plan.replies.map((item) => item.kind), ["directed-reply"], "the reply is delivered as guidance");
  assert.deepEqual([...plan.comments, ...plan.replies].map(describeItem), ["revisão de ana: troque o nome", "check com falha: test"]);
  assert.deepEqual(planned.feedback?.held.map((item) => item.kind), ["check", "directed-reply"], "both are held, told apart by kind");
});

test("a manual resume is a cause of its own, kept with the items", () => {
  const noted = noteManualResume(received([check()]), "cmd-7");
  assert.deepEqual(continuationCauses(noted).map((cause) => cause.reason), ["check-falhou", "retomada-manual"]);

  const { causes, plan } = planContinuation(noted, "resume");
  assert.equal(plan.step, "continue");
  assert.deepEqual(causes.map((cause) => `${cause.reason}:${cause.origin}`), ["check-falhou:pr", "retomada-manual:terminal"]);
});

test("the outcome of an apply or a continuation clears the feedback it delivered", () => {
  const first = planContinuation(received([comment(), check()]), "correction");
  const waiting = recordTriageOutcome(first.job, "list", "help");
  const answered = outcomeOf(waiting, [reply({ message: "1" })]);
  const applied = planContinuation(answered, "resume").job;
  assert.equal(applied.feedback, undefined);
  assert.equal(recordTriageOutcome(applied, "apply", "complete"), applied);
});
