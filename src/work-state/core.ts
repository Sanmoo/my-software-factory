import type { Labels, ModelProviderBudget, RecoveryBudget } from "../config.js";
import type { ExpandedPrFeedback, PullRequestRecord, TicketSnapshot } from "../tracker/expanded-port.js";
import type { IssueComment } from "../tracker/port.js";
import { isAgentSpeech } from "../tracker/port.js";
import { workKeyOf } from "../pool/work-key.js";
import { operatorStopClaim } from "../pool/stop.js";
import { modelProviderDecision } from "../pool/model-provider.js";
import { emptyModelProviderLedger } from "../work-record/model-provider.js";
import { hasPendingReconciliation, MAX_REPAIR_FALLS, MAX_REPAIR_ROUNDS, hasRepairCycle } from "../pool/repair.js";
import { ownOutcomeRecord, type OutcomeRecord } from "../work-record/outcome.js";
import { ownWrittenOutcome, selfReportedBlocked } from "../state/outcome.js";
import type { WorkRecordSnapshot } from "../work-record/record.js";
import type { PauseRecord } from "../work-record/continuity.js";
import type { RepairAttempt, RepairCycle } from "../work-record/repair.js";
import type { PrRepairFacts, RepairReason, RequiredCheckResult } from "../tracker/port.js";
import {
  fallbackDoneComment,
  humanCommentsAfterLastMarker,
  humanCommentsForPause,
  lastPrComment,
  rejectionComment,
  repairSignature,
} from "../state/derive.js";
import type { AttemptEndFacts, WorkFacts } from "./facts.js";
import type { RepairTrigger, WorkRef, WorkStateReading } from "./state.js";

/**
 * The decision core: the ladder from the facts to the Work state, and nothing
 * else. It is the module's internal seam — pure in the sense that matters: it
 * does no I/O, reads no clock and holds no state, so a verdict is a function of
 * the facts handed to it. Every read it needs is a method of {@link WorkFacts};
 * that is why this file imports no port, no disk and no adapter.
 *
 * The ladder is the one `state/derive.ts` walks today, carried over verbatim
 * (ticket #200): where the old ruler and the new module disagree, that is a
 * regression, not a decision. The text helpers (`lastPrComment`, the comment
 * builders) are imported from that ruler rather than copied, so the two cannot
 * drift by a word while both exist; #202 moves them here when it deletes the
 * old ladder.
 */

/** The policy the ladder applies: injected once, never per call. */
export interface DecisionPolicy {
  labels: Labels;
  recovery: RecoveryBudget;
  modelProvider: ModelProviderBudget;
  /** The works this process holds a launch for, by registry key. */
  inFlight: ReadonlySet<string>;
}

export async function deriveBeforeLaunch(
  ref: WorkRef,
  facts: WorkFacts,
  policy: DecisionPolicy,
): Promise<WorkStateReading> {
  const ticket = await facts.ticket();
  // A failed read is not a verdict: the module says that it could not read, and
  // never that the issue is gone (which is what the old `unknown` claimed).
  if (ticket.reading === "unreadable") return unreadable(ref, ticket.because);

  const issue = ticket.value;
  if (issue.state === "closed") {
    // A closed-as-not-planned issue is a terminal fact the factory never acts
    // on — its own state, so `unreadable` never means this (ADR-0010; D2).
    if (issue.stateReason === "not-planned") return { work: ref.work, dir: ref.dir, state: "not-planned" };
    return { work: ref.work, dir: ref.dir, state: "done" };
  }

  // The blocked state listens ONLY to the ticket (the rescue channel): this
  // short-circuit also keeps a handled rejection from being re-derived forever.
  if (issue.labels.includes(policy.labels.blocked)) return blocked(ref, issue, facts);

  const pull = await facts.pullRequest();
  if (pull.reading === "with-pull-request") return withPullRequest(ref, issue, pull.pr, pull.feedback, facts, policy);

  return claimedWithoutPullRequest(ref, issue, facts, policy);
}

