import { spawn } from "node:child_process";
import type {
  BlockerRef,
  ClaimOutcome,
  Comment,
  DoneOutcome,
  IssueChange,
  IssueRef,
  IssueSnapshot,
  Known,
  StatusCategory,
  ReleaseOutcome,
  TrackerPort,
  TrackerScope,
} from "./port.js";
import { PartialWriteError } from "./port.js";
import { isObject, type Obj } from "../core/values.js";

// GitHub Issues adapter (R02, R03, R10). The adapter talks to the REST API through a
// small injected boundary: it asks for the project account's token and then performs
// one REST call with that token. The default boundary runs the gh CLI, injecting the
// token only into the env of those child calls; it never switches the active account.

export type GitHubMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GitHubRequest {
  method: GitHubMethod;
  // Relative to the API root, e.g. "repos/OWNER/REPO/issues/4".
  path: string;
  body?: unknown;
}

export interface GitHubResponse {
  status: number;
  body: unknown;
}

export interface GitHubBoundary {
  accountToken(account: string): Promise<string>;
  api(request: GitHubRequest, token: string): Promise<GitHubResponse>;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface GitHubTrackerOptions {
  // githubAccount of the project: the account that claims and comments.
  account: string;
  // labels.claimed of the project (default "agent-claimed").
  claimedLabel: string;
  boundary: GitHubBoundary;
}


interface RestIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  isPullRequest: boolean;
}

const PER_PAGE = 100;

