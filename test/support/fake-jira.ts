import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { JiraTracker, type JiraConnection, type JiraTrackerSettings } from "../../src/tracker/jira.js";
import type { IssueRef } from "../../src/tracker/port.js";

// A local HTTP fake of the Jira Cloud REST endpoints the adapter uses, shared by the adapter
// tests and the tracker contract. The fake stands in for the system boundary only; it records
// every request so read-only paths can be shown to write nothing.

export const OPERATOR_ACCOUNT = "acc-operator";
export const TOKEN = "fake-token-for-tests";
export const USERNAME = "operator@example.test";

type Category = "new" | "indeterminate" | "done";

interface FakeLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: string;
  outwardIssue?: string;
}

interface FakeTransition {
  id: string;
  name: string;
  to: Category;
}

interface FakeComment {
  id: string;
  accountId: string;
  accountType?: string;
  body: unknown;
  created: string;
}

export interface FakeIssue {
  key: string;
  summary: string;
  // Plain text of the description; null is an issue without description.
  description?: string | null;
  labels: string[];
  statusName: string;
  category: Category;
  assignee: string | null;
  priority?: string | null;
  openSprint: boolean;
  links: FakeLink[];
  transitions: FakeTransition[];
  comments: FakeComment[];
  // Set to omit a field from the response, modelling a field the adapter cannot read.
  hideStatus?: boolean;
}

interface Recorded {
  method: string;
  path: string;
}

const PAGE_SIZE = 2;

// Jira issue linking model: an issue carrying inwardIssue for a Blocks link is blocked by
// that issue (GET /rest/api/3/issue of THING-1 lists inwardIssue FEAT-1 as "is blocked by").
export const BLOCKS = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
export const RELATES = { name: "Relates", inward: "relates to", outward: "relates to" };

export function fakeIssue(overrides: Partial<FakeIssue> & { key: string }): FakeIssue {
  return {
    summary: `${overrides.key} summary`,
    description: null,
    labels: ["ready-for-agent", "playbooks"],
    statusName: "A Fazer",
    category: "new",
    assignee: OPERATOR_ACCOUNT,
    priority: "Medium",
    openSprint: true,
    links: [],
    transitions: [
      { id: "11", name: "Em andamento", to: "indeterminate" },
      { id: "31", name: "Itens concluídos", to: "done" },
    ],
    comments: [],
    ...overrides,
  };
}

// Undefined leaves the priority field out of the response; null is "no priority".
function priorityJson(priority: string | null | undefined): { name: string } | null | undefined {
  if (priority === undefined || priority === null) return priority;
  return { name: priority };
}

export const projectOf = (key: string) => key.slice(0, key.lastIndexOf("-"));

export const adf = (...paragraphs: string[][]) => ({
  type: "doc",
  version: 1,
  content: paragraphs.map((runs) => ({
    type: "paragraph",
    content: runs.map((text) => ({ type: "text", text })),
  })),
});

export class FakeJira {
  readonly requests: Recorded[] = [];
  readonly issues = new Map<string, FakeIssue>();
  authorization: string | undefined;
  failTransitionWrites = false;
  private nextCommentId = 900;

  constructor(issues: FakeIssue[]) {
    for (const issue of issues) this.issues.set(issue.key, issue);
  }

  writes(): Recorded[] {
    return this.requests.filter((request) => request.method !== "GET" && !(request.method === "POST" && request.path === "/rest/api/3/search/jql"));
  }

  handle(method: string, url: URL, body: Record<string, unknown>): { status: number; json?: unknown } {
    const path = url.pathname;
    if (method === "POST" && path === "/rest/api/3/search/jql") return this.search(body);

    const match = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(path);
    if (!match) return { status: 404 };
    const issue = this.issues.get(match[1]);
    if (!issue) return { status: 404 };
    const sub = match[2];

    if (sub === undefined) {
      if (method === "GET") return { status: 200, json: this.issueJson(issue) };
      if (method === "PUT") return this.updateLabels(issue, body);
    }
    if (sub === "/transitions") {
      if (method === "GET") {
        return { status: 200, json: { transitions: issue.transitions.map((t) => ({ id: t.id, name: t.name, to: { name: t.name, statusCategory: { key: t.to } } })) } };
      }
      if (method === "POST") return this.transition(issue, body);
    }
    if (sub === "/comment") {
      if (method === "GET") return this.comments(issue, url);
      if (method === "POST") return this.addComment(issue, body);
    }
    return { status: 405 };
  }

