/**
 * The legacy tracker port (issue 124): the transitional shape existing
 * consumers still speak. The expanded contracts split ticket operations from
 * PR/code-host operations (`expanded-port.ts`); `legacyTrackerPort` bridges
 * this shape onto them, and the bridge is removed once consumers migrate.
 *
 * The port never speaks of `gh`, `git` or any adapter detail; the adapter never
 * speaks of works (trabalhos). A Jira ticket adapter serves the expanded
 * `TicketTracker`; GitHub serves both expanded ports. Contract from ticket
 * 02 / prior art of v1:
 *
 *  - Writes are performed by the adapter only; confirmation is always by
 *    re-reading (ADR 0001). Adapters report the intents they performed, never
 *    "confirmed". Composite writes report partial failure via PartialWriteError.
 *  - Unknown is never absent: a field not consulted does not count as "without
 *    impediment" (Known<T>).
 *  - Priority: GitHub has no native rank — the honest answer is known(null),
 *    and "eligible the longest" orders by createdAt from the same listing.
 */

import type { Labels } from "../config.js";

/** Marks everything the factory or the worker publishes; adapters never remove it. */
export const AGENT_MARKER = "<!-- msf:agent -->";

/** Agent speech carries the marker. The author is not the signal: v0.1 uses
 *  the operator account as the worker account (GitHub hides a fresh bot
 *  account), so the same login speaks on both sides. */
export function isAgentSpeech(body: string): boolean {
  return body.includes(AGENT_MARKER);
}

/** Unknown is never absent: a value not consulted is `known: false`. */
export type Known<T> = { known: true; value: T } | { known: false };

export const known = <T>(value: T): Known<T> => ({ known: true, value });
export const notKnown: Known<never> = { known: false };

export interface IssueRef {
  repo: string;
  number: number;
}

export interface IssueSnapshot {
  ref: IssueRef;
  title: string;
  body: string;
  state: "open" | "closed";
  /** "completed" = done; "not-planned" is NOT done (unknown terminal). */
  stateReason: "completed" | "not-planned" | null;
  labels: string[];
  assignees: string[];
  /** ISO 8601 creation date — age-based priority of the pool. */
  createdAt: string;
}

/** One open issue, no label semantics: the derivation decides what is a
 *  candidate, and `hasOpenPr` keeps eligibility from re-reading the issue. */
export interface OpenIssue {
  ref: IssueRef;
  title: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
  /** Linked by an OPEN PR (Closes/Fixes/Resolves #N). */
  hasOpenPr: boolean;
}

/** The neutral read's cost, pinned by the tracker contract: one issues
 *  listing, at most one open-PRs listing, no per-issue snapshot. */
export interface ReadCost {
  issueListings: number;
  pullListings: number;
  issueReads: number;
}

export interface Blocker {
  ref: IssueRef;
  state: "open" | "closed";
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headBranch: string;
  baseBranch: string;
  author: string;
}

/** PR feedback: conversation + reviews + checks/merge state, read as structured facts. */
export interface PrFeedback {
  /** The open-or-closed PR linked to the issue, or null when none exists. */
  pr: PullRequest | null;
  /** Conversation comments (issue comments on the PR). */
  comments: IssueComment[];
  /** Review comments (inline). */
  reviews: IssueComment[];
}

/**
 * The merge state of a PR as the tracker reports it. `unknown` is distinct
 * from `mergeable`: unavailable information never proves a conflict, and only
 * a confirmed conflict reactivates the worker.
 */
export type MergeState = "unknown" | "mergeable" | "conflicting";

/** A check conclusion, check-run and commit-status vocabularies merged (null = not reported). */
export type CheckConclusion =
  | "success"
  | "failure"
  | "timed_out"
  | "action_required"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "stale"
  | "pending"
  | null;

/** The result of ONE check the PR's applicable rules mark as required, on the CURRENT head. */
export interface RequiredCheckResult {
  name: string;
  /** Check-run lifecycle; null when only a commit status reported (no lifecycle). */
  status: "queued" | "in_progress" | "completed" | null;
  conclusion: CheckConclusion;
  /** Evidence a human can inspect (the check's details URL); never a secret. */
  detailsUrl?: string;
}

/** Why a confirmed impediment reactivates the worker (issue 107). */
export type RepairReason = "conflicts" | "required-checks";

/**
 * The structured merge/CI facts of a work's open PR — the only facts the
 * repair derivation reads. `headSha` is the identity that makes a check
 * result current: an old head's failures never justify a new round.
 */
