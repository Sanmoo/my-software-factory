import type { JiraSourceConfig } from "../config.js";
import type { TicketSelection } from "./expanded-port.js";

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
function githubSource(): TicketSource {
  return { provider: "github", site: GITHUB_SITE };
}

/**
 * The ticket sources the composed adapter serves in production. The
 * orchestration is GitHub-only until the Jira slices land (issue 126): the
 * configured repos narrow WHAT is read from these sources, never which
 * sources the factory can address.
 */
export function composedTicketSources(): TicketSource[] {
  return [githubSource()];
}

/** The comparison key of a ticket source: provider + site, never presentation.
 *  Anything that names a source — a selection's source or a ticket's own
 *  identity — can be compared with it. */
export function sourceKey(source: Pick<TicketSource, "provider" | "site">): string {
  return `${source.provider}:${source.site}`;
}

/** One selection per configured repository: its issues feed its own code host. */
export function githubSelections(repos: readonly string[]): TicketSelection[] {
  return repos.map((repo) => ({ source: githubSource(), destination: githubRepository(repo) }));
}

/** The source of one configured Jira site: provider + site, never the query. */
export function jiraSource(site: string): TicketSource {
  return { provider: "jira", site };
}

/** One selection per configured Jira source: the site, the operator's JQL and
 *  the explicit GitHub destination. Two queries may share a site; each entry
 *  stays its own selection, so no destination is guessed. */
export function jiraSelectionOf(source: JiraSourceConfig): TicketSelection {
  return {
    source: jiraSource(source.site),
    destination: githubRepository(source.destination),
    jql: source.jql,
  };
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

/** The operator-facing name of a ticket: its readable key, scoped by a source
 *  that is not the plain github.com case. Presentation, never identity. */
export function renderTicketIdentity(ticket: TicketIdentity): string {
  if (ticket.provider === "github") {
    const readable = `${ticket.repo}${ticket.key}`;
    return ticket.site === GITHUB_SITE ? readable : `${readable} (github:${ticket.site})`;
  }
  return `${ticket.key} (${ticket.provider}:${ticket.site})`;
}

/** The operator-facing name of a destination repository: one template for
 *  every surface. */
export function renderRepositoryIdentity(repository: RepositoryIdentity): string {
  return `${repository.repo}${repository.site === GITHUB_SITE ? "" : ` (github:${repository.site})`}`;
}

/** The operator-facing name of a Work: its ticket source and the destination
 *  that receives the code. The legacy GitHub spelling stays byte-identical. */
export function renderWorkIdentity(work: WorkIdentity): string {
  const { ticket, destination } = work;
  if (ticket.provider === "github" && ticket.site === GITHUB_SITE && destination.site === GITHUB_SITE) {
    return `${ticket.repo}${ticket.key}`;
  }
  return `${renderTicketIdentity(ticket)} → ${renderRepositoryIdentity(destination)}`;
}

/** The GitHub issue a ticket names, for the adapter's legacy surface (the
 *  smoke and the port contract). A non-GitHub ticket has no such ref. */
export function issueRefOf(ticket: TicketIdentity): LegacyWorkRef {
  if (ticket.provider !== "github") {
    throw new Error(`ticket ${ticket.key} is a ${ticket.provider} ticket, not a GitHub issue`);
  }
  return { repo: ticket.repo, number: ticket.number };
}

/** The same conversion when the caller can legitimately have a non-GitHub ticket. */
export function issueRefOfTicket(ticket: TicketIdentity): LegacyWorkRef | null {
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

/** A workspace record from before the expanded identity: one GitHub issue on
 *  github.com names both the ticket and the destination. Reading it is a
 *  compatibility contract, not a shape new code may produce. */
export interface LegacyWorkRef {
  repo: string;
  number: number;
}

/** The Work a legacy workspace record names: the ticket IS in its destination
 *  repository, the only composition that shape expressed. */
export function workOfLegacyRef(ref: LegacyWorkRef): WorkIdentity {
  return {
    ticket: githubTicket(ref.repo, ref.number),
    destination: githubRepository(ref.repo),
  };
}

/** Does a value read from a legacy workspace file name a Work that way? */
export function isLegacyWorkRef(value: unknown): value is LegacyWorkRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref["repo"] === "string" &&
    ref["repo"] !== "" &&
    typeof ref["number"] === "number" &&
    Number.isInteger(ref["number"]) &&
    ref["number"] >= 1
  );
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

/** A Work as the workspace persists it: the ticket source and the destination
 *  as separate facts. */
export function isWorkIdentity(value: unknown): value is WorkIdentity {
  if (value === null || typeof value !== "object") return false;
  const work = value as Record<string, unknown>;
  return isTicketIdentity(work["ticket"]) && isRepositoryIdentity(work["destination"]);
}

/** A persisted Work record: the expanded shape, or the legacy ref a workspace
 *  written before the expansion holds. Unknown is never reinterpreted. */
export function workOfPersisted(value: unknown): WorkIdentity | null {
  if (isWorkIdentity(value)) return value;
  if (isLegacyWorkRef(value)) return workOfLegacyRef(value);
  return null;
}
