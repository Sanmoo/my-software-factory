import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  createGitHubAdapter,
  MissingCredentialError,
  GitHubTrackerAdapter,
  readGhToken,
  type CommandRunner,
} from "./github-adapter.js";
import { AGENT_MARKER, PartialWriteError, type TrackerPort } from "./port.js";

/**
 * Offline unit tests of the real GitHub adapter: the `gh`/`git` command
 * lines, the JSON mapping and the partial-write semantics — with the command
 * runner injected, no network and no credential. The behavioral contract is
 * proven against the real thing in the smoke (`npm run smoke:github`).
 */

interface Call {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string | undefined;
  input?: string | undefined;
}

function fakeRunner(routes: (call: Call) => { stdout?: string; stderr?: string; fail?: string }) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    const call: Call = { file, args, env: options.env, cwd: options.cwd, input: options.input };
    calls.push(call);
    const out = routes(call);
    if (out.fail) throw new Error(`${out.fail}\nstderr:${out.stderr ?? ""}`);
    return { stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { runner, calls };
}

const TOKEN = "ghp_unit_test_token";

/** The first non-auth gh call recorded (the boot token read is always first). */
function ghCall(calls: Call[], matcher: (c: Call) => boolean): Call {
  const found = calls.find((c) => c.file === "gh" && c.args[0] !== "auth" && matcher(c));
  assert.ok(found, "expected a matching gh call");
  return found;
}

async function makeAdapter(routes: (call: Call) => { stdout?: string; stderr?: string; fail?: string }) {
  const { runner, calls } = fakeRunner((call) => {
    // token reads always succeed with the unit token
    if (call.file === "gh" && call.args[0] === "auth" && call.args[1] === "token") {
      return { stdout: `${TOKEN}\n` };
    }
    return routes(call);
  });
  const adapter = await createGitHubAdapter({ account: "bot-do-samuca", runner, clonesDir: "/tmp/msf-test-clones" });
  return { adapter, calls };
}

describe("boot: credential from the gh keyring", () => {
  test("reads the token with --user <account> and strips ambient GH_TOKEN from the read", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "ghp_x\n" }));
    await createGitHubAdapter({ account: "bot-do-samuca", runner });
    const read = calls.find((c) => c.file === "gh" && c.args[0] === "auth");
    assert.ok(read, "the token read happens at boot");
    assert.deepEqual(read.args.slice(0, 3), ["auth", "token", "--user"]);
    assert.ok(read.args.includes("bot-do-samuca"));
    assert.equal(read.env.GH_TOKEN, undefined, "ambient GH_TOKEN never shadows the keyring");
  });

  test("a missing token fails the boot with a clear message", async () => {
    const { runner } = fakeRunner(() => ({ fail: "no oauth token found for github.com account x" }));
    await assert.rejects(
      createGitHubAdapter({ account: "bot-do-samuca", runner }),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.match(error.message, /bot-do-samuca/);
        assert.match(error.message, /keyring|gh auth/);
        return true;
      },
    );
  });

  test("every gh call carries the bot token in its env, not in the argv", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "[]" }));
    await adapter.listCandidates("Sanmoo/a", "ready-for-agent");
    const gh = calls.find((c) => c.file === "gh" && c.args[0] !== "auth");
    assert.ok(gh);
    assert.equal(gh.env.GH_TOKEN, TOKEN);
    assert.ok(!gh.args.some((a) => a.includes(TOKEN)), "the token never appears in argv");
  });
});

