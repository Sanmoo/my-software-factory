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

  assert.deepEqual(Object.keys(port), ["readPr", "readFeedback"]);
  await port.readPr(ref);
  assert.ok(calls.every((call) => !call.args.some((arg) => /merge/i.test(arg))), "no gh call built by the adapter merges");
});

// ---- CA12: feedback read from the PR (reviews, conversation comments, checks) ---------------

const pullRequestFeedback = (parts: { comments?: unknown[]; reviews?: unknown[]; contexts?: unknown[] | null }) => ({
  comments: { nodes: parts.comments ?? [] },
  reviews: { nodes: parts.reviews ?? [] },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: parts.contexts === null ? null : { contexts: { nodes: parts.contexts ?? [] } },
      },
    }],
  },
});

const actor = (login: string, typename = "User") => ({ login, __typename: typename });

test("PR feedback keeps human reviews and comments, marks bots, and leaves out pending reviews", async () => {
  const { run } = ghWith(pullRequestFeedback({
    comments: [
      { id: "IC_1", author: actor("ana"), body: "troque o nome", createdAt: "2026-05-01T10:00:00Z" },
      { id: "IC_2", author: actor("ci[bot]", "Bot"), body: "relatório automático", createdAt: "2026-05-01T10:01:00Z" },
    ],
    reviews: [
      { id: "PRR_1", author: actor("bruno"), body: "ajuste o teste", state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T11:00:00Z" },
      { id: "PRR_2", author: actor("bruno"), body: "rascunho", state: "PENDING", submittedAt: null },
    ],
    contexts: [],
  }));
  const feedback = await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);

  assert.deepEqual(feedback.comments, [
    { id: "IC_1", kind: "comment", author: "ana", isBot: false, body: "troque o nome", createdAt: "2026-05-01T10:00:00Z" },
    { id: "IC_2", kind: "comment", author: "ci[bot]", isBot: true, body: "relatório automático", createdAt: "2026-05-01T10:01:00Z" },
    { id: "PRR_1", kind: "review", author: "bruno", isBot: false, body: "ajuste o teste", createdAt: "2026-05-01T11:00:00Z" },
  ]);
});

test("PR checks carry their state and the branch protection's required flag", async () => {
  const { run } = ghWith(pullRequestFeedback({
    contexts: [
      { __typename: "CheckRun", id: "CR_1", name: "test", status: "COMPLETED", conclusion: "FAILURE", isRequired: true },
      { __typename: "CheckRun", id: "CR_2", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", isRequired: false },
      { __typename: "CheckRun", id: "CR_3", name: "e2e", status: "IN_PROGRESS", conclusion: null, isRequired: true },
      { __typename: "CheckRun", id: "CR_4", name: "audit", status: "COMPLETED", conclusion: "CANCELLED", isRequired: false },
      { __typename: "StatusContext", id: "SC_1", context: "deploy-preview", state: "ERROR", isRequired: false },
    ],
  }));
  const feedback = await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);

  assert.deepEqual(feedback.checks, [
    { id: "CR_1", name: "test", state: { known: true, value: "failing" }, required: { known: true, value: true } },
    { id: "CR_2", name: "lint", state: { known: true, value: "passing" }, required: { known: true, value: false } },
    { id: "CR_3", name: "e2e", state: { known: true, value: "pending" }, required: { known: true, value: true } },
    { id: "CR_4", name: "audit", state: { known: true, value: "none" }, required: { known: true, value: false } },
    { id: "SC_1", name: "deploy-preview", state: { known: true, value: "failing" }, required: { known: true, value: false } },
  ]);
});

test("a check whose required flag or conclusion GitHub does not report is unknown, never absent", async () => {
  const { run } = ghWith(pullRequestFeedback({
    contexts: [
      { __typename: "CheckRun", id: "CR_9", name: "deploy", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", id: "CR_8", name: "novo", status: "COMPLETED", conclusion: "A_NOVA_CONCLUSAO", isRequired: false },
    ],
  }));
  const [deploy, novo] = (await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref)).checks;

  assert.equal(deploy?.required.known, false, "a missing required flag is unknown");
  assert.equal(deploy?.state.known && deploy.state.value, "failing");
  assert.equal(novo?.state.known, false, "an unrecognized conclusion is unknown");
});

test("a PR without any checks has an empty check list", async () => {
  const { run } = ghWith(pullRequestFeedback({ contexts: null }));
  const feedback = await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);

  assert.deepEqual(feedback, { comments: [], checks: [] });
});

test("a failed or unexpected feedback read is an error, never an empty feedback", async () => {
  const failed = ghWith(pullRequestFeedback({ contexts: [] }), { exitCode: 1, stderr: "HTTP 502" });
  await assert.rejects(createGithubPrPort({ accountOf: () => "acme-bot", run: failed.run }).readFeedback(ref), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /feedback do PR/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });

  const malformed = ghWith({ comments: null });
  await assert.rejects(createGithubPrPort({ accountOf: () => "acme-bot", run: malformed.run }).readFeedback(ref), /feedback do PR/);
});

test("the feedback query sent to gh is well formed: every selection set opens and closes", async () => {
  const { run, calls } = ghWith(pullRequestFeedback({ contexts: [] }));
  await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);

  const query = calls.flatMap((call) => call.args).find((arg) => arg.startsWith("query="));
  assert.ok(query, "the adapter sends a GraphQL query");
  assert.equal([...query].filter((char) => char === "{").length, [...query].filter((char) => char === "}").length);
});
