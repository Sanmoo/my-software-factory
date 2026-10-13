import type { ClaimMark, ClaimOutcome, IssueChange, IssueRef, IssueSnapshot, Known, TrackerPort } from "../tracker/port.js";
import { PartialWriteError } from "../tracker/port.js";
import { issueChangeEvent, issueWriteAttempt, issueWriteFailure, type IssueWriteContext } from "./ops-events.js";
import { noopObserver, type Observer } from "./observability.js";
import { messageOf } from "./values.js";

// The one owner of the "write, reread, grade" sequence for the orchestrator's writes on an
// issue (ADR 0001). Reading a single implementation here covers both the normal path and the
// reconciliation after a write error; the port only writes and never confirms.

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
export type IssueWritesContext = Omit<IssueWriteContext, "ref" | "origin" | "operation">;

// The claim and the doing state the reread does not show: the issue was written to but the start
// is not confirmed, so an operator decides what happens next.
const UNRESOLVED_START = "início não confirmado pelo tracker: claim e doing não estão visíveis";

const CLAIM_WRITE_ERROR_UNREADABLE = "erro de escrita no claim e estado externo ilegível";
const CLAIM_WRITE_ERROR_CLAIMED = "erro de escrita no claim; tracker mostra claim com origem não comprovada: não iniciar";
const CLAIM_WRITE_ERROR_EMPTY = "erro de escrita no claim; nada registrado no tracker, nova tentativa no próximo polling";
const CLAIM_WRITE_ERROR_UNKNOWN = "erro de escrita no claim e estado externo desconhecido";

// A removal the reread shows as done: the label is no longer on the issue, or the account is no
// longer among its assignees. Each change is judged by its own field, so a removal the reread
// cannot see, or a change without a target, stays attempted.
const removalConfirmedByReread = (change: IssueChange, snapshot: IssueSnapshot | undefined): boolean => {
  if (snapshot === undefined || change.result !== "attempted" || change.target === undefined) return false;
  if (change.operation === "remover-label") return snapshot.labels.known && !snapshot.labels.value.includes(change.target);
  if (change.operation === "remover-atribuição") return snapshot.assignees.known && !snapshot.assignees.value.includes(change.target);
  return false;
};

// The reread shows the factory's claim mark gone: none of its labels or accounts is left on the
// issue. Status and other people's assignments do not matter; an unreadable field proves nothing.
const markGone = (snapshot: IssueSnapshot | undefined, mark: ClaimMark): boolean => {
  const absent = (present: Known<string[]>, marked: string[]): boolean =>
    marked.length === 0 || (present.known && !marked.some((item) => present.value.includes(item)));
  return snapshot !== undefined && absent(snapshot.labels, mark.labels) && absent(snapshot.assignees, mark.assignees);
};

export class IssueWrites {
  private readonly obs: Observer;
  private readonly tracker: TrackerPort;

  constructor(tracker: TrackerPort, observer?: Observer) {
    this.tracker = tracker;
    this.obs = observer ?? noopObserver;
  }

  async start(ref: IssueRef, context: IssueWritesContext): Promise<StartDecision> {
    const write = this.writeContext(ref, "claim", context);
    let claimed: ClaimOutcome;
    try {
      claimed = await this.writeIssue(write, () => this.tracker.claim(ref));
    } catch {
      return this.reconcileClaimError(ref);
    }
    this.reportChanges(write, claimed.changes);
    if (claimed.status === "rejected") return { status: "refused", reason: claimed.reason };
    const snapshot = await this.reread(ref);
    const started = snapshot !== undefined
      && snapshot.claimed.known && snapshot.claimed.value
      && snapshot.statusCategory.known && snapshot.statusCategory.value === "in-progress";
    return started ? { status: "accepted" } : { status: "intervention", reason: UNRESOLVED_START, kind: "unconfirmed-start" };
  }

