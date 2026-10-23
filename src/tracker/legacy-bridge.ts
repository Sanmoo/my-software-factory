import type { Labels } from "../config.js";
import {
  GITHUB_SITE,
  githubRepository,
  githubTicket,
  issueRefOf,
  workOfIssueRef,
} from "./identity.js";
import type { PullRequestTracker, TicketTracker } from "./expanded-port.js";
import { legacyPullRequest } from "./expanded-port.js";
import {
  known,
  notKnown,
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
  type TrackerPort,
  type WriteOutcome,
} from "./port.js";

/**
 * TRANSITIONAL bridge (issue 124): the old `TrackerPort` shape over the
 * expanded ticket/PR contracts. The migrated orchestration no longer uses it;
 * it remains the declared compatibility surface until #127 removes it, and
 * the contract regression still exercises it. It never adds a fact of its
 * own — every operation is one call into the expanded port.
 */
export function legacyTrackerPort(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
): TrackerPort {
  const ticketOf = (ref: IssueRef) => githubTicket(ref.repo, ref.number);
  const workOf = (ref: IssueRef) => workOfIssueRef(ref);

  return {
    async listOpenIssues(repo: string): Promise<OpenIssue[]> {
      const open = await tickets.listOpenTickets({
        source: { provider: "github", site: GITHUB_SITE },
        destination: githubRepository(repo),
      });
      return open.map((entry) => ({
        ref: issueRefOf(entry.ticket),
        title: entry.title,
        createdAt: entry.createdAt,
        labels: entry.labels,
        assignees: entry.assignees,
        hasOpenPr: entry.hasOpenPr,
      }));
    },

    async readIssue(ref: IssueRef): Promise<Known<IssueSnapshot>> {
      const snapshot = await tickets.readTicket(ticketOf(ref));
      if (!snapshot.known) return notKnown;
      return known({
        ref,
        title: snapshot.value.title,
        body: snapshot.value.body,
        state: snapshot.value.state,
        stateReason: snapshot.value.stateReason,
        labels: snapshot.value.labels,
        assignees: snapshot.value.assignees,
        createdAt: snapshot.value.createdAt,
      });
    },

    async readBlockers(ref: IssueRef): Promise<Known<Blocker[]>> {
      const blockers = await tickets.readTicketBlockers(ticketOf(ref));
      if (!blockers.known) return notKnown;
      return known(
        blockers.value.map((blocker) => ({
          ref: issueRefOf(blocker.ticket),
          state: blocker.state,
        })),
      );
    },

    claim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
      return tickets.claimTicket(ticketOf(ref), account, readyLabel);
    },

    releaseClaim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
      return tickets.releaseTicketClaim(ticketOf(ref), account, readyLabel);
    },

    blockClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
      return tickets.blockTicketClaim(ticketOf(ref), labels);
    },

    resumeClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
      return tickets.resumeTicketClaim(ticketOf(ref), labels);
    },

    reopenPr(ref: IssueRef): Promise<WriteOutcome> {
      return pullRequests.reopenPullRequest({ work: workOf(ref), pullRequest: null });
    },

    markDone(ref: IssueRef): Promise<WriteOutcome> {
      return tickets.markTicketDone(ticketOf(ref));
    },

    comment(ref: IssueRef, body: string): Promise<WriteOutcome> {
      return tickets.commentOnTicket(ticketOf(ref), body);
    },

    readComments(ref: IssueRef): Promise<Known<IssueComment[]>> {
      return tickets.readTicketComments(ticketOf(ref));
    },

    async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
      const feedback = await pullRequests.readPullRequestFeedback({ work: workOf(ref), pullRequest: null });
      if (!feedback.known) return notKnown;
      if (feedback.value.pr === null) {
        return known({ pr: null, comments: feedback.value.comments, reviews: feedback.value.reviews });
      }
      return known({
        pr: legacyPullRequest(feedback.value.pr),
        comments: feedback.value.comments,
        reviews: feedback.value.reviews,
      });
    },

    readPrRepairFacts(ref: IssueRef): Promise<Known<PrRepairFacts>> {
      return pullRequests.readPullRequestRepairFacts({ work: workOf(ref), pullRequest: null });
    },

    async openPr(input: OpenPrInput): Promise<PullRequest> {
      const opened = await pullRequests.openPullRequest({
        work: workOf({ repo: input.repo, number: input.issueNumber }),
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        title: input.title,
      });
      return legacyPullRequest(opened);
    },

    pushBranch(input: PushBranchInput): Promise<WriteOutcome> {
      return pullRequests.pushWorkBranch({
        destination: githubRepository(input.repo),
        branch: input.branch,
      });
    },

    rank(ref: IssueRef): Promise<Known<number | null>> {
      return tickets.rankTicket(ticketOf(ref));
    },
  };
}
