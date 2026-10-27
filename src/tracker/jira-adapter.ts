import type { Labels } from "../config.js";
import type {
  OpenTicket,
  PrerequisiteLink,
  PrerequisiteTracker,
  SiteTicketTracker,
  TicketBlocker,
  TicketPrerequisite,
  TicketSelection,
  TicketSnapshot,
} from "./expanded-port.js";
import type { IssueComment, Known, WriteOutcome } from "./port.js";
import { known, notKnown } from "./port.js";
import {
  jiraTicket,
  workIdentityKey,
  type JiraTicketIdentity,
  type TicketIdentity,
  type TicketSource,
  type WorkIdentity,
} from "./identity.js";
import { renderAdf, textToAdf } from "./jira-adf.js";
import { withNativeRankOrdering, withSiteRankOrdering, type RankedQuery } from "./jira-jql.js";
import type { JiraPublicationKind } from "../work-record/jira-mediation.js";

/**
 * The real Jira Cloud ticket adapter: reads over the REST API v3
 * with a locally referenced Atlassian API token (HTTP Basic, `account:token`).
 * `/myself` identifies the authenticated account — the Acting account the
 * factory acts as; JQL's `currentUser()` means THAT account, never an
 * implicitly different human operator.
 *
 * This slice reads the selection (native, token-paginated Rank order), one
 * ticket's usable content, its direct prerequisite links and its conversation,
 * and publishes a factory comment through the mediated contract: every factory
 * comment carries structured Jira comment-property evidence, so authorship
 * never depends on the author's login. Every other mutation (and the rank read
 * this slice does not own) is refused before any HTTP write; `msf run` also
 * refuses a Jira configuration before any claim, so no launch path pretends the
 * missing operations exist.
 *
 * The credential is never stored in config, logs or messages: the config names
 * a local environment variable (`token-env`) and the adapter reads its value
 * per call, presenting it only in the Authorization header.
 */

/** One HTTP call as the adapter makes it; a transport is the process boundary. */
export interface JiraRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface JiraResponse {
  status: number;
  text: string;
}

/** The HTTP seam: production is `fetch`, tests are the in-memory REST sim. */
export type JiraTransport = (url: string, init: JiraRequestInit) => Promise<JiraResponse>;

export const jiraHttpTransport: JiraTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { status: response.status, text: await response.text() };
};

export interface JiraAdapterOptions {
  /** The Cloud site host (`<tenant>.atlassian.net`) — also the identity site. */
  site: string;
  /** The Atlassian account email the API token belongs to (Basic auth user). */
  account: string;
  /** The NAME of the local environment variable holding the API token. */
  tokenEnv: string;
  /** Where the token is read from; the process environment by default. */
  env?: NodeJS.ProcessEnv;
  /** The HTTP seam; production uses fetch. */
  transport?: JiraTransport;
}

/** The authenticated Jira identity the adapter acts as. */
export interface JiraActingAccount {
  accountId: string;
  emailAddress: string;
  displayName: string;
}

/** A missing local credential: named, never substituted by another account. */
export class JiraMissingCredentialError extends Error {
  constructor(site: string, tokenEnv: string) {
    super(
      `no Jira API token for site "${site}": the local environment variable "${tokenEnv}" is not set. ` +
        `Export the API token there (the YAML references the variable, never the token) and run again — ` +
        `no other account is tried`,
    );
    this.name = "JiraMissingCredentialError";
  }
}

export class JiraAuthenticationError extends Error {
  constructor(site: string, detail: string) {
    super(
      `Jira site "${site}" rejected the credential (${detail}). ` +
        `Check the configured account and the API token named by "token-env"; no fallback account is used`,
    );
    this.name = "JiraAuthenticationError";
  }
}

/** The credential was accepted, but the site did not say WHICH account it
 *  authenticated: the configured account cannot be verified. */
export class JiraAccountUnverifiedError extends Error {
  constructor(site: string, configured: string) {
    super(
      `Jira site "${site}" accepted the credential but did not report which account it authenticated ` +
        `(/myself carries no emailAddress), so the configured account "${configured}" cannot be verified. ` +
        `The factory refuses to act as an unidentified account`,
    );
    this.name = "JiraAccountUnverifiedError";
  }
}

export class JiraAccountMismatchError extends Error {
  constructor(site: string, authenticated: string, configured: string) {
    super(
      `Jira site "${site}" authenticated as "${authenticated}", but the config names account "${configured}". ` +
        `The factory acts only as the configured account and never falls back to another one`,
    );
    this.name = "JiraAccountMismatchError";
  }
}

