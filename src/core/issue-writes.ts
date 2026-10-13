import type { ClaimMark, Intent, IssueChange, IssueRef, IssueSnapshot, Known, TrackerPort } from "../tracker/port.js";
import { PartialWriteError } from "../tracker/port.js";
import { issueChangeEvent, issueWriteAttempt, issueWriteFailure, type IssueWriteContext } from "./ops-events.js";
import { noopObserver, type FieldValue, type Observer } from "./observability.js";
import { messageOf } from "./values.js";

// The one owner of the "write, reread, confirm" sequence for the orchestrator's writes on an
// issue (ADR 0001). A single implementation covers both the normal path and the reconciliation
// after a write error: the reread is what confirms an alteration, never the adapter's report.
//
// The adapter only writes and reports the intents it made. Everything the core can decide from a
// normalized snapshot -- an issue already claimed, a claim that cannot be read, an issue already
// done, an unreadable status -- is decided here, before the write.

export type StartDecision =
  | { status: "accepted" }
  | { status: "refused"; reason: string }
  | { status: "retry"; reason: string }
  | { status: "intervention"; reason: string; kind: StartIntervention };

// Why the start was not accepted: the claim write's outcome is uncertain (the write errored), or
// the write was accepted but the reread does not confirm the claim and the doing state. The
// caller reports the second as a poll error, since the issue was written to without a start.
export type StartIntervention = "uncertain-write" | "unconfirmed-start";

export type ReleaseDecision =
  | { status: "released" }
  | { status: "not-confirmed"; reason: string };

export type CompletionDecision =
  | { status: "done" }
  | { status: "pending"; reason: string };

// What the caller knows about the write: the job it belongs to, why it is made and the evidence.
// The ref, the origin and the abstract operation are the module's own.
export interface IssueWritesContext {
  job?: string;
  invocation?: string;
  reason: string;
  refs?: Record<string, FieldValue>;
}

// The orchestrator's writes on an issue, as named in the log.
type IssueWriteOperation = "claim" | "release" | "done";

// The claim and the doing state the reread does not show: the issue was written to but the start
// is not confirmed, so an operator decides what happens next.
const UNRESOLVED_START = "início não confirmado pelo tracker: claim e doing não estão visíveis";

const CLAIM_WRITE_ERROR_UNREADABLE = "erro de escrita no claim e estado externo ilegível";
const CLAIM_WRITE_ERROR_CLAIMED = "erro de escrita no claim; tracker mostra claim com origem não comprovada: não iniciar";
const CLAIM_WRITE_ERROR_EMPTY = "erro de escrita no claim; nada registrado no tracker, nova tentativa no próximo polling";
const CLAIM_WRITE_ERROR_UNKNOWN = "erro de escrita no claim e estado externo desconhecido";

// No snapshot means nothing could be read: no precondition can be decided and nothing is
// confirmed by it. The caller decides whether to retry (write) or wait (release, done).
const BEFORE_UNREADABLE = "estado externo ilegível antes da escrita";
const REREAD_UNAVAILABLE = "releitura indisponível";
const DONE_NOT_SHOWN = "releitura não mostra done";
const CONFIRMED_AFTER_WRITE_ERROR = "confirmada por releitura após erro de escrita";

// Which snapshot field each intent concerns, and the state the write intends to leave it in.
const FIELD_OF: Partial<Record<Intent["operation"], { field: "labels" | "assignees"; expected: boolean }>> = {
  "adicionar-label": { field: "labels", expected: true },
  "remover-label": { field: "labels", expected: false },
  "atribuir": { field: "assignees", expected: true },
  "remover-atribuição": { field: "assignees", expected: false },
};

const presentIn = (known: Known<string[]> | undefined, target: string): boolean | undefined => {
  if (known === undefined || !known.known) return undefined;
  return known.value.includes(target);
};

const stateOf = (present: boolean): string => (present ? "presente" : "ausente");

const withoutTarget = (intent: Intent): IssueChange => ({
  operation: intent.operation,
  ...(intent.target === undefined ? {} : { target: intent.target }),
  // Replaced by the grading below; an intent alone is never more than an attempt.
  result: "attempted",
});

