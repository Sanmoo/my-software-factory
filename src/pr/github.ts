import { execFile } from "node:child_process";
import type { PrRef } from "../core/result.js";
import type { Known } from "../tracker/port.js";
import type { CheckState, PrCheck, PrComment, PrFeedback, PrLookup, PrPort, PrSnapshot, PrState, ReviewState } from "./port.js";
import { isObject, type Obj } from "../core/values.js";

// github.com adapter for the PR port, through the `gh` CLI (R01, R11). Each call gets the
// project account's token in its environment (GH_TOKEN), read with
// `gh auth token --user <account>`. The active gh account is never switched and the token
// never appears on the command line.

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The process boundary: runs `gh` with the given arguments and extra environment.
export type GhCall = (args: readonly string[], env: Record<string, string>) => Promise<GhResult>;

export interface GithubPrOptions {
  // GitHub account of the project that owns the repository (ProjectConfig.githubAccount).
  accountOf: (repository: string) => string;
  run?: GhCall;
}

// Read-only: the queries are the pull request lookup and its feedback. No merge operation exists here.
const PULL_REQUEST_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { "
  + "pullRequest(number: $number) { state baseRefName headRefName reviewDecision "
  + "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }";

// Feedback of the PR (R10): conversation comments, reviews (the last 100 of each) and the checks of the
// head commit. `isRequired` answers for the branch protection of the PR's base branch.
const FEEDBACK_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { "
  + "pullRequest(number: $number) { "
  + "comments(last: 100) { nodes { id author { __typename login } body createdAt } } "
  + "reviews(last: 100) { nodes { id author { __typename login } body state submittedAt } } "
  + "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename "
  + "... on CheckRun { id name status conclusion isRequired(pullRequestNumber: $number) } "
  + "... on StatusContext { id context state isRequired(pullRequestNumber: $number) } } } } } } } } } }";

const runGh: GhCall = (args, env) => new Promise((resolve, reject) => {
  execFile("gh", [...args], { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") {
      reject(error);
      return;
    }
    resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
  });
});


const CHECKS: Record<string, CheckState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const REVIEWS: Record<string, ReviewState> = { APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", REVIEW_REQUIRED: "pending" };
const STATES: Record<string, PrState> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
// A completed check run's conclusion. CANCELLED and STALE are neither a pass nor a failure.
const CONCLUSIONS: Record<string, CheckState> = {
  SUCCESS: "passing", NEUTRAL: "passing", SKIPPED: "passing",
  FAILURE: "failing", TIMED_OUT: "failing", STARTUP_FAILURE: "failing", ACTION_REQUIRED: "failing",
  CANCELLED: "none", STALE: "none",
};

function knownFrom<T extends string>(table: Record<string, T>, value: unknown, label: string): Known<T> {
  if (value === null) return { known: true, value: "none" as T };
  const mapped = typeof value === "string" ? table[value] : undefined;
  if (mapped !== undefined) return { known: true, value: mapped };
  return { known: false, reason: `${label} desconhecido: ${String(value)}` };
}

// The checks rollup of the last commit; null when the PR has no checks at all.
function rollupStateOf(pullRequest: Obj): string | null {
  const commits = pullRequest.commits;
  if (!isObject(commits) || !Array.isArray(commits.nodes)) return null;
  const node = commits.nodes[0];
  if (!isObject(node) || !isObject(node.commit)) return null;
  const rollup = node.commit.statusCheckRollup;
  return isObject(rollup) && typeof rollup.state === "string" ? rollup.state : null;
}

// A not-found answer: the repository or the PR is null. A failed call only counts when GraphQL
// explicitly reported NOT_FOUND; a null with a non-zero exit and no such error is an error.
function isNotFound(body: unknown, exitCode: number): boolean {
  if (!isObject(body) || !isObject(body.data)) return false;
  const repository = body.data.repository;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.some((error) => !isObject(error) || error.type !== "NOT_FOUND")) return false;
  if (exitCode !== 0 && errors.length === 0) return false;
  return repository === null || (isObject(repository) && repository.pullRequest === null);
}

const unexpectedFeedback = () => new Error("consulta de feedback do PR: resposta inesperada do github.com");

// The author of a comment or review. A deleted account (null author) is GitHub's "ghost", not a bot.
function authorOf(node: Obj): { author: string; isBot: boolean } {
  const actor = isObject(node.author) ? node.author : undefined;
  const login = typeof actor?.login === "string" ? actor.login : "ghost";
  return { author: login, isBot: actor?.__typename === "Bot" || login.endsWith("[bot]") };
}

function nodesOf(connection: unknown): Obj[] {
  const nodes = isObject(connection) && Array.isArray(connection.nodes) ? connection.nodes : undefined;
  if (nodes === undefined || !nodes.every(isObject)) throw unexpectedFeedback();
  return nodes as Obj[];
}

function commentOf(node: Obj, kind: PrComment["kind"], body: unknown, createdAt: unknown): PrComment {
  if (typeof node.id !== "string" || typeof body !== "string") throw unexpectedFeedback();
  return {
    id: node.id,
    kind,
    ...authorOf(node),
    body,
    createdAt: typeof createdAt === "string" ? createdAt : "",
  };
}

// A check run reports its status until it completes and its conclusion after that. The required
// flag is unknown when GitHub does not answer it, never a silent false.
function checkOf(node: Obj): PrCheck {
  if (typeof node.id !== "string") throw unexpectedFeedback();
  const required: Known<boolean> = typeof node.isRequired === "boolean"
    ? { known: true, value: node.isRequired }
    : { known: false, reason: "obrigatoriedade do check não informada pelo github.com" };
  if (node.__typename === "CheckRun") {
    const state: Known<CheckState> = node.status === "COMPLETED"
      ? knownFrom(CONCLUSIONS, node.conclusion, "conclusão de check")
      : typeof node.status === "string"
        ? { known: true, value: "pending" }
        : { known: false, reason: "estado de check não informado pelo github.com" };
    if (typeof node.name !== "string") throw unexpectedFeedback();
    return { id: node.id, name: node.name, state, required };
  }
  if (node.__typename === "StatusContext") {
    if (typeof node.context !== "string") throw unexpectedFeedback();
    return { id: node.id, name: node.context, state: knownFrom(CHECKS, node.state, "estado de checks"), required };
  }
  throw unexpectedFeedback();
}

function parseFeedback(body: unknown): PrFeedback {
  const repository = isObject(body) && isObject(body.data) ? body.data.repository : undefined;
  const pullRequest = isObject(repository) ? repository.pullRequest : undefined;
  if (!isObject(pullRequest)) throw unexpectedFeedback();
  const reviews = nodesOf(pullRequest.reviews)
    .filter((node) => node.state !== "PENDING") // a draft review is not published, so it is not feedback yet
    .map((node) => commentOf(node, "review", node.body, node.submittedAt));
  const comments = nodesOf(pullRequest.comments).map((node) => commentOf(node, "comment", node.body, node.createdAt));
  const commits = nodesOf(pullRequest.commits);
  const commit = isObject(commits[0]) && isObject(commits[0].commit) ? commits[0].commit : undefined;
  const rollup = commit?.statusCheckRollup;
  const contexts = isObject(rollup) ? nodesOf(rollup.contexts) : [];
  return { comments: [...comments, ...reviews], checks: contexts.map(checkOf) };
}

function parseSnapshot(ref: PrRef, body: unknown): PrSnapshot {
  const repository = isObject(body) && isObject(body.data) ? body.data.repository : undefined;
  const pullRequest = isObject(repository) ? repository.pullRequest : undefined;
  if (!isObject(pullRequest)) throw new Error("consulta de PR: resposta inesperada do github.com");
  const state = typeof pullRequest.state === "string" ? STATES[pullRequest.state] : undefined;
  if (state === undefined || typeof pullRequest.baseRefName !== "string" || typeof pullRequest.headRefName !== "string") {
    throw new Error("consulta de PR: resposta inesperada do github.com");
  }
  return {
    ref,
    state,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
    checks: knownFrom(CHECKS, rollupStateOf(pullRequest), "estado de checks"),
    review: knownFrom(REVIEWS, pullRequest.reviewDecision, "decisão de review"),
  };
}

function ownerAndName(repository: string): [string, string] {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra !== undefined) throw new Error(`repositório inválido: ${repository}`);
  return [owner, name];
}

