// Normalized issue tracker port. The core depends only on these shapes; vendor
// concepts (JQL, sprints, GraphQL fields, label names) stay inside adapters.
// Method names and the Known<T> rule are a contract for adapters and the core.

// Unknown metadata is never treated as absent or as false.
export type Known<T> = { known: true; value: T } | { known: false; reason: string };

export type TrackerKind = "github" | "jira" | "memory";

// Identity = tracker + project/repository + issue id.
export interface IssueRef {
  tracker: TrackerKind;
  project: string;
  id: string;
}

// The tracker-side scope a discovery runs in: a GitHub repository or Jira
// project key, plus the label that marks an issue as ready for an agent.
export interface TrackerScope {
  project: string;
  readyLabel: string;
}

export type StatusCategory = "to-do" | "in-progress" | "done";

export interface BlockerRef {
  ref: IssueRef;
  terminal: Known<boolean>;
}

export interface IssueSnapshot {
  ref: IssueRef;
  title: string;
  labels: Known<string[]>;
  assignees: Known<string[]>;
  claimed: Known<boolean>;
  blockers: Known<BlockerRef[]>;
  statusCategory: Known<StatusCategory>;
  priority: Known<number | null>;
  // The issue body (description). Optional so that adapters that do not read it say nothing;
  // an absent body is unknown, never empty.
  body?: Known<string>;
  // Jira-only metadata, populated only by the Jira adapter.
  openSprint?: Known<boolean>;
  assignee?: Known<string | null>;
}

export interface Comment {
  id: string;
  author: string;
  isBot: boolean;
  body: string;
  createdAt: string;
}

// One concrete write an adapter made (or found unnecessary) on an issue (observability,
// decisions 23 and 24). The adapter says what it did, never what it wished: `confirmed` only
// when it reread the tracker and saw the change; `attempted` when the call was accepted but not
// confirmed; `unchanged` when the tracker already had the expected state (nothing was written).
export type ChangeOperation =
  | "adicionar-label"
  | "remover-label"
  | "atribuir"
  | "remover-atribuição"
  | "transição"
  | "fechar"
  | "comentar";
export type ChangeResult = "confirmed" | "attempted" | "unchanged" | "failed";

export interface IssueChange {
  operation: ChangeOperation;
  // The label, account or transition concerned.
  target?: string;
  // Known values only: an unknown before or after is left out, never invented.
  before?: string;
  after?: string;
  result: ChangeResult;
  detail?: string;
}

// A composite write that failed midway: the writes already made are reported with the error, so
// a partial success is never hidden behind the failure of the next step.
export class PartialWriteError extends Error {
  constructor(message: string, readonly changes: IssueChange[]) {
    super(message);
  }
}

export type ClaimOutcome =
  | { status: "accepted"; changes?: IssueChange[] }
  | { status: "rejected"; reason: string; changes?: IssueChange[] };

export type DoneOutcome =
  | { status: "done" | "already-done"; changes?: IssueChange[] }
  | { status: "not-confirmed"; reason: string; changes?: IssueChange[] };

export interface ReleaseOutcome {
  changes: IssueChange[];
}

export interface TrackerPort {
  // Ready-for-agent issues in scope, paginated by the adapter.
  discoverCandidates(scope: TrackerScope): Promise<IssueRef[]>;
  readIssue(ref: IssueRef): Promise<IssueSnapshot>;
  // Registers claim + start; the caller must confirm via readIssue before running any agent.
  claim(ref: IssueRef): Promise<ClaimOutcome>;
  // Removes the claim only; never marks done. May report the concrete changes it made.
  releaseClaim(ref: IssueRef): Promise<void | ReleaseOutcome>;
  readComments(ref: IssueRef): Promise<Comment[]>;
  // The core prefixes the marker; adapters never strip it. Returns the comment id.
  postComment(ref: IssueRef, body: string): Promise<string>;
  // The adapter re-reads and confirms done; already-done counts as expected.
  markDone(ref: IssueRef): Promise<DoneOutcome>;
}

export function refKey(ref: IssueRef): string {
  return `${ref.tracker}:${ref.project}#${ref.id}`;
}