export class JiraPermissionError extends Error {
  constructor(site: string, detail: string) {
    super(`insufficient Jira permissions on site "${site}" (${detail}). The selection was not read`);
    this.name = "JiraPermissionError";
  }
}

export class JiraInvalidJqlError extends Error {
  constructor(site: string, detail: string) {
    super(`invalid JQL for site "${site}": ${detail}`);
    this.name = "JiraInvalidJqlError";
  }
}

export class JiraRankUnavailableError extends Error {
  constructor(site: string, detail: string) {
    super(
      `native Rank is unavailable on site "${site}" (${detail}). ` +
        `The factory never falls back to creation age or Priority, so no candidates were read`,
    );
    this.name = "JiraRankUnavailableError";
  }
}

export class JiraSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraSelectionError";
  }
}

export class JiraProtocolError extends Error {
  constructor(site: string, detail: string) {
    super(`unexpected Jira response from site "${site}": ${detail}`);
    this.name = "JiraProtocolError";
  }
}

/** A read that failed: unknown, never an empty selection. */
export class JiraReadError extends Error {
  constructor(site: string, detail: string) {
    super(`could not read Jira site "${site}": ${detail}`);
    this.name = "JiraReadError";
  }
}

/**
 * A configured prerequisite link type the site does not have: the
 * rule cannot be evaluated, so the candidate is held — a typo must never read as
 * "no prerequisites".
 */
export class JiraUnknownLinkTypeError extends Error {
  constructor(site: string, type: string, known: readonly string[]) {
    super(
      `the selection configures the link type "${type}", which Jira site "${site}" does not have ` +
        `(its link types: ${known.length === 0 ? "none" : known.join(", ")}). ` +
        `The prerequisite rule cannot be evaluated, so the candidate is held`,
    );
    this.name = "JiraUnknownLinkTypeError";
  }
}

/** An operation this slice does not implement: refused before any write. */
export class UnsupportedJiraOperationError extends Error {
  constructor(site: string, operation: string) {
    super(
      `Jira ${operation} is not implemented for site "${site}" in this release; ` +
        `it is refused before anything is sent`,
    );
    this.name = "UnsupportedJiraOperationError";
  }
}

/** Jira answered, and the comment was definitively NOT created. */
export class JiraPublishRejectedError extends Error {
  constructor(site: string, detail: string) {
    super(`Jira site "${site}" refused the comment (${detail}); nothing was published`);
    this.name = "JiraPublishRejectedError";
  }
}

/** The write may or may not have landed: the caller reconciles by correlation,
 *  never by assuming success or by retrying blindly. */
export class JiraPublishUnknownError extends Error {
  constructor(site: string, detail: string) {
    super(
      `Jira site "${site}" did not answer the comment unambiguously (${detail}); ` +
        `the publication may or may not have landed`,
    );
    this.name = "JiraPublishUnknownError";
  }
}

/** The Jira comment property carrying factory speech and its correlation. */
export const FACTORY_COMMENT_PROPERTY = "msf.factory";

export interface FactoryCommentPublication {
  kind: JiraPublicationKind;
  /** Plain worker text; the adapter renders it as ADF. */
  text: string;
  /** The request id that makes a retry/reconciliation the same publication. */
  correlationId: string;
  work: WorkIdentity;
  sessionId: string;
  attempt: number;
}

/** What the factory published: the provider's id and an inspectable link. */
export interface JiraPublishedComment {
  commentId: string;
  url: string;
}

const MYSELF_PATH = "/rest/api/3/myself";
const LINK_TYPES_PATH = "/rest/api/3/issueLinkType";
const SEARCH_PATH = "/rest/api/3/search/jql";
/** The listing requests only the facts a candidate needs; the JQL decides selection. */
const LIST_FIELDS = ["summary", "labels", "assignee", "created"];
const READ_FIELDS = ["summary", "description", "labels", "assignee", "created"];
/** The one field the prerequisite read asks for: the ticket's own links. */
const LINK_FIELDS = "issuelinks";
/** The page the listing asks for; Jira caps it at its own maximum. */
const PAGE_SIZE = 100;

/** The negative forms Jira uses when the site cannot order by Rank. */
const RANK_UNAVAILABLE =
  /rank[^.;]{0,80}(?:not\s+(?:exist|searchable|supported|available)|unavailable|invalid|unsupported)|(?:not\s+(?:exist|searchable|supported|available)|invalid|unsupported)[^.;]{0,40}rank/i;

export class JiraTicketAdapter implements SiteTicketTracker, PrerequisiteTracker {
  readonly site: string;
  readonly account: string;
  readonly tokenEnv: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: JiraTransport;
  /** `/myself` runs once per adapter; a failure is retried on the next call. */
  private identity: Promise<JiraActingAccount> | null = null;
  /** The site's link type names, read once: a configured rule must exist. */
  private linkTypes: Promise<ReadonlySet<string>> | null = null;

