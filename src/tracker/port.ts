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

// The adapter only writes: it reports the operations it asked the vendor for, never their
// result (ADR 0001). A graded change is core output, produced by comparing the snapshot before
// the write with the reread; an adapter never says "confirmed".
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

// One write an adapter asked the vendor for, without any result: what it did, not what it
// wished. A transition names the categories that count as reached (claim: in-progress; done:
// done). The core grades every intent against the snapshots it read itself.
export interface Intent {
  operation: ChangeOperation;
  // The label, account or transition concerned.
  target?: string;
  // For "transição"/"fechar": the status categories that count as the change having happened.
  // Defaults to ["done"].
  reaches?: StatusCategory[];
}

// What a write returned: the concrete operations it made, or a refusal for what is impossible in
// the vendor (for example a transition the Jira workflow does not offer). Preconditions the core
// can decide from a snapshot are not here.
export interface WriteMade {
  made: Intent[];
}

export interface WriteRefused {
  refused: string;
}

export type WriteOutcome = WriteMade | WriteRefused;

// A composite write that failed midway: the writes already made are reported with the error, so
// a partial success is never hidden behind the failure of the next step.
export class PartialWriteError extends Error {
  constructor(message: string, readonly made: Intent[]) {
    super(message);
  }
}

// What the factory's claim leaves on an issue, already normalized: the labels and the accounts
// whose presence marks the claim as the factory's. A release is confirmed when none is left,
// whatever else keeps the issue claimed (status, other people's assignments).
export interface ClaimMark {
  labels: string[];
  assignees: string[];
}

export interface TrackerPort {
  // The mark the factory's claim leaves on this issue's tracker (the routed port answers per issue).
  claimMarkOf(ref: IssueRef): ClaimMark;
  // Ready-for-agent issues in scope, paginated by the adapter.
  discoverCandidates(scope: TrackerScope): Promise<IssueRef[]>;
  readIssue(ref: IssueRef): Promise<IssueSnapshot>;
  // Registers claim + start; the caller must confirm via readIssue before running any agent.
  claim(ref: IssueRef): Promise<WriteOutcome>;
  // Removes the claim mark only; never marks done. Reports the intents it made.
  releaseClaim(ref: IssueRef): Promise<WriteOutcome>;
  readComments(ref: IssueRef): Promise<Comment[]>;
  // The core prefixes the marker; adapters never strip it. Returns the comment id.
  postComment(ref: IssueRef, body: string): Promise<string>;
  // Marks the issue done; the core confirms via readIssue, and already-done is core knowledge.
  markDone(ref: IssueRef): Promise<WriteOutcome>;
}

export function refKey(ref: IssueRef): string {
  return `${ref.tracker}:${ref.project}#${ref.id}`;
}