describe("the 9 operations over gh", () => {
  test("1. listCandidates: gh issue list --state open --label, mapped from JSON", async () => {
    const { adapter, calls } = await makeAdapter((call) => ({
      stdout:
        call.file === "gh"
          ? `[{"number":7,"title":"do it","createdAt":"2026-01-02T00:00:00Z"}]`
          : "",
    }));
    const candidates = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");
    assert.deepEqual(candidates, [
      { ref: { repo: "Sanmoo/a", number: 7 }, title: "do it", createdAt: "2026-01-02T00:00:00Z" },
    ]);
    const gh = ghCall(calls, (c) => c.args.includes("issue"));
    assert.ok(gh.args.includes("list"));
    assert.ok(gh.args.includes("--state") && gh.args.includes("open"));
    assert.ok(gh.args.includes("--label") && gh.args.includes("ready-for-agent"));
    assert.ok(gh.args.includes("-R") && gh.args.includes("Sanmoo/a"));
  });

  test("2. readIssue: maps state, stateReason, labels, assignees, createdAt", async () => {
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({
        number: 5,
        title: "do the thing",
        body: "body",
        state: "OPEN",
        stateReason: "REOPENED",
        labels: [{ name: "ready-for-agent" }],
        assignees: [{ login: "bot-do-samuca" }],
        createdAt: "2026-01-01T10:00:00Z",
      }),
    }));
    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 5 });
    assert.ok(issue.known);
    assert.equal(issue.value.state, "open");
    assert.equal(issue.value.stateReason, null, "reopened is not a terminal reason");
    assert.deepEqual(issue.value.labels, ["ready-for-agent"]);
    assert.deepEqual(issue.value.assignees, ["bot-do-samuca"]);
    assert.equal(issue.value.createdAt, "2026-01-01T10:00:00Z");
  });

  test("2. readIssue: completed maps to completed, not-planned to not-planned", async () => {
    let reason = "COMPLETED";
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({ number: 1, title: "t", body: "", state: "CLOSED", stateReason: reason, labels: [], assignees: [], createdAt: "2026-01-01T00:00:00Z" }),
    }));
    const done = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(done.known);
    assert.equal(done.value.stateReason, "completed");
    reason = "NOT_PLANNED";
    const rejected = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(rejected.known);
    assert.equal(rejected.value.stateReason, "not-planned");
  });

  test("2. readIssue: missing issue is unknown, never absent-as-empty", async () => {
    const { adapter } = await makeAdapter(() => ({
      fail: "gh: Could not resolve to an issue or pull request with the number of 999.",
    }));
    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 999 });
    assert.ok(!issue.known);
  });

  test("3. readBlockers: blockedBy nodes mapped with terminal state", async () => {
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({
        blockedBy: {
          nodes: [
            { number: 2, state: "CLOSED", title: "b" },
            { number: 3, state: "OPEN", title: "c" },
          ],
        },
      }),
    }));
    const blockers = await adapter.readBlockers({ repo: "Sanmoo/a", number: 1 });
    assert.ok(blockers.known);
    assert.deepEqual(blockers.value, [
      { ref: { repo: "Sanmoo/a", number: 2 }, state: "closed" },
      { ref: { repo: "Sanmoo/a", number: 3 }, state: "open" },
    ]);
  });

  test("4. claim: ensures the label, adds label and assignee as two intents", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    const outcome = await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    assert.ok(outcome.performed.length >= 2);
    const edits = calls.filter((c) => c.file === "gh" && c.args.includes("edit"));
    assert.ok(edits.some((c) => c.args.includes("--add-label") && c.args.includes("agent-claimed")));
    assert.ok(edits.some((c) => c.args.includes("--add-assignee") && c.args.includes("bot-do-samuca")));
  });

  test("4. claim: label landing but assignee failing is a PartialWriteError", async () => {
    let editCalls = 0;
    const { adapter } = await makeAdapter((call) => {
      if (call.args.includes("edit")) {
        editCalls += 1;
        if (editCalls === 2) return { fail: "assignment failed" };
      }
      return { stdout: "" };
    });
    await assert.rejects(
      adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca"),
      (error: unknown) => {
        assert.ok(error instanceof PartialWriteError);
        assert.ok(error.performed.some((p) => p.includes("agent-claimed")));
        return true;
      },
    );
  });

  test("5. releaseClaim: removes label and assignee; 'not found' is tolerated", async () => {
    let editCalls = 0;
    const { adapter, calls } = await makeAdapter((call) => {
      if (call.args.includes("edit")) {
        editCalls += 1;
        if (editCalls === 1) return { fail: "failed to update: 'agent-claimed' not found" };
      }
      return { stdout: "" };
    });
    const outcome = await adapter.releaseClaim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    assert.ok(Array.isArray(outcome.performed));
    const edits = calls.filter((c) => c.args.includes("edit"));
    assert.ok(edits.some((c) => c.args.includes("--remove-label")));
    assert.ok(edits.some((c) => c.args.includes("--remove-assignee")));
  });

  test("6. markDone: closes as completed", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    await adapter.markDone({ repo: "Sanmoo/a", number: 1 });
    const gh = ghCall(calls, () => true);
    assert.ok(gh.args.includes("close"));
    assert.ok(gh.args.includes("--reason") && gh.args.includes("completed"));
  });

  test("7. comment: posts the body with the marker over stdin", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "url" }));
    await adapter.comment({ repo: "Sanmoo/a", number: 1 }, "fell over");
    const gh = ghCall(calls, () => true);
    assert.ok(gh.args.includes("comment"));
    assert.ok(gh.args.includes("--body-file") && gh.args.includes("-"));
    assert.ok(gh.input?.startsWith(AGENT_MARKER));
    assert.ok(gh.input?.includes("fell over"));
  });

  test("8. readComments: maps id, author, body, createdAt", async () => {
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({
        comments: [{ id: "IC_1", author: { login: "samuca" }, body: "hi", createdAt: "2026-01-01T00:00:00Z" }],
      }),
    }));
    const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
    assert.ok(comments.known);
    assert.deepEqual(comments.value, [{ id: "IC_1", author: "samuca", body: "hi", createdAt: "2026-01-01T00:00:00Z" }]);
  });

  test("9a. readPrFeedback: linked PR via the issue timeline, PR fields mapped", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      if (call.args.some((a) => a.includes("timeline"))) {
        // the jq of the real gh collapses the timeline to linked PR numbers
        return { stdout: "3\n" };
      }
      if (call.args[0] === "issue" && call.args[1] === "view") {
        return { stdout: JSON.stringify({ comments: [] }) };
      }
      if (call.args.includes("pr") && call.args.includes("view")) {
        return {
          stdout: JSON.stringify({
            number: 3,
            state: "OPEN",
            mergedAt: null,
            headRefName: "agent-issue-1",
            baseRefName: "main",
            author: { login: "bot-do-samuca" },
            comments: [{ id: "IC_2", author: { login: "samuca" }, body: "fix this", createdAt: "2026-01-01T00:00:00Z" }],
            reviews: [{ id: "PRR_1", author: { login: "samuca" }, body: "review body", submittedAt: "2026-01-02T00:00:00Z" }],
          }),
        };
      }
      return { stdout: "" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 1 });
    assert.ok(feedback.known);
    assert.deepEqual(feedback.value.pr, {
      number: 3,
      state: "open",
      merged: false,
      headBranch: "agent-issue-1",
      baseBranch: "main",
      author: "bot-do-samuca",
    });
    assert.equal(feedback.value.comments[0]?.author, "samuca");
    assert.equal(feedback.value.reviews[0]?.body, "review body");
    assert.equal(feedback.value.reviews[0]?.createdAt, "2026-01-02T00:00:00Z");
    const timeline = ghCall(calls, (c) => c.args.some((a) => a.includes("timeline")));
    assert.ok(timeline.args.some((a) => a.includes("/issues/1/timeline")));
  });

  test("9a. readPrFeedback: no linked PR is known-null, comments still read", async () => {
    const { adapter } = await makeAdapter((call) => {
      if (call.args.some((a) => a.includes("timeline"))) return { stdout: "\n" };
      if (call.args.includes("view")) {
        return { stdout: JSON.stringify({ comments: [{ id: "IC_1", author: { login: "samuca" }, body: "hi", createdAt: "2026-01-01T00:00:00Z" }] }) };
      }
      return { stdout: "" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 1 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr, null);
    assert.equal(feedback.value.comments[0]?.body, "hi");
  });

  test("9b. openPr: creates with head/base, 'Closes #N' linkage and the agent marker", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "https://github.com/Sanmoo/a/pull/12\n" }));
    const pr = await adapter.openPr({
      repo: "Sanmoo/a",
      issueNumber: 5,
      headBranch: "agent-issue-5",
      baseBranch: "main",
      title: "work #5",
    });
    assert.equal(pr.number, 12);
    assert.equal(pr.state, "open");
    assert.equal(pr.headBranch, "agent-issue-5");
    const gh = ghCall(calls, () => true);
    assert.ok(gh.args.includes("pr") && gh.args.includes("create"));
    assert.ok(gh.args.includes("--head") && gh.args.includes("agent-issue-5"));
    assert.ok(gh.args.includes("--base") && gh.args.includes("main"));
    assert.ok(gh.input?.includes("Closes #5"));
    assert.ok(gh.input?.includes(AGENT_MARKER));
  });

  test("rank: GitHub has no native rank — known(null)", async () => {
    const { adapter } = await makeAdapter(() => ({ stdout: "" }));
    const rank = await adapter.rank({ repo: "Sanmoo/a", number: 1 });
    assert.ok(rank.known);
    assert.equal(rank.value, null);
  });
});