  constructor(options: JiraAdapterOptions) {
    this.site = options.site;
    this.account = options.account;
    this.tokenEnv = options.tokenEnv;
    this.env = options.env ?? process.env;
    this.transport = options.transport ?? jiraHttpTransport;
  }

  /** The authenticated Acting account — the identity `currentUser()` means. */
  async actingAccount(): Promise<JiraActingAccount> {
    if (this.identity === null) {
      const pending = this.identify();
      this.identity = pending;
      pending.catch(() => {
        if (this.identity === pending) this.identity = null;
      });
    }
    return this.identity;
  }

  /**
   * A configured link type the site does not have makes the rule unevaluable:
   * the candidate is held with the type named instead of advancing on an empty
   * prerequisite list. The site's own names are read once per adapter.
   */
  private async assertKnownLinkTypes(links: readonly PrerequisiteLink[]): Promise<void> {
    if (links.length === 0) return;
    if (this.linkTypes === null) {
      const pending = this.readLinkTypes();
      this.linkTypes = pending;
      pending.catch(() => {
        if (this.linkTypes === pending) this.linkTypes = null;
      });
    }
    const known = await this.linkTypes;
    const unknown = links.find((link) => !known.has(link.type));
    if (unknown !== undefined) throw new JiraUnknownLinkTypeError(this.site, unknown.type, [...known]);
  }

  private async readLinkTypes(): Promise<ReadonlySet<string>> {
    const json = await this.requestJson("GET", LINK_TYPES_PATH);
    return new Set(parseLinkTypeNames(this.site, json));
  }

  private async identify(): Promise<JiraActingAccount> {
    const json = await this.requestJson("GET", MYSELF_PATH);
    const account = parseActingAccount(this.site, json);
    if (account.active === false) {
      throw new JiraAuthenticationError(this.site, `the account "${account.displayName}" is inactive`);
    }
    // The configured account must be the one the credential authenticated as:
    // an unidentified identity is refused, never relabelled as the config's.
    if (account.emailAddress === null) {
      throw new JiraAccountUnverifiedError(this.site, this.account);
    }
    if (account.emailAddress.toLowerCase() !== this.account.toLowerCase()) {
      throw new JiraAccountMismatchError(this.site, account.emailAddress, this.account);
    }
    return {
      accountId: account.accountId,
      emailAddress: account.emailAddress,
      displayName: account.displayName,
    };
  }

  /**
   * The selection's JQL, read in native Rank ascending order from Jira's own
   * ordered, token-paginated result pages. The order is never re-sorted here
   * and no hidden assignee/status/label/type/subtask filter is added: the
   * operator's JQL is the whole selection.
   */
  async listOpenTickets(selection: TicketSelection): Promise<OpenTicket[]> {
    return this.readRankOrdered(withNativeRankOrdering(this.selectionJql(selection)));
  }

  /**
   * The site's several selections as ONE native Rank-ordered result: the union
   * of their filters, read page by page in Jira's own order. Routing each
   * result to its explicit destination remains the caller's job; this read
   * never guesses one.
   */
  async listSiteTickets(selections: readonly TicketSelection[]): Promise<OpenTicket[]> {
    if (selections.length === 0) {
      throw new JiraSelectionError(`the Jira site "${this.site}" was asked for no selection`);
    }
    return this.readRankOrdered(
      withSiteRankOrdering(selections.map((selection) => this.selectionJql(selection))),
    );
  }

  /** The selection's JQL, once it names this site and carries a query. Whether
   *  that query can keep native Rank is the caller's check: only it knows if it
   *  reads one selection or the site's union. */
  private selectionJql(selection: TicketSelection): string {
    this.assertSource(selection.source);
    const jql = selection.jql;
    if (jql === undefined || jql.trim() === "") {
      throw new JiraSelectionError(`the Jira selection for site "${this.site}" carries no JQL`);
    }
    return jql;
  }

  /** The one native Rank read. An unordered or re-ordered query is a
   *  configuration error, never a result silently sorted by something other
   *  than the site's Rank. */
  private async readRankOrdered(ordering: RankedQuery): Promise<OpenTicket[]> {
    if (!ordering.ok) throw new JiraInvalidJqlError(this.site, ordering.because);
    await this.actingAccount();
    const tickets: OpenTicket[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        jql: ordering.jql,
        fields: LIST_FIELDS,
        maxResults: PAGE_SIZE,
        ...(pageToken === undefined ? {} : { nextPageToken: pageToken }),
      };
      const page = parseSearchPage(this.site, await this.requestJson("POST", SEARCH_PATH, body));
      for (const issue of page.issues) tickets.push(openTicket(this.site, issue));
      if (page.nextPageToken === null) return tickets;
      if (seenTokens.has(page.nextPageToken)) {
        throw new JiraProtocolError(this.site, `the page token "${page.nextPageToken}" repeated`);
      }
      seenTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
  }