// ---- the blocked channel: the ticket owns the answer ----

async function blocked(ref: WorkRef, issue: TicketSnapshot, facts: WorkFacts): Promise<WorkStateReading> {
  const comments = await facts.comments();

  // A record the factory cannot read is a doubt, not an empty record: the work
  // holds (nothing is decided, nothing is recovered) instead of falling back to
  // a verdict built on facts nobody read. The pause part of the record applies
  // the same rule to itself (reason `record-unreadable`).
  const snapshot = await readableRecord(facts);
  if (snapshot === null) return parked(ref);

  const pause = currentPause(snapshot);
  // The operator's answer is bound to the question it answered (issue 174):
  // with a CURRENT continuity pause the boundary is the pause's own request,
  // never the last thing the factory said. Every other blocked cause (a fall, a
  // repair, a rejection) keeps the generic last-marker rule. An unreadable
  // comments read sees no answer at all — it never invents one, and never
  // swallows the pause below.
  const issueReplies =
    comments.reading === "known"
      ? pause === null
        ? humanCommentsAfterLastMarker(comments.value)
        : humanCommentsForPause(comments.value, pause.pause)
      : NO_REPLIES;

  if (issueReplies.length > 0) {
    // A pending reconciliation outranks the human answer (issue 112, story 21):
    // the remote may already carry this attempt's commit.
    const cycle = snapshot.repair;
    if (cycle.attempt !== null && hasPendingReconciliation(cycle.attempt)) return parked(ref);
    return resumable(ref, issue, issueReplies, facts);
  }

  // A pause nobody answered is not a reason to wait parked (issue 173): the loop
  // re-reads the evidence the pause doubts before any human is asked again.
  if (pause !== null) {
    return { work: ref.work, dir: ref.dir, state: "continuity-paused", attempt: pause.attempt, pause: pause.pause };
  }
  return parked(ref);
}

// ---- the PR channel: the PR owns the fact ----

