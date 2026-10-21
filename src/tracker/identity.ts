import type { IssueRef } from "./port.js";

/**
 * Explicit identities of a Work (issue 124): the ticket that requests the
 * change, the code repository that receives it and the PR that delivers it.
 *
 * The provider and site scope every identity, so equal keys/numbers on
 * different sources never collide. The human-readable key is presentation
 * only: a Jira key can change, while `stableId` is the provider's immutable
 * issue id. GitHub keeps its repo-scoped issue number as the stable id.
 */

export const GITHUB_SITE = "github.com";

export type TicketProvider = "github" | "jira";

export interface TicketSource {
  provider: TicketProvider;
  /** Host that scopes the identity: github.com for GitHub Issues; a Jira Cloud site host. */
  site: string;
}

export interface GitHubTicketIdentity {
  provider: "github";
  site: string;
  /** The repository that holds the issue. */
  repo: string;
  /** The issue number — stable within this repo, never a Jira ticket. */
  number: number;
  /** Provider-stable identity, scoped by provider + site + repo. */
  stableId: string;
  /** Human-readable key ("#42"); presentation only, never identity. */
  key: string;
}

export interface JiraTicketIdentity {
  provider: "jira";
  site: string;
  /** Jira's immutable issue id; the mutable key never stands in for it. */
  stableId: string;
  /** Human-readable key ("ABC-123"); presentation only, never identity. */
  key: string;
  /** Human-facing link, when known. */
  url?: string;
}

export type TicketIdentity = GitHubTicketIdentity | JiraTicketIdentity;

export interface RepositoryIdentity {
  provider: "github";
  site: string;
  /** "owner/name". */
  repo: string;
}

export interface PullRequestIdentity {
  provider: "github";
  site: string;
  repository: RepositoryIdentity;
  /** Stable PR number within the repository. */
  number: number;
}

export interface WorkIdentity {
  ticket: TicketIdentity;
  destination: RepositoryIdentity;
}

export function githubRepository(repo: string): RepositoryIdentity {
  return { provider: "github", site: GITHUB_SITE, repo };
}

export function githubTicket(repo: string, number: number): GitHubTicketIdentity {
  return {
    provider: "github",
    site: GITHUB_SITE,
    repo,
    number,
    stableId: String(number),
    key: `#${number}`,
  };
}

export function jiraTicket(input: {
  site: string;
  stableId: string;
  key: string;
  url?: string;
}): JiraTicketIdentity {
  return {
    provider: "jira",
    site: input.site,
    stableId: input.stableId,
    key: input.key,
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

export function pullRequestIdentity(repository: RepositoryIdentity, number: number): PullRequestIdentity {
  return { provider: "github", site: repository.site, repository, number };
}

/** The ticket's stable identity: provider + site + stable id (plus repo for GitHub). */
export function ticketIdentityKey(ticket: TicketIdentity): string {
  if (ticket.provider === "github") {
    return `github:${ticket.site}:${ticket.repo}#${ticket.stableId}`;
  }
  return `jira:${ticket.site}:${ticket.stableId}`;
}

export function repositoryIdentityKey(repository: RepositoryIdentity): string {
  return `${repository.provider}:${repository.site}:${repository.repo}`;
}

export function workIdentityKey(work: WorkIdentity): string {
  return `${ticketIdentityKey(work.ticket)}/${repositoryIdentityKey(work.destination)}`;
}

export function pullRequestIdentityKey(pullRequest: PullRequestIdentity): string {
  return `${repositoryIdentityKey(pullRequest.repository)}#${pullRequest.number}`;
}

/** The transitional bridge's conversion: a GitHub ticket back to the old ref. */
export function issueRefOf(ticket: TicketIdentity): IssueRef {
  if (ticket.provider !== "github") {
    throw new Error(`ticket ${ticket.key} is a ${ticket.provider} ticket, not a GitHub issue`);
  }
  return { repo: ticket.repo, number: ticket.number };
}

/** The transitional bridge's conversion: an old ref to the explicit Work identity. */
export function workOfIssueRef(ref: IssueRef): WorkIdentity {
  return {
    ticket: githubTicket(ref.repo, ref.number),
    destination: githubRepository(ref.repo),
  };
}
