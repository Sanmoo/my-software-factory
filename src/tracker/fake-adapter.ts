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
  type PrRepairFacts,
  type PullRequest,
  type PushBranchInput,
  type ReadCost,
  type RequiredCheckResult,
  type TrackerPort,
  type WriteOutcome,
  known,
  notKnown,
} from "./port.js";
import type {
  ExpandedPrFeedback,
  OpenPullRequestInput,
  OpenTicket,
  PullRequestRecord,
  PullRequestTracker,
  PushWorkBranchInput,
  TicketBlocker,
  TicketSelection,
  TicketSnapshot,
  TicketTracker,
  WorkPullRequest,
} from "./expanded-port.js";
import { withPullRequestIdentity } from "./expanded-port.js";
import {
  githubRepository,
  githubTicket,
  isGitHubSource,
  issueRefOf,
  issueRefOfTicket,
  pullRequestIdentity,
  pullRequestIdentityKey,
  type TicketIdentity,
} from "./identity.js";

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
  /** The merge/CI facts of the PR, when one exists (defaulted at open). */
  repair: PrRepairFacts | null;
}

export class FakeTrackerAdapter implements TrackerPort, TicketTracker, PullRequestTracker {
  private readonly issues = new Map<string, FakeIssue>();
  private nextCommentId = 1;
  private nextPrNumber = 1;

  /** Every pushBranch performed, in order — for assertions. */
  readonly pushedBranches: PushBranchInput[] = [];
  /** PRs opened for a non-GitHub ticket: no GitHub issue exists to link them to. */
  private readonly standalonePullRequests = new Map<string, PullRequestRecord>();
  /** The reservation sequence: every claim's "<repo>#<n>", in order. */
  readonly claimedOrder: string[] = [];
  /** Read cost of the neutral read; the fake resolves linkage structurally,
   *  so `pullListings` stays 0. */
  private readonly readCounts: ReadCost = { issueListings: 0, pullListings: 0, issueReads: 0 };

  /** Test-only fault injection (the interruption rows of the swaps, issue 98):
   *  an armed key makes the NEXT matching step fail with a real error — never
   *  the tolerated absent-label case. Keys: "claim:label", "claim:assignee",
   *  "release:relabel", "release:unassign", "block:label", "resume:label" and
   *  "remove:<label>". One-shot: the key is consumed when it fires. */
  readonly failAt = new Set<string>();

  constructor(private readonly options: { workerAccount: string }) {}

  private armed(key: string): void {
    if (this.failAt.delete(key)) throw new Error(`fake: injected failure at ${key}`);
  }

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
      repair: null,
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
    if (issue.repair === null) {
      issue.repair = defaultRepairFacts(input.number, issue.pr.baseBranch);
    }
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