async function withPullRequest(
  ref: WorkRef,
  issue: TicketSnapshot,
  pr: PullRequestRecord,
  feedback: ExpandedPrFeedback,
  facts: WorkFacts,
  policy: DecisionPolicy,
): Promise<WorkStateReading> {
  if (pr.merged) {
    return { work: ref.work, dir: ref.dir, state: "done-fallback", pr, comment: fallbackDoneComment() };
  }
  if (pr.state === "closed") {
    return { work: ref.work, dir: ref.dir, state: "rejected", pr, comment: rejectionComment(pr) };
  }

  const snapshot = await readableRecord(facts);
  if (snapshot === null) return parked(ref);

  // The stop of THIS attempt, when the claim is still on the issue and no worker
  // of this process carries it: the same channel the claim-without-PR arm reads.
  const claim = operatorStopClaim(snapshot.recovery, {
    lastAttempt: snapshot.attempt ?? 0,
    acceptNextAttempt: true,
    outcome: snapshot.outcome,
  });
  if (claim.kind !== "none" &&
      issue.labels.includes(policy.labels.claimed) && !policy.inFlight.has(workKeyOf(ref.work))) {
    return claim.kind === "requested"
      ? { work: ref.work, dir: ref.dir, state: "stop-resume", attempt: claim.attempt }
      : { work: ref.work, dir: ref.dir, state: "stop-unconfirmed", attempt: claim.attempt, because: claim.because };
  }

  // The repair channel (issue 107): only CONFIRMED facts of the CURRENT head
  // trigger — conflicts with the current base, or required checks concluded with
  // failure/timeout. Unknown mergeability and pending/optional checks never do,
  // and the Block above already won over all of it.
  const repairFacts = await facts.repairFacts();
  const repair = repairFacts.reading === "known" ? repairFacts.value : null;
  const trigger = repair === null ? null : confirmedTrigger(repair);
  const cycle = snapshot.repair;
  const attempt = cycle.attempt;

  // The attempt's own state comes before the trigger and the evidence
  // consumption (issue 112): two consecutive falls and an unattributable remote
  // change block the work EVEN with the PR open and even when the current facts
  // are not confirmed — the open PR never hides a fall.
  if (attempt !== null && cycle.consecutiveFalls >= MAX_REPAIR_FALLS) {
    return unpublishedRepairBlock(ref, pr, cycle, snapshot, attempt, "consecutive-falls", facts);
  }
  if (attempt?.publication === "concurrent-change") {
    return unpublishedRepairBlock(ref, pr, cycle, snapshot, attempt, "concurrent-change", facts);
  }
  // Pending reconciliation: no worker of any kind and no budget return until
  // the remote or the host answers — placed before the trigger so an
  // unconfirmed PR fact cannot open a session while the reconciliation pends.
  if (attempt !== null && hasPendingReconciliation(attempt)) return parked(ref);

  if (trigger !== null) {
    const signature = repairSignature(ref.work, trigger);
    // A resumption takes over the attempt whose evidence is still the one this
    // head presents (issue 112): a fall on OLDER evidence is history, and the
    // current head gets a round of its own, pinned to its own head.
    if (attempt !== null && attempt.publication === "not-published" && attempt.evidence === signature) {
      return { work: ref.work, dir: ref.dir, state: "repair", pr, createdAt: issue.createdAt, trigger, resuming: attempt };
    }
    // Story 19: re-finding the same failure without new evidence is never a new
    // session; the exhausted cap still blocks.
    if (cycle.lastEvidence === signature) {
      if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) return repairBlock(ref, pr, trigger, cycle.usedRounds);
      return parked(ref);
    }
    if (cycle.usedRounds >= MAX_REPAIR_ROUNDS) return repairBlock(ref, pr, trigger, cycle.usedRounds);
    return { work: ref.work, dir: ref.dir, state: "repair", pr, createdAt: issue.createdAt, trigger, resuming: null };
  }

  // Confirmed recovery (story 22): no conflicts and every required check
  // approved — the only thing besides a human unblock that resets the cap. The
  // gate is "this work has a repair cycle", not "a round is charged": after a
  // fall the charged round was returned, and the fall ledger is what recovery
  // must clear (issue 112, story 25).
  if (repair !== null && hasRepairCycle(cycle) && repairRecovered(repair)) {
    return { work: ref.work, dir: ref.dir, state: "repair-recovered", pr };
  }

  // The worker just opened the PR (or ended the round commenting on it): the
  // ball is with the human — parked, nothing to decide.
  const last = lastPrComment(feedback);
  if (last !== null && !isAgentSpeech(last.body)) {
    return { work: ref.work, dir: ref.dir, state: "feedback", pr, createdAt: issue.createdAt };
  }
  return parked(ref);
}

// ---- the claimed work with no PR: the record decides ----

async function claimedWithoutPullRequest(
  ref: WorkRef,
  issue: TicketSnapshot,
  facts: WorkFacts,
  policy: DecisionPolicy,
): Promise<WorkStateReading> {
  if (!issue.labels.includes(policy.labels.claimed)) return parked(ref);

  const snapshot = await readableRecord(facts);
  if (snapshot === null) return parked(ref);

  // A pending reconciliation holds the claim: releasing it would hand the work
  // back to the pool while its publication is still unknown (issue 112).
  if (snapshot.repair.attempt !== null && hasPendingReconciliation(snapshot.repair.attempt)) return parked(ref);

  const unreconciled = await unreconciledAttempt(ref, facts, policy, snapshot);
  // Only an interruption can be a model provider failure: the attempt's own
  // stream decides it (issue 144) — a written outcome or a bare reservation
  // never reads the model provider ledger.
  if (unreconciled.state === "interrupted") {
    const providerFailure = await modelProviderFailureOf(ref, issue, facts, policy, snapshot, unreconciled.attempt);
    if (providerFailure !== null) return providerFailure;
  }
  return unreconciled;
}

