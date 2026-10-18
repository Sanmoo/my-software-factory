import type { CommandRunner } from "./github-adapter.js";

/**
 * An in-memory GitHub that speaks the exact REST dialect the real adapter
 * uses over `gh api` — the gh/process-boundary double for the
 * offline contract suite (ticket 16: the suite must pass against the REAL
 * adapter, the same checks the fake satisfies; here the real adapter runs
 * against a simulated GitHub instead of the network).
 *
 * What it models: issues and PRs sharing the numbering (a PR IS an issue),
 * repo labels, branch refs, native blocked_by dependencies, issue comments,
 * the cross-referenced timeline linkage ("Closes #N") and git clone/push.
 * Shapes follow the real REST endpoints: snake_case fields, `user.login`,
 * `created_at`, `state_reason: "not planned"` (with the space), numeric ids.
 *
 * Errors are gh-shaped: a failed call rejects with an Error whose `stderr`
 * carries `gh: ... (HTTP 404)` — the adapter's tolerances read that stderr.
 *
 * Scope: ONE repo per sim (the harness seeds it; the repo in every ref is
 * ignored — the contract suite exercises one repo at a time).
 */

export interface SimComment {
  id: number;
  userName: string;
  body: string;
  createdAt: string;
}

export interface SimTimelineEvent {
  event: string;
  source?: { issue?: { number: number; pull_request?: object } };
}

export interface SimIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: "completed" | "not planned" | "reopened" | null;
  labels: string[];
  assignees: string[];
  createdAt: string;
  comments: SimComment[];
  /** Native dependencies: the issue numbers this issue is blocked by. */
  blockedBy: number[];
  timeline: SimTimelineEvent[];
  /** Present only on PRs. */
  pr?: { head: string; base: string };
  reviews: { id: number; userName: string; body: string; submittedAt: string | null }[];
}

class SimHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SimHttpError";
  }
}

export class GitHubSim {
  /** Sim issues and PRs share the number space — like GitHub. */
  readonly issues = new Map<number, SimIssue>();
  readonly repoLabels = new Set<string>();
  /** Branch refs that exist on the "remote". */
  readonly branches = new Set<string>();
  readonly defaultBranch = "main";
  private nextNumber = 100;
  private nextId = 5000;
  private nextCommentId = 9000;
  private nextReviewId = 7000;
  /** Recorded git pushes (branch → refs/heads/<branch> landed). */
  readonly pushedBranches = new Set<string>();

  /** The CommandRunner handed to the adapter (and to the test harness). */
  readonly runner: CommandRunner = async (file, args, options) => {
    try {
      // await inside the try: a REJECTED gh promise must reach this catch and
      // be wrapped gh-shaped (it wasn't — raw SimHttpError came out, without a
      // stderr, and the adapter's tolerances — which read stderr — broke)
      if (file === "gh") return await this.gh(args, options.input);
      if (file === "git") return await this.git(args);
      throw new SimHttpError(0, `sim: unexpected command ${file}`);
    } catch (error) {
      // gh-shaped failures: the message goes to stderr, exit non-zero
      if (error instanceof SimHttpError) {
        const wrapped = new Error(`gh: ${error.message} (HTTP ${error.status})`);
        Object.assign(wrapped, { stderr: wrapped.message });
        throw wrapped;
      }
      throw error;
    }
  };

  // ---- seeding helpers (the harness's reach into the state) ----

  createIssue(input: { title: string; labels?: string[]; closed?: boolean; createdAt?: string; body?: string }): SimIssue {
    const number = this.nextNumber++;
    const issue: SimIssue = {
      number,
      id: this.nextId++,
      title: input.title,
      body: input.body ?? "",
      state: input.closed ? "closed" : "open",
      stateReason: input.closed ? "completed" : null,
      labels: [...(input.labels ?? [])],
      assignees: [],
      createdAt: input.createdAt ?? new Date().toISOString(),
      comments: [],
      blockedBy: [],
      timeline: [],
      reviews: [],
    };
    this.issues.set(number, issue);
    for (const label of issue.labels) this.repoLabels.add(label);
    return issue;
  }

  addBlocker(refNumber: number, blockerNumber: number): void {
    this.issues.get(refNumber)?.blockedBy.push(blockerNumber);
  }