  /**
   * One ticket in usable form: the description's ADF meaning rendered as text
   * (never as HTML or GitHub Markdown), the current readable key with the
   * immutable id, and the site's browse URL.
   *
   * `state` stays `open`: the port's `closed`/`completed` is the GitHub issue
   * lifecycle, and Jira's Done category is Issue completion, not this Work's
   * completion (ADR 0004) — the Jira lifecycle slice owns that distinction.
   */
  async readTicket(ticket: TicketIdentity): Promise<Known<TicketSnapshot>> {
    const source = this.assertTicket(ticket);
    await this.actingAccount();
    const json = await this.requestJsonOrNull(
      "GET",
      `${issuePath(source.stableId)}?fields=${READ_FIELDS.join(",")}`,
    );
    if (json === null) return notKnown;

    const issue = parseIssue(this.site, json);
    return known({
      ticket: identityOf(this.site, issue),
      title: issue.summary,
      body: renderAdf(issue.description),
      state: "open",
      stateReason: null,
      labels: issue.labels,
      assignees: issue.assignees,
      createdAt: issue.created,
    });
  }

  /**
   * The ticket's DIRECT prerequisites: only the linked issues sitting on the
   * configured side of a configured link type, each with its Done status
   * category. The link descriptions Jira sends are never read — the config
   * decides the direction, so a site's own link wording cannot change it — and
   * a parent/epic relation is no prerequisite.
   *
   * A link or prerequisite whose state the site does not show is UNKNOWN, never
   * a satisfied prerequisite and never a shorter list.
   */
  async readTicketPrerequisites(
    ticket: TicketIdentity,
    links: readonly PrerequisiteLink[],
  ): Promise<Known<TicketPrerequisite[]>> {
    const source = this.assertTicket(ticket);
    await this.actingAccount();
    await this.assertKnownLinkTypes(links);
    const json = await this.requestJsonOrNull(
      "GET",
      `${issuePath(source.stableId)}?fields=${LINK_FIELDS}`,
    );
    if (json === null) return notKnown;
    return known(selectPrerequisites(this.site, parseIssueLinks(this.site, json), links));
  }

  /**
   * The ticket's conversation in usable text: each comment's ADF meaning
   * rendered, with the factory's structured evidence (comment property) as
   * `agentSpeech`/`agentCorrelation`. A human and the factory can share the
   * acting account: the author login is not the signal.
   *
   * The properties are asked for explicitly (`expand=properties`): Jira exposes
   * a comment's properties on the comment resource only when the read expands
   * them, so an unexpanded read would turn the factory's own speech into a
   * human comment — and a retried publication into a second copy.
   */
  async readTicketComments(ticket: TicketIdentity): Promise<Known<IssueComment[]>> {
    const source = this.assertTicket(ticket);
    await this.actingAccount();
    const comments: IssueComment[] = [];
    let startAt = 0;
    for (;;) {
      const json = await this.requestJsonOrNull(
        "GET",
        `${issuePath(source.stableId)}/comment?startAt=${startAt}&maxResults=${PAGE_SIZE}&expand=properties`,
      );
      if (json === null) return notKnown;
      const page = parseCommentPage(this.site, json);
      for (const comment of page.comments) comments.push(parseComment(this.site, comment));
      // `total` is Jira's own statement of completeness: without it a page
      // would read as the whole conversation, which is unknown, not empty.
      if (startAt + page.comments.length >= page.total) return known(comments);
      if (page.comments.length === 0) {
        throw new JiraProtocolError(this.site, "a comment page before the total carried no comments");
      }
      startAt += page.comments.length;
    }
  }

