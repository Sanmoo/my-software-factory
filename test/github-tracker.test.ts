import assert from "node:assert/strict";
import test from "node:test";
import { coreRules, evaluateEligibility } from "../src/core/eligibility.js";
import {
  GitHubTracker,
  type GitHubBoundary,
  type GitHubRequest,
  type GitHubResponse,
} from "../src/tracker/github.js";
import type { BlockerRef, IssueRef, TrackerScope } from "../src/tracker/port.js";

const REPO = "Sanmoo/my-software-factory";
const ACCOUNT = "Sanmoo";
const scope: TrackerScope = { project: REPO, readyLabel: "ready-for-agent" };
const ref = (id: number | string): IssueRef => ({ tracker: "github", project: REPO, id: String(id) });

interface FakeComment {
  id: number;
  login: string;
  type: "User" | "Bot";
  body: string;
  createdAt: string;
}

interface FakeIssue {
  number: number;
  dbId: number;
  title: string;
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

// A fake GitHub REST boundary: it routes the endpoints the adapter uses over in-memory
// state, pages list endpoints with per_page/page, and records every call with the
// account whose token was used. It never talks to the network.
class FakeGitHub implements GitHubBoundary {
  readonly issues = new Map<number, FakeIssue>();
  readonly calls: Call[] = [];
  readonly tokenRequests: string[] = [];
  failDependencies = false;
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

const tracker = (gh: FakeGitHub) => new GitHubTracker({ account: ACCOUNT, claimedLabel: "agent-claimed", boundary: gh });

test("discovery follows every page and returns only open ready issues, never pull requests", async () => {
  const gh = new FakeGitHub();
  for (let number = 1; number <= 120; number++) gh.add({ number, labels: ["ready-for-agent"] });
  gh.add({ number: 121, labels: ["ready-for-agent"], pullRequest: true });
  gh.add({ number: 122, labels: ["ready-for-agent"], state: "closed" });
  gh.add({ number: 123, labels: ["other"] });

  const found = await tracker(gh).discoverCandidates(scope);

  assert.equal(found.length, 120);
  assert.deepEqual(found[0], ref(1));
  assert.deepEqual(found[119], ref(120));
  const listPages = gh.calls.filter((call) => call.method === "GET" && call.path === `/repos/${REPO}/issues`);
  assert.equal(listPages.length, 2, "120 ready issues need two pages of 100");
});

test("discovery uses the configured ready label name", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["pronta-para-agente"] });
  gh.add({ number: 2, labels: ["ready-for-agent"] });

  const found = await tracker(gh).discoverCandidates({ project: REPO, readyLabel: "pronta-para-agente" });

  assert.deepEqual(found, [ref(1)]);
});

test("claimed is true for any assignee or for the claimed label, and false otherwise", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"], assignees: ["human"] });
  gh.add({ number: 2, labels: ["ready-for-agent", "agent-claimed"] });
  gh.add({ number: 3, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  const claimed = [1, 2, 3].map(async (n) => (await adapter.readIssue(ref(n))).claimed);

  assert.deepEqual(await Promise.all(claimed), [
    { known: true, value: true },
    { known: true, value: true },
    { known: true, value: false },
  ]);
});

test("open blockers are non-terminal and closed blockers are terminal", async () => {
  const gh = new FakeGitHub();
  const open = gh.add({ number: 2 });
  const closed = gh.add({ number: 3, state: "closed", stateReason: "completed" });
  gh.add({ number: 1, labels: ["ready-for-agent"], blockedBy: [open.dbId, closed.dbId] });

  const snapshot = await tracker(gh).readIssue(ref(1));

  assert.deepEqual(snapshot.blockers, {
    known: true,
    value: [
      { ref: ref(2), terminal: { known: true, value: false } },
      { ref: ref(3), terminal: { known: true, value: true } },
    ],
  });
});

test("an issue that blocks another one is not blocked by that link", async () => {
  const gh = new FakeGitHub();
  const blocker = gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2, labels: ["ready-for-agent"], blockedBy: [blocker.dbId] });
  const adapter = tracker(gh);

  assert.deepEqual((await adapter.readIssue(ref(1))).blockers, { known: true, value: [] });
  const blocked = await adapter.readIssue(ref(2));
  assert.equal(blocked.blockers.known && blocked.blockers.value.length, 1);
});

