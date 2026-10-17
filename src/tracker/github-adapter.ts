import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_MARKER,
  type Blocker,
  type Candidate,
  type IssueComment,
  type IssueRef,
  type IssueSnapshot,
  type Known,
  type OpenPrInput,
  type PrFeedback,
  type PullRequest,
  type PushBranchInput,
  type TrackerPort,
  type WriteOutcome,
  known,
  notKnown,
  PartialWriteError,
} from "./port.js";

/**
 * The real tracker adapter: GitHub over the `gh` CLI (ticket 16). The token
 * lives in the keyring of the gh CLI (`gh auth token --user <account>` — the
 * keyring is the config's secret-free companion, spec user story 33) and is
 * injected as `GH_TOKEN` in the env of every gh/git call only — the active gh
 * account of the machine is never touched (ticket 09). Push is git with the
 * credential helper baked into the clone (the pattern proven in ticket 09:
 * `!gh auth git-credential` + `GH_TOKEN` authenticates clone and push).
 *
 * REST-only (the machine's shared-IP budget leaves no GraphQL room): the gh
 * calls are `gh issue list` (REST under the hood) and `gh api` against the
 * REST endpoints — never `gh issue view`/`gh pr view`/`gh pr create` (GraphQL).
 *
 * Contract from the port: writes report intents, never confirmations; unknown
 * is never absent; priority is createdAt from the same listing (GitHub has no
 * native rank).
 */

const GIT_CREDENTIAL_HELPER = "!gh auth git-credential";

export type CommandRunner = (
  file: string,
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    cwd?: string;
    input?: string;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface GitHubAdapterOptions {
  /** The bot account owning the token in the gh keyring (boot check reads it). */
  account: string;
  /** The account PRs arrive from and claims are assigned to; defaults to account. */
  workerAccount?: string;
  /** Where per-repo clones live: <clonesDir>/<owner>#<name>/. */
  clonesDir?: string;
  /** The claim label; defaults to the port's vocabulary default. */
  claimedLabel?: string;
  /** Command runner injection for offline tests. */
  runner?: CommandRunner;
}

export class MissingCredentialError extends Error {
  constructor(account: string, reason: string) {
    super(
      `no GitHub token in the gh keyring for account "${account}" (${reason}). ` +
        `Set up the bot credential — e.g. \`gh auth login\` as ${account} or ` +
        `\`secret-tool\` in the gh keyring format (service gh:github.com, username ${account}) — ` +
        `then run again.`,
    );
    this.name = "MissingCredentialError";
  }
}

class CommandError extends Error {
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${file} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
    this.name = "CommandError";
  }
}

/** The env every gh/git call of the factory runs with: the bot token and no prompts. */
export function ghCliEnv(token: string): Record<string, string | undefined> {
  return { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" };
}

/** The production command runner (real child processes); injectable in tests. */
export const defaultCommandRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new CommandError(file, args, code, stderr));
      }
    });
    child.stdin.end(options.input ?? "");
  });

/**
 * Boot check (ticket 16): read the bot token from the gh keyring. Fails the
 * boot with a clear message when the account has no token. The read strips
 * ambient GH_TOKEN from the env so an environment token never shadows the
 * keyring (v1's createGhCliBoundary pattern).
 */
export async function readGhToken(
  account: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<string> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GH_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    const { stdout } = await runner("gh", ["auth", "token", "--user", account], { env });
    const token = stdout.trim();
    if (token === "") throw new Error("empty token");
    return token;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
    throw new MissingCredentialError(account, reason);
  }
}

/** Factory: reads the credential (boot check) and hands back the adapter. */
export async function createGitHubAdapter(options: GitHubAdapterOptions): Promise<GitHubTrackerAdapter> {
  const runner = options.runner ?? defaultCommandRunner;
  const token = await readGhToken(options.account, runner);
  return new GitHubTrackerAdapter({ ...options, token, runner });
}

// ---- REST JSON shapes (only the fields the adapter reads) ----

/** GET /repos/{owner}/{repo}/issues/{n} */
interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not planned" | "reopened" | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
}

/** GET /repos/{owner}/{repo}/issues/{n}/comments */
interface RestComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}

/** GET /repos/{owner}/{repo}/pulls/{n} */
interface RestPull {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  user: { login: string };
}

/** GET /repos/{owner}/{repo}/pulls/{n}/reviews */
interface RestReview {
  id: number;
  user: { login: string };
  body: string;
  submitted_at: string | null;
}

/** GET /repos/{owner}/{repo}/issues/{n}/timeline (cross-referenced event) */
interface RestTimelineEvent {
  event: string;
  source?: { issue?: { number: number; pull_request?: unknown } };
}

