import type { PrRef } from "../core/result.js";
import type { Known } from "../tracker/port.js";

// Pull request port (R08, R11). The factory only reads PRs: it validates a "PR pronto"
// result and polls CI, review and merge. The port has no merge operation (R11, CA13).
// The MVP has a single adapter, for github.com (R11).

export type PrState = "open" | "closed" | "merged";
export type CheckState = "pending" | "passing" | "failing" | "none";
export type ReviewState = "none" | "pending" | "approved" | "changes-requested";

export interface PrSnapshot {
  ref: PrRef;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  checks: Known<CheckState>;
  review: Known<ReviewState>;
}

// `not-found` is a definitive answer. Any other failure is thrown, never read as absence.
export type PrLookup = { status: "found"; pr: PrSnapshot } | { status: "not-found" };

export interface PrPort {
  readPr(ref: PrRef): Promise<PrLookup>;
}
