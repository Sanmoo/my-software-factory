import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Labels } from "../config.js";
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
 * REST-only (the machine's shared-IP budget leaves no GraphQL room): every gh
 * call is `gh api` against the REST endpoints — never `gh issue list` (GraphQL
 * under the hood in gh ≥ 2.63), `gh issue view`/`gh pr view`/`gh pr create`.
 *
 * Contract from the port: writes report intents, never confirmations; unknown
 * is never absent; priority is createdAt from the same listing (GitHub has no
 * native rank).
 */

const GIT_CREDENTIAL_HELPER = "!gh auth git-credential";
const CREDENTIAL_URL_HELPER_KEY = "credential.https://github.com.helper";

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
 * 9c. Bake exactly ONE credential helper into a clone's local config. A reused
 * clone accumulates helper entries: clone time bakes two (`--config
 * credential.helper=` plus the gh helper), and earlier works or an odd machine
 * config can leave more behind (ticket 16's smoke: a bare set on the multivar
 * failed with exit 5 — "cannot overwrite multiple values with a single value").
 *
 * So the bake unsets EVERY local value of both helper keys first, then sets the
 * single intended values. The unset tolerates exit 5 — the key is simply absent
 * — and every read of the keys is multivar-safe (`--unset-all` / `--get-all`),
 * so git's "has multiple values" warning can never break the flow.
 */
export async function bakeCredentialHelper(
  cloneDir: string,
  env: Record<string, string | undefined>,
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  const unsetAll = async (key: string): Promise<void> => {
    try {
      await runner("git", ["config", "--local", "--unset-all", key], { cwd: cloneDir, env });
    } catch (error) {
      // Exit 5: the key holds no value in the local config — nothing to unset.
      if ((error as { exitCode?: number | null }).exitCode !== 5) throw error;
    }
  };
  // The empty value resets the ambient helper list read so far (the system and
  // global scopes — e.g. a broken mac leftover); the URL-scoped one is the gh
  // keyring helper for real remotes.
  await unsetAll("credential.helper");
  await unsetAll(CREDENTIAL_URL_HELPER_KEY);
  await runner("git", ["config", "--local", "credential.helper", ""], { cwd: cloneDir, env });
  await runner("git", ["config", "--local", CREDENTIAL_URL_HELPER_KEY, GIT_CREDENTIAL_HELPER], { cwd: cloneDir, env });
}

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

/** GET /repos/{owner}/{repo}/issues?state=open (the listing; PRs excluded defensively) */
interface RestListedIssue {
  number: number;
  title: string;
  created_at: string;
  pull_request?: unknown;
  labels: { name: string }[];
}

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

/** GET /repos/{owner}/{repo}/pulls?state=open (the linkage read of the pool) */
interface RestListedPull {
  number: number;
  body: string | null;
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

/** GET /repos/{owner}/{repo}/pulls/{n}/reviews — body is null for approval-only reviews. */
interface RestReview {
  id: number;
  user: { login: string };
  body: string | null;
  submitted_at: string | null;
}

/** GET /repos/{owner}/{repo}/pulls/{n}/comments — the inline review comment. */
interface RestInlineComment extends RestComment {
  path?: string;
  line?: number | null;
}

/** GET /repos/{owner}/{repo}/issues/{n}/timeline (cross-referenced event) */
interface RestTimelineEvent {
  event: string;
  source?: { issue?: { number: number; pull_request?: unknown } };
}

const isNotFound = (stderr: string): boolean => stderr.includes("Not Found") || stderr.includes("HTTP 404");
const isAbsentLabel = (stderr: string): boolean => /'[^']+' not found/.test(stderr) || isNotFound(stderr);
const isLabelAlreadyExists = (stderr: string): boolean =>
  /already.?exists/i.test(stderr) ||
  // gh prints the 422 body to stdout, not stderr: "Validation Failed (HTTP 422)"
  // with {"errors":[{"code":"already_exists", ...}]} — the label-exists case is
  // the only realistic 422 of a label create; a true failure surfaces later on
  // the label's first real use.
  stderr.includes("HTTP 422");

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

  /** 1. Open issues carrying the ready label — candidates and createdAt in the same listing.
   *
   * The ready label is matched CLIENT-SIDE, not with the listing's `labels` query
   * param: GitHub's label-filtered listing is search-index-backed and lags minutes
   * behind a freshly applied label, while the plain open-issues listing is
   * immediately consistent (a just-labeled issue appears at once). The client-side
   * filter makes candidates see brand-new labeled issues in the same poll — the
   * real-GitHub smoke failure that motivated this dialect (ticket 16).
   *
   * Ticket 12 (spec: only issues WITHOUT a PR enter the pool): the issue listing
   * cannot tell PR linkage, so ONE open-PRs listing is read and every issue whose
   * number a PR body links (Closes/Fixes/Resolves #N) is excluded. LIMITATION,
   * accepted for budget: a human PR whose body carries no linkage keyword slips
   * through — the honest alternative, a per-candidate timeline cross-ref, costs
   * one REST call per candidate and was rejected (60/h shared budget). A slipped
   * work is caught after its claim (the PR fact re-derives every tick), and only
   * the first 100 open PRs are read (per_page=100, one call).
   */
  async listCandidates(repo: string, readyLabel: string): Promise<Candidate[]> {
    const nodes = await this.api<RestListedIssue[]>(
      `repos/${repo}/issues?state=open&per_page=500`,
    );
    const labeled = nodes
      .filter((issue) => !issue.pull_request) // PRs never appear in the issue listing
      .filter((issue) => issue.labels.some((label) => label.name === readyLabel));
    if (nodes.length === 0) return []; // nothing listed — nothing to filter, no PR read
    const linked = await this.linkedIssueNumbers(repo);
    return labeled
      .filter((issue) => !linked.has(issue.number))
      .map((issue) => ({
        ref: { repo, number: issue.number },
        title: issue.title,
        createdAt: issue.created_at,
      }));
  }

  /** The issue numbers linked by OPEN PR bodies — one listing, one pass. */
  private async linkedIssueNumbers(repo: string): Promise<Set<number>> {
    const pulls = await this.api<RestListedPull[]>(`repos/${repo}/pulls?state=open&per_page=100`);
    const linked = new Set<number>();
    for (const pull of pulls) {
      for (const match of pull.body?.matchAll(/(?:Closes|Fixes|Resolves) #(\d+)/g) ?? []) {
        linked.add(Number(match[1]));
      }
    }
    return linked;
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

  /** 5. Release: swap claimed→ready back (the ruler's 1st fall — the work re-enters
   *  the pool; the ready label is given) or remove only the claim mark when no ready
   *  label is given. The swap mirrors the claim's composite write in reverse: the
   *  ready label comes back last, so a half-written release never shows the work as
   *  ready while the claim mark is still on. */
  async releaseClaim(ref: IssueRef, account: string, readyLabel?: string): Promise<WriteOutcome> {
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
    // The ruler's 1st fall releases the work BACK to the pool: the ready label
    // returns — same composite shape as the claim's swap, mirrored in reverse.
    if (readyLabel !== undefined) {
      try {
        await this.ensureLabelExists(ref.repo, readyLabel);
        await this.api(`repos/${ref.repo}/issues/${ref.number}/labels`, {
          method: "POST",
          input: { labels: [readyLabel] },
        });
      } catch (error) {
        throw new PartialWriteError(performed, (error as Error).message);
      }
      performed.push(`label+${readyLabel} on ${ref.repo}#${ref.number}`);
    }
    return { performed };
  }

  /** 5b. Block: swap claimed→blocked on the 2nd consecutive fall (the ruler of
   *  ticket 13) — the claim is held until the terminal state, so the assignee
   *  stays. The blocked label replaces the claimed one, same ordered composite
   *  write as the claim's swap. */
  async blockClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
    const performed: string[] = [];
    // absent label (on the issue or in the repo) is a tolerated no-op
    await this.api(`repos/${ref.repo}/issues/${ref.number}/labels/${labels.claimed}`, {
      method: "DELETE",
      tolerate: isAbsentLabel,
    }).then(
      () => performed.push(`label-${labels.claimed} on ${ref.repo}#${ref.number}`),
      () => {},
    );
    try {
      await this.ensureLabelExists(ref.repo, labels.blocked);
      await this.api(`repos/${ref.repo}/issues/${ref.number}/labels`, {
        method: "POST",
        input: { labels: [labels.blocked] },
      });
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`label+${labels.blocked} on ${ref.repo}#${ref.number}`);
    return { performed };
  }

  /** 5c. Resume (ticket 14): swap blocked→claimed on the retomada — a human
   *  answered after the marker, the claim is held again. Mirrors blockClaim
   *  in reverse: the blocked label leaves first (tolerated when absent), the
   *  claimed label returns last, the assignee never left. */
  async resumeClaim(ref: IssueRef, labels: Labels): Promise<WriteOutcome> {
    const performed: string[] = [];
    await this.api(`repos/${ref.repo}/issues/${ref.number}/labels/${labels.blocked}`, {
      method: "DELETE",
      tolerate: isAbsentLabel,
    }).then(
      () => performed.push(`label-${labels.blocked} on ${ref.repo}#${ref.number}`),
      () => {},
    );
    try {
      await this.ensureLabelExists(ref.repo, labels.claimed);
      await this.api(`repos/${ref.repo}/issues/${ref.number}/labels`, {
        method: "POST",
        input: { labels: [labels.claimed] },
      });
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`label+${labels.claimed} on ${ref.repo}#${ref.number}`);
    return { performed };
  }

  /** 9d. Reopen (ticket 14): the rejection's retomada reopens the SAME PR
   *  linked to the issue, never a new one. No PR linked (yet) is a tolerated
   *  no-op — the derivation only schedules the reopen with a PR in hand. */
  async reopenPr(ref: IssueRef): Promise<WriteOutcome> {
    const performed: string[] = [];
    const timeline = await this.apiOrNull<RestTimelineEvent[]>(
      `repos/${ref.repo}/issues/${ref.number}/timeline?per_page=100`,
    );
    if (!timeline) return { performed };
    const prNumber = linkedPrNumber(timeline);
    if (prNumber === null) return { performed };
    try {
      await this.api(`repos/${ref.repo}/pulls/${prNumber}`, {
        method: "PATCH",
        input: { state: "open" },
      });
    } catch (error) {
      throw new PartialWriteError(performed, (error as Error).message);
    }
    performed.push(`pull ${ref.repo}#${prNumber} reopened`);
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
    const [pull, comments, reviews, inline] = await Promise.all([
      this.api<RestPull>(`repos/${ref.repo}/pulls/${prNumber}`),
      this.api<RestComment[]>(`repos/${ref.repo}/issues/${prNumber}/comments`),
      this.api<RestReview[]>(`repos/${ref.repo}/pulls/${prNumber}/reviews`),
      this.api<RestInlineComment[]>(`repos/${ref.repo}/pulls/${prNumber}/comments`),
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
      comments: (comments ?? []).map(mapComment),
      reviews: [
        // Approval-only reviews carry body: null — no speech signal in them,
        // so they are dropped here (an approval is not feedback; the inline
        // comments come from the other channel below). Dropped, a null body
        // can never reach the state derivation, where isAgentSpeech would
        // crash on it (body.includes of null — spec #7). A review that DID
        // speak keeps its submitted_at; one without it falls back to ""
        // (sorted first — the honest floor, never a lie).
        ...(reviews ?? []).filter(isSpeechReview).map((review) => ({
          id: String(review.id),
          author: review.user.login,
          body: review.body,
          createdAt: review.submitted_at ?? "",
        })),
        ...(inline ?? []).map((comment) => ({
          id: String(comment.id),
          author: comment.user.login,
          body: inlineCommentBody(comment),
          createdAt: comment.created_at,
        })),
      ],
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
    // Bake the helper into the clone — unset-all first, then set, so a reused
    // clone never accumulates stale helpers and the bake never fails on a
    // multi-valued key (exit 5).
    await bakeCredentialHelper(cloneDir, env, this.runner);
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

/** A review submission that carries speech — body null/empty is the
 *  approval-only review: no signal, dropped before it can reach the
 *  derivation (a null body would crash isAgentSpeech — spec #7). */
function isSpeechReview(review: RestReview): review is RestReview & { body: string } {
  return review.body !== null && review.body !== "";
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

/** The inline comment, with the file it points at — the body alone hides where. */
function inlineCommentBody(comment: RestInlineComment): string {
  if (!comment.path) return comment.body;
  const at = comment.line == null ? comment.path : `${comment.path}:${comment.line}`;
  return `${comment.body}\n(${at})`;
}
