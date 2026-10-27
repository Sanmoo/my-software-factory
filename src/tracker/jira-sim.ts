import type { JiraTransport } from "./jira-adapter.js";

/**
 * An in-memory Jira Cloud that speaks the REST dialect the real adapter uses
 * over HTTP — the process-boundary double of the adapter's
 * contract: `/rest/api/3/myself`, the token-paginated `/rest/api/3/search/jql`,
 * a single-issue read, and the comment conversation/publication.
 *
 * It models what the adapter's decisions depend on: the Basic credential, the
 * native Rank order (independent of creation date and Priority), opaque
 * pagination tokens, cancel-free reads, the issue's typed/directional links
 * with the linked issue's status category, and Jira's `errorMessages` error
 * shape. Tests drive the REAL adapter against it; the CLI suite patches `fetch`
 * with the same answers through the e2e harness. No network, no Atlassian.
 */

export interface SimJiraAccount {
  accountId: string;
  emailAddress: string;
  displayName: string;
}

export interface SimJiraComment {
  id: string;
  author: SimJiraAccount | null;
  /** An ADF document, as Jira stores it. */
  body: unknown;
  created: string;
  /** Jira comment properties: the factory's structured speech evidence. */
  properties?: Array<{ key: string; value: unknown }>;
}

export interface SimJiraIssue {
  id: string;
  key: string;
  summary: string;
  /** An Atlassian Document Format document, or null for no description. */
  description: unknown;
  status: { name: string; categoryKey: "new" | "indeterminate" | "done" };
  /** Jira's resolution name, when the issue carries one: business success,
   *  which is never this adapter's completion fact. */
  resolution?: string;
  assignee: SimJiraAccount | null;
  labels: string[];
  issueType: string;
  /** Jira Priority, when the test models it; Rank order deliberately does not
   *  read this field. */
  priority?: string;
  created: string;
  parentKey?: string;
  /** The issue's own links, as the site reports them. */
  links: SimJiraLink[];
  /** The issue's conversation, oldest first. */
  comments?: SimJiraComment[];
}

/** The link types a Jira Cloud site starts with: the vocabulary a configured
 *  rule must name (a site may add its own). */
export const DEFAULT_LINK_TYPES = ["Blocks", "Cloners", "Duplicate", "Relates"] as const;

/** One link of an issue: the site's link type and the side the OTHER issue is on. */
export interface SimJiraLink {
  type: string;
  /** The side the linked issue sits on, as the link object lists it
   *  (`inwardIssue`/`outwardIssue`). */
  side: "inward" | "outward";
  key: string;
}

export interface SimJiraRequest {
  method: string;
  path: string;
  /** The selection query a search carried (null for other requests). */
  jql: string | null;
  /** The paging token a search carried, when any. */
  nextPageToken: string | null;
  /** The Basic credential presented, verbatim (test observation only). */
  authorization: string | null;
}

export interface SimJiraFault {
  status: number;
  messages: string[];
}

export interface SimJiraFaults {
  myself?: SimJiraFault;
  linkTypes?: SimJiraFault;
  search?: SimJiraFault;
  issue?: SimJiraFault;
  commentRead?: SimJiraFault;
  commentCreate?: SimJiraFault;
}

export class JiraSim {
  readonly site: string;
  readonly token: string;
  readonly account: SimJiraAccount;
  /** Every issue the sim holds, in the site's native Rank order. */
  issues: SimJiraIssue[] = [];
  /** Test-side stand-in for Jira's JQL evaluation; absent means "select all",
   *  which keeps the one-selection suites concise. */
  select: ((jql: string, issues: readonly SimJiraIssue[]) => readonly SimJiraIssue[]) | null = null;
  /** Issues whose state the site will not show: their links arrive without the
   *  linked issue's fields — an unknown prerequisite, never a satisfied one. */
  hidden = new Set<string>();
  /** The site's own link type names, as `/issueLinkType` reports them. */
  linkTypes: string[] = [...DEFAULT_LINK_TYPES];
  /** The page size the sim caps answers at, whatever the request asks. */
  pageSize = 100;
  readonly requests: SimJiraRequest[] = [];
  faults: SimJiraFaults = {};
  private nextCommentId = 50_000;

  constructor(options: { site?: string; token?: string; account?: SimJiraAccount } = {}) {
    this.site = options.site ?? "acme.atlassian.net";
    this.token = options.token ?? "sim-jira-api-token";
    this.account = options.account ?? {
      accountId: "5b10ac8d82e05b22cc7d4ef5",
      emailAddress: "bot@acme.example",
      displayName: "Factory Bot",
    };
  }

