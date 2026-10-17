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

// ---- gh JSON shapes (only the fields the adapter reads) ----

interface GhIssueView {
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  createdAt: string;
}

interface GhComment {
  id: string;
  author: { login: string };
  body: string;
  createdAt: string;
}

interface GhPrView {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  comments: GhComment[];
  reviews: { id: string; author: { login: string }; body: string; submittedAt: string | null }[];
}

const isNotFound = (stderr: string): boolean => stderr.includes("Could not resolve to an issue");
const isAbsentLabel = (stderr: string): boolean => /'[^']+' not found/.test(stderr);

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
    const view = await this.issueView<GhIssueView>(ref, "number,title,body,state,stateReason,labels,assignees,createdAt");
    if (!view) return notKnown;
    return known({
      ref,
      title: view.title,
      body: view.body ?? "",
      state: view.state === "CLOSED" ? "closed" : "open",
      stateReason: terminalReason(view.stateReason),
      labels: view.labels.map((label) => label.name),
      assignees: view.assignees.map((assignee) => assignee.login),
      createdAt: view.createdAt,
    });
  }

  /** 3. Native blocked_by dependencies with each blocker's terminal state. */
  async readBlockers(ref: IssueRef): Promise<Known<Blocker[]>> {
    const view = await this.issueView<{ blockedBy?: { nodes?: { number: number; state: string }[] } }>(ref, "blockedBy");
    if (!view) return notKnown;
    const nodes = view.blockedBy?.nodes ?? [];
    return known(
      nodes.map((node) => ({
        ref: { repo: ref.repo, number: node.number },
        state: node.state === "CLOSED" ? ("closed" as const) : ("open" as const),
      })),
    );
  }

  /** 4. Claim: claimed label + assign the worker account (two intents, partial reported). */
  async claim(ref: IssueRef, account: string): Promise<WriteOutcome> {
    await this.ensureLabelExists(ref.repo, this.claimedLabel);
    await this.gh(["issue", "edit", String(ref.number), "-R", ref.repo, "--add-label", this.claimedLabel]);
    const labelDone = `label+${this.claimedLabel} on ${ref.repo}#${ref.number}`;
    try {
      await this.gh(["issue", "edit", String(ref.number), "-R", ref.repo, "--add-assignee", account]);
    } catch (error) {
      throw new PartialWriteError([labelDone], (error as Error).message);
    }
    return { performed: [labelDone, `assignee ${account}`] };
  }

  /** 5. Release: remove only the claim mark (label + account assignee). */
  async releaseClaim(ref: IssueRef, account: string): Promise<WriteOutcome> {
    const performed: string[] = [];
    // absent label (on the issue or in the repo) is a tolerated no-op
    await this.gh(
      ["issue", "edit", String(ref.number), "-R", ref.repo, "--remove-label", this.claimedLabel],
      { tolerate: isAbsentLabel },
    ).then(
      () => performed.push(`label-${this.claimedLabel} on ${ref.repo}#${ref.number}`),
      () => {},
    );
    try {
      await this.gh(["issue", "edit", String(ref.number), "-R", ref.repo, "--remove-assignee", account]);
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`unassignee ${account}`);
    return { performed };
  }

  /** 6. Done: close the issue as completed. */
  async markDone(ref: IssueRef): Promise<WriteOutcome> {
    await this.gh(["issue", "close", String(ref.number), "-R", ref.repo, "--reason", "completed"]);
    return { performed: [`close as completed ${ref.repo}#${ref.number}`] };
  }

  /** 7. Comment on the issue — everything published carries the agent marker. */
  async comment(ref: IssueRef, body: string): Promise<WriteOutcome> {
    const marked = body.startsWith(AGENT_MARKER) ? body : `${AGENT_MARKER} ${body}`;
    await this.gh(["issue", "comment", String(ref.number), "-R", ref.repo, "--body-file", "-"], {
      input: marked,
    });
    return { performed: [`comment on ${ref.repo}#${ref.number}`] };
  }

  /** 8. The issue's comments. */
  async readComments(ref: IssueRef): Promise<Known<IssueComment[]>> {
    const view = await this.issueView<{ comments: GhComment[] }>(ref, "comments");
    if (!view) return notKnown;
    return known(view.comments.map(mapComment));
  }

  /** 9a. PR feedback: the PR linked to the issue (timeline linkage), its conversation and reviews. */
  async readPrFeedback(ref: IssueRef): Promise<Known<PrFeedback>> {
    const view = await this.issueView<{ comments: GhComment[] }>(ref, "comments");
    if (!view) return notKnown;
    const comments = (view.comments ?? []).map(mapComment);

    const prNumber = await this.findLinkedPrNumber(ref);
    if (prNumber === null) {
      return known({ pr: null, comments, reviews: [] });
    }
    const { stdout } = await this.gh([
      "pr", "view", String(prNumber), "-R", ref.repo,
      "--json", "number,state,mergedAt,headRefName,baseRefName,author,comments,reviews",
    ]);
    const pr = JSON.parse(stdout) as GhPrView;
    return known({
      pr: {
        number: pr.number,
        state: pr.state === "OPEN" ? "open" : "closed",
        merged: pr.mergedAt !== null,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        author: pr.author.login,
      },
      comments: pr.comments.map(mapComment),
      reviews: pr.reviews.map((review) => ({
        id: review.id,
        author: review.author.login,
        body: review.body,
        createdAt: review.submittedAt ?? "",
      })),
    });
  }

  /** 9b. Open the PR of a work's branch, linked to the issue ("Closes #N"). */
  async openPr(input: OpenPrInput): Promise<PullRequest> {
    const body = `Closes #${input.issueNumber}\n\n${AGENT_MARKER}`;
    const { stdout } = await this.gh(
      [
        "pr", "create",
        "-R", input.repo,
        "--head", input.headBranch,
        "--base", input.baseBranch,
        "--title", input.title,
        "--body-file", "-",
      ],
      { input: body },
    );
    const match = stdout.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`gh pr create did not return a PR URL: ${stdout.trim()}`);
    }
    return {
      number: Number(match[1]),
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

  /** Issue view or null when the issue does not exist (unknown is never absent). */
  private async issueView<T>(ref: IssueRef, fields: string): Promise<T | null> {
    try {
      const { stdout } = await this.gh(["issue", "view", String(ref.number), "-R", ref.repo, "--json", fields]);
      return JSON.parse(stdout) as T;
    } catch (error) {
      const stderr = (error as CommandError).stderr ?? (error as Error).message;
      if (isNotFound(stderr)) return null;
      throw error;
    }
  }

  /** The PR linked to the issue: the latest cross-reference from a PR ("Closes #N"). */
  private async findLinkedPrNumber(ref: IssueRef): Promise<number | null> {
    const { stdout } = await this.gh([
      "api",
      `repos/${ref.repo}/issues/${ref.number}/timeline`,
      "--paginate",
      "--jq",
      `.[] | select(.event == "cross-referenced") | .source.issue | select(.pull_request != null) | .number`,
    ]);
    const numbers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const last = numbers.at(-1);
    return last === undefined ? null : Number(last);
  }

  private async ensureLabelExists(repo: string, label: string): Promise<void> {
    await this.gh(["label", "create", label, "-R", repo], {
      tolerate: (stderr) => stderr.includes("already exists"),
    });
  }
}

function terminalReason(reason: GhIssueView["stateReason"]): IssueSnapshot["stateReason"] {
  if (reason === "COMPLETED") return "completed";
  if (reason === "NOT_PLANNED") return "not-planned";
  return null; // reopened (or absent) is not a terminal reason
}

function mapComment(comment: GhComment): IssueComment {
  return {
    id: comment.id,
    author: comment.author.login,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}