/**
 * The claimed work whose attempt the factory did not settle (ticket 05 Q3; 123):
 * the record decides which question is being asked.
 *
 *  - a confirmed Outcome prevails over the interpretation of the stop (#146);
 *  - a self-report whose label never landed is reserved, never recovered;
 *  - a written failure is ruled as at collection;
 *  - the persisted stop of THIS attempt is neither an interruption nor a fall;
 *  - otherwise the attempt was interrupted: the recovery budget decides, and a
 *    claim with zero attempt evidence is attempt 1. Inside this process's
 *    in-flight set the claim is a legitimate launch between the claim and the
 *    worker's first write — held, never recovered behind its back.
 */
async function unreconciledAttempt(
  ref: WorkRef,
  facts: WorkFacts,
  policy: DecisionPolicy,
  snapshot: WorkRecordSnapshot,
): Promise<WorkStateReading> {
  const lastAttempt = snapshot.attempt ?? 0;
  const current = lastAttempt === 0 ? 1 : lastAttempt;
  const outcome = snapshot.outcome;

  if (selfReportedBlocked(outcome, lastAttempt)) return parked(ref);

  const written = ownWrittenOutcome(outcome, lastAttempt);
  if (written !== null) return unreconciledFailure(ref, facts, lastAttempt, outcome, snapshot);

  const claim = operatorStopClaim(snapshot.recovery, { lastAttempt: current, outcome });
  if (claim.kind === "requested") return { work: ref.work, dir: ref.dir, state: "stop-resume", attempt: claim.attempt };
  if (claim.kind === "unconfirmed") {
    return { work: ref.work, dir: ref.dir, state: "stop-unconfirmed", attempt: claim.attempt, because: claim.because };
  }

  if (lastAttempt === 0) {
    if (policy.inFlight.has(workKeyOf(ref.work))) return parked(ref);
    if (snapshot.pause !== null) {
      return { work: ref.work, dir: ref.dir, state: "continuity-paused", attempt: 1, pause: snapshot.pause };
    }
    return interrupted(ref, facts, 1);
  }

  if (snapshot.pause !== null) {
    return { work: ref.work, dir: ref.dir, state: "continuity-paused", attempt: lastAttempt, pause: snapshot.pause };
  }
  return interrupted(ref, facts, lastAttempt);
}

/**
 * The ruler for a written outcome the factory never applied: the attempt is
 * consumed and the ruler applies as at collection — the 2nd consecutive fall
 * blocks, otherwise the 1st releases. The consecutiveness fact is the attempt
 * NUMBER of the last fall, never the last stop: an interruption of the current
 * attempt must not erase the fall of the one before it.
 */
async function unreconciledFailure(
  ref: WorkRef,
  facts: WorkFacts,
  attempt: number,
  record: OutcomeRecord | null,
  snapshot: WorkRecordSnapshot,
): Promise<WorkStateReading> {
  const previousWasFall = snapshot.recovery.lastFallAttempt === attempt - 1;
  if (!previousWasFall) return { work: ref.work, dir: ref.dir, state: "fall", decision: "release", attempt };
  return {
    work: ref.work,
    dir: ref.dir,
    state: "fall",
    decision: "block",
    attempt,
    comment: await facts.fallenAttemptComment(record, attempt),
  };
}

// ---- the repair pieces: the trigger, the two blocks, the recovery ----

/** A check only reacts when it concluded, and failed or timed out — never
 *  pending, cancelled, skipped, neutral or an optional one. */
function isFailingRequiredCheck(check: RequiredCheckResult): boolean {
  return check.status === "completed" && (check.conclusion === "failure" || check.conclusion === "timed_out");
}

/** The trigger of an open PR, or null when nothing is confirmed. */
function confirmedTrigger(facts: PrRepairFacts): RepairTrigger | null {
  const reasons: RepairReason[] = [];
  if (facts.mergeState === "conflicting") reasons.push("conflicts");
  const failingChecks = (facts.requiredChecks ?? []).filter(isFailingRequiredCheck);
  if (failingChecks.length > 0) reasons.push("required-checks");
  if (reasons.length === 0) return null;
  return { reasons, facts, failingChecks };
}