  /** Seed one issue; the call order is the site's Rank order, deliberately
   *  independent of `created` and of any Priority. */
  addIssue(input: Partial<SimJiraIssue> & { key: string; summary: string }): SimJiraIssue {
    const issue: SimJiraIssue = {
      id: input.id ?? String(10_000 + this.issues.length),
      key: input.key,
      summary: input.summary,
      description: input.description ?? null,
      status: input.status ?? { name: "To Do", categoryKey: "new" },
      ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      assignee: input.assignee === undefined ? this.account : input.assignee,
      labels: input.labels ?? [],
      issueType: input.issueType ?? "Task",
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      created: input.created ?? "2026-01-01T00:00:00.000+0000",
      links: input.links ?? [],
      ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
      comments: input.comments ?? [],
    };
    this.issues.push(issue);
    return issue;
  }

  /** Seed one comment; `properties` is how the factory's speech is marked. */
  addComment(key: string, input: Partial<SimJiraComment> & { body: unknown }): SimJiraComment {
    const issue = this.issue(key);
    if (issue === undefined) throw new Error(`the sim holds no issue ${key}`);
    const comment: SimJiraComment = {
      id: input.id ?? String(this.nextCommentId++),
      author: input.author === undefined ? this.account : input.author,
      body: input.body,
      created: input.created ?? "2026-01-02T00:00:00.000+0000",
      ...(input.properties === undefined ? {} : { properties: input.properties }),
    };
    (issue.comments ??= []).push(comment);
    return comment;
  }

  /** The transport the real adapter runs against. */
  readonly transport: JiraTransport = (url, init) => Promise.resolve(this.respond(url, init));

  private respond(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return answer(400, { errorMessages: [`the sim cannot parse the URL ${url}`] });
    }
    const path = parsed.pathname;
    const authorization = init.headers["authorization"] ?? null;
    const record: SimJiraRequest = {
      method: init.method,
      path,
      jql: null,
      nextPageToken: null,
      authorization,
    };
    this.requests.push(record);

    if (parsed.host !== this.site) {
      return answer(404, { errorMessages: [`the sim holds no site ${parsed.host}`] });
    }
    // The token authenticates as the sim's account: the presented login is the
    // credential's own, so /myself reports the canonical identity the adapter
    // must compare with its configured account.
    const presented = basicCredential(authorization);
    if (presented === null || presented.token !== this.token) {
      return answer(401, { errorMessages: ["Unauthorized"] });
    }

    const faulted = this.faultFor(path, init.method);
    if (faulted !== undefined) return answer(faulted.status, { errorMessages: faulted.messages });

