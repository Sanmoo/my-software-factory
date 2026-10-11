import type { IssueRef, IssueSnapshot, ClaimOutcome, Comment, DoneOutcome, TrackerPort, TrackerScope } from "./port.js";

// Jira Cloud adapter for the normalized TrackerPort. Credentials come only from the
// JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN environment variables; values are never
// printed. States are read by status category, never by name; only the transition
// names for doing and done are configured.

export interface JiraConnection {
  baseUrl: string;
  username: string;
  apiToken: string;
}

export interface JiraTrackerSettings {
  // Label that marks an issue as claimed by the factory (ProjectLabels.claimed).
  claimedLabel: string;
  // Transition names configured per project; matched exactly.
  doingTransition: string;
  doneTransition: string;
  // Link type names whose "is blocked by" direction blocks the issue.
  blockingLinkTypes: readonly string[];
}

export const JIRA_ENV_VARS = ["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"] as const;

export class JiraConfigError extends Error {}

export class JiraRequestError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    // Response bodies are not echoed: they may contain user data or echoed credentials.
    super(`Jira ${method} ${path} respondeu HTTP ${status}`);
  }
}

export function jiraConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConnection {
  const missing = JIRA_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new JiraConfigError(`variáveis de ambiente ausentes: ${missing.join(", ")}`);
  }
  return {
    baseUrl: env.JIRA_URL as string,
    username: env.JIRA_USERNAME as string,
    apiToken: env.JIRA_API_TOKEN as string,
  };
}

export async function jiraRequest<T = unknown>(
  connection: JiraConnection,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const credentials = Buffer.from(`${connection.username}:${connection.apiToken}`).toString("base64");
  const headers: Record<string, string> = { accept: "application/json", authorization: `Basic ${credentials}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${connection.baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new JiraRequestError(response.status, method, path.split("?")[0]);
  if (response.status === 204) return undefined;
  return (await response.json()) as T;
}

// JQL string literal: double quotes, with backslashes and quotes escaped.
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class JiraTracker implements TrackerPort {
  constructor(
    private readonly connection: JiraConnection,
    private readonly settings: JiraTrackerSettings,
  ) {}

  async discoverCandidates(scope: TrackerScope): Promise<IssueRef[]> {
    const jql = `project = ${jqlString(scope.project)} AND labels = ${jqlString(scope.readyLabel)} ORDER BY key ASC`;
    const issues = await this.searchAll(jql, ["key"]);
    return issues.map((issue) => ({ tracker: "jira", project: scope.project, id: issue.key }));
  }

  async readIssue(_ref: IssueRef): Promise<IssueSnapshot> {
    throw new Error("não implementado");
  }

  async claim(_ref: IssueRef): Promise<ClaimOutcome> {
    throw new Error("não implementado");
  }

  async releaseClaim(_ref: IssueRef): Promise<void> {
    throw new Error("não implementado");
  }

  async readComments(_ref: IssueRef): Promise<Comment[]> {
    throw new Error("não implementado");
  }

  async postComment(_ref: IssueRef, _body: string): Promise<string> {
    throw new Error("não implementado");
  }

  async markDone(_ref: IssueRef): Promise<DoneOutcome> {
    throw new Error("não implementado");
  }

  // Follows nextPageToken until Jira reports the last page.
  private async searchAll(jql: string, fields: string[]): Promise<Array<{ key: string }>> {
    const found: Array<{ key: string }> = [];
    let nextPageToken: string | undefined;
    do {
      const page: { issues: Array<{ key: string }>; nextPageToken?: string; isLast?: boolean } | undefined =
        await jiraRequest(this.connection, "POST", "/rest/api/3/search/jql", {
          jql,
          fields,
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      found.push(...(page?.issues ?? []));
      nextPageToken = page?.isLast === false ? page.nextPageToken : undefined;
    } while (nextPageToken);
    return found;
  }
}