const isNotFound = (stderr: string): boolean => stderr.includes("Not Found") || stderr.includes("HTTP 404");
const isAbsentLabel = (stderr: string): boolean => /'[^']+' not found/.test(stderr) || isNotFound(stderr);
const isLabelAlreadyExists = (stderr: string): boolean => /already.?exists/i.test(stderr);

export interface GitHubTrackerAdapterOptions extends GitHubAdapterOptions {
  token: string;
  runner: CommandRunner;
}

export class GitHubTrackerAdapter implements TrackerPort {
  private readonly token: string;
  private readonly runner: CommandRunner;
  readonly account: string;
  readonly workerAccount: string;
  readonly claimedLabel: string;
  private readonly clonesDir: string;
  /** Repo labels already ensured this boot — one REST call, not one per claim. */
  private readonly labelsEnsured = new Set<string>();

  constructor(options: GitHubTrackerAdapterOptions) {
    this.token = options.token;
    this.runner = options.runner ?? defaultCommandRunner;
    this.account = options.account;
    this.workerAccount = options.workerAccount ?? options.account;
    this.claimedLabel = options.claimedLabel ?? "agent-claimed";
    this.clonesDir = options.clonesDir ?? join(tmpdir(), "msf-clones");
  }

  // ---- the 9 operations + rank ----

  /** 1. Open issues carrying the ready label — candidates and createdAt in the same listing. */
  async listCandidates(repo: string, readyLabel: string): Promise<Candidate[]> {
    const { stdout } = await this.gh([
      "issue", "list",
      "-R", repo,
      "--state", "open",
      "--label", readyLabel,
      "--limit", "500",
      "--json", "number,title,createdAt",
    ]);
    const parsed = JSON.parse(stdout) as { number: number; title: string; createdAt: string }[];
    // gh issue list never returns PRs — no pull_request filter needed here.
    return parsed.map((issue) => ({
      ref: { repo, number: issue.number },
      title: issue.title,
      createdAt: issue.createdAt,
    }));
  }

  /** 2. Snapshot of one issue. */
  async readIssue(ref: IssueRef): Promise<Known<IssueSnapshot>> {
    const view = await this.apiOrNull<RestIssue>(`repos/${ref.repo}/issues/${ref.number}`);
    if (!view) return notKnown;
    return known({
      ref,
      title: view.title,
      body: view.body ?? "",
      state: view.state === "closed" ? "closed" : "open",
      stateReason: terminalReason(view.state_reason),
      labels: view.labels.map((label) => label.name),
      assignees: view.assignees.map((assignee) => assignee.login),
      createdAt: view.created_at,
    });
  }

  /** 3. Native blocked_by dependencies with each blocker's terminal state. */
  async readBlockers(ref: IssueRef): Promise<Known<Blocker[]>> {
    const nodes = await this.apiOrNull<RestIssue[]>(
      `repos/${ref.repo}/issues/${ref.number}/dependencies/blocked_by`,
    );
    if (!nodes) return notKnown;
    return known(
      nodes.map((node) => ({
        ref: { repo: ref.repo, number: node.number },
        state: node.state === "closed" ? ("closed" as const) : ("open" as const),
      })),
    );
  }

