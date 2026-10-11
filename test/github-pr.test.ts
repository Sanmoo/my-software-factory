import assert from "node:assert/strict";
import test from "node:test";
import { createGithubPrPort, type GhCall, type GhResult } from "../src/pr/github.js";

// The process boundary is the only thing replaced: `gh` itself is not run.
const TOKEN = "gho_test_token_not_real";
const ref = { repository: "acme/app", number: 9 };

interface Recorded { args: readonly string[]; env: Record<string, string> }

function ghWith(
  pullRequest: unknown,
  options: { exitCode?: number; stderr?: string } = {},
): { run: GhCall; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const run: GhCall = async (args, env): Promise<GhResult> => {
    calls.push({ args, env });
    if (args[0] === "auth") return { exitCode: 0, stdout: `${TOKEN}\n`, stderr: "" };
    const body = JSON.stringify({ data: { repository: { pullRequest } } });
    return { exitCode: options.exitCode ?? 0, stdout: body, stderr: options.stderr ?? "" };
  };
  return { run, calls };
}

const pullRequest = (overrides: Record<string, unknown> = {}, rollup: unknown = { state: "PENDING" }) => ({
  state: "OPEN",
  baseRefName: "main",
  headRefName: "msf/8",
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  ...overrides,
});

test("an open PR is read with the project account's token injected per call, never on the command line", async () => {
  const { run, calls } = ghWith(pullRequest());
  const port = createGithubPrPort({ accountOf: () => "acme-bot", run });

  const lookup = await port.readPr(ref);

  assert.deepEqual(lookup, {
    status: "found",
    pr: {
      ref,
      state: "open",
      baseBranch: "main",
      headBranch: "msf/8",
      checks: { known: true, value: "pending" },
      review: { known: true, value: "none" },
    },
  });
  const [tokenCall, apiCall] = calls;
  assert.deepEqual(tokenCall?.args, ["auth", "token", "--user", "acme-bot"], "token of the project account");
  assert.deepEqual(tokenCall?.env, {}, "reading the token does not inject one");
  assert.equal(apiCall?.env.GH_TOKEN, TOKEN, "the token reaches the gh process through its environment");
  assert.ok(apiCall?.args.includes("owner=acme") && apiCall.args.includes("name=app") && apiCall.args.includes("number=9"));
  for (const call of calls) {
    assert.ok(!call.args.some((arg) => arg.includes(TOKEN)), "the token never appears in argv");
  }
});

test("merged and closed PRs keep their state and the base and head branches", async () => {
  const merged = ghWith(pullRequest({ state: "MERGED" }, { state: "SUCCESS" }));
  const closed = ghWith(pullRequest({ state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" }, { state: "FAILURE" }));

  const mergedLookup = await createGithubPrPort({ accountOf: () => "acme-bot", run: merged.run }).readPr(ref);
  const closedLookup = await createGithubPrPort({ accountOf: () => "acme-bot", run: closed.run }).readPr(ref);

  assert.equal(mergedLookup.status === "found" && mergedLookup.pr.state, "merged");
  assert.equal(mergedLookup.status === "found" && mergedLookup.pr.checks.known && mergedLookup.pr.checks.value, "passing");
  assert.equal(closedLookup.status === "found" && closedLookup.pr.state, "closed");
  assert.equal(closedLookup.status === "found" && closedLookup.pr.review.known && closedLookup.pr.review.value, "changes-requested");
  assert.equal(closedLookup.status === "found" && closedLookup.pr.checks.known && closedLookup.pr.checks.value, "failing");
});

test("a PR that GitHub does not know is a definitive not-found, not an error", async () => {
  const missingPr = ghWith(null);
  const missingRepo = createGithubPrPort({
    accountOf: () => "acme-bot",
    run: async (args: readonly string[]): Promise<GhResult> => (args[0] === "auth"
      ? { exitCode: 0, stdout: `${TOKEN}\n`, stderr: "" }
      : {
        exitCode: 1,
        stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
        stderr: "",
      }),
  });

  assert.deepEqual(await createGithubPrPort({ accountOf: () => "acme-bot", run: missingPr.run }).readPr(ref), { status: "not-found" });
  assert.deepEqual(await missingRepo.readPr(ref), { status: "not-found" });
});

test("a failed query is an error, never read as the PR being absent; the token is not in the message", async () => {
  const { run } = ghWith(null, { exitCode: 1, stderr: "HTTP 502" });
  const port = createGithubPrPort({ accountOf: () => "acme-bot", run });

  await assert.rejects(port.readPr(ref), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /consulta de PR/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test("the PR port exposes reads only: there is no merge operation to call", async () => {
  const { run, calls } = ghWith(pullRequest({ state: "MERGED" }, { state: "SUCCESS" }));
  const port = createGithubPrPort({ accountOf: () => "acme-bot", run });

  assert.deepEqual(Object.keys(port), ["readPr"]);
  await port.readPr(ref);
  assert.ok(calls.every((call) => !call.args.some((arg) => /merge/i.test(arg))), "no gh call built by the adapter merges");
});