  async release(ref: IssueRef, context: IssueWritesContext): Promise<ReleaseDecision> {
    const write = this.writeContext(ref, "release", context);
    const mark = this.tracker.claimMarkOf(ref);
    let changes: IssueChange[] | undefined;
    let snapshot: IssueSnapshot | undefined;
    try {
      const outcome = await this.writeIssue(write, async () => this.tracker.releaseClaim(ref));
      changes = outcome?.changes;
      snapshot = await this.reread(ref);
    } catch (error) {
      snapshot = await this.reread(ref);
      if (!markGone(snapshot, mark)) {
        return { status: "not-confirmed", reason: `liberação não confirmada pelo tracker: ${messageOf(error)}` };
      }
      // The write failed or its answer was lost, and the reread shows the mark gone: the uncertainty
      // is resolved by evidence, not by assumption. Each part of the mark is a confirmed change.
      const detail = "confirmada por releitura após erro de escrita";
      for (const target of mark.labels) {
        this.obs.emit(issueChangeEvent(write, { operation: "remover-label", target, result: "confirmed", after: "ausente", detail }));
      }
      for (const target of mark.assignees) {
        this.obs.emit(issueChangeEvent(write, { operation: "remover-atribuição", target, result: "confirmed", after: "ausente", detail }));
      }
    }
    // The reread decides what each change was: an accepted call alone is only an attempt.
    this.reportChanges(write, changes?.map((change) =>
      removalConfirmedByReread(change, snapshot) ? { ...change, result: "confirmed" as const } : change));
    if (!markGone(snapshot, mark)) {
      return {
        status: "not-confirmed",
        reason: `liberação não confirmada pelo tracker: ${snapshot === undefined ? "releitura indisponível" : "claim ainda visível na releitura"}`,
      };
    }
    return { status: "released" };
  }

  async complete(ref: IssueRef, context: IssueWritesContext): Promise<CompletionDecision> {
    const write = this.writeContext(ref, "done", context);
    try {
      const outcome = await this.writeIssue(write, () => this.tracker.markDone(ref));
      if (outcome.status === "not-confirmed") {
        this.reportChanges(write, outcome.changes);
        return { status: "pending", reason: outcome.reason };
      }
      // The reread is the evidence: an adapter that only attempted the write is confirmed by it.
      // A reread that fails keeps the job pending with the failure as its reason.
      const snapshot = await this.tracker.readIssue(ref);
      const confirmed = snapshot.statusCategory.known && snapshot.statusCategory.value === "done";
      this.reportChanges(write, outcome.changes?.map((change) =>
        confirmed && change.result === "attempted" ? { ...change, result: "confirmed" as const } : change));
      return confirmed ? { status: "done" } : { status: "pending", reason: "releitura não mostra done" };
    } catch (error) {
      return { status: "pending", reason: messageOf(error) };
    }
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

  private writeContext(ref: IssueRef, operation: string, context: IssueWritesContext): IssueWriteContext {
    return {
      ref,
      origin: "orquestrador",
      operation,
      reason: context.reason,
      ...(context.job === undefined ? {} : { job: context.job }),
      ...(context.invocation === undefined ? {} : { invocation: context.invocation }),
      ...(context.refs === undefined ? {} : { refs: context.refs }),
    };
  }

  // A tracker write: the attempt is announced before, the concrete changes a partial failure
  // reported after, and the failure itself last. The error travels to the caller, which knows
  // whether the sequence can continue.
  private async writeIssue<T extends { changes?: IssueChange[] } | void>(
    context: IssueWriteContext,
    write: () => Promise<T>,
  ): Promise<T> {
    this.obs.emit(issueWriteAttempt(context));
    try {
      return await write();
    } catch (error) {
      if (error instanceof PartialWriteError) this.reportChanges(context, error.changes);
      this.obs.emit(issueWriteFailure(context, messageOf(error), true));
      throw error;
    }
  }

  private reportChanges(context: IssueWriteContext, changes: readonly IssueChange[] | undefined): void {
    for (const change of changes ?? []) this.obs.emit(issueChangeEvent(context, change));
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
