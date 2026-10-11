import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  JiraTracker,
  jiraConnectionFromEnv,
  type JiraConnection,
  type JiraTrackerSettings,
} from "../src/tracker/jira.js";
import type { IssueRef } from "../src/tracker/port.js";

// Jira adapter seams: the TrackerPort of JiraTracker, exercised against a local HTTP
// fake of the Jira Cloud REST endpoints it uses. The fake stands in for the system
// boundary only; it records every request so read-only paths can be shown to write nothing.

const OPERATOR_ACCOUNT = "acc-operator";
const TOKEN = "fake-token-for-tests";
const USERNAME = "operator@example.test";

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

interface FakeIssue {
  key: string;
  summary: string;
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

const BLOCKS = { name: "Blocks", inward: "is blocked by", outward: "blocks" };

function fakeIssue(overrides: Partial<FakeIssue> & { key: string }): FakeIssue {
  return {
    summary: `${overrides.key} summary`,
    labels: ["ready-for-agent", "playbooks"],
    statusName: "A Fazer",
    category: "new",
    assignee: OPERATOR_ACCOUNT,
    priority: "Medium",
    openSprint: true,
    links: [],
    transitions: [
      { id: "11", name: "Em andamento", to: "indeterminate" },
      { id: "31", name: "Concluído", to: "done" },
    ],
    comments: [],
    ...overrides,
  };
}

const projectOf = (key: string) => key.slice(0, key.lastIndexOf("-"));

class FakeJira {
  readonly requests: Recorded[] = [];
  readonly issues = new Map<string, FakeIssue>();
  authorization: string | undefined;
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
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
      labels: issue.labels,
      assignee: issue.assignee === null ? null : { accountId: issue.assignee, displayName: "Operator" },
      priority: issue.priority === undefined ? undefined : issue.priority === null ? null : { name: issue.priority },
      issuelinks: issue.links.map((link) => {
        const other = link.inwardIssue ?? link.outwardIssue ?? "";
        const target = this.issues.get(other);
        const linked = {
          key: other,
          fields: {
            summary: target?.summary ?? other,
            status: { name: target?.statusName ?? "?", statusCategory: { key: target ? target.category : "undefined" } },
          },
        };
        return {
          id: `${issue.key}-${other}`,
          type: link.type,
          ...(link.inwardIssue !== undefined ? { inwardIssue: linked.key ? linked : undefined } : {}),
          ...(link.outwardIssue !== undefined ? { outwardIssue: linked } : {}),
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
    const id = (body.transition as { id?: string } | undefined)?.id;
    const target = issue.transitions.find((t) => t.id === id);
    if (!target) return { status: 400 };
    issue.category = target.to;
    issue.statusName = target.name;
    return { status: 204 };
  }

  private comments(issue: FakeIssue, url: URL): { status: number; json?: unknown } {
    const startAt = Number(url.searchParams.get("startAt") ?? 0);
    const page = issue.comments.slice(startAt, startAt + PAGE_SIZE);
    return { status: 200, json: { startAt, maxResults: PAGE_SIZE, total: issue.comments.length, comments: page } };
  }

  private addComment(issue: FakeIssue, body: Record<string, unknown>): { status: number; json?: unknown } {
    const id = String(this.nextCommentId++);
    issue.comments.push({ id, accountId: OPERATOR_ACCOUNT, body: body.body, created: "2026-05-01T12:00:00.000+0000" });
    return { status: 201, json: { id } };
  }
}

async function startFake(fake: FakeJira): Promise<{ server: Server; connection: JiraConnection }> {
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

const SETTINGS: JiraTrackerSettings = {
  claimedLabel: "agent-claimed",
  doingTransition: "Em andamento",
  doneTransition: "Concluído",
  blockingLinkTypes: ["Blocks"],
};

async function withTracker<T>(issues: FakeIssue[], run: (tracker: JiraTracker, fake: FakeJira) => Promise<T>): Promise<T> {
  const fake = new FakeJira(issues);
  const { server, connection } = await startFake(fake);
  try {
    return await run(new JiraTracker(connection, SETTINGS), fake);
  } finally {
    server.close();
  }
}

const ref = (id: string): IssueRef => ({ tracker: "jira", project: projectOf(id), id });

test("connection is read from the JIRA_* environment variables; missing ones are named without values", () => {
  assert.deepEqual(
    jiraConnectionFromEnv({ JIRA_URL: "https://example.atlassian.net", JIRA_USERNAME: USERNAME, JIRA_API_TOKEN: TOKEN }),
    { baseUrl: "https://example.atlassian.net", username: USERNAME, apiToken: TOKEN },
  );
  assert.throws(
    () => jiraConnectionFromEnv({ JIRA_URL: "https://example.atlassian.net", JIRA_API_TOKEN: TOKEN }),
    (error: Error) => error.message.includes("JIRA_USERNAME") && !error.message.includes(TOKEN),
  );
});

test("discovery returns every ready-for-agent issue of the project across pages, in key order", async () => {
  const issues = [
    fakeIssue({ key: "VAN-3" }),
    fakeIssue({ key: "VAN-1" }),
    fakeIssue({ key: "VAN-7", labels: ["playbooks"] }),
    fakeIssue({ key: "CON-2" }),
    fakeIssue({ key: "VAN-5" }),
    fakeIssue({ key: "VAN-2" }),
  ];
  const keys = await withTracker(issues, async (tracker, fake) => {
    const found = await tracker.discoverCandidates({ project: "VAN", readyLabel: "ready-for-agent" });
    assert.equal(fake.authorization, `Basic ${Buffer.from(`${USERNAME}:${TOKEN}`).toString("base64")}`);
    return found;
  });
  assert.deepEqual(keys, [
    { tracker: "jira", project: "VAN", id: "VAN-1" },
    { tracker: "jira", project: "VAN", id: "VAN-2" },
    { tracker: "jira", project: "VAN", id: "VAN-3" },
    { tracker: "jira", project: "VAN", id: "VAN-5" },
  ]);
});

test("readIssue maps labels, assignee, status category, priority and the open sprint", async () => {
  const snapshot = await withTracker(
    [fakeIssue({ key: "VAN-10", summary: "Playbook item", statusName: "Em andamento", category: "indeterminate", priority: "High" })],
    (tracker) => tracker.readIssue(ref("VAN-10")),
  );
  assert.deepEqual(snapshot, {
    ref: { tracker: "jira", project: "VAN", id: "VAN-10" },
    title: "Playbook item",
    labels: { known: true, value: ["ready-for-agent", "playbooks"] },
    assignees: { known: true, value: [OPERATOR_ACCOUNT] },
    claimed: { known: true, value: true },
    blockers: { known: true, value: [] },
    statusCategory: { known: true, value: "in-progress" },
    priority: { known: true, value: 2 },
    openSprint: { known: true, value: true },
    assignee: { known: true, value: OPERATOR_ACCOUNT },
  });
});

test("an issue outside the open sprint, or unassigned, reads as such", async () => {
  const snapshot = await withTracker(
    [fakeIssue({ key: "VAN-11", openSprint: false, assignee: null, priority: null })],
    (tracker) => tracker.readIssue(ref("VAN-11")),
  );
  assert.deepEqual(snapshot.openSprint, { known: true, value: false });
  assert.deepEqual(snapshot.assignee, { known: true, value: null });
  assert.deepEqual(snapshot.priority, { known: true, value: null });
});

test("a To Do issue without the claimed label is not claimed; the label or a non To Do status claims it", async () => {
  const todo = await withTracker([fakeIssue({ key: "VAN-12" })], (tracker) => tracker.readIssue(ref("VAN-12")));
  assert.deepEqual(todo.claimed, { known: true, value: false });
  const labelled = await withTracker(
    [fakeIssue({ key: "VAN-13", labels: ["ready-for-agent", "agent-claimed"] })],
    (tracker) => tracker.readIssue(ref("VAN-13")),
  );
  assert.deepEqual(labelled.claimed, { known: true, value: true });
  const done = await withTracker(
    [fakeIssue({ key: "VAN-14", statusName: "Concluído", category: "done" })],
    (tracker) => tracker.readIssue(ref("VAN-14")),
  );
  assert.deepEqual(done.claimed, { known: true, value: true });
});

test("an unreadable status makes claim and category unknown, never false", async () => {
  const snapshot = await withTracker([fakeIssue({ key: "VAN-15", hideStatus: true })], (tracker) => tracker.readIssue(ref("VAN-15")));
  assert.equal(snapshot.statusCategory.known, false);
  assert.equal(snapshot.claimed.known, false);
});

test("an unreadable sprint state is reported as unknown, not as outside the sprint", async () => {
  const snapshot = await withTracker([fakeIssue({ key: "VAN-16", summary: "NO_BOARD" })], (tracker) => tracker.readIssue(ref("VAN-16")));
  assert.equal(snapshot.openSprint?.known, false);
});
