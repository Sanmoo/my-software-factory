import {
  AGENT_MARKER,
  type Blocker,
  type Candidate,
  type IssueComment,
  type IssueRef,
  type IssueSnapshot,
  type Known,
  type OpenPrInput,
  type PrFeedback,
  type PullRequest,
  type PushBranchInput,
  type TrackerPort,
  type WriteOutcome,
  known,
  notKnown,
} from "./port.js";

/**
 * The in-memory fake tracker: the second adapter the port foresees from the
 * start (fundação #3). It feeds the state machine, derivation and launches of
 * the whole loop with deterministic scenarios — no network, no container.
 */

interface FakeComment extends IssueComment {}

interface FakePr extends PullRequest {}

export interface FakeIssueInput {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  stateReason?: "completed" | "not-planned" | null;
  labels?: string[];
  createdAt?: string;
}

export interface FakePullRequestInput {
  repo: string;
  number: number;
  headBranch?: string;
  baseBranch?: string;
  author?: string;
  state?: "open" | "closed";
  merged?: boolean;
  labels?: string[];
}

interface FakeIssue {
  ref: IssueRef;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: "completed" | "not-planned" | null;
  labels: Set<string>;
  assignees: Set<string>;
  createdAt: string;
  comments: FakeComment[];
  blockers: IssueRef[];
  pr: FakePr | null;
}

export class FakeTrackerAdapter implements TrackerPort {
  private readonly issues = new Map<string, FakeIssue>();
  private nextCommentId = 1;
  private nextPrNumber = 1;

  /** Every pushBranch performed, in order — for assertions. */
  readonly pushedBranches: PushBranchInput[] = [];

  constructor(private readonly options: { workerAccount: string }) {}

  // ---- seeding (test side of the seam; not part of the port) ----

  seedIssue(input: FakeIssueInput): void {
    const ref: IssueRef = { repo: input.repo, number: input.number };
    this.issues.set(this.key(ref), {
      ref,
      title: input.title ?? `issue #${input.number}`,
      body: input.body ?? "",
      state: input.state ?? "open",
      stateReason: input.stateReason ?? null,
      labels: new Set(input.labels ?? []),
      assignees: new Set(),
      createdAt: input.createdAt ?? "2026-01-01T00:00:00Z",
      comments: [],
      blockers: [],
      pr: null,
    });
  }

  seedPullRequest(input: FakePullRequestInput): void {
    this.seedIssue({
      repo: input.repo,
      number: input.number,
      ...(input.labels === undefined ? {} : { labels: input.labels }),
    });
    const issue = this.mustGet({ repo: input.repo, number: input.number });
    issue.pr = {
      number: input.number,
      state: input.state ?? "open",
      merged: input.merged ?? false,
      headBranch: input.headBranch ?? `agent-issue-${input.number}`,
      baseBranch: input.baseBranch ?? "main",
      author: input.author ?? this.options.workerAccount,
    };
  }

  addBlocker(ref: IssueRef, blocker: IssueRef): void {
    this.mustGet(ref).blockers.push(blocker);
  }

  /** Human (or scripted) comment on an issue — bypasses the port, no marker. */
  addComment(ref: IssueRef, author: string, body: string): void {
    this.mustGet(ref).comments.push({
      id: String(this.nextCommentId++),
      author,
      body,
      createdAt: "2026-01-01T00:00:00Z",
    });
  }

  /** Human (or scripted) comment on a PR conversation. */
  addPrComment(input: { repo: string; prNumber: number }, author: string, body: string): void {
    const pr = this.findPrByNumber(input.repo, input.prNumber);
    if (pr === null) throw new Error(`no PR #${input.prNumber} in ${input.repo}`);
    this.addComment(pr.issueRef, author, body);
  }

  // ---- the port (9 operations + rank) ----