    if (init.method === "GET" && path === "/rest/api/3/myself") {
      return answer(200, this.account);
    }
    if (init.method === "GET" && path === "/rest/api/3/issueLinkType") {
      return answer(200, { issueLinkTypes: this.linkTypes.map((name, index) => ({ id: String(index + 1), name })) });
    }
    if (init.method === "POST" && path === "/rest/api/3/search/jql") {
      return this.search(init.body ?? "", record);
    }
    const commentPath = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path);
    if (commentPath !== null) {
      const idOrKey = decodeURIComponent(commentPath[1]!);
      if (init.method === "GET") return this.readComments(parsed, idOrKey);
      if (init.method === "POST") return this.createComment(idOrKey, init.body ?? "");
    }
    if (init.method === "GET" && path.startsWith("/rest/api/3/issue/")) {
      return this.readIssue(decodeURIComponent(path.slice("/rest/api/3/issue/".length)));
    }
    return answer(404, { errorMessages: [`the sim has no endpoint ${init.method} ${path}`] });
  }

  private faultFor(path: string, method: string): SimJiraFault | undefined {
    if (path === "/rest/api/3/myself") return this.faults.myself;
    if (path === "/rest/api/3/issueLinkType") return this.faults.linkTypes;
    if (path === "/rest/api/3/search/jql") return this.faults.search;
    if (/\/comment$/.test(path)) {
      return method === "POST" ? this.faults.commentCreate : this.faults.commentRead;
    }
    if (path.startsWith("/rest/api/3/issue/")) return this.faults.issue;
    return undefined;
  }

  private issue(idOrKey: string): SimJiraIssue | undefined {
    return this.issues.find((entry) => entry.id === idOrKey || entry.key === idOrKey);
  }

  private readComments(url: URL, idOrKey: string) {
    const issue = this.issue(idOrKey);
    if (issue === undefined) {
      return answer(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    const comments = issue.comments ?? [];
    const startAt = Number(url.searchParams.get("startAt") ?? "0");
    const maxResults = Number(url.searchParams.get("maxResults") ?? "100");
    const page = comments.slice(startAt, startAt + Math.max(1, Math.min(maxResults, this.pageSize)));
    return answer(200, {
      startAt,
      maxResults: page.length,
      total: comments.length,
      comments: page.map(commentRest),
    });
  }

  private createComment(idOrKey: string, raw: string) {
    const issue = this.issue(idOrKey);
    if (issue === undefined) {
      return answer(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    let parsed: { body?: unknown; properties?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return answer(400, { errorMessages: ["the comment body is not JSON"] });
    }
    if (parsed.body === null || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      return answer(400, { errorMessages: ["the comment body is not an ADF document"] });
    }
    if (!Array.isArray(parsed.properties)) {
      return answer(400, { errorMessages: ["the comment carries no properties"] });
    }
    const comment: SimJiraComment = {
      id: String(this.nextCommentId++),
      author: this.account,
      body: parsed.body,
      created: "2026-01-03T00:00:00.000+0000",
      properties: parsed.properties as Array<{ key: string; value: unknown }>,
    };
    (issue.comments ??= []).push(comment);
    return answer(201, commentRest(comment));
  }

  private search(raw: string, record: SimJiraRequest) {
    let body: { jql?: unknown; maxResults?: unknown; nextPageToken?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return answer(400, { errorMessages: ["the search body is not JSON"] });
    }
    if (typeof body.jql !== "string") return answer(400, { errorMessages: ["the search carries no JQL"] });
    record.jql = body.jql;

    const requested = typeof body.maxResults === "number" ? body.maxResults : 50;
    let start = 0;
    if (body.nextPageToken !== undefined) {
      if (typeof body.nextPageToken !== "string" || !/^\d+$/.test(body.nextPageToken)) {
        return answer(400, { errorMessages: ["the page token is invalid"] });
      }
      record.nextPageToken = body.nextPageToken;
      start = Number(body.nextPageToken);
    }
    const size = Math.max(1, Math.min(requested, this.pageSize));
    const selected = this.select === null ? this.issues : [...this.select(record.jql ?? "", this.issues)];
    const page = selected.slice(start, start + size);
    const end = start + page.length;
    return answer(200, {
      issues: page.map((issue) => this.restIssue(issue)),
      ...(end < selected.length ? { nextPageToken: String(end), isLast: false } : { isLast: true }),
    });
  }

  private readIssue(idOrKey: string) {
    const issue = this.issue(idOrKey);
    if (issue === undefined) {
      return answer(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    return answer(200, this.restIssue(issue));
  }

  private restIssue(issue: SimJiraIssue) {
    return {
      id: issue.id,
      key: issue.key,
      self: `https://${this.site}/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { name: issue.status.name, statusCategory: { key: issue.status.categoryKey } },
        ...(issue.resolution === undefined ? {} : { resolution: { name: issue.resolution } }),
        assignee:
          issue.assignee === null
            ? null
            : {
                accountId: issue.assignee.accountId,
                emailAddress: issue.assignee.emailAddress,
                displayName: issue.assignee.displayName,
              },
        labels: issue.labels,
        issuetype: { name: issue.issueType, subtask: issue.parentKey !== undefined },
        priority: { name: issue.priority ?? "Medium" },
        created: issue.created,
        issuelinks: issue.links.map((link, index) => ({
          id: String(index + 1),
          type: { name: link.type },
          ...(link.side === "inward"
            ? { inwardIssue: this.linkedIssue(link.key) }
            : { outwardIssue: this.linkedIssue(link.key) }),
        })),
        ...(issue.parentKey === undefined ? {} : { parent: { key: issue.parentKey } }),
      },
    };
  }

  /** The linked issue as Jira includes it in a link: its identity always, its
   *  fields only when the site shows its state. A key the sim does not hold is
   *  a link the site cannot identify — no id, no key. */
  private linkedIssue(key: string) {
    const other = this.issues.find((entry) => entry.key === key);
    if (other === undefined) return { key, self: `https://${this.site}/rest/api/3/issue/${key}` };
    const identity = { id: other.id, key: other.key, self: `https://${this.site}/rest/api/3/issue/${other.id}` };
    if (this.hidden.has(key)) return identity;
    return {
      ...identity,
      fields: {
        summary: other.summary,
        status: { name: other.status.name, statusCategory: { key: other.status.categoryKey } },
        ...(other.resolution === undefined ? {} : { resolution: { name: other.resolution } }),
      },
    };
  }
}

/** The Atlassian Basic credential: `Basic base64(account:api-token)`. */
export function basic(account: string, token: string): string {
  return `Basic ${Buffer.from(`${account}:${token}`, "utf8").toString("base64")}`;
}

/** The login and token a Basic header presents, or null when it is not Basic. */
function basicCredential(header: string | null): { account: string; token: string } | null {
  if (header === null || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { account: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
}

function commentRest(comment: SimJiraComment) {
  return {
    id: comment.id,
    author:
      comment.author === null
        ? null
        : {
            accountId: comment.author.accountId,
            emailAddress: comment.author.emailAddress,
            displayName: comment.author.displayName,
          },
    body: comment.body,
    created: comment.created,
    ...(comment.properties === undefined ? {} : { properties: comment.properties }),
  };
}

function answer(status: number, body: unknown): { status: number; text: string } {
  return { status, text: JSON.stringify(body) };
}
