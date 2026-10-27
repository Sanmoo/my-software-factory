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
import { pullRequestIdentity } from "./identity.js";

/**
 * The expanded tracker contracts: ticket facts/mutations and
 * PR/code-host operations are separate ports. The GitHub adapter serves both
 * because GitHub owns both for its issues; a Jira ticket adapter can serve
 * `TicketTracker` without implementing any PR operation.
 */

/** What a ticket listing selects: the tracker source and the destination repo. */
export interface TicketSelection {
  source: TicketSource;
  destination: RepositoryIdentity;
  /** Jira only: the configured JQL that selects candidates. Absent for GitHub,
   *  whose selection is the repository's own open issues. */
  jql?: string;
}

/** One open ticket, no label semantics: the derivation decides eligibility. */
export interface OpenTicket {
  ticket: TicketIdentity;
  title: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
  /** Linked by an OPEN PR. null = the source does not carry that linkage. */
  hasOpenPr: boolean | null;
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

/**
 * A tracker that can read several selections of ONE site as a single native
 * ordered result. Concatenating each selection's own order would
 * pretend independent queues are the site's Rank; only the site as a whole
 * can answer that.
 */
export interface SiteTicketTracker extends TicketTracker {
  listSiteTickets(selections: readonly TicketSelection[]): Promise<OpenTicket[]>;
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

/** The expanded record over the old PR shape; one identity, built in one place. */
export function withPullRequestIdentity(pull: PullRequest, repository: RepositoryIdentity): PullRequestRecord {
  return { ...pull, identity: pullRequestIdentity(repository, pull.number) };
}

/** The old shape, without the explicit PR identity the expanded contract adds. */
export function legacyPullRequest(record: PullRequestRecord): PullRequest {
  const { identity: _identity, ...pull } = record;
  return pull;
}
