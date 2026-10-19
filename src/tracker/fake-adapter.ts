import type { Labels } from "../config.js";
import {
  AGENT_MARKER,
  type Blocker,
  type IssueComment,
  type IssueRef,
  type IssueSnapshot,
  type Known,
  type OpenIssue,
  type OpenPrInput,
  type PrFeedback,
  type PullRequest,
  type PushBranchInput,
  type ReadCost,
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
  reviews: FakeComment[];
  blockers: IssueRef[];
  pr: FakePr | null;
}

export class FakeTrackerAdapter implements TrackerPort {
  private readonly issues = new Map<string, FakeIssue>();
  private nextCommentId = 1;
  private nextPrNumber = 1;

  /** Every pushBranch performed, in order — for assertions. */
  readonly pushedBranches: PushBranchInput[] = [];
  /** The reservation sequence: every claim's "<repo>#<n>", in order. */
  readonly claimedOrder: string[] = [];
  /** Read cost of the neutral read; the fake resolves linkage structurally,
   *  so `pullListings` stays 0. */
  private readonly readCounts: ReadCost = { issueListings: 0, pullListings: 0, issueReads: 0 };

  /** Test-only fault injection (the interruption rows of the swaps, issue 98):
   *  an armed key makes the NEXT matching step of a transition fail with a real
   *  error — never the tolerated "label absent" case. Keys: "claim:label",
   *  "claim:assignee", "release:relabel", "release:unassign", "block:label",
   *  "resume:label" and "remove:<label>" for whichever removal of that label
   *  happens next. One-shot: the key is consumed when it fires. */
  readonly failAt = new Set<string>();

  constructor(private readonly options: { workerAccount: string }) {}

  /** The injected failure of one step, when armed. */
  private armed(key: string): void {
    if (this.failAt.delete(key)) throw new Error(`fake: injected failure at ${key}`);
  }

  /** The injected failure of removing one label, when armed ("remove:<label>"). */
  private armedRemoval(label: string): void {
    this.armed(`remove:${label}`);
  }