export function createGithubPrPort(options: GithubPrOptions): PrPort {
  const run = options.run ?? runGh;

  // The account token is read per call and injected only into that gh process.
  async function gh(repository: string, args: readonly string[]): Promise<GhResult> {
    const account = options.accountOf(repository);
    const token = await run(["auth", "token", "--user", account], {});
    if (token.exitCode !== 0 || token.stdout.trim() === "") {
      throw new Error(`token da conta ${account} indisponível no gh`);
    }
    return run(args, { GH_TOKEN: token.stdout.trim() });
  }

  return {
    async readPr(ref: PrRef): Promise<PrLookup> {
      const [owner, name] = ownerAndName(ref.repository);
      const result = await gh(ref.repository, [
        "api", "graphql", "-f", `query=${PULL_REQUEST_QUERY}`,
        "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${ref.number}`,
      ]);
      let body: unknown;
      try {
        body = JSON.parse(result.stdout);
      } catch {
        body = undefined;
      }
      if (isNotFound(body, result.exitCode)) return { status: "not-found" };
      if (result.exitCode !== 0) throw new Error("consulta de PR no github.com falhou");
      return { status: "found", pr: parseSnapshot(ref, body) };
    },

    async readFeedback(ref: PrRef): Promise<PrFeedback> {
      const [owner, name] = ownerAndName(ref.repository);
      const result = await gh(ref.repository, [
        "api", "graphql", "-f", `query=${FEEDBACK_QUERY}`,
        "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${ref.number}`,
      ]);
      if (result.exitCode !== 0) throw new Error("consulta de feedback do PR no github.com falhou");
      let body: unknown;
      try {
        body = JSON.parse(result.stdout);
      } catch {
        throw unexpectedFeedback();
      }
      return parseFeedback(body);
    },
  };
}
