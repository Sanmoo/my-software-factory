import type { PrRef } from "../core/result.js";
import type { Comment, Known } from "../tracker/port.js";

// Pull request port. The factory only reads PRs: it validates a "PR pronto"
// result and polls CI, review and merge. The port has no merge operation.
// The MVP has a single adapter, for github.com.

export type PrState = "open" | "closed" | "merged";
export type CheckState = "pending" | "passing" | "failing" | "none";
export type ReviewState = "none" | "pending" | "approved" | "changes-requested";
// Whether the PR conflicts with its base branch. Unknown while GitHub has not computed it.
export type Mergeability = "mergeable" | "conflicting";

export interface PrSnapshot {
  ref: PrRef;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  // The commits the PR was read at. A conflict is identified by this pair.
  headSha: string;
  baseSha: string;
  mergeable: Known<Mergeability>;
  checks: Known<CheckState>;
  review: Known<ReviewState>;
}

// `not-found` is a definitive answer. Any other failure is thrown, never read as absence.
export type PrLookup = { status: "found"; pr: PrSnapshot } | { status: "not-found" };

// A review thread of the diff: the file it is anchored to and whether it was resolved.
export interface PrThread {
  id: string;
  // The file the thread is anchored to.
  path: string;
  resolved: boolean;
}

// One comment of the PR. `kind` tells a conversation comment, a review body or an inline comment.
export interface PrComment extends Comment {
  // "inline" is a comment of a review thread and always carries its `thread`.
  kind: "review" | "comment" | "inline";
  thread?: PrThread;
}

export interface PrCheck {
  id: string;
  name: string;
  state: Known<CheckState>;
  required: Known<boolean>;
}

// Feedback on a PR: the unit is the comment. Conversation comments, inline comments of
// review threads and the bodies of reviews are read one by one, plus the checks of the head commit
// with the branch protection's required flag. Each item keeps its identity so the job can record
// what it already consumed. A review with an empty body is still listed (its body is empty); the
// judgement decides that it is not feedback.
export interface PrFeedback {
  comments: PrComment[];
  checks: PrCheck[];
  // Set when the read did not cover every comment (pagination limits). Items not read are not
  // absent: the judgement sends the case to the human instead of treating it as no feedback.
  incomplete?: string;
}

export interface PrPort {
  readPr(ref: PrRef): Promise<PrLookup>;
  // Reads only; throws when GitHub cannot answer. Called for a PR already confirmed as open.
  readFeedback(ref: PrRef): Promise<PrFeedback>;
}