test("a failed dependency read leaves blockers unknown, so the issue is not eligible", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.failDependencies = true;
  const adapter = tracker(gh);

  const snapshot = await adapter.readIssue(ref(1));
  const verdict = evaluateEligibility({
    project: { enabled: true, readyLabel: scope.readyLabel, routing: { kind: "repository" } },
    issue: snapshot,
    tracked: new Set(),
  }, coreRules);

  assert.equal(snapshot.blockers.known, false);
  assert.equal(verdict.eligible, false);
  assert.deepEqual(!verdict.eligible && verdict.rejections.map((r) => r.rule), ["no-blockers"]);
});

test("a ready, unclaimed issue without blockers is eligible with no sprint or assignee requirement", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const snapshot = await tracker(gh).readIssue(ref(1));

  const verdict = evaluateEligibility({
    project: { enabled: true, readyLabel: scope.readyLabel, routing: { kind: "repository" } },
    issue: snapshot,
    tracked: new Set(),
  }, coreRules);

  assert.deepEqual(verdict, { eligible: true });
  assert.equal(snapshot.openSprint, undefined);
  assert.equal(snapshot.assignee, undefined);
});

test("claim adds the claimed label and assigns the project account, confirmed by reread", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  assert.deepEqual(await adapter.claim(ref(1)), { status: "accepted" });

  const snapshot = await adapter.readIssue(ref(1));
  assert.deepEqual(snapshot.claimed, { known: true, value: true });
  assert.deepEqual(snapshot.labels, { known: true, value: ["ready-for-agent", "agent-claimed"] });
  assert.deepEqual(snapshot.assignees, { known: true, value: [ACCOUNT] });
  assert.deepEqual(snapshot.statusCategory, { known: true, value: "in-progress" });
});

test("claim is rejected without any write when the issue is already claimed", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"], assignees: ["human"] });
  const adapter = tracker(gh);

  const outcome = await adapter.claim(ref(1));

  assert.equal(outcome.status, "rejected");
  assert.deepEqual(gh.writes(), []);
  assert.deepEqual((await adapter.readIssue(ref(1))).assignees, { known: true, value: ["human"] });
});

test("claim is rejected when the reread does not confirm the project assignment", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.ignoreAssigneeWrites = true;

  const outcome = await tracker(gh).claim(ref(1));

  assert.equal(outcome.status, "rejected");
});

test("a failed token read is not cached: the next call asks the boundary again", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  let failuresLeft = 1;
  const flaky: GitHubBoundary = {
    accountToken: async (account) => {
      if (failuresLeft-- > 0) throw new Error("gh indisponível");
      return gh.accountToken(account);
    },
    api: (request, token) => gh.api(request, token),
  };
  const adapter = new GitHubTracker({ account: ACCOUNT, claimedLabel: "agent-claimed", boundary: flaky });

  await assert.rejects(adapter.discoverCandidates(scope), /gh indisponível/);
  assert.deepEqual(await adapter.discoverCandidates(scope), [ref(1)]);
});

test("every call is made with the project account token", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  await adapter.discoverCandidates(scope);
  await adapter.claim(ref(1));
  await adapter.postComment(ref(1), "texto");
  await adapter.releaseClaim(ref(1));
  await adapter.markDone(ref(2));

  assert.ok(gh.calls.length > 5);
  assert.ok(gh.calls.every((call) => call.login === ACCOUNT));
  assert.deepEqual([...new Set(gh.tokenRequests)], [ACCOUNT]);
});

test("releaseClaim removes the claimed label and the project assignment without closing", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);
  await adapter.claim(ref(1));

  await adapter.releaseClaim(ref(1));

  const snapshot = await adapter.readIssue(ref(1));
  assert.equal(snapshot.claimed.known && snapshot.claimed.value, false);
  assert.deepEqual(snapshot.labels, { known: true, value: ["ready-for-agent"] });
  assert.deepEqual(snapshot.assignees, { known: true, value: [] });
  assert.equal(gh.issues.get(1)?.state, "open");
});

test("releaseClaim keeps assignees that are not the project account", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent", "agent-claimed"], assignees: [ACCOUNT, "human"] });
  const adapter = tracker(gh);

  await adapter.releaseClaim(ref(1));

  assert.deepEqual((await adapter.readIssue(ref(1))).assignees, { known: true, value: ["human"] });
});