/** Confirmed recovery (story 22): no conflicts and every required check
 *  approved — narrower than an obsolete premise, which also holds for pending,
 *  neutral or skipped checks. The required set must be KNOWN: the empty set a
 *  repository without CI declares is a confirmation; null is never one. */
function repairRecovered(facts: PrRepairFacts): boolean {
  if (facts.mergeState !== "mergeable") return false;
  const checks = facts.requiredChecks;
  if (checks === null) return false;
  return checks.every((check) => check.conclusion === "success");
}

/** The block after the automatic rounds, naming what persists. */
function repairBlock(
  ref: WorkRef,
  pr: PullRequestRecord,
  trigger: RepairTrigger,
  usedRounds: number,
): WorkStateReading {
  const comment =
    `automatic repair stopped after ${usedRounds} rounds without recovering PR #${pr.number}: ` +
    `${repairReasonsPhrase(trigger)} persist on the current HEAD. A human decision, authorization or fix is needed.`;
  return { work: ref.work, dir: ref.dir, state: "repair-blocked", pr, trigger, usedRounds, comment };
}

/** The persisting impediments, in the operator's words. */
function repairReasonsPhrase(trigger: RepairTrigger): string {
  return trigger.reasons
    .map((reason) => (reason === "conflicts" ? "the conflict with the base" : "the failing required checks"))
    .join(" and ");
}

/** The block of a Repair that stopped without publishing (issue 112): the
 *  attempt that fell, its abrupt end and the evidence paths are named by the
 *  comment; the local work is never touched. */
async function unpublishedRepairBlock(
  ref: WorkRef,
  pr: PullRequestRecord,
  cycle: RepairCycle,
  snapshot: WorkRecordSnapshot,
  attempt: RepairAttempt,
  cause: "consecutive-falls" | "concurrent-change",
  facts: WorkFacts,
): Promise<WorkStateReading> {
  const comment = await facts.unpublishedRepairComment({
    cause,
    prNumber: pr.number,
    consecutiveFalls: cycle.consecutiveFalls,
    attempt,
    record: snapshot.outcome,
  });
  return { work: ref.work, dir: ref.dir, state: "repair-fall-blocked", pr, comment, attempt: attempt.attempt };
}

// ---- the small pieces the ladder shares ----

function parked(ref: WorkRef): WorkStateReading {
  return { work: ref.work, dir: ref.dir, state: "parked" };
}

function unreadable(ref: WorkRef, because: string): WorkStateReading {
  return { work: ref.work, dir: ref.dir, state: "unreadable", because };
}

/**
 * The record, or null when the factory could not read it. The read before a
 * launch holds (parked) instead of inventing a verdict out of a failed read —
 * the same rule the Work record applies to a pause it cannot read. The read
 * after an attempt answers with the record it could not see, because that is
 * what the collection ruler has always done with it: no written verdict of this
 * attempt (`readOutcomeRecord` answers null for absence and for garbage alike).
 */
async function readableRecord(facts: WorkFacts): Promise<WorkRecordSnapshot | null> {
  const record = await facts.record();
  return record.reading === "known" ? record.value : null;
}

async function interrupted(ref: WorkRef, facts: WorkFacts, attempt: number): Promise<WorkStateReading> {
  return { work: ref.work, dir: ref.dir, state: "interrupted", attempt, recovery: await facts.recovery(attempt) };
}

async function resumable(
  ref: WorkRef,
  issue: TicketSnapshot,
  issueReplies: IssueComment[],
  facts: WorkFacts,
): Promise<WorkStateReading> {
  const pull = await facts.pullRequest();
  // A failed PR read is not "no PR" — but the retomada's payload must carry
  // something, so it carries only what was read: the branch is the worker's,
  // and the launch path re-reads the PR anyway.
  const pr = pull.reading === "with-pull-request" ? pull.pr : null;
  return { work: ref.work, dir: ref.dir, state: "resumable", pr, createdAt: issue.createdAt, issueReplies };
}