  /**
   * Publish factory speech with the correlation the mediation contract gave
   * it. The property, not the ADF body, is the recoverable evidence: a human
   * comment by the same account carries no property and is never factory
   * speech.
   */
  async publishFactoryComment(
    ticket: TicketIdentity,
    publication: FactoryCommentPublication,
  ): Promise<JiraPublishedComment> {
    const source = this.assertTicket(ticket);
    await this.actingAccount();
    const evidence = {
      version: 1,
      kind: publication.kind,
      correlationId: publication.correlationId,
      work: workIdentityKey(publication.work),
      sessionId: publication.sessionId,
      attempt: publication.attempt,
    };
    const json = await this.writeJson(`${issuePath(source.stableId)}/comment`, {
      body: textToAdf(publication.text),
      properties: [{ key: FACTORY_COMMENT_PROPERTY, value: evidence }],
    });
    if (!isRecord(json) || typeof json["id"] !== "string" || json["id"] === "") {
      // A 2xx without the comment id cannot prove which comment landed: the
      // caller reconciles by the correlation instead of reporting success.
      throw new JiraPublishUnknownError(this.site, "the created comment carries no id");
    }
    return {
      commentId: json["id"],
      url: `${jiraBrowseUrl(this.site, source.key)}?focusedCommentId=${encodeURIComponent(json["id"])}`,
    };
  }

  // ---- the operations this slice refuses ----

  /** GitHub's native blocked_by read: its open/closed vocabulary is not Jira's
   *  Done category, so this slice refuses it instead of answering with it. */
  readTicketBlockers(_ticket: TicketIdentity): Promise<Known<TicketBlocker[]>> {
    return this.refuse("native blocked_by read");
  }

  claimTicket(_ticket: TicketIdentity, _account: string, _readyLabel?: string): Promise<WriteOutcome> {
    return this.refuse("claim");
  }

  releaseTicketClaim(_ticket: TicketIdentity, _account: string, _readyLabel?: string): Promise<WriteOutcome> {
    return this.refuse("claim release");
  }

  blockTicketClaim(_ticket: TicketIdentity, _labels: Labels): Promise<WriteOutcome> {
    return this.refuse("block");
  }

  resumeTicketClaim(_ticket: TicketIdentity, _labels: Labels): Promise<WriteOutcome> {
    return this.refuse("resume");
  }

  markTicketDone(_ticket: TicketIdentity): Promise<WriteOutcome> {
    return this.refuse("mark done");
  }

  commentOnTicket(_ticket: TicketIdentity, _body: string): Promise<WriteOutcome> {
    // An unmediated comment would carry no factory evidence and no correlation
    // to reconcile a retry: publications travel through the mediated contract.
    return this.refuse("unmediated comment");
  }

  rankTicket(_ticket: TicketIdentity): Promise<Known<number | null>> {
    // Rank is opaque: reading it as a number is the very fallback this slice
    // forbids, so the operation is refused rather than answered with a guess.
    return this.refuse("rank read");
  }

  private refuse(operation: string): Promise<never> {
    return Promise.reject(new UnsupportedJiraOperationError(this.site, operation));
  }

  // ---- the REST seam ----

  private assertSource(source: TicketSource): void {
    if (source.provider !== "jira" || source.site !== this.site) {
      throw new JiraSelectionError(
        `the adapter for Jira site "${this.site}" cannot list ${source.provider} tickets from "${source.site}"`,
      );
    }
  }

  private assertTicket(ticket: TicketIdentity): JiraTicketIdentity {
    if (ticket.provider !== "jira") {
      throw new JiraSelectionError(`the Jira adapter cannot read a ${ticket.provider} ticket`);
    }
    this.assertSource(ticket);
    return ticket;
  }

