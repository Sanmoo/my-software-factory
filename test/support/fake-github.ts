import type { GitHubBoundary, GitHubRequest, GitHubResponse } from "../../src/tracker/github.js";

// A fake GitHub REST boundary shared by the adapter tests and the tracker contract: it routes the
// endpoints the adapter uses over in-memory state, pages list endpoints with per_page/page, and
// records every call with the account whose token was used. It never talks to the network.

export const REPO = "Sanmoo/my-software-factory";
export const ACCOUNT = "Sanmoo";

interface FakeComment {
  id: number;
  login: string;
  type: "User" | "Bot";
  body: string;
  createdAt: string;
}

export interface FakeIssue {
  number: number;
  dbId: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  pullRequest: boolean;
  blockedBy: number[]; // database ids of the blocking issues
  comments: FakeComment[];
}

interface Call {
  method: string;
  path: string;
  login: string;
}

export class FakeGitHub implements GitHubBoundary {
  readonly issues = new Map<number, FakeIssue>();
  readonly calls: Call[] = [];
  readonly tokenRequests: string[] = [];
  failDependencies = false;
  failAssigneeWrites = false;
  ignoreAssigneeWrites = false;
  private nextDbId = 5000;
  private nextCommentId = 9000;

  add(partial: Partial<FakeIssue> & { number: number }): FakeIssue {
    const issue: FakeIssue = {
      dbId: this.nextDbId++,
      title: `issue ${partial.number}`,
      state: "open",
      stateReason: null,
      labels: [],
      assignees: [],
      pullRequest: false,
      blockedBy: [],
      comments: [],
      ...partial,
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  writes(): Call[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  async accountToken(account: string): Promise<string> {
    this.tokenRequests.push(account);
    return `token:${account}`;
  }

  async api(request: GitHubRequest, token: string): Promise<GitHubResponse> {
    const login = token.replace(/^token:/, "");
    const url = new URL(request.path, "https://api.github.test/");
    this.calls.push({ method: request.method, path: url.pathname, login });
    return this.route(request, url, login);
  }

  private route(request: GitHubRequest, url: URL, login: string): GitHubResponse {
    const path = url.pathname.replace(`/repos/${REPO}`, "");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = <T>(items: T[]): T[] => items.slice((page - 1) * perPage, page * perPage);

    if (request.method === "GET" && path === "/issues") {
      const state = url.searchParams.get("state") ?? "open";
      const labels = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
      const matching = [...this.issues.values()]
        .sort((a, b) => a.number - b.number)
        .filter((issue) => state === "all" || issue.state === state)
        .filter((issue) => labels.every((label) => issue.labels.includes(label)));
      return { status: 200, body: slice(matching).map((issue) => this.issueJson(issue)) };
    }

    const match = /^\/issues\/(\d+)(\/.*)?$/.exec(path);
    if (!match) return { status: 404, body: { message: "Not Found" } };
    const issue = this.issues.get(Number(match[1]));
    const sub = match[2] ?? "";
    if (!issue) return { status: 404, body: { message: "Not Found" } };

    if (request.method === "GET" && sub === "") return { status: 200, body: this.issueJson(issue) };
    if (request.method === "PATCH" && sub === "") {
      issue.state = body.state === "closed" ? "closed" : "open";
      issue.stateReason = (body.state_reason as string | undefined) ?? null;
      return { status: 200, body: this.issueJson(issue) };
    }
    if (request.method === "POST" && sub === "/labels") {
      for (const label of body.labels as string[]) if (!issue.labels.includes(label)) issue.labels.push(label);
      return { status: 200, body: issue.labels.map((name) => ({ name })) };
    }
    if (request.method === "DELETE" && sub.startsWith("/labels/")) {
      const name = decodeURIComponent(sub.slice("/labels/".length));
      if (!issue.labels.includes(name)) return { status: 404, body: { message: "Label does not exist" } };
      issue.labels = issue.labels.filter((label) => label !== name);
      return { status: 200, body: issue.labels.map((n) => ({ name: n })) };
    }
    if (sub === "/assignees") {
      if (this.failAssigneeWrites) return { status: 500, body: { message: "boom" } };
      const names = body.assignees as string[];
      if (request.method === "POST" && !this.ignoreAssigneeWrites) {
        for (const name of names) if (!issue.assignees.includes(name)) issue.assignees.push(name);
      }
      if (request.method === "DELETE") issue.assignees = issue.assignees.filter((name) => !names.includes(name));
      return { status: request.method === "POST" ? 201 : 200, body: { assignees: issue.assignees } };
    }
    if (sub === "/comments") {
      if (request.method === "GET") {
        return { status: 200, body: slice(issue.comments).map((comment) => this.commentJson(comment)) };
      }
      const comment: FakeComment = {
        id: this.nextCommentId++,
        login,
        type: login.endsWith("[bot]") ? "Bot" : "User",
        body: body.body as string,
        createdAt: `2026-10-11T12:00:0${issue.comments.length % 10}Z`,
      };
      issue.comments.push(comment);
      return { status: 201, body: this.commentJson(comment) };
    }
    if (sub.startsWith("/dependencies/blocked_by")) {
      if (this.failDependencies) return { status: 500, body: { message: "boom" } };
      if (request.method === "GET" && sub === "/dependencies/blocked_by") {
        const blockers = issue.blockedBy.flatMap((dbId) => this.byDbId(dbId) ?? []);
        return { status: 200, body: slice(blockers).map((blocker) => this.issueJson(blocker)) };
      }
      if (request.method === "POST" && sub === "/dependencies/blocked_by") {
        const blocker = this.byDbId(Number(body.issue_id));
        if (!blocker) return { status: 404, body: { message: "Not Found" } };
        issue.blockedBy.push(blocker.dbId);
        return { status: 201, body: this.issueJson(blocker) };
      }
      if (request.method === "DELETE") {
        const dbId = Number(sub.split("/").pop());
        if (!issue.blockedBy.includes(dbId)) return { status: 404, body: { message: "Not Found" } };
        issue.blockedBy = issue.blockedBy.filter((id) => id !== dbId);
        return { status: 200, body: this.issueJson(issue) };
      }
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  private byDbId(dbId: number): FakeIssue | undefined {
    return [...this.issues.values()].find((issue) => issue.dbId === dbId);
  }

  private issueJson(issue: FakeIssue) {
    return {
      id: issue.dbId,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state,
      state_reason: issue.stateReason,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      ...(issue.pullRequest ? { pull_request: { url: "https://api.github.test/pr" } } : {}),
    };
  }

  private commentJson(comment: FakeComment) {
    return {
      id: comment.id,
      user: { login: comment.login, type: comment.type },
      body: comment.body,
      created_at: comment.createdAt,
    };
  }
}