async function modelProviderFailureOf(
  ref: WorkRef,
  issue: TicketSnapshot,
  facts: WorkFacts,
  policy: DecisionPolicy,
  snapshot: WorkRecordSnapshot,
  attempt: number,
): Promise<WorkStateReading | null> {
  const failure = await facts.modelProviderFailure(attempt);
  if (failure === null) return null;

  const decision = modelProviderDecision(snapshot.modelProvider, policy.modelProvider, attempt, failure);
  if (decision.decision === "awaiting-model-provider") {
    // The model provider budget is exhausted: the work waits for the operator —
    // a help request, never a block. A human answer after the marker resumes it,
    // the same channel a blocked work listens to.
    const comments = await facts.comments();
    const issueReplies = comments.reading === "known" ? humanCommentsAfterLastMarker(comments.value) : NO_REPLIES;
    if (issueReplies.length > 0) return resumable(ref, issue, issueReplies, facts);
  }
  return {
    work: ref.work,
    dir: ref.dir,
    state: "model-provider-failure",
    attempt,
    failure,
    modelProvider: decision,
  };
}

/** The pause the factory keeps re-evaluating, if any (see the Work record). */
function currentPause(snapshot: WorkRecordSnapshot): { pause: PauseRecord; attempt: number } | null {
  const pause = snapshot.pause;
  if (pause === null) return null;
  return { pause, attempt: pause.attempt >= 1 ? pause.attempt : Math.max(snapshot.attempt ?? 0, 1) };
}

const NO_REPLIES: IssueComment[] = [];

// ---- the second reading: what happened to the Attempt that just ended ----

/**
 * The ladder from an ENDED Attempt to the Work state. Same facts seam, same
 * policy, same vocabulary as the read before a launch: what changes is the
 * moment, and the questions it asks — the record the attempt wrote, the stop
 * that may own its end, the PR the factory sees now.
 *
 * The rulings are the ones `classifyOutcome` makes at collection today, in the
 * same priority order, so #202 can let the loop speak this vocabulary without
 * changing a verdict.
 */
