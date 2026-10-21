import type { Labels } from "../config.js";
import type {
  IssueComment,
  Known,
  PrRepairFacts,
  PullRequest,
  WriteOutcome,
} from "./port.js";
import type {
  PullRequestIdentity,
  RepositoryIdentity,
  TicketIdentity,
  TicketSource,
  WorkIdentity,
} from "./identity.js";

/**
 * The expanded tracker contracts (issue 124): ticket facts/mutations and
 * PR/code-host operations are separate ports. The GitHub adapter serves both
 * because GitHub owns both for its issues; a Jira ticket adapter can serve
 * `TicketTracker` without implementing any PR operation.
 */

/** What a ticket listing selects: the tracker source and the destination repo. */
export interface TicketSelection {
  source: TicketSource;
  destination: RepositoryIdentity;
}

/** One open ticket, no label semantics: the derivation decides eligibility. */
export interface OpenTicket {
  ticket: TicketIdentity;
  title: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
  /** Linked by an OPEN PR. */
  hasOpenPr: boolean;
}

export interface TicketSnapshot {
  ticket: TicketIdentity;
  title: string;
  body: string;
  state: "open" | "closed";
  /** "completed" = done; "not-planned" is NOT done (unknown terminal). */
  stateReason: "completed" | "not-planned" | null;
  labels: string[];
  assignees: string[];
  createdAt: string;
}

export interface TicketBlocker {
  ticket: TicketIdentity;
  state: "open" | "closed";
}

export interface TicketTracker {
  listOpenTickets(selection: TicketSelection): Promise<OpenTicket[]>;
  readTicket(ticket: TicketIdentity): Promise<Known<TicketSnapshot>>;
  readTicketBlockers(ticket: TicketIdentity): Promise<Known<TicketBlocker[]>>;
  claimTicket(ticket: TicketIdentity, account: string, readyLabel?: string): Promise<WriteOutcome>;
  releaseTicketClaim(ticket: TicketIdentity, account: string, readyLabel?: string): Promise<WriteOutcome>;
  blockTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome>;
  resumeTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome>;
  markTicketDone(ticket: TicketIdentity): Promise<WriteOutcome>;
  commentOnTicket(ticket: TicketIdentity, body: string): Promise<WriteOutcome>;
  readTicketComments(ticket: TicketIdentity): Promise<Known<IssueComment[]>>;
  rankTicket(ticket: TicketIdentity): Promise<Known<number | null>>;
}

/** A PR read: the Work plus the PR already associated with it, when known. */
export interface WorkPullRequest {
  work: WorkIdentity;
  /** null = no association known yet; it never asserts that no PR exists. */
  pullRequest: PullRequestIdentity | null;
}

export interface OpenPullRequestInput {
  work: WorkIdentity;
  headBranch: string;
  baseBranch: string;
  title: string;
}

export interface PushWorkBranchInput {
  destination: RepositoryIdentity;
  branch: string;
}

/** A PR carrying its explicit identity; the old shape remains a structural subset. */
export interface PullRequestRecord extends PullRequest {
  identity: PullRequestIdentity;
}

export interface ExpandedPrFeedback {
  pr: PullRequestRecord | null;
  comments: IssueComment[];
  reviews: IssueComment[];
}

export interface PullRequestTracker {
  readPullRequestFeedback(target: WorkPullRequest): Promise<Known<ExpandedPrFeedback>>;
  readPullRequestRepairFacts(target: WorkPullRequest): Promise<Known<PrRepairFacts>>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRecord>;
  reopenPullRequest(target: WorkPullRequest): Promise<WriteOutcome>;
  pushWorkBranch(input: PushWorkBranchInput): Promise<WriteOutcome>;
}
