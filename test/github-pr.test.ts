import assert from "node:assert/strict";
import test from "node:test";
import { createGithubPrPort, type GhCall, type GhResult } from "../src/pr/github.js";
import { jobBranch } from "../src/core/job.js";

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

const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";

const pullRequest = (overrides: Record<string, unknown> = {}, rollup: unknown = { state: "PENDING" }) => ({
  state: "OPEN",
  baseRefName: "main",
  headRefName: jobBranch({ tracker: "github", project: "acme/app", id: "8" }),
  headRefOid: HEAD_SHA,
  baseRefOid: BASE_SHA,
  mergeable: "MERGEABLE",
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
      headBranch: jobBranch({ tracker: "github", project: "acme/app", id: "8" }),
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeable: { known: true, value: "mergeable" },
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

// ---- issue #19: mergeability of the PR, read from github.com ----------------------------

const mergeableOf = async (mergeable: unknown) => {
  const { run } = ghWith(pullRequest({ mergeable }));
  const lookup = await createGithubPrPort({ accountOf: () => "acme-bot", run }).readPr(ref);
  assert.equal(lookup.status, "found");
  return lookup.status === "found" ? lookup.pr.mergeable : undefined;
};

test("a PR that conflicts with its base is conflicting; one that is only behind or clean is mergeable", async () => {
  assert.deepEqual(await mergeableOf("CONFLICTING"), { known: true, value: "conflicting" });
  assert.deepEqual(await mergeableOf("MERGEABLE"), { known: true, value: "mergeable" });
});

test("mergeability GitHub has not computed yet is unknown, never read as the absence of a conflict", async () => {
  const unknown = await mergeableOf("UNKNOWN");
  assert.equal(unknown?.known, false);
  assert.match(unknown?.known === false ? unknown.reason : "", /mergeabilidade/);
  const unrecognized = await mergeableOf("A_NOVA_MERGEABILIDADE");
  assert.equal(unrecognized?.known, false, "an unrecognized value is unknown too");
});

test("a PR without the commits it was read at is an unexpected answer, not a PR to judge", async () => {
  const { run } = ghWith(pullRequest({ headRefOid: undefined }));
  await assert.rejects(createGithubPrPort({ accountOf: () => "acme-bot", run }).readPr(ref), /consulta de PR/);
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
  // Reading mergeability is allowed; any merge mutation or `pr merge` command is not.
  assert.ok(calls.every((call) => !call.args.some((arg) => /mergePullRequest|enablePullRequestAutoMerge|pr merge/i.test(arg))), "no gh call built by the adapter merges");
});

// ---- feedback read from the PR (reviews, conversation comments, checks) ---------------

// `more` marks a connection GitHub did not read to its end (pageInfo), by name.
const pullRequestFeedback = (parts: {
  comments?: unknown[]; reviews?: unknown[]; threads?: unknown[]; contexts?: unknown[] | null; more?: string[];
}) => ({
  comments: { pageInfo: { hasPreviousPage: parts.more?.includes("comments") ?? false }, nodes: parts.comments ?? [] },
  reviews: { pageInfo: { hasPreviousPage: parts.more?.includes("reviews") ?? false }, nodes: parts.reviews ?? [] },
  reviewThreads: { pageInfo: { hasNextPage: parts.more?.includes("threads") ?? false }, nodes: parts.threads ?? [] },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: parts.contexts === null ? null : { contexts: { nodes: parts.contexts ?? [] } },
      },
    }],
  },
});

const actor = (login: string, typename = "User") => ({ login, __typename: typename });

const thread = (id: string, path: string, comments: unknown[], options: { resolved?: boolean; more?: boolean } = {}) => ({
  id,
  path,
  isResolved: options.resolved ?? false,
  comments: { pageInfo: { hasNextPage: options.more ?? false }, nodes: comments },
});
const inlineNode = (id: string, login: string, body: string, state = "SUBMITTED") =>
  ({ id, author: actor(login), body, state, createdAt: "2026-05-01T12:00:00Z" });

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

// ---- issue #18: inline comments of review threads, one item per comment --------------------

const readFeedbackOf = async (parts: Parameters<typeof pullRequestFeedback>[0]) => {
  const { run } = ghWith(pullRequestFeedback({ contexts: [], ...parts }));
  return createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);
};

