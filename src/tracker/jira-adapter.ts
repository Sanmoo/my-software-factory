import type { Labels } from "../config.js";
import type {
  OpenTicket,
  TicketBlocker,
  TicketSelection,
  TicketSnapshot,
  TicketTracker,
} from "./expanded-port.js";
import type { IssueComment, Known, WriteOutcome } from "./port.js";
import { known, notKnown } from "./port.js";
import { jiraTicket, type JiraTicketIdentity, type TicketIdentity, type TicketSource } from "./identity.js";
import { renderAdf } from "./jira-adf.js";
import { withNativeRankOrdering } from "./jira-jql.js";

/**
 * The real Jira Cloud ticket adapter (issue 128): reads over the REST API v3
 * with a locally referenced Atlassian API token (HTTP Basic, `account:token`).
 * `/myself` identifies the authenticated account — the Acting account the
 * factory acts as; JQL's `currentUser()` means THAT account, never an
 * implicitly different human operator.
 *
 * This slice is READ-ONLY: listing (native, token-paginated Rank order) and
 * one ticket's usable content. Every mutation (and dependency/comment/rank
 * read this slice does not own) is refused before any HTTP write; `msf run`
 * also refuses a Jira configuration before any claim, so no launch path
 * pretends the missing operations exist.
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
  /** Items per native page (Jira's own cap still applies). */
  pageSize?: number;
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

/** An operation this slice does not implement: refused before any write. */
export class UnsupportedJiraOperationError extends Error {
  constructor(site: string, operation: string) {
    super(
      `Jira ${operation} is not implemented yet for site "${site}": ` +
        `this release reads Jira candidates only and refuses the operation before anything is sent`,
    );
    this.name = "UnsupportedJiraOperationError";
  }
}

const MYSELF_PATH = "/rest/api/3/myself";
const SEARCH_PATH = "/rest/api/3/search/jql";
/** The listing requests only the facts a candidate needs; the JQL decides selection. */
const LIST_FIELDS = ["summary", "labels", "assignee", "created"];
const READ_FIELDS = ["summary", "description", "labels", "assignee", "created"];

/** The negative forms Jira uses when the site cannot order by Rank. */
const RANK_UNAVAILABLE =
  /rank[^.;]{0,80}(?:not\s+(?:exist|searchable|supported|available)|unavailable|invalid|unsupported)|(?:not\s+(?:exist|searchable|supported|available)|invalid|unsupported)[^.;]{0,40}rank/i;

export class JiraTicketAdapter implements TicketTracker {
  readonly site: string;
  readonly account: string;
  readonly tokenEnv: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: JiraTransport;
  private readonly pageSize: number;
  /** `/myself` runs once per adapter; a failure is retried on the next call. */
  private identity: Promise<JiraActingAccount> | null = null;

  constructor(options: JiraAdapterOptions) {
    this.site = options.site;
    this.account = options.account;
    this.tokenEnv = options.tokenEnv;
    this.env = options.env ?? process.env;
    this.transport = options.transport ?? jiraHttpTransport;
    this.pageSize = options.pageSize ?? 100;
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

  private async identify(): Promise<JiraActingAccount> {
    const json = await this.requestJson("GET", MYSELF_PATH);
    const account = parseActingAccount(this.site, json);
    if (account.active === false) {
      throw new JiraAuthenticationError(this.site, `the account "${account.displayName}" is inactive`);
    }
    // The configured account must be the one the credential authenticated as:
    // an unidentified identity is refused, never relabelled as the config's.
    if (account.emailAddress === null) {
      throw new JiraAuthenticationError(
        this.site,
        "the site did not report the authenticated account's email, so the configured account cannot be verified",
      );
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
    this.assertSelection(selection);
    const jql = selection.jql;
    if (jql === undefined || jql.trim() === "") {
      throw new JiraSelectionError(`the Jira selection for site "${this.site}" carries no JQL`);
    }
    const ordering = withNativeRankOrdering(jql);
    if (!ordering.ok) throw new JiraInvalidJqlError(this.site, ordering.because);
    await this.actingAccount();

    const tickets: OpenTicket[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        jql: ordering.jql,
        fields: LIST_FIELDS,
        maxResults: this.pageSize,
        ...(pageToken === undefined ? {} : { nextPageToken: pageToken }),
      };
      const page = parseSearchPage(this.site, await this.requestJson("POST", SEARCH_PATH, body));
      for (const issue of page.issues) tickets.push(openTicket(this.site, issue));
      if (page.nextPageToken === null || page.isLast) return tickets;
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
      `${SEARCH_ISSUE_PATH(source.stableId)}?fields=${READ_FIELDS.join(",")}`,
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

  // ---- the operations this read-only slice refuses ----

  readTicketBlockers(_ticket: TicketIdentity): Promise<Known<TicketBlocker[]>> {
    return this.refuse("dependency read");
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
    return this.refuse("comment");
  }

  readTicketComments(_ticket: TicketIdentity): Promise<Known<IssueComment[]>> {
    return this.refuse("comment read");
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

  private assertSelection(selection: TicketSelection): void {
    this.assertSource(selection.source);
  }

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
export function jiraBrowseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`;
}

const SEARCH_ISSUE_PATH = (stableId: string): string => `/rest/api/3/issue/${encodeURIComponent(stableId)}`;

class JiraNotFoundError extends Error {
  constructor(site: string, detail: string) {
    super(`Jira site "${site}" does not expose this ticket (${detail})`);
    this.name = "JiraNotFoundError";
  }
}

// ---- REST shapes the adapter reads ----

function parseSearchPage(site: string, body: unknown): {
  issues: unknown[];
  nextPageToken: string | null;
  isLast: boolean;
} {
  if (!isRecord(body) || !Array.isArray(body["issues"])) {
    throw new JiraProtocolError(site, "the search response carries no issues array");
  }
  const token = body["nextPageToken"];
  if (token !== undefined && typeof token !== "string") {
    throw new JiraProtocolError(site, "the search response carries a non-string page token");
  }
  return {
    issues: body["issues"] as unknown[],
    nextPageToken: typeof token === "string" && token !== "" ? token : null,
    isLast: body["isLast"] === true,
  };
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