  private async requestJsonOrNull(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.requestJson(method, path, body);
    } catch (error) {
      if (error instanceof JiraNotFoundError) return null;
      throw error;
    }
  }

  private async requestJson(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const token = this.requiredToken();
    const response = await this.send(method, path, token, body);
    if (response.status >= 200 && response.status < 300) {
      try {
        return JSON.parse(response.text) as unknown;
      } catch {
        throw new JiraProtocolError(this.site, "the response is not JSON");
      }
    }
    throw this.httpError(response);
  }

  /** A write: a failure is either a definite refusal or an ambiguity the
   *  caller must reconcile — never a silent retry at this layer. */
  private async writeJson(path: string, body: unknown): Promise<unknown> {
    const token = this.requiredToken();
    let response: JiraResponse;
    try {
      response = await this.send("POST", path, token, body);
    } catch (error) {
      if (error instanceof JiraReadError) {
        throw new JiraPublishUnknownError(this.site, error.message);
      }
      throw error;
    }
    if (response.status >= 200 && response.status < 300) {
      try {
        return JSON.parse(response.text) as unknown;
      } catch {
        throw new JiraPublishUnknownError(this.site, "the response is not JSON");
      }
    }
    const detail = jiraErrorDetail(response.text);
    // The site may have applied the write before answering: these statuses do
    // not prove absence, so the result is unknown, never a retry invitation.
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new JiraPublishUnknownError(this.site, `HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
    }
    if (response.status === 401) throw new JiraAuthenticationError(this.site, detail);
    if (response.status === 403) throw new JiraPermissionError(this.site, detail);
    throw new JiraPublishRejectedError(
      this.site,
      `HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    token: string,
    body: unknown,
  ): Promise<JiraResponse> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.account}:${token}`, "utf8").toString("base64")}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    try {
      return await this.transport(`https://${this.site}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new JiraReadError(this.site, `the site could not be reached (${reason})`);
    }
  }

  private requiredToken(): string {
    const token = this.env[this.tokenEnv];
    if (typeof token !== "string" || token.trim() === "") {
      throw new JiraMissingCredentialError(this.site, this.tokenEnv);
    }
    return token;
  }

  private httpError(response: JiraResponse): Error {
    const detail = jiraErrorDetail(response.text);
    if (response.status === 401) return new JiraAuthenticationError(this.site, detail);
    if (response.status === 403) return new JiraPermissionError(this.site, detail);
    if (response.status === 404) return new JiraNotFoundError(this.site, detail);
    if (response.status === 400 && RANK_UNAVAILABLE.test(detail)) {
      return new JiraRankUnavailableError(this.site, detail);
    }
    if (response.status === 400 && /jql/i.test(detail)) {
      return new JiraInvalidJqlError(this.site, detail);
    }
    return new JiraReadError(this.site, `HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** The one place the browse URL is built — presentation, never identity. */
function jiraBrowseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`;
}

const issuePath = (stableId: string): string => `/rest/api/3/issue/${encodeURIComponent(stableId)}`;

class JiraNotFoundError extends Error {
  constructor(site: string, detail: string) {
    super(`Jira site "${site}" does not expose this ticket (${detail})`);
    this.name = "JiraNotFoundError";
  }
}

// ---- REST shapes the adapter reads ----

interface ParsedCommentPage {
  comments: unknown[];
  total: number;
}

function parseCommentPage(site: string, body: unknown): ParsedCommentPage {
  if (!isRecord(body) || !Array.isArray(body["comments"])) {
    throw new JiraProtocolError(site, "the comment response carries no comments array");
  }
  const total = body["total"];
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new JiraProtocolError(site, "the comment page carries no total");
  }
  return { comments: body["comments"] as unknown[], total };
}

/** One comment: ADF rendered as text, and the factory's structured evidence. */
function parseComment(site: string, value: unknown): IssueComment {
  if (!isRecord(value)) throw new JiraProtocolError(site, "a comment is not an object");
  const id = value["id"];
  const created = value["created"];
  if (typeof id !== "string" || id === "") throw new JiraProtocolError(site, "a comment carries no id");
  if (typeof created !== "string" || created === "") {
    throw new JiraProtocolError(site, `comment ${id} carries no creation date`);
  }
  const evidence = factoryEvidence(value["properties"]);
  return {
    id,
    author: commentAuthorName(value["author"]),
    body: renderAdf(value["body"]),
    createdAt: created,
    // The provider's own fact: no property means NOT factory speech, even when
    // the author is the acting account.
    agentSpeech: evidence !== null,
    ...(evidence === null ? {} : { agentCorrelation: evidence.correlationId }),
  };
}