export async function deriveAfterAttempt(
  ref: WorkRef,
  end: { attempt: number; stopping: boolean },
  facts: AttemptEndFacts,
  policy: DecisionPolicy,
): Promise<WorkStateReading> {
  const ticket = await facts.ticket();
  const issue = ticket.reading === "known" ? ticket.value : null;

  // The terminal state was reached while this claim was held (ticket 14).
  if (issue !== null && issue.state === "closed") return { work: ref.work, dir: ref.dir, state: "done" };

  const pull = await facts.pullRequest();
  const pr = pull.reading === "with-pull-request" ? pull.pr : null;

  // A merged PR is delivery, whatever the attempt wrote (issue 149): the
  // terminal state reached the PR first, and the action closes the issue (the
  // linkage fallback) before archiving — the same state, and the same action,
  // the read before a launch answers for a merged PR with an open issue.
  if (pr !== null && pr.merged) {
    return { work: ref.work, dir: ref.dir, state: "done-fallback", pr, comment: fallbackDoneComment() };
  }

  // The Work record in one read. Absence, and a record the factory cannot parse,
  // are the SAME fact here, as they have always been for the collection ruler:
  // no verdict of this attempt was written. What names an attempt comes out of
  // it — its own outcome, the fall the ledger counted for the previous one, and
  // what ended its own turn.
  const written = await readableRecord(facts);
  const record = written?.outcome ?? null;
  const own = ownOutcomeRecord(record, end.attempt);

  // The stop that may own this END (issue #146). A confirmed Outcome prevails
  // over the interpretation of the stop, so this is asked only while the
  // attempt wrote no record at all: the operator's requested stop — the one
  // this process is carrying out, or the evidence a previous one left on the
  // attempt — resumes the same attempt and spends no recovery.
  if (own === null && (end.stopping || (await facts.stopClaim(end.attempt)).kind !== "none")) {
    return {
      work: ref.work,
      dir: ref.dir,
      state: "stop-resume",
      attempt: end.attempt,
      because: end.stopping ? "stop-in-progress" : "stop-recorded",
    };
  }

  // Classes 1 and 5: an open PR keeps the work reserved for the human. No fall
  // is ever recorded over it, and the claim is held.
  if (pr !== null && pr.state === "open") return { work: ref.work, dir: ref.dir, state: "parked", because: "pr-open" };

  // Class 6: the worker posted the marker and the label itself. The factory only
  // RECORDS it — no release, no fall, no comment of its own. Both structured
  // facts speak (the label, or the record's own class), and only for THIS
  // attempt: desfecho.json survives between attempts.
  const selfReported =
    (issue !== null && issue.labels.includes(policy.labels.blocked)) || selfReportedBlocked(record, end.attempt);
  if (selfReported) {
    return { work: ref.work, dir: ref.dir, state: "parked", because: "blocked-self-report" };
  }

  // A PR closed without merge is the fact the collection vocabulary had no word
  // for (epic #198): the Work state has one — the same `rejected` the read
  // before a launch gives it — and NOBODY executes it yet (#203 wires the
  // block). Until then this arm merely names the fact, and the loop keeps
  // answering with `classifyOutcome` exactly as before.
  if (pr !== null && pr.state === "closed" && !pr.merged) {
    return { work: ref.work, dir: ref.dir, state: "rejected", pr, comment: rejectionComment(pr) };
  }

  // No record of its OWN: an INTERRUPTION, not a failure (issue 123). The
  // attempt keeps its number and no failure is recorded; what ended its own
  // turn decides which of the two vocabularies answers it.
  if (own === null) return interruption(ref, end.attempt, facts, written, policy);

  // A written failure/abandon without a PR: the fall ruler applies, exactly as
  // it does at collection. Its consecutiveness fact is the record's own ledger
  // — the highest attempt that ended in a WRITTEN failure — so a crash, an
  // interruption or another process's memory can never make a fall "second".
  const previousFell = (await facts.lastFallAttempt()) === end.attempt - 1;
  if (!previousFell) return { work: ref.work, dir: ref.dir, state: "fall", decision: "release", attempt: end.attempt };
  return {
    work: ref.work,
    dir: ref.dir,
    state: "fall",
    decision: "block",
    attempt: end.attempt,
    comment: await facts.fallenAttemptComment(record, end.attempt),
  };
}

/**
 * An attempt that ended without an outcome record. Two very different things
 * look alike here, and only the attempt's own stream tells them apart
 * (issue 144): the agent was interrupted — the recovery budget absorbs it and
 * the same attempt continues — or its turn ended in a model provider error,
 * which retries on its OWN budget and never touches the recovery one.
 *
 * The provider budget's answer is CARRIED, not acted on: settling it (the wait,
 * the persisted consumption, the exhausted budget's help request) belongs to the
 * retry launch, which is where the collection path has always settled it.
 */
async function interruption(
  ref: WorkRef,
  attempt: number,
  facts: AttemptEndFacts,
  written: WorkRecordSnapshot | null,
  policy: DecisionPolicy,
): Promise<WorkStateReading> {
  const failure = await facts.modelProviderFailure(attempt);
  if (failure !== null) {
    return {
      work: ref.work,
      dir: ref.dir,
      state: "model-provider-failure",
      attempt,
      failure,
      modelProvider: modelProviderDecision(
        written?.modelProvider ?? emptyModelProviderLedger(),
        policy.modelProvider,
        attempt,
        failure,
      ),
    };
  }
  return {
    work: ref.work,
    dir: ref.dir,
    state: "interrupted",
    attempt,
    recovery: await facts.recovery(attempt),
  };
}