describe("9c. pushBranch: git with the credential helper baked into the clone", () => {
  test("fresh clone: clone with helper configs, bake helper into local config, branch from origin/HEAD and push", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    // no clone dir exists (never created in tests): the sequence is exercised for its command lines
    await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-3" }).catch(() => {});
    const clone = calls.find((c) => c.file === "git" && c.args[0] === "clone");
    assert.ok(clone, "a clone is made when none exists");
    assert.ok(clone.args.includes("https://github.com/Sanmoo/a.git"));
    const helperConfigs = clone.args.filter((a) => a.includes("credential.helper"));
    assert.ok(helperConfigs.length >= 2, "the credential helper is baked at clone time");
    const configCalls = calls.filter((c) => c.file === "git" && c.args[0] === "config" && c.args[1] === "--local");
    assert.ok(configCalls.some((c) => c.args.includes("!gh auth git-credential")), "helper baked into the clone");
    const push = calls.find((c) => c.file === "git" && c.args[0] === "push");
    assert.ok(push, "a push happens");
    assert.ok(
      push.args.includes("refs/heads/agent-issue-3:refs/heads/agent-issue-3"),
      "the local branch is pushed as-is",
    );
  });

  test("git env: GH_TOKEN is set and prompts are off", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-3" }).catch(() => {});
    const git = calls.find((c) => c.file === "git")!;
    assert.equal(git.env.GH_TOKEN, TOKEN);
    assert.equal(git.env.GIT_TERMINAL_PROMPT, "0");
  });
});

describe("runner default: real child process", () => {
  test("default runner executes and surfaces failure (real gh, keyring only)", async () => {
    await assert.rejects(readGhToken("definitely-not-an-account-xyz"));
  });
});

// the adapter type must remain a TrackerPort
const _typeCheck: TrackerPort = undefined as unknown as GitHubTrackerAdapter;
void _typeCheck;