  private search(body: Record<string, unknown>): { status: number; json?: unknown } {
    const jql = String(body.jql);
    const discovery = /^project = "([^"]+)" AND labels = "([^"]+)" ORDER BY key ASC$/.exec(jql);
    const sprint = /^key = "([^"]+)" AND sprint in openSprints\(\)$/.exec(jql);
    let matches: FakeIssue[];
    if (discovery) {
      matches = [...this.issues.values()]
        .filter((issue) => projectOf(issue.key) === discovery[1] && issue.labels.includes(discovery[2]))
        .sort((a, b) => a.key.localeCompare(b.key));
    } else if (sprint) {
      // Models a project without a board, where openSprints() is rejected by Jira.
      if (this.issues.get(sprint[1])?.summary === "NO_BOARD") return { status: 400 };
      matches = [...this.issues.values()].filter((issue) => issue.key === sprint[1] && issue.openSprint);
    } else {
      return { status: 400 };
    }
    const offset = Number(body.nextPageToken ?? 0);
    const page = matches.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE < matches.length ? String(offset + PAGE_SIZE) : undefined;
    return {
      status: 200,
      json: {
        issues: page.map((issue) => ({ key: issue.key, fields: {} })),
        ...(next ? { nextPageToken: next } : {}),
        isLast: next === undefined,
      },
    };
  }

  private issueJson(issue: FakeIssue): unknown {
    const fields: Record<string, unknown> = {
      summary: issue.summary,
      description: issue.description === undefined || issue.description === null ? issue.description : adf(...issue.description.split("\n").map((line) => [line])),
      labels: issue.labels,
      assignee: issue.assignee === null ? null : { accountId: issue.assignee, displayName: "Operator" },
      priority: priorityJson(issue.priority),
      issuelinks: issue.links.map((link) => {
        const other = link.inwardIssue ?? link.outwardIssue ?? "";
        const target = this.issues.get(other);
        const linked = {
          key: other,
          fields: {
            summary: target?.summary ?? other,
            ...(target && !target.hideStatus
              ? { status: { name: target.statusName, statusCategory: { key: target.category } } }
              : {}),
          },
        };
        return {
          id: `${issue.key}-${other}`,
          type: link.type,
          ...(link.inwardIssue === undefined ? {} : { inwardIssue: linked }),
          ...(link.outwardIssue === undefined ? {} : { outwardIssue: linked }),
        };
      }),
    };
    if (!issue.hideStatus) {
      fields.status = { name: issue.statusName, statusCategory: { key: (issue.category) } };
    }
    return { key: issue.key, fields };
  }

  private updateLabels(issue: FakeIssue, body: Record<string, unknown>): { status: number } {
    const update = body.update as { labels?: Array<{ add?: string; remove?: string }> } | undefined;
    for (const op of update?.labels ?? []) {
      if (op.add !== undefined && !issue.labels.includes(op.add)) issue.labels.push(op.add);
      if (op.remove !== undefined) issue.labels = issue.labels.filter((label) => label !== op.remove);
    }
    return { status: 204 };
  }

  private transition(issue: FakeIssue, body: Record<string, unknown>): { status: number } {
    if (this.failTransitionWrites) return { status: 500 };
    const id = (body.transition as { id?: string } | undefined)?.id;
    const target = issue.transitions.find((t) => t.id === id);
    if (!target) return { status: 400 };
    issue.category = target.to;
    issue.statusName = target.name;
    // Jira answers some successful writes with 201 and no body (as issueLink does).
    return { status: 201 };
  }

  private comments(issue: FakeIssue, url: URL): { status: number; json?: unknown } {
    const startAt = Number(url.searchParams.get("startAt") ?? 0);
    const page = issue.comments.slice(startAt, startAt + PAGE_SIZE).map((comment) => ({
      id: comment.id,
      author: { accountId: comment.accountId, displayName: "Author", accountType: comment.accountType ?? "atlassian" },
      body: comment.body,
      created: comment.created,
    }));
    return { status: 200, json: { startAt, maxResults: PAGE_SIZE, total: issue.comments.length, comments: page } };
  }

  private addComment(issue: FakeIssue, body: Record<string, unknown>): { status: number; json?: unknown } {
    const id = String(this.nextCommentId++);
    issue.comments.push({ id, accountId: OPERATOR_ACCOUNT, body: body.body, created: "2026-05-01T12:00:00.000+0000" });
    return { status: 201, json: { id } };
  }
}

export async function startFake(fake: FakeJira): Promise<{ server: Server; connection: JiraConnection }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    fake.authorization = req.headers.authorization;
    fake.requests.push({ method: req.method ?? "", path: new URL(req.url ?? "/", "http://fake").pathname });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const result = fake.handle(req.method ?? "", new URL(req.url ?? "/", "http://fake"), body);
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.json === undefined ? "" : JSON.stringify(result.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, connection: { baseUrl: `http://127.0.0.1:${port}`, username: USERNAME, apiToken: TOKEN } };
}

export const SETTINGS: JiraTrackerSettings = {
  claimedLabel: "agent-claimed",
  doingTransition: "Em andamento",
  doneTransition: "Itens concluídos",
  blockingLinkTypes: ["Blocks"],
};

export async function withTracker<T>(issues: FakeIssue[], run: (tracker: JiraTracker, fake: FakeJira) => Promise<T>): Promise<T> {
  const fake = new FakeJira(issues);
  const { server, connection } = await startFake(fake);
  try {
    return await run(new JiraTracker(connection, SETTINGS), fake);
  } finally {
    server.close();
  }
}

export const ref = (id: string): IssueRef => ({ tracker: "jira", project: projectOf(id), id });
