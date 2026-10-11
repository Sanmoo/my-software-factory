import type { PrRef } from "../core/result.js";
import type { Comment, Known } from "../tracker/port.js";

// Pull request port (R08, R11). The factory only reads PRs: it validates a "PR pronto"
// result and polls CI, review and merge. The port has no merge operation (R11, CA13).
// The MVP has a single adapter, for github.com (R11).

export type PrState = "open" | "closed" | "merged";
export type CheckState = "pending" | "passing" | "failing" | "none";
export type ReviewState = "none" | "pending" | "approved" | "changes-requested";
// Whether the PR conflicts with its base branch (R10). Unknown while GitHub has not computed it.
export type Mergeability = "mergeable" | "conflicting";

export interface PrSnapshot {
  ref: PrRef;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  // The commits the PR was read at. A conflict is identified by this pair (R10).
  headSha: string;
  baseSha: string;
  mergeable: Known<Mergeability>;
  checks: Known<CheckState>;
  review: Known<ReviewState>;
}

// `not-found` is a definitive answer. Any other failure is thrown, never read as absence.
export type PrLookup = { status: "found"; pr: PrSnapshot } | { status: "not-found" };

// Feedback on a PR (R10, CA12): human reviews and conversation comments, and the checks of the
// head commit with the branch protection's required flag. Each item keeps its identity so the
// job can record what it already consumed.
export interface PrComment extends Comment {
  kind: "review" | "comment";
}

export interface PrCheck {
  id: string;
  name: string;
  state: Known<CheckState>;
  required: Known<boolean>;
}

export interface PrFeedback {
  comments: PrComment[];
  checks: PrCheck[];
}

export interface PrPort {
  readPr(ref: PrRef): Promise<PrLookup>;
  // Reads only; throws when GitHub cannot answer. Called for a PR already confirmed as open.
  readFeedback(ref: PrRef): Promise<PrFeedback>;
}