  /** 4. Claim: swap ready→claimed (when the ready label is given) + assign the worker
   *  account — the reservation lands on the tracker BEFORE any launch. The swap
   *  is ordered: the ready label leaves first, so a concurrent sweep never sees
   *  the work again; then the claimed label, then the assignee. */
  async claim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
    const performed: string[] = [];
    if (readyLabel !== undefined) {
      // the absent ready label is a tolerated no-op (the fake tolerates it too)
      await this.api(`repos/${ref.repo}/issues/${ref.number}/labels/${readyLabel}`, {
        method: "DELETE",
        tolerate: isAbsentLabel,
      }).then(
        () => performed.push(`label-${readyLabel} on ${ref.repo}#${ref.number}`),
        () => {},
      );
    }
    await this.ensureLabelExists(ref.repo, this.claimedLabel);
    await this.api(`repos/${ref.repo}/issues/${ref.number}/labels`, {
      method: "POST",
      input: { labels: [this.claimedLabel] },
    });
    const labelDone = `label+${this.claimedLabel} on ${ref.repo}#${ref.number}`;
    performed.push(labelDone);
    try {
      await this.api(`repos/${ref.repo}/issues/${ref.number}/assignees`, {
        method: "POST",
        input: { assignees: [account] },
      });
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`assignee ${account}`);
    return { performed };
  }

  /** 5. Release: remove only the claim mark (label + account assignee). */
  async releaseClaim(ref: IssueRef, account: string): Promise<WriteOutcome> {
    const performed: string[] = [];
    // absent label (on the issue or in the repo) is a tolerated no-op
    await this.api(`repos/${ref.repo}/issues/${ref.number}/labels/${this.claimedLabel}`, {
      method: "DELETE",
      tolerate: isAbsentLabel,
    }).then(
      () => performed.push(`label-${this.claimedLabel} on ${ref.repo}#${ref.number}`),
      () => {},
    );
    try {
      await this.api(`repos/${ref.repo}/issues/${ref.number}/assignees`, {
        method: "DELETE",
        input: { assignees: [account] },
      });
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`unassignee ${account}`);
    return { performed };
  }

  /** 6. Done: close the issue as completed. */
  async markDone(ref: IssueRef): Promise<WriteOutcome> {
    await this.api(`repos/${ref.repo}/issues/${ref.number}`, {
      method: "PATCH",
      input: { state: "closed", state_reason: "completed" },
    });
    return { performed: [`close as completed ${ref.repo}#${ref.number}`] };
  }

  /** 7. Comment on the issue — everything published carries the agent marker. */
  async comment(ref: IssueRef, body: string): Promise<WriteOutcome> {
    const marked = body.startsWith(AGENT_MARKER) ? body : `${AGENT_MARKER} ${body}`;
    await this.api(`repos/${ref.repo}/issues/${ref.number}/comments`, {
      method: "POST",
      input: { body: marked },
    });
    return { performed: [`comment on ${ref.repo}#${ref.number}`] };
  }

  /** 8. The issue's comments. */
  async readComments(ref: IssueRef): Promise<Known<IssueComment[]>> {
    const comments = await this.apiOrNull<RestComment[]>(`repos/${ref.repo}/issues/${ref.number}/comments`);
    if (!comments) return notKnown;
    return known(comments.map(mapComment));
  }

  /** 9a. PR feedback: the PR linked to the issue (timeline linkage), its conversation and reviews. */
  async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
    const timeline = await this.apiOrNull<RestTimelineEvent[]>(
      `repos/${ref.repo}/issues/${ref.number}/timeline?per_page=100`,
    );
    if (!timeline) return notKnown;
    const prNumber = linkedPrNumber(timeline);
    if (prNumber === null) {
      const comments = await this.apiOrNull<RestComment[]>(`repos/${ref.repo}/issues/${ref.number}/comments`);
      if (!comments) return notKnown;
      return known({ pr: null, comments: comments.map(mapComment), reviews: [] });
    }
    const [pull, comments, reviews] = await Promise.all([
      this.api<RestPull>(`repos/${ref.repo}/pulls/${prNumber}`),
      this.api<RestComment[]>(`repos/${ref.repo}/issues/${prNumber}/comments`),
      this.api<RestReview[]>(`repos/${ref.repo}/pulls/${prNumber}/reviews`),
    ]);
    return known({
      pr: {
        number: pull.number,
        state: pull.state === "open" ? "open" : "closed",
        merged: pull.merged_at !== null,
        headBranch: pull.head.ref,
        baseBranch: pull.base.ref,
        author: pull.user.login,
      },
      comments: comments.map(mapComment),
      reviews: reviews.map((review) => ({
        id: String(review.id),
        author: review.user.login,
        body: review.body,
        createdAt: review.submitted_at ?? "",
      })),
    });
  }

  /** 9b. Open the PR of a work's branch, linked to the issue ("Closes #N"). */
  async openPr(input: OpenPrInput): Promise<PullRequest> {
    const body = `Closes #${input.issueNumber}\n\n${AGENT_MARKER}`;
    const pull = await this.api<{ number: number }>(`repos/${input.repo}/pulls`, {
      method: "POST",
      input: { title: input.title, head: input.headBranch, base: input.baseBranch, body },
    });
    return {
      number: pull.number,
      state: "open",
      merged: false,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      author: this.workerAccount,
    };
  }

  /** 9c. Push a work's branch: git, with the credential helper baked into the clone. */
  async pushBranch(input: PushBranchInput): Promise<WriteOutcome> {
    const cloneDir = join(this.clonesDir, input.repo.replace("/", "#"));
    const url = `https://github.com/${input.repo}.git`;
    const env = this.gitEnv();

    if (!existsSync(join(cloneDir, ".git"))) {
      await this.runner("git", ["clone", "--config", "credential.helper=", "--config", `credential.helper=${GIT_CREDENTIAL_HELPER}`, url, cloneDir], { env });
    }
    // Bake the helper into the clone and isolate ambient helper config: the
    // empty values reset whatever the system/global config declared.
    await this.runner("git", ["config", "--local", "credential.helper", ""], { cwd: cloneDir, env });
    await this.runner("git", ["config", "--local", "credential.https://github.com.helper", ""], { cwd: cloneDir, env });
    await this.runner("git", ["config", "--local", "credential.https://github.com.helper", GIT_CREDENTIAL_HELPER], { cwd: cloneDir, env });
    await this.runner("git", ["fetch", "origin", "--prune"], { cwd: cloneDir, env });

    const hasLocalBranch = await this.runner(
      "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`], { cwd: cloneDir, env },
    ).then(
      () => true,
      () => false,
    );

    if (hasLocalBranch) {
      await this.runner("git", ["push", "origin", `refs/heads/${input.branch}:refs/heads/${input.branch}`], { cwd: cloneDir, env });
      return { performed: [`push ${input.repo}:${input.branch}`] };
    }

    // No local branch yet: the work branch is born from the default branch
    // (origin/HEAD), exactly the birth the branch strategy prescribes.
    const { stdout: sha } = await this.runner("git", ["rev-parse", "refs/remotes/origin/HEAD"], { cwd: cloneDir, env });
    await this.runner("git", ["push", "origin", `${sha.trim()}:refs/heads/${input.branch}`], { cwd: cloneDir, env });
    return { performed: [`push ${input.repo}:${input.branch} (born from origin default)`] };
  }

  /** GitHub has no native priority — the honest answer is null; age orders the pool. */
  async rank(_ref: IssueRef): Promise<Known<number | null>> {
    return known(null);
  }

  // ---- internals ----

  private ghEnv(): Record<string, string | undefined> {
    return ghCliEnv(this.token);
  }

  private gitEnv(): Record<string, string | undefined> {
    return this.ghEnv();
  }

  private async gh(
    args: string[],
    options: { input?: string; tolerate?: (stderr: string) => boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runner("gh", args, {
        env: this.ghEnv(),
        ...(options.input === undefined ? {} : { input: options.input }),
      });
    } catch (error) {
      const commandError = error as CommandError;
      if (options.tolerate && typeof commandError.stderr === "string" && options.tolerate(commandError.stderr)) {
        return { stdout: "", stderr: commandError.stderr };
      }
      throw error;
    }
  }

  /** One REST call over `gh api` — the body goes over stdin (`--input -`), never argv. */
  private async api<T>(
    path: string,
    init: { method?: "POST" | "PATCH" | "DELETE"; input?: unknown; tolerate?: (stderr: string) => boolean } = {},
  ): Promise<T> {
    const args = ["api", ...(init.method ? ["-X", init.method] : []), path];
    const { stdout } = await this.gh(
      init.input === undefined ? args : [...args, "--input", "-"],
      {
        ...(init.input === undefined ? {} : { input: JSON.stringify(init.input) }),
        ...(init.tolerate ? { tolerate: init.tolerate } : {}),
      },
    );
    return (stdout.trim() === "" ? null : JSON.parse(stdout)) as T;
  }

  /** The REST call or null when GitHub answers 404 (unknown is never absent). */
  private async apiOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.api<T>(path);
    } catch (error) {
      const stderr = (error as CommandError).stderr ?? (error as Error).message;
      if (typeof stderr === "string" && isNotFound(stderr)) return null;
      throw error;
    }
  }

  private async ensureLabelExists(repo: string, label: string): Promise<void> {
    const cacheKey = `${repo}/${label}`;
    if (this.labelsEnsured.has(cacheKey)) return;
    await this.api(`repos/${repo}/labels`, {
      method: "POST",
      input: { name: label },
      tolerate: isLabelAlreadyExists,
    });
    this.labelsEnsured.add(cacheKey);
  }
}

/** The PR linked to the issue: the latest cross-reference from a PR ("Closes #N"). */
function linkedPrNumber(timeline: RestTimelineEvent[]): number | null {
  const numbers = timeline
    .filter((event) => event.event === "cross-referenced")
    .map((event) => event.source?.issue)
    .flatMap((issue) => (issue !== undefined && issue.pull_request != null ? [issue.number] : []));
  const last = numbers.at(-1);
  return last === undefined ? null : last;
}

function terminalReason(reason: RestIssue["state_reason"]): IssueSnapshot["stateReason"] {
  if (reason === "completed") return "completed";
  if (reason === "not planned") return "not-planned";
  return null; // reopened (or absent) is not a terminal reason
}

function mapComment(comment: RestComment): IssueComment {
  return {
    id: String(comment.id),
    author: comment.user.login,
    body: comment.body,
    createdAt: comment.created_at,
  };
}