// Grades one intent against the snapshot read before the write and the reread, with no I/O and no
// events: the adapter reports the attempt, this function says what the tracker shows. A missing
// before or after leaves the change unconfirmed -- an attempt is all that can be said without it.
export function gradeChange(intent: Intent, before?: IssueSnapshot, after?: IssueSnapshot): IssueChange {
  const field = FIELD_OF[intent.operation];
  if (field !== undefined) {
    const target = intent.target ?? "";
    const beforeState = before === undefined ? undefined : presentIn(before[field.field], target);
    const afterState = after === undefined ? undefined : presentIn(after[field.field], target);
    const change = withoutTarget(intent);
    if (beforeState !== undefined) change.before = stateOf(beforeState);
    if (afterState !== undefined) change.after = stateOf(afterState);
    change.result = beforeState === undefined || afterState === undefined
      ? "attempted"
      : afterState !== field.expected
        ? "attempted"
        : beforeState === field.expected ? "unchanged" : "confirmed";
    return change;
  }
  if (intent.operation === "transição" || intent.operation === "fechar") {
    // A transition is confirmed when the reread shows one of the categories it reaches.
    const reaches = intent.reaches ?? ["done"];
    const beforeState = before?.statusCategory.known ? before.statusCategory.value : undefined;
    const afterState = after?.statusCategory.known ? after.statusCategory.value : undefined;
    const change = withoutTarget(intent);
    if (beforeState !== undefined) change.before = beforeState;
    if (afterState !== undefined) change.after = afterState;
    const reached = afterState !== undefined && reaches.includes(afterState);
    const already = beforeState !== undefined && reaches.includes(beforeState);
    change.result = beforeState === undefined || afterState === undefined
      ? "attempted"
      : reached ? (already ? "unchanged" : "confirmed") : "attempted";
    return change;
  }
  // A comment leaves no snapshot evidence: one attempt, never a confirmation.
  return withoutTarget(intent);
}

// A release the reread does not confirm, with the cause the operator reads.
const notConfirmedRelease = (reason: string): ReleaseDecision => ({
  status: "not-confirmed",
  reason: `liberação não confirmada pelo tracker: ${reason}`,
});

export class IssueWrites {
  private readonly obs: Observer;
  private readonly tracker: TrackerPort;

  constructor(tracker: TrackerPort, observer?: Observer) {
    this.tracker = tracker;
    this.obs = observer ?? noopObserver;
  }

  async start(ref: IssueRef, context: IssueWritesContext): Promise<StartDecision> {
    const write = this.writeContext(ref, "claim", context);
    const before = await this.reread(ref);
    // Preconditions decided from the previous read: a claim is never taken twice, and an
    // unreadable claim is never presumed absent.
    if (before === undefined) return { status: "retry", reason: BEFORE_UNREADABLE };
    if (!before.claimed.known) return { status: "refused", reason: `claim não lido: ${before.claimed.reason}` };
    if (before.claimed.value) return { status: "refused", reason: "issue já claimed" };
    // A closed issue is not claimed again, whatever its assignees and labels show.
    if (before.statusCategory.known && before.statusCategory.value === "done") {
      return { status: "refused", reason: "issue já concluída" };
    }

    let made: Intent[];
    try {
      const outcome = await this.writeIssue(write, () => this.tracker.claim(ref), before);
      if ("refused" in outcome) return { status: "refused", reason: outcome.refused };
      made = outcome.made;
    } catch {
      return this.reconcileClaimError(ref);
    }
    const after = await this.reread(ref);
    this.reportIntents(write, made, before, after);
    const started = after !== undefined
      && after.claimed.known && after.claimed.value
      && after.statusCategory.known && after.statusCategory.value === "in-progress";
    return started ? { status: "accepted" } : { status: "intervention", reason: UNRESOLVED_START, kind: "unconfirmed-start" };
  }

  async release(ref: IssueRef, context: IssueWritesContext): Promise<ReleaseDecision> {
    const write = this.writeContext(ref, "release", context);
    const mark = this.tracker.claimMarkOf(ref);
    const before = await this.reread(ref);
    if (before === undefined) return notConfirmedRelease(REREAD_UNAVAILABLE);
    let made: Intent[];
    let after: IssueSnapshot | undefined;
    try {
      const outcome = await this.writeIssue(write, () => this.tracker.releaseClaim(ref), before);
      if ("refused" in outcome) return notConfirmedRelease(outcome.refused);
      made = outcome.made;
      after = await this.reread(ref);
    } catch (error) {
      after = await this.reread(ref);
      if (!markGone(after, mark)) return notConfirmedRelease(messageOf(error));
      // The write failed or its answer was lost, and the reread shows the mark gone: the uncertainty
      // is resolved by evidence, not by assumption. Each part of the mark is a confirmed change.
      this.reportIntents(write, intentsOfMark(mark), before, after, CONFIRMED_AFTER_WRITE_ERROR);
      return { status: "released" };
    }
    // The reread decides what each intent was: an accepted call alone is only an attempt.
    this.reportIntents(write, made, before, after);
    if (!markGone(after, mark)) {
      return notConfirmedRelease(after === undefined ? REREAD_UNAVAILABLE : "claim ainda visível na releitura");
    }
    return { status: "released" };
  }