test("readComments maps identity, bot flag, body and time across pages", async () => {
  const gh = new FakeGitHub();
  const issue = gh.add({ number: 1, labels: ["ready-for-agent"] });
  for (let i = 0; i < 101; i++) {
    issue.comments.push({ id: 100 + i, login: "human", type: "User", body: `c${i}`, createdAt: "2026-10-11T10:00:00Z" });
  }
  issue.comments.push({ id: 900, login: "renovate[bot]", type: "Bot", body: "bot", createdAt: "2026-10-11T11:00:00Z" });

  const comments = await tracker(gh).readComments(ref(1));

  assert.equal(comments.length, 102);
  assert.deepEqual(comments[0], { id: "100", author: "human", isBot: false, body: "c0", createdAt: "2026-10-11T10:00:00Z" });
  assert.deepEqual(comments[101], { id: "900", author: "renovate[bot]", isBot: true, body: "bot", createdAt: "2026-10-11T11:00:00Z" });
});

test("postComment posts the body as given and returns the new comment id", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);
  const body = "resultado\n\n<!-- msf:agent -->";

  const id = await adapter.postComment(ref(1), body);

  const [posted] = await adapter.readComments(ref(1));
  assert.equal(posted.id, id);
  assert.equal(posted.body, body);
  assert.equal(posted.author, ACCOUNT);
  assert.equal(posted.isBot, false);
});

test("markDone closes the issue as completed and confirms it by reread", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  assert.deepEqual(await adapter.markDone(ref(1)), { status: "done" });
  assert.equal(gh.issues.get(1)?.state, "closed");
  assert.equal(gh.issues.get(1)?.stateReason, "completed");
  assert.deepEqual((await adapter.readIssue(ref(1))).statusCategory, { known: true, value: "done" });
});

const PROJECT = { enabled: true, readyLabel: "ready-for-agent", routing: { kind: "repository" as const } };

test("terminal means closed as completed: a completed issue is done", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "completed" });

  assert.deepEqual((await tracker(gh).readIssue(ref(1))).statusCategory, { known: true, value: "done" });
});

test("an issue closed for another reason is not done and its category is not guessed", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "not_planned" });
  gh.add({ number: 2, state: "closed", stateReason: "duplicate" });
  gh.add({ number: 3, state: "closed", stateReason: null });
  const adapter = tracker(gh);

  for (const n of [1, 2, 3]) {
    const category = (await adapter.readIssue(ref(n))).statusCategory;
    assert.equal(category.known, false, `#${n} must not read as a known category`);
    assert.notDeepEqual(category, { known: true, value: "done" }, `#${n} is not done`);
  }
});

test("an issue closed for another reason is not eligible: its status is unknown, so eligibility rejects it", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"], state: "closed", stateReason: "not_planned" });
  const snapshot = await tracker(gh).readIssue(ref(1));

  const verdict = evaluateEligibility({ project: PROJECT, issue: snapshot, tracked: new Set() }, coreRules);

  assert.equal(verdict.eligible, false);
});

test("only open blocked_by dependencies block: a blocker closed for another reason does not block", async () => {
  const gh = new FakeGitHub();
  const notPlanned = gh.add({ number: 3, state: "closed", stateReason: "not_planned" });
  gh.add({ number: 1, labels: ["ready-for-agent"], blockedBy: [notPlanned.dbId] });

  const snapshot = await tracker(gh).readIssue(ref(1));

  assert.deepEqual(snapshot.blockers, {
    known: true,
    value: [{ ref: ref(3), terminal: { known: true, value: true } }],
  });
  const verdict = evaluateEligibility({ project: PROJECT, issue: snapshot, tracked: new Set() }, coreRules);
  assert.equal(verdict.eligible, true);
});

test("markDone on an issue already closed as completed is expected and writes nothing", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "completed" });
  const adapter = tracker(gh);

  assert.deepEqual(await adapter.markDone(ref(1)), { status: "already-done" });
  assert.deepEqual(gh.writes(), []);
});

test("an issue closed as not planned is not confirmed as done", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "not_planned" });

  const outcome = await tracker(gh).markDone(ref(1));

  assert.equal(outcome.status, "not-confirmed");
  assert.deepEqual(gh.writes(), []);
});

test("the native blocked_by edge can be added and removed", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2 });
  const adapter = tracker(gh);

  await adapter.addBlockedBy(ref(1), ref(2));
  const blocked = await adapter.readIssue(ref(1));
  assert.equal(blocked.blockers.known, true);
  const terminals = blocked.blockers.known ? blocked.blockers.value.map((b: BlockerRef) => b.terminal) : [];
  assert.deepEqual(terminals, [{ known: true, value: false }]);

  await adapter.removeBlockedBy(ref(1), ref(2));
  assert.deepEqual((await adapter.readIssue(ref(1))).blockers, { known: true, value: [] });
});