export interface PrRepairFacts {
  headSha: string;
  /** The PR's current base branch (never substituted by the repo default). */
  baseBranch: string;
  baseSha: string;
  mergeState: MergeState;
  /** The checks the applicable rules require, with their current result.
   *  null = the required set could not be determined; [] = known none. */
  requiredChecks: RequiredCheckResult[] | null;
}

export interface OpenPrInput {
  repo: string;
  issueNumber: number;
  headBranch: string;
  baseBranch: string;
  title: string;
}

export interface PushBranchInput {
  repo: string;
  branch: string;
}

/** Adapters report the intents they performed — never "confirmed". */
export interface WriteOutcome {
  performed: string[];
}

/** A composite write where some intents landed and others did not. */
export class PartialWriteError extends Error {
  readonly performed: string[];

  constructor(performed: string[], reason: string) {
    super(`partial write (${performed.join(", ") || "nothing"} performed): ${reason}`);
    this.name = "PartialWriteError";
    this.performed = performed;
  }
}

/**
 * @deprecated Transitional (issue 124): new code speaks `TicketTracker` /
 * `PullRequestTracker`; existing consumers keep this shape through
 * `legacyTrackerPort` until they migrate.
 *
 * The 9 operations + rank (ticket 02, table 1), in port terms:
 *
 *   1. listOpenIssues   2. readIssue        3. readBlockers
 *   4. claim            5. releaseClaim     6. markDone
 *   7. comment          8. readComments     9. readPrFeedback / openPr / pushBranch
 *   +. rank (honest null on GitHub)
 */
export interface TrackerPort {
  /** 1. The neutral read of a repo's open issues; the derivation owns the
   *  label decisions. */
  listOpenIssues(repo: string): Promise<OpenIssue[]>;

  /** 2. Snapshot of one issue. */
  readIssue(ref: IssueRef): Promise<Known<IssueSnapshot>>;

  /** 3. Native blocked_by dependencies with each blocker's terminal state. */
  readBlockers(ref: IssueRef): Promise<Known<Blocker[]>>;

  /** 4. Claim: the reservation lands on the tracker BEFORE any launch. The
   *  claim label (the padlock) lands first and the pool label leaves last, so a
   *  neighbouring sweep excludes by the padlock's presence, never by the pool
   *  label's absence (issue 98); the reverse order once left an interrupted
   *  claim in neither the pool nor the reserved set. Only an absent label is
   *  tolerated; any other failure propagates. */
  claim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome>;

  /** 5. Release: swap claimed→ready back (the ruler's 1st fall — the work re-enters the pool) or remove only the padlock when no ready label is given. Mirrored order (issue 98): the pool label comes back first, the padlock leaves last. */
  releaseClaim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome>;

  /** 5b. Block: swap claimed→blocked on the 2nd consecutive fall (ticket 13) — the claim is held until the terminal state, so the assignee stays. The blocked label lands first, the padlock leaves last. The 3-label vocabulary travels as ONE `Labels` object (config.labels), never as loose strings. */
  blockClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome>;

  /** 5c. Resume: swap blocked→claimed on the retomada (a human answered the issue after the marker, ticket 14). The padlock returns first, the blocked mark leaves last. Same bundled `Labels`. */
  resumeClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome>;

  /** 5d. Reopen the issue's closed PR — the rejection's retomada pushes the same branch and reopens the SAME PR, never a new one (ticket 04 Q9). Tolerated when no PR exists. */
  reopenPr(ref: IssueRef): Promise<WriteOutcome>;

  /** 6. Done: close the issue as completed. */
  markDone(ref: IssueRef): Promise<WriteOutcome>;

  /** 7. Comment on the issue (the port carries the agent marker). */
  comment(ref: IssueRef, body: string): Promise<WriteOutcome>;

  /** 8. Read the issue's comments. */
  readComments(ref: IssueRef): Promise<Known<IssueComment[]>>;

  /** 9a. Read the PR feedback of the issue's work. */
  readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>>;

  /**
   * 9e. The structured merge/CI facts of the issue's open PR: the current
   *  head/base identity, mergeability and the results of the checks the
   *  rules applicable to the PR mark as required. Unknown when the PR or a
   *  fact cannot be read — unknown is never "without impediment".
   */
  readPrRepairFacts(ref: IssueRef): Promise<Known<PrRepairFacts>>;

  /** 9b. Open the PR of a work's branch. */
  openPr(input: OpenPrInput): Promise<PullRequest>;

  /** 9c. Push a work's branch (git on the GitHub adapter; a plain write here). */
  pushBranch(input: PushBranchInput): Promise<WriteOutcome>;

  /** Native rank, when the tracker has one. GitHub: known(null). */
  rank(ref: IssueRef): Promise<Known<number | null>>;
}