  addComment(refNumber: number, author: string, body: string): void {
    this.issues.get(refNumber)?.comments.push({
      id: this.nextCommentId++,
      userName: author,
      body,
      createdAt: new Date().toISOString(),
    });
  }

  addReview(prNumber: number, author: string, body: string): void {
    this.issues.get(prNumber)?.reviews.push({
      id: this.nextReviewId++,
      userName: author,
      body,
      submittedAt: new Date().toISOString(),
    });
  }

  missingNumber(): number {
    let max = 0;
    for (const number of this.issues.keys()) max = Math.max(max, number);
    return max + 1_000_000;
  }

  // ---- the gh boundary ----

  private fail(status: number, message: string): never {
    throw new SimHttpError(status, message);
  }

  private notFound(what: string): never {
    this.fail(404, `Not Found — ${what}`);
  }

  private issue(number: number): SimIssue {
    const issue = this.issues.get(number);
    if (!issue) this.notFound(`issue #${number}`);
    return issue;
  }

  /** The REST serialization of an issue (what GET .../issues/{n} returns). */
  private restIssue(issue: SimIssue) {
    return {
      number: issue.number,
      id: issue.id,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      created_at: issue.createdAt,
      ...(issue.pr === undefined ? {} : { pull_request: { merged_at: null } }),
    };
  }

  private restComment(comment: SimComment) {
    return { id: comment.id, user: { login: comment.userName }, body: comment.body, created_at: comment.createdAt };
  }

  private async gh(args: string[], input: string | undefined): Promise<{ stdout: string; stderr: string }> {
    if (args[0] === "auth" && args[1] === "token") {
      return { stdout: "sim-token\n", stderr: "" };
    }
    if (args[0] === "api") {
      return { stdout: this.api(args, input), stderr: "" };
    }
    throw new SimHttpError(0, `sim: unexpected gh command: ${args.join(" ")}`);
  }