  async complete(ref: IssueRef, context: IssueWritesContext): Promise<CompletionDecision> {
    const write = this.writeContext(ref, "done", context);
    const before = await this.reread(ref);
    if (before === undefined) return { status: "pending", reason: REREAD_UNAVAILABLE };
    // An unreadable category proves nothing: the reason the tracker gave is the decision's reason.
    if (!before.statusCategory.known) return { status: "pending", reason: before.statusCategory.reason };
    if (before.statusCategory.value === "done") {
      // Already done: nothing is written and the change says so.
      this.obs.emit(issueChangeEvent(write, gradeChange({ operation: "fechar" }, before, before)));
      return { status: "done" };
    }
    let made: Intent[];
    try {
      const outcome = await this.writeIssue(write, () => this.tracker.markDone(ref), before);
      if ("refused" in outcome) return { status: "pending", reason: outcome.refused };
      made = outcome.made;
    } catch (error) {
      return { status: "pending", reason: messageOf(error) };
    }
    // The reread is the evidence: an adapter that only attempted the write is confirmed by it.
    // A reread that fails keeps the job pending with the failure as its reason.
    const after = await this.reread(ref);
    this.reportIntents(write, made, before, after);
    const confirmed = after !== undefined && after.statusCategory.known && after.statusCategory.value === "done";
    return confirmed ? { status: "done" } : { status: "pending", reason: DONE_NOT_SHOWN };
  }

  // After a claim write error the external state is reread before anything else (P02): a claim
  // the reread shows is never re-claimed, and one the reread shows absent may be retried.
  private async reconcileClaimError(ref: IssueRef): Promise<StartDecision> {
    const snapshot = await this.reread(ref);
    if (snapshot === undefined) return { status: "intervention", reason: CLAIM_WRITE_ERROR_UNREADABLE, kind: "uncertain-write" };
    if (snapshot.claimed.known && snapshot.claimed.value) {
      return { status: "intervention", reason: CLAIM_WRITE_ERROR_CLAIMED, kind: "uncertain-write" };
    }
    if (snapshot.claimed.known) return { status: "retry", reason: CLAIM_WRITE_ERROR_EMPTY };
    return { status: "intervention", reason: CLAIM_WRITE_ERROR_UNKNOWN, kind: "uncertain-write" };
  }

  private writeContext(ref: IssueRef, operation: IssueWriteOperation, context: IssueWritesContext): IssueWriteContext {
    return { ...context, ref, origin: "orquestrador", operation };
  }

  // A tracker write: the attempt is announced before, the intents a partial failure reported
  // after, and the failure itself last. The error travels to the caller, which knows whether the
  // sequence can continue. The intents are graded without a reread, so they stay at most attempted.
  private async writeIssue<T>(context: IssueWriteContext, write: () => Promise<T>, before: IssueSnapshot): Promise<T> {
    this.obs.emit(issueWriteAttempt(context));
    try {
      return await write();
    } catch (error) {
      if (error instanceof PartialWriteError) this.reportIntents(context, error.made, before, undefined);
      this.obs.emit(issueWriteFailure(context, messageOf(error), true));
      throw error;
    }
  }

  private reportIntents(
    context: IssueWriteContext,
    intents: readonly Intent[],
    before: IssueSnapshot | undefined,
    after: IssueSnapshot | undefined,
    detail?: string,
  ): void {
    for (const intent of intents) {
      const change = gradeChange(intent, before, after);
      this.obs.emit(issueChangeEvent(context, detail === undefined ? change : { ...change, detail }));
    }
  }

  // Rereads the issue: undefined when the reread itself fails, so nothing is confirmed by it.
  private async reread(ref: IssueRef): Promise<IssueSnapshot | undefined> {
    try {
      return await this.tracker.readIssue(ref);
    } catch {
      return undefined;
    }
  }
}

// The intents a release of this mark makes, in the order the adapter would report them. Used when
// the write errored but the reread shows the mark gone: evidence replaces the lost report.
const intentsOfMark = (mark: ClaimMark): Intent[] => [
  ...mark.labels.map((target): Intent => ({ operation: "remover-label", target })),
  ...mark.assignees.map((target): Intent => ({ operation: "remover-atribuição", target })),
];

// The reread shows the factory's claim mark gone: none of its labels or accounts is left on the
// issue. Status and other people's assignments do not matter; an unreadable field proves nothing.
const markGone = (snapshot: IssueSnapshot | undefined, mark: ClaimMark): boolean => {
  const absent = (present: Known<string[]>, marked: string[]): boolean =>
    marked.length === 0 || (present.known && !marked.some((item) => present.value.includes(item)));
  return snapshot !== undefined && absent(snapshot.labels, mark.labels) && absent(snapshot.assignees, mark.assignees);
};