test("inline comments of review threads are read with their text, file and thread, resolved or not", async () => {
  const feedback = await readFeedbackOf({
    threads: [
      thread("PRRT_1", "README.md", [inlineNode("PRRC_1", "ana", "troque este título"), inlineNode("PRRC_2", "acme-bot", "feito")]),
      thread("PRRT_2", "src/a.ts", [inlineNode("PRRC_3", "bruno", "e este nome?")], { resolved: true }),
    ],
  });

  assert.deepEqual(feedback.comments, [
    { id: "PRRC_1", kind: "inline", author: "ana", isBot: false, body: "troque este título", createdAt: "2026-05-01T12:00:00Z", thread: { id: "PRRT_1", path: "README.md", resolved: false } },
    { id: "PRRC_2", kind: "inline", author: "acme-bot", isBot: false, body: "feito", createdAt: "2026-05-01T12:00:00Z", thread: { id: "PRRT_1", path: "README.md", resolved: false } },
    { id: "PRRC_3", kind: "inline", author: "bruno", isBot: false, body: "e este nome?", createdAt: "2026-05-01T12:00:00Z", thread: { id: "PRRT_2", path: "src/a.ts", resolved: true } },
  ]);
  assert.equal(feedback.incomplete, undefined);
});

test("a review with a body and inline comments yields the body and each comment as their own item", async () => {
  const feedback = await readFeedbackOf({
    reviews: [{ id: "PRR_1", author: actor("ana"), body: "no geral ok", state: "COMMENTED", submittedAt: "2026-05-01T11:00:00Z" }],
    threads: [thread("PRRT_1", "a.ts", [inlineNode("PRRC_1", "ana", "um"), inlineNode("PRRC_2", "ana", "dois")])],
  });

  assert.deepEqual(feedback.comments.map((comment) => [comment.id, comment.kind]), [
    ["PRR_1", "review"], ["PRRC_1", "inline"], ["PRRC_2", "inline"],
  ]);
});

test("an empty-bodied review is read as it is, with its empty body", async () => {
  const feedback = await readFeedbackOf({
    reviews: [{ id: "PRR_9", author: actor("acme-bot"), body: "", state: "COMMENTED", submittedAt: "2026-05-01T11:00:00Z" }],
  });

  assert.deepEqual(feedback.comments.map((comment) => [comment.id, comment.kind, comment.body]), [["PRR_9", "review", ""]]);
});

test("inline comments of a draft review are not published, so they are not read", async () => {
  const feedback = await readFeedbackOf({
    threads: [thread("PRRT_1", "a.ts", [inlineNode("PRRC_1", "ana", "rascunho", "PENDING"), inlineNode("PRRC_2", "ana", "publicado")])],
  });

  assert.deepEqual(feedback.comments.map((comment) => comment.id), ["PRRC_2"]);
});

test("a read that a pagination limit cut short says so, whichever connection was cut", async () => {
  for (const more of ["comments", "reviews", "threads"]) {
    const feedback = await readFeedbackOf({ more: [more] });
    assert.match(feedback.incomplete ?? "", /incompleta/, `${more} cut short`);
  }
  const cutThread = await readFeedbackOf({ threads: [thread("PRRT_1", "a.ts", [inlineNode("PRRC_1", "ana", "x")], { more: true })] });
  assert.match(cutThread.incomplete ?? "", /incompleta/, "comments of a thread cut short");
  assert.deepEqual(cutThread.comments.map((comment) => comment.id), ["PRRC_1"], "what was read is still reported");
});

test("an answer without the paging information is unexpected, never read as complete", async () => {
  const { run } = ghWith({ ...pullRequestFeedback({ contexts: [] }), reviewThreads: { nodes: [] } });
  await assert.rejects(createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref), /feedback do PR/);
});

test("the feedback query asks for the threads and the paging information it relies on", async () => {
  const { run, calls } = ghWith(pullRequestFeedback({ contexts: [] }));
  await createGithubPrPort({ accountOf: () => "acme-bot", run }).readFeedback(ref);

  const query = calls.flatMap((call) => call.args).find((arg) => arg.startsWith("query=")) ?? "";
  for (const needle of ["reviewThreads", "isResolved", "path", "hasNextPage", "hasPreviousPage"]) {
    assert.ok(query.includes(needle), `the query selects ${needle}`);
  }
});