  /** Test-side: rewrite the PR's structured merge/CI facts (the repair trigger). */
  setPrRepairFacts(input: {
    repo: string;
    prNumber: number;
    headSha?: string;
    baseSha?: string;
    baseBranch?: string;
    mergeState?: PrRepairFacts["mergeState"];
    requiredChecks?: RequiredCheckResult[] | null;
  }): void {
    const found = this.findPrByNumber(input.repo, input.prNumber);
    if (found === null) throw new Error(`no PR #${input.prNumber} in ${input.repo}`);
    const issue = this.mustGet(found.issueRef);
    const current = issue.repair ?? defaultRepairFacts(input.prNumber, issue.pr?.baseBranch ?? "main");
    issue.repair = {
      headSha: input.headSha ?? current.headSha,
      baseBranch: input.baseBranch ?? current.baseBranch,
      baseSha: input.baseSha ?? current.baseSha,
      mergeState: input.mergeState ?? current.mergeState,
      requiredChecks: input.requiredChecks === undefined ? current.requiredChecks : input.requiredChecks,
    };
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
    // The order is the decision (issue 98): the padlock lands first, the pool
    // label leaves last, so an interruption leaves the work claimed with its
    // reservation.
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
    // Mirrored order (issue 98): the pool label returns first, the padlock
    // leaves last — an interrupted release stays recoverable.
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
    // Same order as the claim (issue 98): the blocked label lands first, the
    // padlock leaves last.
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
    // The padlock returns first, the blocked mark leaves last.
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

  async readPrRepairFacts(ref: IssueRef): Promise<Known<PrRepairFacts>> {
    const issue = this.issues.get(this.key(ref));
    if (!issue || issue.pr === null || issue.repair === null) return notKnown;
    return known({ ...issue.repair, requiredChecks: issue.repair.requiredChecks?.map((check) => ({ ...check })) ?? null });
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

  // ---- expanded ticket/PR contracts (issue 124) ----

  async listOpenTickets(selection: TicketSelection): Promise<OpenTicket[]> {
    if (!isGitHubSource(selection.source)) {
      throw new Error(
        `the fake GitHub adapter cannot list ${selection.source.provider} tickets from ${selection.source.site}`,
      );
    }
    const open = await this.listOpenIssues(selection.destination.repo);
    return open.map((entry) => ({
      ticket: githubTicket(entry.ref.repo, entry.ref.number),
      title: entry.title,
      createdAt: entry.createdAt,
      labels: entry.labels,
      assignees: entry.assignees,
      hasOpenPr: entry.hasOpenPr,
    }));
  }

  async readTicket(ticket: TicketIdentity): Promise<Known<TicketSnapshot>> {
    const snapshot = await this.readIssue(issueRefOf(ticket));
    if (!snapshot.known) return notKnown;
    return known({
      ticket,
      title: snapshot.value.title,
      body: snapshot.value.body,
      state: snapshot.value.state,
      stateReason: snapshot.value.stateReason,
      labels: snapshot.value.labels,
      assignees: snapshot.value.assignees,
      createdAt: snapshot.value.createdAt,
    });
  }

  async readTicketBlockers(ticket: TicketIdentity): Promise<Known<TicketBlocker[]>> {
    const blockers = await this.readBlockers(issueRefOf(ticket));
    if (!blockers.known) return notKnown;
    return known(
      blockers.value.map((blocker) => ({
        ticket: githubTicket(blocker.ref.repo, blocker.ref.number),
        state: blocker.state,
      })),
    );
  }

  claimTicket(ticket: TicketIdentity, account: string, readyLabel?: string): Promise<WriteOutcome> {
    return this.claim(issueRefOf(ticket), account, readyLabel);
  }

  releaseTicketClaim(ticket: TicketIdentity, account: string, readyLabel?: string): Promise<WriteOutcome> {
    return this.releaseClaim(issueRefOf(ticket), account, readyLabel);
  }

  blockTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome> {
    return this.blockClaim(issueRefOf(ticket), labels);
  }

  resumeTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome> {
    return this.resumeClaim(issueRefOf(ticket), labels);
  }

  markTicketDone(ticket: TicketIdentity): Promise<WriteOutcome> {
    return this.markDone(issueRefOf(ticket));
  }

  commentOnTicket(ticket: TicketIdentity, body: string): Promise<WriteOutcome> {
    return this.comment(issueRefOf(ticket), body);
  }

  readTicketComments(ticket: TicketIdentity): Promise<Known<IssueComment[]>> {
    return this.readComments(issueRefOf(ticket));
  }

  rankTicket(ticket: TicketIdentity): Promise<Known<number | null>> {
    return this.rank(issueRefOf(ticket));
  }

  async readPullRequestFeedback(target: WorkPullRequest): Promise<Known<ExpandedPrFeedback>> {
    if (target.pullRequest !== null) {
      const detached = this.standalonePullRequests.get(
        this.pullRequestKey(target.pullRequest.repository.repo, target.pullRequest.number),
      );
      if (detached !== undefined) return known({ pr: { ...detached }, comments: [], reviews: [] });
      const ref = this.issueRefOfPr(target.pullRequest.repository.repo, target.pullRequest.number);
      if (ref === null) return notKnown;
      return this.expandedFeedback(ref);
    }
    const ref = issueRefOfTicket(target.work.ticket);
    if (ref === null) return notKnown;
    return this.expandedFeedback(ref);
  }

  async readPullRequestRepairFacts(target: WorkPullRequest): Promise<Known<PrRepairFacts>> {
    if (target.pullRequest !== null) {
      const detached = this.standalonePullRequests.get(
        this.pullRequestKey(target.pullRequest.repository.repo, target.pullRequest.number),
      );
      if (detached !== undefined) {
        return known({
          headSha: `head-${detached.number}`,
          baseBranch: detached.baseBranch,
          baseSha: `base-${detached.number}`,
          mergeState: "unknown",
          requiredChecks: null,
        });
      }
      const ref = this.issueRefOfPr(target.pullRequest.repository.repo, target.pullRequest.number);
      if (ref === null) return notKnown;
      return this.readPrRepairFacts(ref);
    }
    const ref = issueRefOfTicket(target.work.ticket);
    return ref === null ? notKnown : this.readPrRepairFacts(ref);
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRecord> {
    const ref = issueRefOfTicket(input.work.ticket);
    if (ref !== null) {
      const pull = await this.openPr({
        repo: input.work.destination.repo,
        issueNumber: ref.number,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        title: input.title,
      });
      return withPullRequestIdentity(pull, input.work.destination);
    }
    const number = this.nextPrNumber++;
    const record = withPullRequestIdentity(
      {
        number,
        state: "open",
        merged: false,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        author: this.options.workerAccount,
      },
      input.work.destination,
    );
    this.standalonePullRequests.set(this.pullRequestKey(input.work.destination.repo, number), record);
    return { ...record };
  }

  reopenPullRequest(target: WorkPullRequest): Promise<WriteOutcome> {
    if (target.pullRequest !== null) {
      const key = this.pullRequestKey(target.pullRequest.repository.repo, target.pullRequest.number);
      const detached = this.standalonePullRequests.get(key);
      if (detached !== undefined) {
        detached.state = "open";
        return Promise.resolve({ performed: [`pull ${target.pullRequest.repository.repo}#${detached.number} reopened`] });
      }
      const ref = this.issueRefOfPr(target.pullRequest.repository.repo, target.pullRequest.number);
      return ref === null ? Promise.resolve({ performed: [] }) : this.reopenPr(ref);
    }
    const ref = issueRefOfTicket(target.work.ticket);
    return ref === null ? Promise.resolve({ performed: [] }) : this.reopenPr(ref);
  }

  pushWorkBranch(input: PushWorkBranchInput): Promise<WriteOutcome> {
    return this.pushBranch({ repo: input.destination.repo, branch: input.branch });
  }

  private async expandedFeedback(ref: IssueRef): Promise<Known<ExpandedPrFeedback>> {
    const feedback = await this.readPrFeedback(ref);
    if (!feedback.known) return notKnown;
    if (feedback.value.pr === null) {
      return known({ pr: null, comments: feedback.value.comments, reviews: feedback.value.reviews });
    }
    return known({
      pr: withPullRequestIdentity(feedback.value.pr, githubRepository(ref.repo)),
      comments: feedback.value.comments,
      reviews: feedback.value.reviews,
    });
  }

  private pullRequestKey(repo: string, number: number): string {
    return pullRequestIdentityKey(pullRequestIdentity(githubRepository(repo), number));
  }

  private issueRefOfPr(repo: string, prNumber: number): IssueRef | null {
    return this.findPrByNumber(repo, prNumber)?.issueRef ?? null;
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

/** A PR with no known impediment until the test scripts one. */
function defaultRepairFacts(prNumber: number, baseBranch: string): PrRepairFacts {
  return {
    headSha: `head-${prNumber}`,
    baseBranch,
    baseSha: `base-${prNumber}`,
    mergeState: "mergeable",
    requiredChecks: [],
  };
}