function parseIssue(raw: unknown): RestIssue {
  if (!isObject(raw) || typeof raw.number !== "number" || typeof raw.id !== "number") {
    throw new Error("resposta GitHub inesperada: issue sem id/number");
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels.flatMap((label) => (isObject(label) && typeof label.name === "string" ? [label.name] : []))
    : [];
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees.flatMap((user) => (isObject(user) && typeof user.login === "string" ? [user.login] : []))
    : [];
  return {
    id: raw.id,
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    // GitHub answers null for an empty body: that is empty text, not an unread one.
    body: typeof raw.body === "string" ? raw.body : "",
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: typeof raw.state_reason === "string" ? raw.state_reason : null,
    labels,
    assignees,
    isPullRequest: raw.pull_request !== undefined,
  };
}

function parseComment(raw: unknown): Comment {
  if (!isObject(raw) || typeof raw.id !== "number" || !isObject(raw.user)) {
    throw new Error("resposta GitHub inesperada: comentário sem id/autor");
  }
  const login = typeof raw.user.login === "string" ? raw.user.login : "";
  return {
    id: String(raw.id),
    author: login,
    isBot: raw.user.type === "Bot" || login.endsWith("[bot]"),
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
  };
}

function expectStatus(response: GitHubResponse, ok: number[], what: string): void {
  if (ok.includes(response.status)) return;
  const message = isObject(response.body) && typeof response.body.message === "string" ? response.body.message : "";
  throw new GitHubApiError(response.status, `${what} falhou no GitHub (HTTP ${response.status})${message ? `: ${message}` : ""}`);
}

function repoPath(project: string): string {
  const parts = project.split("/");
  if (parts.length !== 2 || parts.some((part) => part === "")) {
    throw new Error(`repositório GitHub inválido: '${project}' (esperado OWNER/REPO)`);
  }
  return `repos/${parts[0]}/${parts[1]}`;
}

export class GitHubTracker implements TrackerPort {
  private tokenPromise?: Promise<string>;

  constructor(private readonly options: GitHubTrackerOptions) {}

  async discoverCandidates(scope: TrackerScope): Promise<IssueRef[]> {
    const repo = repoPath(scope.project);
    const refs: IssueRef[] = [];
    for (let page = 1; ; page++) {
      const query = `state=open&labels=${encodeURIComponent(scope.readyLabel)}&per_page=${PER_PAGE}&page=${page}`;
      const items = await this.getList(`${repo}/issues?${query}`, "listar candidatos");
      for (const raw of items) {
        const issue = parseIssue(raw);
        if (!issue.isPullRequest) refs.push(this.ref(scope.project, issue.number));
      }
      if (items.length < PER_PAGE) return refs;
    }
  }

  async readIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const issue = await this.fetchIssue(ref);
    const claimed = this.isClaimed(issue);
    return {
      ref,
      title: issue.title,
      labels: { known: true, value: issue.labels },
      assignees: { known: true, value: issue.assignees },
      claimed: { known: true, value: claimed },
      blockers: await this.readBlockers(ref),
      statusCategory: this.statusOf(issue, claimed),
      body: { known: true, value: issue.body },
      // GitHub Issues has no priority field: null is the honest answer, not unknown.
      priority: { known: true, value: null },
    };
  }

  async claim(ref: IssueRef): Promise<ClaimOutcome> {
    const before = await this.fetchIssue(ref);
    if (before.state === "closed") return { status: "rejected", reason: "issue fechada" };
    if (this.isClaimed(before)) return { status: "rejected", reason: "issue já claimed" };

    const path = this.issuePath(ref);
    const { claimedLabel, account } = this.options;
    const label: IssueChange = { operation: "adicionar-label", target: claimedLabel, before: "ausente", result: "failed" };
    const assignee: IssueChange = { operation: "atribuir", target: account, before: "sem a conta", result: "failed" };
    const made: IssueChange[] = [];
    try {
      expectStatus(
        await this.call({ method: "POST", path: `${path}/labels`, body: { labels: [claimedLabel] } }),
        [200],
        "adicionar label de claim",
      );
      made.push({ ...label, after: "presente", result: "attempted" });
      expectStatus(
        await this.call({ method: "POST", path: `${path}/assignees`, body: { assignees: [account] } }),
        [201],
        "atribuir conta do projeto",
      );
      made.push({ ...assignee, after: "atribuída", result: "attempted" });
    } catch (error) {
      if (made.length === 0) throw error;
      throw new PartialWriteError((error as Error).message, made);
    }

    const after = await this.fetchIssue(ref);
    const labelled = after.labels.includes(claimedLabel);
    const assigned = after.assignees.includes(account);
    const changes: IssueChange[] = [
      { ...made[0]!, result: labelled ? "confirmed" : "attempted" },
      { ...made[1]!, result: assigned ? "confirmed" : "attempted" },
    ];
    return labelled && assigned
      ? { status: "accepted", changes }
      : { status: "rejected", reason: "claim não confirmado na releitura", changes };
  }

  async releaseClaim(ref: IssueRef): Promise<ReleaseOutcome> {
    const path = this.issuePath(ref);
    const { claimedLabel, account } = this.options;
    const changes: IssueChange[] = [];
    try {
      const label = await this.call({ method: "DELETE", path: `${path}/labels/${encodeURIComponent(claimedLabel)}` });
      if (label.status !== 404) expectStatus(label, [200], "remover label de claim");
      changes.push(label.status === 404
        ? { operation: "remover-label", target: claimedLabel, before: "ausente", after: "ausente", result: "unchanged" }
        : { operation: "remover-label", target: claimedLabel, before: "presente", after: "ausente", result: "attempted" });
      expectStatus(
        await this.call({ method: "DELETE", path: `${path}/assignees`, body: { assignees: [account] } }),
        [200],
        "remover atribuição da conta do projeto",
      );
      changes.push({ operation: "remover-atribuição", target: account, result: "attempted" });
    } catch (error) {
      if (changes.length === 0) throw error;
      throw new PartialWriteError((error as Error).message, changes);
    }
    return { changes };
  }

  async readComments(ref: IssueRef): Promise<Comment[]> {
    const comments: Comment[] = [];
    for (let page = 1; ; page++) {
      const items = await this.getList(`${this.issuePath(ref)}/comments?per_page=${PER_PAGE}&page=${page}`, "ler comentários");
      comments.push(...items.map(parseComment));
      if (items.length < PER_PAGE) return comments;
    }
  }

  async postComment(ref: IssueRef, body: string): Promise<string> {
    const response = await this.call({ method: "POST", path: `${this.issuePath(ref)}/comments`, body: { body } });
    expectStatus(response, [201], "publicar comentário");
    return parseComment(response.body).id;
  }

  async markDone(ref: IssueRef): Promise<DoneOutcome> {
    const before = await this.fetchIssue(ref);
    if (before.state === "closed") {
      const changes: IssueChange[] = [{ operation: "fechar", before: "closed", after: "closed", result: "unchanged" }];
      return before.stateReason === "completed"
        ? { status: "already-done", changes }
        : { status: "not-confirmed", reason: `fechada como ${before.stateReason ?? "sem motivo"}, não como completed`, changes };
    }
    expectStatus(
      await this.call({
        method: "PATCH",
        path: this.issuePath(ref),
        body: { state: "closed", state_reason: "completed" },
      }),
      [200],
      "fechar issue",
    );
    const after = await this.fetchIssue(ref);
    const confirmed = after.state === "closed" && after.stateReason === "completed";
    const changes: IssueChange[] = [{
      operation: "fechar", before: "open", after: after.state === "closed" ? `closed (${after.stateReason ?? "sem motivo"})` : "open",
      result: confirmed ? "confirmed" : "attempted",
    }];
    return confirmed
      ? { status: "done", changes }
      : { status: "not-confirmed", reason: "fechamento não confirmado na releitura", changes };
  }

  // Native dependency edges. Not part of TrackerPort: used by the conformance check to
  // exercise the blocked_by representation (R02) against a disposable issue.
  async addBlockedBy(ref: IssueRef, blocker: IssueRef): Promise<void> {
    const blockerIssue = await this.fetchIssue(blocker);
    expectStatus(
      await this.call({
        method: "POST",
        path: `${this.issuePath(ref)}/dependencies/blocked_by`,
        body: { issue_id: blockerIssue.id },
      }),
      [201],
      "adicionar dependência blocked_by",
    );
  }

  async removeBlockedBy(ref: IssueRef, blocker: IssueRef): Promise<void> {
    const blockerIssue = await this.fetchIssue(blocker);
    expectStatus(
      await this.call({
        method: "DELETE",
        path: `${this.issuePath(ref)}/dependencies/blocked_by/${blockerIssue.id}`,
      }),
      [200],
      "remover dependência blocked_by",
    );
  }

  private ref(project: string, number: number | string): IssueRef {
    return { tracker: "github", project, id: String(number) };
  }

  private issuePath(ref: IssueRef): string {
    return `${repoPath(ref.project)}/issues/${ref.id}`;
  }

  private isClaimed(issue: RestIssue): boolean {
    return issue.assignees.length > 0 || issue.labels.includes(this.options.claimedLabel);
  }

  // R02: done is an issue closed as completed. Closed for another reason is not done, and GitHub
  // has no category for it, so its status stays unknown and eligibility rejects it. Open and
  // claimed means started.
  private statusOf(issue: RestIssue, claimed: boolean): Known<StatusCategory> {
    if (issue.state === "closed") {
      return issue.stateReason === "completed"
        ? { known: true, value: "done" }
        : { known: false, reason: `fechada como ${issue.stateReason ?? "sem motivo"}, não como completed` };
    }
    return { known: true, value: claimed ? "in-progress" : "to-do" };
  }

  private async fetchIssue(ref: IssueRef): Promise<RestIssue> {
    const response = await this.call({ method: "GET", path: this.issuePath(ref) });
    expectStatus(response, [200], `ler issue #${ref.id}`);
    return parseIssue(response.body);
  }

  // A failed read is Unknown, never absent: an issue whose blockers cannot be read is
  // not eligible (R03, CA04).
  private async readBlockers(ref: IssueRef): Promise<Known<BlockerRef[]>> {
    try {
      const blockers: BlockerRef[] = [];
      for (let page = 1; ; page++) {
        const items = await this.getList(
          `${this.issuePath(ref)}/dependencies/blocked_by?per_page=${PER_PAGE}&page=${page}`,
          "ler dependências",
        );
        for (const raw of items) {
          const blocker = parseIssue(raw);
          blockers.push({
            ref: this.ref(ref.project, blocker.number),
            terminal: { known: true, value: blocker.state === "closed" },
          });
        }
        if (items.length < PER_PAGE) return { known: true, value: blockers };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { known: false, reason: `dependências não lidas: ${reason}` };
    }
  }

  private async getList(path: string, what: string): Promise<unknown[]> {
    const response = await this.call({ method: "GET", path });
    expectStatus(response, [200], what);
    if (!Array.isArray(response.body)) throw new Error(`resposta GitHub inesperada em ${what}`);
    return response.body;
  }

  private async call(request: GitHubRequest): Promise<GitHubResponse> {
    const token = await this.token();
    return this.options.boundary.api(request, token);
  }

  // The token is read once per adapter; a failed read is forgotten so it is retried.
  private token(): Promise<string> {
    if (!this.tokenPromise) {
      const pending = this.options.boundary.accountToken(this.options.account);
      this.tokenPromise = pending;
      pending.catch(() => {
        if (this.tokenPromise === pending) this.tokenPromise = undefined;
      });
    }
    return this.tokenPromise;
  }
}

// Real boundary: runs the gh CLI. The token of the project account is read with
// `gh auth token --user ACCOUNT` (ambient GH_TOKEN/GITHUB_TOKEN are removed from that
// call so the stored credential of the named account is the one returned) and then
// injected as GH_TOKEN only into the env of the REST calls. Responses come from
// `gh api --include`, so the HTTP status is read even for error responses.
export interface GhCliOptions {
  command?: string;
}

export function createGhCliBoundary(options: GhCliOptions = {}): GitHubBoundary {
  const command = options.command ?? "gh";
  return {
    async accountToken(account) {
      const env = { ...process.env };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      const result = await runCommand(command, ["auth", "token", "--user", account], { env });
      const token = result.stdout.trim();
      if (result.code !== 0 || token === "") {
        throw new Error(`token da conta GitHub '${account}' indisponível (gh auth token --user)`);
      }
      return token;
    },
    async api(request, token) {
      const args = ["api", "--include", "--method", request.method, request.path];
      const input = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (input !== undefined) args.push("--input", "-");
      const result = await runCommand(command, args, {
        env: { ...process.env, GH_TOKEN: token },
        input,
      });
      const parsed = parseIncludeOutput(result.stdout);
      if (parsed) return parsed;
      throw new Error(`gh api ${request.method} ${request.path} sem resposta HTTP (exit ${result.code}): ${result.stderr.trim()}`);
    },
  };
}

function parseIncludeOutput(stdout: string): GitHubResponse | undefined {
  const statusMatch = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!statusMatch) return undefined;
  const separator = /\r?\n\r?\n/.exec(stdout);
  const text = separator ? stdout.slice(separator.index + separator[0].length).trim() : "";
  return { status: Number(statusMatch[1]), body: text === "" ? null : JSON.parse(text) as unknown };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}