  /** The bot account this fake acts as (also used by the fake runtime). */
  get workerAccount(): string {
    return this.options.workerAccount;
  }

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
      reviews: [],
      blockers: [],
      pr: null,
    });
  }

  seedPullRequest(input: FakePullRequestInput): void {
    const ref: IssueRef = { repo: input.repo, number: input.number };
    // The PR attaches to the issue already seeded (labels/comments kept) —
    // only a never-seeded issue gets a fresh one.
    if (!this.issues.has(this.key(ref))) {
      this.seedIssue({
        repo: input.repo,
        number: input.number,
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      });
    }
    const issue = this.mustGet(ref);
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

  /** Human (or scripted) inline review comment on a PR. */
  addReviewComment(input: { repo: string; prNumber: number }, author: string, body: string): void {
    const pr = this.findPrByNumber(input.repo, input.prNumber);
    if (pr === null) throw new Error(`no PR #${input.prNumber} in ${input.repo}`);
    const issue = this.mustGet(pr.issueRef);
    issue.reviews.push({
      id: String(this.nextCommentId++),
      author,
      body,
      createdAt: "2026-01-01T00:00:00Z",
    });
  }

  /** Test-side: close the issue's PR (a human act — rejection or merge). */
  closePr(input: { repo: string; prNumber: number }, options: { merged: boolean }): void {
    const found = this.findPrByNumber(input.repo, input.prNumber);
    if (found === null) throw new Error(`no PR #${input.prNumber} in ${input.repo}`);
    const issue = this.mustGet(found.issueRef);
    issue.pr!.state = "closed";
    issue.pr!.merged = options.merged;
  }

  /** Test-side: close the issue itself (a human act — linkage or not-planned). */
  closeIssue(ref: IssueRef, stateReason: "completed" | "not-planned" = "completed"): void {
    const issue = this.mustGet(ref);
    issue.state = "closed";
    issue.stateReason = stateReason;
  }

  // ---- the port (9 operations + rank) ----

  async listOpenIssues(repo: string): Promise<OpenIssue[]> {
    this.readCounts.issueListings += 1;
    const open: OpenIssue[] = [];
    for (const issue of this.issues.values()) {
      if (issue.ref.repo !== repo) continue;
      if (issue.state !== "open") continue;
      open.push({
        ref: issue.ref,
        title: issue.title,
        createdAt: issue.createdAt,
        labels: [...issue.labels],
        assignees: [...issue.assignees],
        hasOpenPr: issue.pr !== null && issue.pr.state === "open",
      });
    }
    return open;
  }

  /** The read cost since construction — the neutral read's budget pin. */
  readCost(): ReadCost {
    return { ...this.readCounts };
  }

  async readIssue(ref: IssueRef): Promise<Known<IssueSnapshot>> {
    this.readCounts.issueReads += 1;
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
    this.claimedOrder.push(this.key(ref));
    // The order is the decision (issue 98): the claim label is the padlock — it
    // lands FIRST and the pool label leaves LAST, so an interruption leaves the
    // work claimed with its reservation (the next tick releases it on the 1st
    // fall) instead of in neither the pool nor the reserved set.
    this.armed("claim:label");
    issue.labels.add("agent-claimed");
    performed.push(`label+agent-claimed on ${ref.repo}#${ref.number}`);
    this.armed("claim:assignee");
    issue.assignees.add(account);
    performed.push(`assignee ${account}`);
    if (readyLabel !== undefined) {
      this.armedRemoval(readyLabel);
      if (issue.labels.delete(readyLabel)) {
        performed.push(`label-${readyLabel} on ${ref.repo}#${ref.number}`);
      }
    }
    return { performed };
  }

  async releaseClaim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const performed: string[] = [];
    // Mirrored discipline (issue 98): the pool label returns FIRST, the claim
    // mark (the padlock) leaves LAST — an interrupted release keeps the work
    // claimed, so the next derivation releases it again.
    if (readyLabel !== undefined && !issue.labels.has(readyLabel)) {
      this.armed("release:relabel");
      issue.labels.add(readyLabel);
      performed.push(`label+${readyLabel} on ${ref.repo}#${ref.number}`);
    }
    this.armed("release:unassign");
    if (issue.assignees.delete(account)) {
      performed.push(`unassignee ${account}`);
    }
    this.armedRemoval("agent-claimed");
    if (issue.labels.delete("agent-claimed")) {
      performed.push(`label-agent-claimed on ${ref.repo}#${ref.number}`);
    }
    return { performed };
  }

  async blockClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const performed: string[] = [];
    // Same discipline as the claim (issue 98): the blocked label lands first,
    // the claim mark (the padlock) leaves last.
    this.armed("block:label");
    issue.labels.add(labels.blocked);
    performed.push(`label+${labels.blocked} on ${ref.repo}#${ref.number}`);
    this.armedRemoval(labels.claimed);
    if (issue.labels.delete(labels.claimed)) {
      performed.push(`label-${labels.claimed} on ${ref.repo}#${ref.number}`);
    }
    return { performed };
  }

  async resumeClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    const performed: string[] = [];
    // The claim mark (the padlock) returns first, the blocked mark leaves last.
    this.armed("resume:label");
    issue.labels.add(labels.claimed);
    performed.push(`label+${labels.claimed} on ${ref.repo}#${ref.number}`);
    this.armedRemoval(labels.blocked);
    if (issue.labels.delete(labels.blocked)) {
      performed.push(`label-${labels.blocked} on ${ref.repo}#${ref.number}`);
    }
    return { performed };
  }

  async reopenPr(ref: IssueRef): Promise<WriteOutcome> {
    const issue = this.mustGet(ref);
    if (issue.pr === null) return { performed: [] }; // nothing to reopen — tolerated
    issue.pr.state = "open";
    return { performed: [`reopen PR #${issue.pr.number} of ${ref.repo}#${ref.number}`] };
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
      reviews: issue.reviews.map((review) => ({ ...review })),
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
