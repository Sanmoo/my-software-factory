import type { JiraTransport } from "./jira-adapter.js";

/**
 * An in-memory Jira Cloud that speaks the REST dialect the real adapter uses
 * over HTTP  — the process-boundary double of the adapter's
 * contract: `/rest/api/3/myself`, the token-paginated `/rest/api/3/search/jql`
 * and a single-issue read.
 *
 * It models what the adapter's decisions depend on: the Basic credential, the
 * native Rank order (independent of creation date and Priority), opaque
 * pagination tokens, cancel-free reads and Jira's `errorMessages` error shape.
 * Tests drive the REAL adapter against it; the CLI suite patches `fetch` with
 * the same answers through the e2e harness. No network, no Atlassian.
 */

export interface SimJiraAccount {
  accountId: string;
  emailAddress: string;
  displayName: string;
}

export interface SimJiraIssue {
  id: string;
  key: string;
  summary: string;
  /** An Atlassian Document Format document, or null for no description. */
  description: unknown;
  status: { name: string; categoryKey: "new" | "indeterminate" | "done" };
  assignee: SimJiraAccount | null;
  labels: string[];
  issueType: string;
  created: string;
  parentKey?: string;
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
  search?: SimJiraFault;
  issue?: SimJiraFault;
}

export class JiraSim {
  readonly site: string;
  readonly token: string;
  readonly account: SimJiraAccount;
  /** Every issue the sim holds, in the site's native Rank order. */
  issues: SimJiraIssue[] = [];
  /** The page size the sim caps answers at, whatever the request asks. */
  pageSize = 100;
  readonly requests: SimJiraRequest[] = [];
  faults: SimJiraFaults = {};

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
      assignee: input.assignee === undefined ? this.account : input.assignee,
      labels: input.labels ?? [],
      issueType: input.issueType ?? "Task",
      created: input.created ?? "2026-01-01T00:00:00.000+0000",
      ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
    };
    this.issues.push(issue);
    return issue;
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

    const faulted = this.faultFor(path);
    if (faulted !== undefined) return answer(faulted.status, { errorMessages: faulted.messages });

    if (init.method === "GET" && path === "/rest/api/3/myself") {
      return answer(200, this.account);
    }
    if (init.method === "POST" && path === "/rest/api/3/search/jql") {
      return this.search(init.body ?? "", record);
    }
    if (init.method === "GET" && path.startsWith("/rest/api/3/issue/")) {
      return this.readIssue(decodeURIComponent(path.slice("/rest/api/3/issue/".length)));
    }
    return answer(404, { errorMessages: [`the sim has no endpoint ${init.method} ${path}`] });
  }

  private faultFor(path: string): SimJiraFault | undefined {
    if (path === "/rest/api/3/myself") return this.faults.myself;
    if (path === "/rest/api/3/search/jql") return this.faults.search;
    if (path.startsWith("/rest/api/3/issue/")) return this.faults.issue;
    return undefined;
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
    const page = this.issues.slice(start, start + size);
    const end = start + page.length;
    return answer(200, {
      issues: page.map((issue) => this.restIssue(issue)),
      ...(end < this.issues.length ? { nextPageToken: String(end), isLast: false } : { isLast: true }),
    });
  }

  private readIssue(idOrKey: string) {
    const issue = this.issues.find((entry) => entry.id === idOrKey || entry.key === idOrKey);
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
        created: issue.created,
        ...(issue.parentKey === undefined ? {} : { parent: { key: issue.parentKey } }),
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

function answer(status: number, body: unknown): { status: number; text: string } {
  return { status, text: JSON.stringify(body) };
}