function commentAuthorName(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  for (const field of ["displayName", "emailAddress", "accountId"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return "unknown";
}

/** The factory evidence a comment carries, or null when it carries none we can
 *  trust. Jira exposes comment properties as `[{key, value}]` (create shape);
 *  the reader accepts a keyed object too. A malformed value is not evidence. */
function factoryEvidence(properties: unknown): { correlationId: string } | null {
  let record: Record<string, unknown> | null = null;
  if (Array.isArray(properties)) {
    const entry = properties.find(
      (candidate) => isRecord(candidate) && candidate["key"] === FACTORY_COMMENT_PROPERTY,
    );
    if (isRecord(entry) && isRecord(entry["value"])) record = entry["value"];
  } else if (isRecord(properties) && isRecord(properties[FACTORY_COMMENT_PROPERTY])) {
    record = properties[FACTORY_COMMENT_PROPERTY] as Record<string, unknown>;
  }
  if (record === null) return null;
  if (record["version"] !== 1) return null;
  const correlationId = record["correlationId"];
  if (typeof correlationId !== "string" || correlationId === "") return null;
  return { correlationId };
}

function parseSearchPage(site: string, body: unknown): {
  issues: unknown[];
  nextPageToken: string | null;
} {
  if (!isRecord(body) || !Array.isArray(body["issues"])) {
    throw new JiraProtocolError(site, "the search response carries no issues array");
  }
  const token = body["nextPageToken"];
  if (token !== undefined && typeof token !== "string") {
    throw new JiraProtocolError(site, "the search response carries a non-string page token");
  }
  const nextPageToken = typeof token === "string" && token !== "" ? token : null;
  const isLast = body["isLast"];
  if (isLast !== undefined && typeof isLast !== "boolean") {
    throw new JiraProtocolError(site, "the search response carries a non-boolean isLast");
  }
  // Exactly one of Jira's two completeness statements must hold; a page that
  // leaves it open would make a truncated answer read as the whole selection,
  // which is a read failure (unknown), never a short list.
  if (isLast === true && nextPageToken !== null) {
    throw new JiraProtocolError(site, "the search page ends the result and also carries a page token");
  }
  if (isLast !== true && nextPageToken === null) {
    throw new JiraProtocolError(site, "the search page neither ends the result nor carries a page token");
  }
  return { issues: body["issues"] as unknown[], nextPageToken };
}

interface ParsedIssue {
  stableId: string;
  key: string;
  summary: string;
  description: unknown;
  labels: string[];
  assignees: string[];
  created: string;
}

function openTicket(site: string, issue: unknown): OpenTicket {
  const parsed = parseIssue(site, issue);
  return {
    ticket: identityOf(site, parsed),
    title: parsed.summary,
    createdAt: parsed.created,
    labels: parsed.labels,
    assignees: parsed.assignees,
    // Jira carries no GitHub PR linkage: the unknown answer is null, never a
    // fabricated "no open PR". The registry owns a Jira Work's PR association.
    hasOpenPr: null,
  };
}

function parseIssue(site: string, issue: unknown): ParsedIssue {
  if (!isRecord(issue)) throw new JiraProtocolError(site, "an issue is not an object");
  const id = issue["id"];
  const key = issue["key"];
  if (typeof id !== "string" || id === "") throw new JiraProtocolError(site, "an issue carries no id");
  if (typeof key !== "string" || key === "") throw new JiraProtocolError(site, "an issue carries no key");
  const fields = issue["fields"];
  if (!isRecord(fields)) throw new JiraProtocolError(site, `issue ${key} carries no fields`);
  const summary = fields["summary"];
  const created = fields["created"];
  if (typeof summary !== "string") throw new JiraProtocolError(site, `issue ${key} carries no summary`);
  if (typeof created !== "string" || created === "") {
    throw new JiraProtocolError(site, `issue ${key} carries no creation date`);
  }
  const labels = Array.isArray(fields["labels"])
    ? fields["labels"].filter((label): label is string => typeof label === "string")
    : [];
  const assignee = assigneeName(fields["assignee"]);
  return {
    stableId: id,
    key,
    summary,
    description: fields["description"] ?? null,
    labels,
    assignees: assignee === null ? [] : [assignee],
    created,
  };
}

function identityOf(site: string, issue: ParsedIssue): JiraTicketIdentity {
  return jiraTicket({
    site,
    stableId: issue.stableId,
    key: issue.key,
    url: jiraBrowseUrl(site, issue.key),
  });
}

/** The site's link type names: the vocabulary a configured rule must name. */
function parseLinkTypeNames(site: string, body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["issueLinkTypes"])) {
    throw new JiraProtocolError(site, "the link type response carries no issueLinkTypes array");
  }
  return body["issueLinkTypes"].map((entry) => {
    const name = isRecord(entry) ? entry["name"] : undefined;
    if (typeof name !== "string" || name === "") {
      throw new JiraProtocolError(site, "a link type carries no name");
    }
    return name;
  });
}

/** One link as the ticket sees it: its type and the linked issue on one side. */
interface LinkedIssue {
  type: string;
  side: "inward" | "outward";
  stableId: string;
  key: string;
  status: string | null;
  completion: "done" | "not-done" | null;
}

/**
 * The `issuelinks` of one issue read. The field was explicitly requested, so a
 * response without it cannot be read as "no links" — that is a read failure,
 * and a candidate that could not have its links read never advances.
 */
function parseIssueLinks(site: string, body: unknown): LinkedIssue[] {
  if (!isRecord(body)) throw new JiraProtocolError(site, "the issue response is not an object");
  const key = body["key"];
  if (typeof key !== "string" || key === "") throw new JiraProtocolError(site, "the issue carries no key");
  const fields = body["fields"];
  if (!isRecord(fields)) throw new JiraProtocolError(site, `issue ${key} carries no fields`);
  const links = fields["issuelinks"];
  if (!Array.isArray(links)) {
    throw new JiraProtocolError(site, `issue ${key} carries no issuelinks array`);
  }
  return links.map((link) => parseLink(site, key, link));
}

