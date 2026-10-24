/**
 * The harness's GitHub Issues model.
 *
 * It models ONLY the operations the candidates use — issue comments, labels,
 * assignment, conversation lock — and two environmental facts the protocol
 * must not assume away:
 *
 *  - A write has no conditional form. There is no compare-and-set: every
 *    operation is a blind append/replace (the documented API; see the report's
 *    primary sources).
 *  - A read may return an older projection of the applied writes. The docs
 *    promise neither read-your-writes nor that a comments listing contains
 *    every applied comment. The harness therefore lets the experiment choose
 *    the projection per read: `all` (the strongest, a premise), a `prefix` of
 *    the applied history (monotone visibility, also a premise), or an
 *    arbitrary `omit` set (the weakest admission: no documented guarantee
 *    excludes it).
 *
 * A comment id is assigned when the write is applied. Its order relative to
 * the other applied comment is an explicit environment choice (`apply` or
 * `reverse`): GitHub documents that a comments listing is ordered by ascending
 * id, but NOT that ids are assigned in the order the concurrent requests are
 * applied. The protocol's safety must not silently assume that order.
 *
 * What the model does NOT do: it never invents a conditional write, a queue,
 * a lease, or a winner oracle. The only facts a factory can observe are the
 * snapshots this class returns.
 */

import type { TicketIdentity } from "./identity.js";

export interface ProviderComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
}

export interface IssueSnapshot {
  readonly ticket: TicketIdentity;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Ascending by id, like the documented comments listing. */
  readonly comments: readonly ProviderComment[];
  readonly locked: boolean;
}

export type Mutation =
  | { readonly kind: "comment"; readonly author: string; readonly body: string }
  | { readonly kind: "add-label"; readonly label: string }
  | { readonly kind: "remove-label"; readonly label: string }
  | { readonly kind: "add-assignee"; readonly login: string }
  | { readonly kind: "lock" }
  | { readonly kind: "delete-comment"; readonly commentId: number };

export type ReadView =
  | { readonly kind: "all" }
  | { readonly kind: "prefix"; readonly upto: number }
  | { readonly kind: "omit"; readonly indices: readonly number[] };

export type CommentIdOrder = "apply" | "reverse";

export interface SeedIssue {
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly comments?: readonly ProviderComment[];
  readonly locked?: boolean;
}

interface AppliedMutation {
  readonly mutation: Mutation;
  readonly commentId: number | null;
}

interface ReplayState {
  labels: string[];
  assignees: string[];
  comments: ProviderComment[];
  locked: boolean;
}

export class SimTracker {
  private readonly history: AppliedMutation[] = [];
  private appliedComments = 0;

  constructor(
    readonly ticket: TicketIdentity,
    private readonly seed: SeedIssue = {},
    private readonly idOrder: CommentIdOrder = "apply",
  ) {}

  /** How many writes have been applied; a read view refers to this history. */
  get appliedCount(): number {
    return this.history.length;
  }

  /**
   * Apply one request atomically. A multi-field candidate is expressed as
   * several requests, so a partially applied Claim is representable — as it is
   * in the real API.
   */
  apply(mutation: Mutation): void {
    let commentId: number | null = null;
    if (mutation.kind === "comment") {
      commentId =
        this.idOrder === "apply" ? 100 + this.appliedComments : 1_000_000 - this.appliedComments * 10;
      this.appliedComments += 1;
    }
    this.history.push({ mutation, commentId });
  }

  read(view: ReadView = { kind: "all" }): IssueSnapshot {
    const included = this.includedIndices(view);
    const state: ReplayState = {
      labels: [...(this.seed.labels ?? [])],
      assignees: [...(this.seed.assignees ?? [])],
      comments: [...(this.seed.comments ?? [])],
      locked: this.seed.locked ?? false,
    };
    for (const index of included) {
      const entry = this.history[index];
      if (entry === undefined) throw new Error(`read view names an unapplied write: ${index}`);
      this.replay(state, entry);
    }
    return {
      ticket: this.ticket,
      labels: state.labels,
      assignees: state.assignees,
      comments: [...state.comments].sort((left, right) => left.id - right.id),
      locked: state.locked,
    };
  }

  /** The full applied state, for the harness/operator — never for a factory. */
  snapshot(): IssueSnapshot {
    return this.read({ kind: "all" });
  }

  private includedIndices(view: ReadView): number[] {
    if (view.kind === "all") return this.history.map((_, index) => index);
    if (view.kind === "prefix") {
      if (!Number.isInteger(view.upto) || view.upto < 0 || view.upto > this.history.length) {
        throw new Error(`read view prefix out of range: ${view.upto}`);
      }
      return this.history.slice(0, view.upto).map((_, index) => index);
    }
    const omitted = new Set(view.indices);
    return this.history.map((_, index) => index).filter((index) => !omitted.has(index));
  }

  private replay(state: ReplayState, entry: AppliedMutation): void {
    const mutation = entry.mutation;
    switch (mutation.kind) {
      case "comment": {
        if (entry.commentId === null) throw new Error("comment without an assigned id");
        state.comments.push({ id: entry.commentId, author: mutation.author, body: mutation.body });
        return;
      }
      case "add-label": {
        if (!state.labels.includes(mutation.label)) state.labels.push(mutation.label);
        return;
      }
      case "remove-label": {
        state.labels = state.labels.filter((label) => label !== mutation.label);
        return;
      }
      case "add-assignee": {
        if (!state.assignees.includes(mutation.login)) state.assignees.push(mutation.login);
        return;
      }
      case "lock": {
        state.locked = true;
        return;
      }
      case "delete-comment": {
        state.comments = state.comments.filter((comment) => comment.id !== mutation.commentId);
        return;
      }
      default: {
        const exhaustive: never = mutation;
        throw new Error(`unknown mutation: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