  async listCandidates(repo: string, readyLabel: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const issue of this.issues.values()) {
      if (issue.ref.repo !== repo) continue;
      if (issue.state !== "open") continue;
      if (!issue.labels.has(readyLabel)) continue;
      if (issue.pr !== null) continue; // candidates are never PRs
      candidates.push({ ref: issue.ref, title: issue.title, createdAt: issue.createdAt });
    }
    return candidates;
  }

  async readIssue(ref: IssueRef): Promise<Known<IssueSnapshot>> {
    const issue = this.issues.get(this.key(ref));
    if (!issue) return notKnown;
    return known({
      ref: issue.ref,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      labels: [...issue.labels],
      assignees: [...issue.assignees],
      createdAt: issue.createdAt,
    });
  }

  async readBlockers(ref: IssueRef): Promise<Known<Blocker[]>> {
    const issue = this.issues.get(this.key(ref));
    if (!issue) return notKnown;
    const blockers: Blocker[] = issue.blockers.map((blockerRef) => {
      const blocker = this.issues.get(this.key(blockerRef));
      return {
        ref: blockerRef,
        state: blocker?.state ?? "open",
      };
    });
    return known(blockers);
  }

  async claim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const performed: string[] = [];
    // The swap ready→claimed is one composite write: removing the ready label
    // is what keeps a concurrent sweep from ever seeing the work again.
    if (readyLabel !== undefined && issue.labels.delete(readyLabel)) {
      performed.push(`label-${readyLabel} on ${ref.repo}#${ref.number}`);
    }
    issue.labels.add("agent-claimed");
    issue.assignees.add(account);
    performed.push(`label+agent-claimed on ${ref.repo}#${ref.number}`, `assignee ${account}`);
    return { performed };
  }

  async releaseClaim(ref: IssueRef, account: string): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const performed: string[] = [];
    if (issue.labels.delete("agent-claimed")) {
      performed.push(`label-agent-claimed on ${ref.repo}#${ref.number}`);
    }
    if (issue.assignees.delete(account)) {
      performed.push(`unassignee ${account}`);
    }
    return { performed };
  }

  async markDone(ref: IssueRef): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    issue.state = "closed";
    issue.stateReason = "completed";
    return { performed: [`close as completed ${ref.repo}#${ref.number}`] };
  }

  async comment(ref: IssueRef, body: string): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const marked = body.startsWith(AGENT_MARKER) ? body : `${AGENT_MARKER} ${body}`;
    issue.comments.push({
      id: String(this.nextCommentId++),
      author: this.options.workerAccount,
      body: marked,
      createdAt: "2026-01-01T00:00:00Z",
    });
    return { performed: [`comment on ${ref.repo}#${ref.number}`] };
  }

  async readComments(ref: IssueRef): Promise<Known<IssueComment[]>> {
    const issue = this.issues.get(this.key(ref));
    if (!issue) return notKnown;
    return known(issue.comments.map((comment) => ({ ...comment })));
  }

  async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
    const issue = this.issues.get(this.key(ref));
    if (!issue) return notKnown;
    return known({
      pr: issue.pr ? { ...issue.pr } : null,
      comments: issue.comments.map((comment) => ({ ...comment })),
      reviews: [],
    });
  }

  async openPr(input: OpenPrInput): Promise<PullRequest> {
    const ref: IssueRef = { repo: input.repo, number: input.issueNumber };
    const issue = this.mustGet(ref);
    const pr: FakePr = {
      number: this.nextPrNumber++,
      state: "open",
      merged: false,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      author: this.options.workerAccount,
    };
    issue.pr = pr;
    return { ...pr };
  }

  async pushBranch(input: PushBranchInput): Promise<WriteOutcome> {
    this.pushedBranches.push({ ...input });
    return { performed: [`push ${input.repo}:${input.branch}`] };
  }

  async rank(_ref: IssueRef): Promise<Known<number | null>> {
    // GitHub has no native priority: the honest answer is null — priority is
    // the field of the port, and age (createdAt) is the fallback.
    return known(null);
  }

  // ---- internals ----

  private key(ref: IssueRef): string {
    return `${ref.repo}#${ref.number}`;
  }

  private mustGet(ref: IssueRef): FakeIssue {
    const issue = this.issues.get(this.key(ref));
    if (!issue) throw new Error(`fake tracker: unknown issue ${this.key(ref)}`);
    return issue;
  }

  private findPrByNumber(repo: string, prNumber: number): { issueRef: IssueRef } | null {
    for (const issue of this.issues.values()) {
      if (issue.ref.repo === repo && issue.pr?.number === prNumber) {
        return { issueRef: issue.ref };
      }
    }
    return null;
  }
}

/** Seed helper free-standing for test ergonomics. */
export function seedIssue(adapter: FakeTrackerAdapter, input: FakeIssueInput): void {
  adapter.seedIssue(input);
}
