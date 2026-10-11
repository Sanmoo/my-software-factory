import {
  refKey,
  type BlockerRef,
  type ClaimOutcome,
  type Comment,
  type DoneOutcome,
  type IssueRef,
  type IssueSnapshot,
  type Known,
  type StatusCategory,
  type TrackerPort,
  type TrackerScope,
} from "./port.js";

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
  // Some successful writes (204, or 201 for issueLink) answer without a body.
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as T);
}

// JQL string literal: double quotes, with backslashes and quotes escaped.
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const ISSUE_FIELDS = "summary,status,labels,assignee,priority,issuelinks";
const PAGE_SIZE = 100;
const JIRA_MARKER = "[msf]";

// Atlassian Document Format node, as returned for comment bodies.
interface AdfNode {
  type: string;
  text?: string;
  attrs?: { text?: string };
  content?: AdfNode[];
}

interface JiraComment {
  id: string;
  author?: { accountId?: string; accountType?: string };
  body: AdfNode | string;
  created: string;
}

const INLINE_NODES = new Set(["text", "hardBreak", "mention"]);

// Plain text of an ADF body: blocks are separated by newlines, inline runs are concatenated.
function adfText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text ?? "";
  const children = node.content ?? [];
  const inline = children.every((child) => INLINE_NODES.has(child.type));
  return children.map(adfText).join(inline ? "" : "\n");
}

// One ADF paragraph per line of the text.
function adfFromText(text: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line === "" ? [] : [{ type: "text", text: line }],
    })),
  } as unknown as AdfNode;
}

// Shapes of the Jira REST responses the adapter reads; only the fields it uses.
interface JiraStatus {
  statusCategory?: { key?: string };
}
interface JiraLink {
  type?: { name?: string };
  inwardIssue?: { key: string; fields?: { status?: JiraStatus } };
  outwardIssue?: { key: string };
}
interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    labels?: string[];
    assignee?: { accountId: string } | null;
    priority?: { name?: string } | null;
    issuelinks?: JiraLink[];
  };
}

// Jira status categories map to the port's categories; never by status name.
const CATEGORY_BY_KEY: Record<string, StatusCategory> = {
  new: "to-do",
  indeterminate: "in-progress",
  done: "done",
};

function categoryOf(status: JiraStatus | undefined): Known<StatusCategory> {
  if (status === undefined) return { known: false, reason: "status não lido" };
  const category = CATEGORY_BY_KEY[status.statusCategory?.key ?? ""];
  return category ? { known: true, value: category } : { known: false, reason: "categoria de status desconhecida" };
}

function terminalOf(status: JiraStatus): Known<boolean> {
  const category = categoryOf(status);
  return category.known ? { known: true, value: category.value === "done" } : category;
}

// Claimed = the claimed label, or a status category other than To Do. Either one is
// enough; with neither confirmed, the result is unknown unless both were read as false.
function claimedOf(labels: Known<string[]>, category: Known<StatusCategory>, claimedLabel: string): Known<boolean> {
  const byLabel = labels.known ? labels.value.includes(claimedLabel) : undefined;
  const byStatus = category.known ? category.value !== "to-do" : undefined;
  if (byLabel === true || byStatus === true) return { known: true, value: true };
  if (byLabel === false && byStatus === false) return { known: true, value: false };
  const reason = !labels.known ? labels.reason : !category.known ? category.reason : "claim indeterminado";
  return { known: false, reason };
}

// Jira default priority names, most urgent first (P05: lower number = more urgent).
const PRIORITY_RANK: Record<string, number> = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 };

function priorityOf(priority: { name?: string } | null | undefined): Known<number | null> {
  if (priority === undefined) return { known: false, reason: "prioridade não lida" };
  if (priority === null) return { known: true, value: null };
  const rank = PRIORITY_RANK[priority.name ?? ""];
  return rank === undefined ? { known: false, reason: `prioridade sem mapeamento: ${priority.name}` } : { known: true, value: rank };
}