  /** One `gh api` call: ["api", "-X", METHOD, path, "--input", "-"] — the
   *  path may carry a query string (the listing's state). */
  private api(args: string[], input: string | undefined): string {
    const parsed = { method: "GET", path: "", query: new URLSearchParams(), body: undefined as unknown };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-X") {
        parsed.method = args[i + 1] ?? "GET";
        i++;
      } else if (args[i] === "--input") {
        parsed.body = JSON.parse(input ?? "{}");
        i++;
      } else if (parsed.path === "") {
        const raw = args[i] ?? "";
        const qIndex = raw.indexOf("?");
        if (qIndex >= 0) {
          parsed.path = raw.slice(0, qIndex);
          parsed.query = new URLSearchParams(raw.slice(qIndex + 1));
        } else {
          parsed.path = raw;
        }
      }
    }
    const path = parsed.path.replace(/^\//, "");
    const parts = path.split("/"); // repos/{owner}/{repo}/...
    const out = this.route(parsed.method, parts.slice(3), parsed.body, parsed.query);
    return JSON.stringify(out);
  }

  /** `rest` = the path after repos/{owner}/{repo}; query = its query params. */
  private route(method: string, rest: string[], body: unknown, query: URLSearchParams): unknown {
    if (rest.length === 0) {
      // GET /repos/{repo} → repo metadata
      return { name: "sim", default_branch: this.defaultBranch };
    }
    if (rest[0] === "issues" && rest.length === 1 && method === "GET") {
      // the listing: GET /repos/{repo}/issues?state=… — issues only, never PRs
      // (the pull_request filter in the adapter is defensive). The `labels` query
      // param is not spoken: the real adapter matches the ready label CLIENT-SIDE
      // (the label-filtered listing lags on real GitHub), so it never sends it.
      const state = query.get("state") ?? "open";
      return [...this.issues.values()]
        .filter((issue) => issue.pr === undefined)
        .filter((issue) => (state === "all" ? true : issue.state === state))
        .map((issue) => this.restIssue(issue));
    }
    if (rest[0] === "issues") {
      const issue = this.issue(Number(rest[1]));
      const sub = rest[2];
      if (sub === undefined) {
        if (method === "GET") return this.restIssue(issue);
        if (method === "PATCH") return this.patchIssue(issue, body);
      }
      if (sub === "comments") {
        if (method === "GET") return issue.comments.map((c) => this.restComment(c));
        if (method === "POST") {
          const { body: text } = body as { body: string };
          const comment: SimComment = {
            id: this.nextCommentId++,
            userName: "sim-adapter",
            body: text,
            createdAt: new Date().toISOString(),
          };
          issue.comments.push(comment);
          return this.restComment(comment);
        }
      }
      if (sub === "labels") {
        if (rest.length === 3 && method === "POST") {
          const { labels } = body as { labels: string[] };
          for (const label of labels) {
            if (!issue.labels.includes(label)) issue.labels.push(label);
            this.repoLabels.add(label);
          }
          return this.restIssue(issue);
        }
        if (rest.length === 4 && method === "DELETE") {
          const label = rest[3] ?? "";
          if (!issue.labels.includes(label)) this.notFound(`label not found: ${label}`);
          issue.labels = issue.labels.filter((l) => l !== label);
          return null;
        }
      }
      if (sub === "assignees") {
        if (method === "POST") {
          const { assignees } = body as { assignees: string[] };
          for (const login of assignees) {
            if (!issue.assignees.includes(login)) issue.assignees.push(login);
          }
          return this.restIssue(issue);
        }
        if (method === "DELETE") {
          const { assignees } = body as { assignees: string[] };
          issue.assignees = issue.assignees.filter((login) => !assignees.includes(login));
          return this.restIssue(issue);
        }
      }
      if (sub === "dependencies" && rest[3] === "blocked_by") {
        if (rest.length === 4 && method === "GET") {
          return issue.blockedBy.map((n) => this.restIssue(this.issue(n)));
        }
        if (rest.length === 4 && method === "POST") {
          const { issue_id: issueId } = body as { issue_id: number };
          const blocker = [...this.issues.values()].find((i) => i.id === issueId);
          if (!blocker) this.notFound(`issue id ${issueId}`);
          if (!issue.blockedBy.includes(blocker.number)) issue.blockedBy.push(blocker.number);
          return this.restIssue(issue);
        }
        if (rest.length === 5 && method === "DELETE") {
          const blockerId = Number(rest[4]);
          const blocker = [...this.issues.values()].find((i) => i.id === blockerId);
          if (!blocker || !issue.blockedBy.includes(blocker.number)) this.notFound(`dependency ${blockerId}`);
          issue.blockedBy = issue.blockedBy.filter((n) => n !== blocker.number);
          return null;
        }
      }
      if (sub === "timeline" && method === "GET") {
        return issue.timeline;
      }
    }
    if (rest[0] === "pulls") {
      if (rest.length === 1 && method === "GET") {
        // the pool's linkage read: GET /repos/{repo}/pulls?state=open — only
        // the fields the adapter's listOpenIssues reads (number, body). A PR
        // body carries the "Closes/Fixes/Resolves #N" linkage keywords.
        const state = query.get("state") ?? "open";
        return [...this.issues.values()]
          .filter((issue) => issue.pr !== undefined)
          .filter((issue) => (state === "all" ? true : issue.state === state))
          .map((issue) => ({ number: issue.number, state: issue.state, body: issue.body }));
      }
      if (rest.length === 1 && method === "POST") {
        const input = body as { title: string; head: string; base: string; body: string };
        const number = this.nextNumber++;
        const pr: SimIssue = {
          number,
          id: this.nextId++,
          title: input.title,
          body: input.body,
          state: "open",
          stateReason: null,
          labels: [],
          assignees: [],
          createdAt: new Date().toISOString(),
          comments: [],
          blockedBy: [],
          timeline: [],
          pr: { head: input.head, base: input.base },
          reviews: [],
        };
        this.issues.set(number, pr);
        // the cross-reference ("Closes #N") lands on the ISSUE's timeline
        const closes = input.body.match(/Closes #(\d+)/);
        if (closes) {
          const target = this.issues.get(Number(closes[1]));
          target?.timeline.push({
            event: "cross-referenced",
            source: { issue: { number, pull_request: { merged_at: null } } },
          });
        }
        return { number, state: "open", html_url: `https://github.com/sim/pull/${number}` };
      }
      if (rest.length === 2) {
        const issue = this.issue(Number(rest[1]));
        if (issue.pr === undefined) this.notFound(`pull #${rest[1]}`);
        if (method === "GET") {
          return {
            number: issue.number,
            state: issue.state,
            merged_at: null,
            head: { ref: issue.pr.head },
            base: { ref: issue.pr.base },
            user: { login: "sim-adapter" },
          };
        }
        if (method === "PATCH") {
          const { state } = body as { state: string };
          issue.state = state === "closed" ? "closed" : "open";
          return { number: issue.number, state: issue.state };
        }
      }
      if (rest[2] === "reviews" && method === "GET") {
        return this.issue(Number(rest[1])).reviews.map((r) => ({
          id: r.id,
          user: { login: r.userName },
          body: r.body,
          submitted_at: r.submittedAt,
        }));
      }
      if (rest[2] === "comments" && method === "GET") {
        return [];
      }
    }
    if (rest[0] === "labels") {
      if (rest.length === 1 && method === "POST") {
        const { name } = body as { name: string };
        if (this.repoLabels.has(name)) this.fail(422, `label already exists: ${name}`);
        this.repoLabels.add(name);
        return { name };
      }
      if (rest.length === 2 && method === "DELETE") {
        const name = rest[1] ?? "";
        if (!this.repoLabels.has(name)) this.notFound(`label ${name}`);
        this.repoLabels.delete(name);
        return null;
      }
    }
    if (rest[0] === "git" && rest[1] === "refs") {
      // create/delete branch refs (the harness's ensureBranch/cleanup)
      if (method === "POST") {
        const { ref, sha } = body as { ref: string; sha: string };
        const branch = ref.replace("refs/heads/", "");
        if (this.branches.has(branch)) this.fail(422, "Reference already exists");
        this.branches.add(branch);
        return { ref, object: { sha } };
      }
      if (method === "DELETE") {
        const branch = rest.slice(3).join("/");
        this.branches.delete(branch);
        return null;
      }
    }
    if (rest[0] === "branches" && rest.length === 2 && method === "GET") {
      const branch = rest[1] ?? "";
      if (!this.branches.has(branch)) this.notFound(`branch ${branch}`);
      return { name: branch };
    }
    if (rest[0] === "contents" && method === "PUT") {
      // a probe commit on a branch — just prove the branch exists
      const { branch } = body as { branch: string };
      if (!this.branches.has(branch)) this.notFound(`branch ${branch}`);
      return { content: { path: "probe" } };
    }
    this.notFound(`sim route ${method} ${rest.join("/")}`);
  }

  private patchIssue(issue: SimIssue, body: unknown): unknown {
    const input = body as {
      state?: string;
      state_reason?: string | null;
      labels?: string[];
      assignees?: string[];
      title?: string;
      body?: string;
    };
    if (input.state === "closed") issue.state = "closed";
    if (input.state === "open") issue.state = "open";
    if (input.state_reason !== undefined) {
      // the PATCH vocabulary is underscored ("not_planned"), the GET shape is
      // spaced ("not planned") — the sim normalizes on store, like GitHub
      const stored = input.state_reason === "not_planned" ? "not planned" : input.state_reason;
      issue.stateReason = (stored === "" ? null : stored) as SimIssue["stateReason"];
    }
    if (input.labels !== undefined) issue.labels = [...input.labels];
    if (input.assignees !== undefined) issue.assignees = [...input.assignees];
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    return this.restIssue(issue);
  }

  // ---- the git boundary ----

  private git(args: string[]): { stdout: string; stderr: string } {
    const [command] = args;
    if (command === "clone" || command === "config" || command === "fetch") return { stdout: "", stderr: "" };
    if (command === "rev-parse") {
      const ref = args[1] === "--verify" ? args[3] : args[1];
      if (ref === "refs/remotes/origin/HEAD") return { stdout: "sim-origin-sha\n", stderr: "" };
      // local branches never exist in the sim's fresh clones
      throw new SimHttpError(1, `fatal: needed a single revision — ${ref}`);
    }
    if (command === "push") {
      const spec = args.find((a) => a.includes("refs/heads/")) ?? "";
      const branch = spec.split(":").at(-1)?.replace("refs/heads/", "");
      if (branch) {
        this.branches.add(branch);
        this.pushedBranches.add(branch);
      }
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}
