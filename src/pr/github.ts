import { execFile } from "node:child_process";
import type { PrRef } from "../core/result.js";
import type { Known } from "../tracker/port.js";
import type { CheckState, PrLookup, PrPort, PrSnapshot, ReviewState } from "./port.js";

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

// Read-only: the only query is the pull request lookup. No merge operation exists here.
const PULL_REQUEST_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { "
  + "pullRequest(number: $number) { state baseRefName headRefName reviewDecision "
  + "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }";

const runGh: GhCall = (args, env) => new Promise((resolve, reject) => {
  execFile("gh", [...args], { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") {
      reject(error);
      return;
    }
    resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
  });
});

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CHECKS: Record<string, CheckState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const REVIEWS: Record<string, ReviewState> = { APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", REVIEW_REQUIRED: "pending" };

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

function parseSnapshot(ref: PrRef, body: unknown): PrSnapshot {
  const repository = isObject(body) && isObject(body.data) ? body.data.repository : undefined;
  const pullRequest = isObject(repository) ? repository.pullRequest : undefined;
  if (!isObject(pullRequest)) throw new Error("consulta de PR: resposta inesperada do github.com");
  const state = pullRequest.state === "MERGED" ? "merged" : pullRequest.state === "CLOSED" ? "closed" : pullRequest.state === "OPEN" ? "open" : undefined;
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
      const [owner, name, extra] = ref.repository.split("/");
      if (!owner || !name || extra !== undefined) throw new Error(`repositório inválido: ${ref.repository}`);
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
  };
}