// Issue keys are PROJECTKEY-NUMBER; the project is everything before the last hyphen.
function projectOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
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

  async readIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const issue = await jiraRequest<JiraIssue>(
      this.connection,
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(ref.id)}?fields=${ISSUE_FIELDS}`,
    );
    const fields = issue?.fields ?? {};
    const labels: Known<string[]> = fields.labels === undefined
      ? { known: false, reason: "labels não lidas" }
      : { known: true, value: fields.labels };
    const category = categoryOf(fields.status);
    const claimed = claimedOf(labels, category, this.settings.claimedLabel);
    const assignee: Known<string | null> = fields.assignee === undefined
      ? { known: false, reason: "atribuição não lida" }
      : { known: true, value: fields.assignee?.accountId ?? null };
    return {
      ref,
      title: fields.summary ?? "",
      labels,
      assignees: assignee.known ? { known: true, value: assignee.value === null ? [] : [assignee.value] } : assignee,
      claimed,
      blockers: this.blockersOf(fields.issuelinks),
      statusCategory: category,
      priority: priorityOf(fields.priority),
      openSprint: await this.openSprint(ref.id),
      assignee,
    };
  }

  // Blockers are "is blocked by" links (inwardIssue) of the configured link types.
  private blockersOf(links: JiraLink[] | undefined): Known<BlockerRef[]> {
    if (links === undefined) return { known: false, reason: "links não lidos" };
    const blockers: BlockerRef[] = [];
    for (const link of links) {
      if (link.inwardIssue === undefined) continue;
      if (!this.settings.blockingLinkTypes.includes(link.type?.name ?? "")) continue;
      const blocker = link.inwardIssue;
      const terminal = blocker.fields?.status === undefined
        ? { known: false as const, reason: `estado de ${blocker.key} não lido` }
        : terminalOf(blocker.fields.status);
      blockers.push({
        ref: { tracker: "jira", project: projectOfKey(blocker.key), id: blocker.key },
        terminal,
      });
    }
    return { known: true, value: blockers };
  }

  // `sprint in openSprints()` per issue. A query that Jira rejects (for example a project
  // without a board) is unknown, never "outside the sprint".
  private async openSprint(key: string): Promise<Known<boolean>> {
    try {
      const page = await jiraRequest<{ issues: unknown[] }>(this.connection, "POST", "/rest/api/3/search/jql", {
        jql: `key = ${jqlString(key)} AND sprint in openSprints()`,
        fields: ["key"],
        maxResults: 1,
      });
      return { known: true, value: (page?.issues.length ?? 0) > 0 };
    } catch (error) {
      return { known: false, reason: `sprint não consultada: ${(error as Error).message}` };
    }
  }

  // Adds the claimed label and runs the doing transition, then rereads: the start counts
  // only when the tracker confirms both the claim and the In Progress category.
  async claim(ref: IssueRef): Promise<ClaimOutcome> {
    const before = await this.readIssue(ref);
    if (!before.claimed.known) return { status: "rejected", reason: `claim não lido: ${before.claimed.reason}` };
    if (before.claimed.value) return { status: "rejected", reason: "issue já claimed" };
    const doing = await this.transitionTo(ref.id, this.settings.doingTransition);
    if (doing === undefined) {
      return { status: "rejected", reason: `transição '${this.settings.doingTransition}' indisponível para ${ref.id}` };
    }
    await this.updateLabels(ref.id, [{ add: this.settings.claimedLabel }]);
    await this.runTransition(ref.id, doing);
    const after = await this.readIssue(ref);
    const started = after.claimed.known && after.claimed.value
      && after.statusCategory.known && after.statusCategory.value === "in-progress";
    return started ? { status: "accepted" } : { status: "rejected", reason: "início não confirmado pelo Jira" };
  }

  // Removes the claimed label only; the status is left as it is.
  async releaseClaim(ref: IssueRef): Promise<void> {
    await this.updateLabels(ref.id, [{ remove: this.settings.claimedLabel }]);
  }

  async readComments(ref: IssueRef): Promise<Comment[]> {
    const found: JiraComment[] = [];
    let startAt = 0;
    let total = 0;
    do {
      const page: { total?: number; comments?: JiraComment[] } | undefined = await jiraRequest(
        this.connection,
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(ref.id)}/comment?startAt=${startAt}&maxResults=${PAGE_SIZE}`,
      );
      const items = page?.comments ?? [];
      total = page?.total ?? 0;
      found.push(...items);
      startAt += items.length;
      if (items.length === 0) break;
    } while (startAt < total);
    return found.map((comment) => ({
      id: comment.id,
      author: comment.author?.accountId ?? "desconhecido",
      isBot: comment.author?.accountType === "app",
      body: typeof comment.body === "string" ? comment.body : adfText(comment.body),
      createdAt: comment.created,
    }));
  }

  // Every comment the factory publishes starts with the [msf] marker, added once.
  async postComment(ref: IssueRef, body: string): Promise<string> {
    const text = body.startsWith(JIRA_MARKER) ? body : `${JIRA_MARKER} ${body}`;
    const created = await jiraRequest<{ id: string }>(
      this.connection,
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(ref.id)}/comment`,
      { body: adfFromText(text) },
    );
    if (created === undefined) throw new Error("Jira não devolveu o id do comentário");
    return created.id;
  }

  async markDone(ref: IssueRef): Promise<DoneOutcome> {
    const before = await this.readIssue(ref);
    if (before.statusCategory.known && before.statusCategory.value === "done") return { status: "already-done" };
    const done = await this.transitionTo(ref.id, this.settings.doneTransition);
    if (done === undefined) {
      return { status: "not-confirmed", reason: `transição '${this.settings.doneTransition}' indisponível para ${ref.id}` };
    }
    await this.runTransition(ref.id, done);
    const after = await this.readIssue(ref);
    return after.statusCategory.known && after.statusCategory.value === "done"
      ? { status: "done" }
      : { status: "not-confirmed", reason: "categoria Done não confirmada pelo Jira" };
  }

  private async transitionTo(key: string, name: string): Promise<string | undefined> {
    const page = await jiraRequest<{ transitions: Array<{ id: string; name: string }> }>(
      this.connection,
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return page?.transitions.find((transition) => transition.name === name)?.id;
  }

  private async runTransition(key: string, transitionId: string): Promise<void> {
    await jiraRequest(this.connection, "POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  private async updateLabels(key: string, operations: Array<{ add: string } | { remove: string }>): Promise<void> {
    await jiraRequest(this.connection, "PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      update: { labels: operations },
    });
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