function parseLink(site: string, issueKey: string, link: unknown): LinkedIssue {
  if (!isRecord(link)) throw new JiraProtocolError(site, `a link of issue ${issueKey} is not an object`);
  const type = isRecord(link["type"]) ? link["type"]["name"] : undefined;
  if (typeof type !== "string" || type === "") {
    throw new JiraProtocolError(site, `a link of issue ${issueKey} carries no type name`);
  }
  const inward = link["inwardIssue"];
  const outward = link["outwardIssue"];
  const side: LinkedIssue["side"] = isRecord(inward) ? "inward" : "outward";
  const linked = isRecord(inward) ? inward : outward;
  if (!isRecord(linked)) {
    throw new JiraProtocolError(site, `the "${type}" link of issue ${issueKey} names no issue`);
  }
  const id = linked["id"];
  const key = linked["key"];
  if (typeof id !== "string" || id === "" || typeof key !== "string" || key === "") {
    throw new JiraProtocolError(site, `the "${type}" link of issue ${issueKey} names no identifiable issue`);
  }
  const status = linkedStatus(linked);
  return { type, side, stableId: id, key, ...status };
}

/** The linked issue's status and its native category; both unknown when the
 *  site lists the link but does not show the issue's state. */
function linkedStatus(linked: Record<string, unknown>): {
  status: string | null;
  completion: TicketPrerequisite["completion"];
} {
  const fields = linked["fields"];
  const status = isRecord(fields) ? fields["status"] : undefined;
  if (!isRecord(status)) return { status: null, completion: null };
  const name = typeof status["name"] === "string" && status["name"] !== "" ? status["name"] : null;
  const category = isRecord(status["statusCategory"]) ? status["statusCategory"]["key"] : undefined;
  // The category KEY is the fact: a status merely named "Done" is not Done,
  // and a Cancelled/Duplicate status inside the category is (ADR 0004).
  if (category === "done") return { status: name, completion: "done" };
  if (category === "new" || category === "indeterminate") return { status: name, completion: "not-done" };
  return { status: name, completion: null };
}

/**
 * The links the configured types and directions select, one entry per linked
 * issue: a repeated issue keeps the strictest completion, so a second link can
 * never turn an unfinished prerequisite into a satisfied one.
 */
function selectPrerequisites(
  site: string,
  linked: readonly LinkedIssue[],
  configured: readonly PrerequisiteLink[],
): TicketPrerequisite[] {
  const selected = new Map<string, TicketPrerequisite>();
  for (const link of linked) {
    if (!configured.some((entry) => entry.type === link.type && entry.direction === link.side)) continue;
    const previous = selected.get(link.stableId);
    if (previous === undefined || completionRank(link.completion) > completionRank(previous.completion)) {
      selected.set(link.stableId, {
        ticket: jiraTicket({ site, stableId: link.stableId, key: link.key }),
        status: link.status,
        completion: link.completion,
      });
    }
  }
  return [...selected.values()];
}

/** Unknown outranks not-done, which outranks done. */
function completionRank(completion: TicketPrerequisite["completion"]): number {
  return completion === null ? 2 : completion === "not-done" ? 1 : 0;
}

/** One assignee, named for presentation: display name, then email, then id. */
function assigneeName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const field of ["displayName", "emailAddress", "accountId"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

interface ParsedActingAccount {
  accountId: string;
  emailAddress: string | null;
  displayName: string;
  active: boolean;
}

function parseActingAccount(site: string, body: unknown): ParsedActingAccount {
  if (!isRecord(body)) throw new JiraProtocolError(site, "the /myself response is not an object");
  const accountId = body["accountId"];
  if (typeof accountId !== "string" || accountId === "") {
    throw new JiraProtocolError(site, "the /myself response carries no accountId");
  }
  return {
    accountId,
    emailAddress: typeof body["emailAddress"] === "string" ? body["emailAddress"] : null,
    displayName:
      typeof body["displayName"] === "string" && body["displayName"] !== ""
        ? body["displayName"]
        : accountId,
    active: body["active"] !== false,
  };
}

/** Jira's own error text: `errorMessages` first, field errors after, bounded. */
function jiraErrorDetail(text: string): string {
  const flatten = (value: unknown): string => (typeof value === "string" ? value : "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const messages = Array.isArray(parsed["errorMessages"])
        ? parsed["errorMessages"].map(flatten).filter((message) => message !== "")
        : [];
      const errors = isRecord(parsed["errors"]) ? Object.values(parsed["errors"]).map(flatten) : [];
      const detail = [...messages, ...errors].filter((message) => message !== "").join("; ");
      if (detail !== "") return detail.slice(0, 300);
    }
  } catch {
    // Not JSON: the raw body is the detail.
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
