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
  url?: string;
}

export type TicketIdentity = GitHubTicketIdentity | JiraTicketIdentity;

export interface RepositoryIdentity {
  provider: "github";
  site: string;
  repo: string;
}

export interface PullRequestIdentity {
  provider: "github";
  site: string;
  repository: RepositoryIdentity;
  number: number;
}

export interface WorkIdentity {
  ticket: TicketIdentity;
  destination: RepositoryIdentity;
}

export function githubRepository(repo: string): RepositoryIdentity {
  return { provider: "github", site: GITHUB_SITE, repo };
}

/** The source a GitHub Issues selection reads: the code host's own issue tracker. */
export function githubSource(site: string = GITHUB_SITE): TicketSource {
  return { provider: "github", site };
}

/** One selection per configured repository: its issues feed its own code host. */
export function githubSelections(repos: readonly string[]): Array<{ source: TicketSource; destination: RepositoryIdentity }> {
  return repos.map((repo) => ({ source: githubSource(), destination: githubRepository(repo) }));
}

export function githubTicket(repo: string, number: number): GitHubTicketIdentity {
  return githubTicketAt(GITHUB_SITE, repo, number);
}

/** A GitHub ticket on any site; github.com is the default via {@link githubTicket}. */
export function githubTicketAt(site: string, repo: string, number: number): GitHubTicketIdentity {
  return {
    provider: "github",
    site,
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

/** Ticket identity + destination: the pair a record persists as separate facts. */
export function workIdentity(ticket: TicketIdentity, destination: RepositoryIdentity): WorkIdentity {
  return { ticket, destination };
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

/** The same conversion when the caller can legitimately have a non-GitHub ticket. */
export function issueRefOfTicket(ticket: TicketIdentity): IssueRef | null {
  return ticket.provider === "github" ? issueRefOf(ticket) : null;
}

/** The operator-facing link of a ticket — presentation, never identity. */
export function ticketUrl(ticket: TicketIdentity): string | undefined {
  if (ticket.provider === "github") return githubIssueUrl(ticket.site, ticket.repo, ticket.number);
  return ticket.url;
}

/** The link of a GitHub issue on its own site — one template for every surface. */
export function githubIssueUrl(site: string, repo: string, number: number): string {
  return `https://${site}/${repo}/issues/${number}`;
}

/** The link of a GitHub PR on its own site — one template for every surface. */
export function githubPullUrl(site: string, repo: string, number: number): string {
  return `https://${site}/${repo}/pull/${number}`;
}

export function isGitHubSource(source: TicketSource): boolean {
  return source.provider === "github" && source.site === GITHUB_SITE;
}

/** The transitional bridge's conversion: an old ref to the explicit Work identity. */
export function workOfIssueRef(ref: IssueRef): WorkIdentity {
  return {
    ticket: githubTicket(ref.repo, ref.number),
    destination: githubRepository(ref.repo),
  };
}

/**
 * Validation of identities read back from disk. A persisted reservation whose
 * facts do not match these shapes is UNKNOWN — never silently reinterpreted.
 */
export function isTicketIdentity(value: unknown): value is TicketIdentity {
  if (value === null || typeof value !== "object") return false;
  const ticket = value as Record<string, unknown>;
  if (typeof ticket["site"] !== "string" || ticket["site"] === "") return false;
  if (typeof ticket["stableId"] !== "string" || ticket["stableId"] === "") return false;
  if (typeof ticket["key"] !== "string" || ticket["key"] === "") return false;
  if (ticket["provider"] === "jira") {
    return ticket["url"] === undefined || typeof ticket["url"] === "string";
  }
  if (ticket["provider"] !== "github") return false;
  return (
    typeof ticket["repo"] === "string" &&
    ticket["repo"] !== "" &&
    typeof ticket["number"] === "number" &&
    Number.isInteger(ticket["number"]) &&
    ticket["number"] >= 1
  );
}

export function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (value === null || typeof value !== "object") return false;
  const repository = value as Record<string, unknown>;
  return (
    repository["provider"] === "github" &&
    typeof repository["site"] === "string" &&
    repository["site"] !== "" &&
    typeof repository["repo"] === "string" &&
    repository["repo"] !== ""
  );
}

export function isPullRequestIdentity(value: unknown): value is PullRequestIdentity {
  if (value === null || typeof value !== "object") return false;
  const pullRequest = value as Record<string, unknown>;
  return (
    pullRequest["provider"] === "github" &&
    pullRequest["site"] === (pullRequest["repository"] as { site?: unknown } | null)?.site &&
    isRepositoryIdentity(pullRequest["repository"]) &&
    typeof pullRequest["number"] === "number" &&
    Number.isInteger(pullRequest["number"]) &&
    pullRequest["number"] >= 1
  );
}
