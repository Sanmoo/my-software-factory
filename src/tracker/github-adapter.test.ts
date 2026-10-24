import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  bakeCredentialHelper,
  createGitHubAdapter,
  defaultCommandRunner,
  MissingCredentialError,
  GitHubTrackerAdapter,
  readGhToken,
  type CommandRunner,
} from "./github-adapter.js";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
    if (out.fail) {
      // gh-shaped, like the real runner and the simulator: the adapter reads the
      // failure reason from `stderr`, and the tolerances (absent label, unknown
      // issue) are decided on it — a failure without stderr is a real one.
      const failure = new Error(`${out.fail}\nstderr:${out.stderr ?? ""}`);
      Object.assign(failure, { stderr: out.stderr ?? out.fail });
      throw failure;
    }
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
    await adapter.listOpenIssues("Sanmoo/a");
    const gh = calls.find((c) => c.file === "gh" && c.args[0] !== "auth");
    assert.ok(gh);
    assert.equal(gh.env.GH_TOKEN, TOKEN);
    assert.ok(!gh.args.some((a) => a.includes(TOKEN)), "the token never appears in argv");
  });
});

describe("the 9 operations over gh", () => {
  test("1. listOpenIssues: plain open-issues listing, ALL labels matched CLIENT-SIDE (no label filter), PRs excluded", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/pulls?")) return { stdout: "[]" };
      return {
        stdout:
          call.file === "gh"
            ? `[{"number":7,"title":"do it","created_at":"2026-01-02T00:00:00Z","labels":[{"name":"ready-for-agent"},{"name":"triaged"}],"assignees":[{"login":"bot-do-samuca"}]},{"number":8,"title":"a pr","created_at":"2026-01-03T00:00:00Z","pull_request":{},"labels":[{"name":"ready-for-agent"}],"assignees":[]},{"number":9,"title":"unlabeled","created_at":"2026-01-04T00:00:00Z","labels":[],"assignees":[]},{"number":10,"title":"other label","created_at":"2026-01-05T00:00:00Z","labels":[{"name":"other"}],"assignees":[]}]`
            : "",
      };
    });
    const issues = await adapter.listOpenIssues("Sanmoo/a");
    assert.deepEqual(issues, [
      {
        ref: { repo: "Sanmoo/a", number: 7 },
        title: "do it",
        createdAt: "2026-01-02T00:00:00Z",
        labels: ["ready-for-agent", "triaged"],
        assignees: ["bot-do-samuca"],
        hasOpenPr: false,
      },
      {
        ref: { repo: "Sanmoo/a", number: 9 },
        title: "unlabeled",
        createdAt: "2026-01-04T00:00:00Z",
        labels: [],
        assignees: [],
        hasOpenPr: false,
      },
      {
        ref: { repo: "Sanmoo/a", number: 10 },
        title: "other label",
        createdAt: "2026-01-05T00:00:00Z",
        labels: ["other"],
        assignees: [],
        hasOpenPr: false,
      },
    ]);
    const gh = ghCall(calls, (c) => c.args[0] === "api");
    const path = gh.args.find((a) => a.startsWith("repos/"));
    assert.ok(path?.includes("state=open"));
    // the dialect: NO labels query param — the label-filtered listing is
    // search-index-backed and lags minutes behind a fresh label, while the
    // neutral read hands every issue to the derivation
    assert.ok(!path?.includes("labels="), "the labels query param is never sent");
    assert.ok(!gh.args.includes("issue"), "gh issue list (GraphQL) is never touched");
  });

  test("1. listOpenIssues: an issue linked by an OPEN PR's body is flagged hasOpenPr (the derivation excludes it)", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.endsWith("/issues") || path?.includes("/issues?")) {
        return {
          stdout: JSON.stringify([
            { number: 7, title: "has a PR", created_at: "2026-01-02T00:00:00Z", labels: [{ name: "ready-for-agent" }], assignees: [] },
            { number: 8, title: "no PR", created_at: "2026-01-03T00:00:00Z", labels: [{ name: "ready-for-agent" }], assignees: [] },
          ]),
        };
      }
      if (path?.includes("/pulls?")) {
        return {
          stdout: JSON.stringify([
            { number: 20, body: "Closes #7\n\nwork of #7" },
            { number: 21, body: "a human PR without a linkage keyword — slips through (documented limitation)" },
            { number: 22, body: "Resolves #99 — outside the issue listing" },
            { number: 23, body: null },
          ]),
        };
      }
      return { stdout: "[]" };
    });
    const issues = await adapter.listOpenIssues("Sanmoo/a");
    const byNumber = new Map(issues.map((issue) => [issue.ref.number, issue]));
    assert.equal(byNumber.get(7)?.hasOpenPr, true, "#7 (Closes #7) is flagged");
    assert.equal(byNumber.get(8)?.hasOpenPr, false, "#8 has no open PR");
    const pulls = calls.filter(
      (c) => c.file === "gh" && (c.args.find((a) => a.startsWith("repos/")) ?? "").includes("/pulls?"),
    );
    assert.equal(pulls.length, 1, "the open-PRs listing is read ONCE, not per issue");
    const pullsPath = pulls[0]?.args.find((a) => a.startsWith("repos/"));
    assert.match(pullsPath ?? "", /state=open/);
  });

  test("1. listOpenIssues: the whole read is ONE issues listing + ONE open-PRs listing — no per-issue read", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/pulls?")) return { stdout: JSON.stringify([{ number: 20, body: "Closes #7" }]) };
      if (path?.includes("/issues?")) {
        return {
          stdout: JSON.stringify([
            { number: 7, title: "a", created_at: "2026-01-01T00:00:00Z", labels: [], assignees: [] },
            { number: 8, title: "b", created_at: "2026-01-02T00:00:00Z", labels: [], assignees: [] },
          ]),
        };
      }
      return { stdout: "[]" };
    });
    await adapter.listOpenIssues("Sanmoo/a");
    const listings = calls.filter((c) => c.file === "gh" && c.args[0] === "api");
    const pathOf = (c: { args: string[] }) => c.args.find((a) => a.startsWith("repos/")) ?? "";
    assert.equal(listings.filter((c) => pathOf(c).includes("/issues?")).length, 1, "one issues listing");
    assert.equal(listings.filter((c) => pathOf(c).includes("/pulls?")).length, 1, "one open-PRs listing");
    assert.ok(
      !listings.some((c) => /\/issues\/\d+$/.test(pathOf(c))),
      "no per-issue snapshot read — labels and linkage come from the listings",
    );
  });

  test("1. listOpenIssues: an EMPTY issues listing never reads the open-PRs listing (nothing to link)", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "[]" }));
    const issues = await adapter.listOpenIssues("Sanmoo/a");
    assert.deepEqual(issues, []);
    assert.ok(
      !calls.some(
        (c) => c.file === "gh" && (c.args.find((a) => a.startsWith("repos/")) ?? "").includes("/pulls"),
      ),
      "no PR listing call when the issues listing is empty",
    );
  });

  test("2. readIssue: maps state, stateReason, labels, assignees, createdAt", async () => {
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({
        number: 5,
        title: "do the thing",
        body: "body",
        state: "open",
        state_reason: "reopened",
        labels: [{ name: "ready-for-agent" }],
        assignees: [{ login: "bot-do-samuca" }],
        created_at: "2026-01-01T10:00:00Z",
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
    let reason: string | null = "completed";
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify({ number: 1, title: "t", body: "", state: "closed", state_reason: reason, labels: [], assignees: [], created_at: "2026-01-01T00:00:00Z" }),
    }));
    const done = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(done.known);
    assert.equal(done.value.stateReason, "completed");
    reason = "not planned";
    const rejected = await adapter.readIssue({ repo: "Sanmoo/a", number: 1 });
    assert.ok(rejected.known);
    assert.equal(rejected.value.stateReason, "not-planned");
  });

  test("2. readIssue: missing issue is unknown, never absent-as-empty", async () => {
    const { adapter } = await makeAdapter(() => ({
      fail: "gh: Not Found (HTTP 404)",
    }));
    const issue = await adapter.readIssue({ repo: "Sanmoo/a", number: 999 });
    assert.ok(!issue.known);
  });

  test("2. readIssue: a malformed answer is a real failure, never a silent empty read", async () => {
    const { adapter } = await makeAdapter(() => ({ stdout: "{ not json" }));
    await assert.rejects(
      adapter.readIssue({ repo: "Sanmoo/a", number: 1 }),
      /gh api .* returned invalid JSON/,
    );
  });

  test("3. readBlockers: blocked_by dependencies mapped with terminal state", async () => {
    const { adapter, calls } = await makeAdapter(() => ({
      stdout: JSON.stringify([
        { number: 2, state: "closed", title: "b" },
        { number: 3, state: "open", title: "c" },
      ]),
    }));
    const blockers = await adapter.readBlockers({ repo: "Sanmoo/a", number: 1 });
    assert.ok(blockers.known);
    assert.deepEqual(blockers.value, [
      { ref: { repo: "Sanmoo/a", number: 2 }, state: "closed" },
      { ref: { repo: "Sanmoo/a", number: 3 }, state: "open" },
    ]);
    const api = ghCall(calls, () => true);
    assert.ok(api.args.some((a) => a.includes("dependencies/blocked_by")), "the native dependencies endpoint");
  });

  test("4. claim: ensures the label, adds label and assignee as two intents", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    const outcome = await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    assert.ok(outcome.performed.length >= 2);
    const posts = calls.filter((c) => c.file === "gh" && c.args.includes("-X") && c.args.includes("POST"));
    assert.ok(posts.some((c) => c.args.some((a) => a.endsWith("/labels") && !a.includes("issues/"))), "the repo label is ensured first");
    assert.ok(posts.some((c) => c.args.some((a) => a.endsWith("/issues/1/labels"))), "the claim label lands on the issue");
    assert.ok(posts.some((c) => c.args.some((a) => a.endsWith("/issues/1/assignees"))), "the account is assigned");
  });

  test("4. claim: the claim mark lands before the pool label leaves", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca", "ready-for-agent");

    const writes = calls
      .filter((c) => c.file === "gh" && c.args[0] === "api" && c.args.includes("-X"))
      .map((c) => `${c.args[c.args.indexOf("-X") + 1]} ${c.args.find((a) => a.startsWith("repos/")) ?? ""}`);
    const claimLabel = writes.indexOf("POST repos/Sanmoo/a/issues/1/labels");
    const assignee = writes.indexOf("POST repos/Sanmoo/a/issues/1/assignees");
    const unlabel = writes.indexOf("DELETE repos/Sanmoo/a/issues/1/labels/ready-for-agent");

    assert.ok(claimLabel >= 0, `the claim label is written: ${writes.join(" | ")}`);
    assert.ok(assignee > claimLabel, `the assignee follows the claim mark: ${writes.join(" | ")}`);
    assert.ok(unlabel > assignee, `the pool label leaves LAST: ${writes.join(" | ")}`);
  });

  test("4. claim: label landing but assignee failing is a PartialWriteError", async () => {
    let postCalls = 0;
    const { adapter } = await makeAdapter((call) => {
      if (call.args.includes("-X") && call.args.includes("POST")) {
        postCalls += 1;
        if (postCalls === 3) return { fail: "assignment failed" }; // repo label, issue label, then the assignee
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

  test("4. claim: the label ensure is cached per repo+label — one call, not one per claim", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    const repoLabelPosts = calls.filter(
      (c) => c.file === "gh" && c.args.some((a) => a === "repos/Sanmoo/a/labels"),
    ).length;
    assert.equal(repoLabelPosts, 1);
    await adapter.claim({ repo: "Sanmoo/a", number: 2 }, "bot-do-samuca");
    const after = calls.filter(
      (c) => c.file === "gh" && c.args.some((a) => a === "repos/Sanmoo/a/labels"),
    ).length;
    assert.equal(after, 1, "no second POST for the same repo label");
  });

  test("5. releaseClaim: removes label and assignee; 'not found' is tolerated", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      // The absent claim mark, wherever it sits in the swap: tolerated.
      if (
        call.args.includes("-X") &&
        call.args.includes("DELETE") &&
        call.args.some((a) => a.includes("/labels/agent-claimed"))
      ) {
        return { fail: "gh: Not Found (HTTP 404)" };
      }
      return { stdout: "" };
    });
    const outcome = await adapter.releaseClaim({ repo: "Sanmoo/a", number: 1 }, "bot-do-samuca");
    assert.ok(Array.isArray(outcome.performed));
    const deleteCalls = calls.filter((c) => c.args.includes("-X") && c.args.includes("DELETE"));
    assert.ok(deleteCalls.some((c) => c.args.some((a) => a.includes("/labels/agent-claimed"))));
    assert.ok(deleteCalls.some((c) => c.args.some((a) => a.endsWith("/issues/1/assignees"))));
  });

  test("6. markDone: closes as completed", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "" }));
    await adapter.markDone({ repo: "Sanmoo/a", number: 1 });
    const api = ghCall(calls, () => true);
    assert.ok(api.args.includes("-X") && api.args.includes("PATCH"));
    assert.equal(api.input, JSON.stringify({ state: "closed", state_reason: "completed" }));
  });

  test("7. comment: posts the body with the marker over stdin", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: JSON.stringify({ id: 9 }) }));
    await adapter.comment({ repo: "Sanmoo/a", number: 1 }, "fell over");
    const api = ghCall(calls, () => true);
    assert.ok(api.args.some((a) => a.endsWith("/issues/1/comments")));
    assert.ok(api.args.includes("--input") && api.args.includes("-"));
    const posted = JSON.parse(api.input ?? "") as { body: string };
    assert.ok(posted.body.startsWith(AGENT_MARKER));
    assert.ok(posted.body.includes("fell over"));
  });

  test("8. readComments: maps id, author, body, createdAt", async () => {
    const { adapter } = await makeAdapter(() => ({
      stdout: JSON.stringify([
        { id: 1, user: { login: "samuca" }, body: "hi", created_at: "2026-01-01T00:00:00Z" },
      ]),
    }));
    const comments = await adapter.readComments({ repo: "Sanmoo/a", number: 1 });
    assert.ok(comments.known);
    assert.deepEqual(comments.value, [{ id: "1", author: "samuca", body: "hi", createdAt: "2026-01-01T00:00:00Z" }]);
  });

  test("9a. readPrFeedback: linked PR via the issue timeline, PR fields mapped", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/timeline")) {
        return {
          stdout: JSON.stringify([
            { event: "cross-referenced", source: { issue: { number: 3, pull_request: { merged_at: null } } } },
          ]),
        };
      }
      if (path?.includes("/pulls/3/reviews")) {
        return {
          stdout: JSON.stringify([
            { id: 7, user: { login: "samuca" }, body: "review body", submitted_at: "2026-01-02T00:00:00Z" },
          ]),
        };
      }
      if (path?.includes("/pulls/3/comments")) {
        return {
          stdout: JSON.stringify([
            {
              id: 9,
              user: { login: "samuca" },
              body: "inline: too many comments",
              created_at: "2026-01-03T00:00:00Z",
              path: "internal/issuefiles/write.go",
              line: 53,
            },
          ]),
        };
      }
      if (path?.endsWith("/pulls/3")) {
        return {
          stdout: JSON.stringify({
            number: 3,
            state: "open",
            merged_at: null,
            head: { ref: "agent-issue-1" },
            base: { ref: "main" },
            user: { login: "bot-do-samuca" },
          }),
        };
      }
      if (path?.includes("/issues/3/comments")) {
        return {
          stdout: JSON.stringify([
            { id: 2, user: { login: "samuca" }, body: "fix this", created_at: "2026-01-01T00:00:00Z" },
          ]),
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
    assert.equal(feedback.value.reviews[1]?.body, "inline: too many comments\n(internal/issuefiles/write.go:53)");
    assert.equal(feedback.value.reviews[1]?.createdAt, "2026-01-03T00:00:00Z");
    const timeline = ghCall(calls, (c) => c.args.some((a) => a.includes("/timeline")));
    assert.ok(timeline.args.some((a) => a.includes("/issues/1/timeline")));
  });

  test("9a. readPrFeedback: another Work's PR that mentions the issue never steals the linkage", async () => {
    // The timeline lists every cross-referenced PR, in order. The #141 work saw
    // its own PR (164) and later #181's PR (184), which mentioned the issue —
    // the newest cross-reference answered for the wrong Work.
    const { adapter } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/timeline")) {
        return {
          stdout: JSON.stringify([
            { event: "cross-referenced", source: { issue: { number: 164, pull_request: { merged_at: null } } } },
            { event: "cross-referenced", source: { issue: { number: 184, pull_request: { merged_at: null } } } },
          ]),
        };
      }
      if (path?.endsWith("/pulls/184")) {
        return {
          stdout: JSON.stringify({
            number: 184,
            state: "open",
            merged_at: null,
            head: { ref: "agent-issue-181" },
            base: { ref: "main" },
            user: { login: "bot-do-samuca" },
          }),
        };
      }
      if (path?.endsWith("/pulls/164")) {
        return {
          stdout: JSON.stringify({
            number: 164,
            state: "open",
            merged_at: null,
            head: { ref: "agent-issue-141" },
            base: { ref: "main" },
            user: { login: "bot-do-samuca" },
          }),
        };
      }
      return { stdout: "[]" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 141 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.number, 164, "the PR whose head is this Work's branch");
    assert.equal(feedback.value.pr?.headBranch, "agent-issue-141");
  });

  test("9a. readPrFeedback: with no PR on this Work's branch the newest cross-reference stands", async () => {
    const { adapter } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/timeline")) {
        return {
          stdout: JSON.stringify([
            { event: "cross-referenced", source: { issue: { number: 3, pull_request: { merged_at: null } } } },
            { event: "cross-referenced", source: { issue: { number: 4, pull_request: { merged_at: null } } } },
          ]),
        };
      }
      const number = path?.endsWith("/pulls/4") ? 4 : path?.endsWith("/pulls/3") ? 3 : null;
      if (number !== null) {
        return {
          stdout: JSON.stringify({
            number,
            state: "open",
            merged_at: null,
            head: { ref: `agent-issue-9${number}` },
            base: { ref: "main" },
            user: { login: "samuca" },
          }),
        };
      }
      return { stdout: "[]" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 1 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.number, 4, "a hand-named branch keeps the legacy answer");
  });

  test("9a. readPrFeedback: an approval-only review (body null) is dropped — no crash, the inline comment still counts", async () => {
    // GitHub returns body: null for approval-only reviews. The
    // adapter drops them (no speech signal); the inline comment — the other
    // channel — still counts as feedback. A null body reaching the state
    // derivation crashed isAgentSpeech (body.includes of null).
    const { adapter } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/timeline")) {
        return {
          stdout: JSON.stringify([
            { event: "cross-referenced", source: { issue: { number: 3, pull_request: { merged_at: null } } } },
          ]),
        };
      }
      if (path?.includes("/pulls/3/reviews")) {
        return {
          stdout: JSON.stringify([
            { id: 7, user: { login: "samuca" }, body: null, submitted_at: "2026-01-02T00:00:00Z" },
            { id: 8, user: { login: "samuca" }, body: "LGTM", submitted_at: "2026-01-02T01:00:00Z" },
          ]),
        };
      }
      if (path?.includes("/pulls/3/comments")) {
        return {
          stdout: JSON.stringify([
            {
              id: 9,
              user: { login: "samuca" },
              body: "inline: too many comments",
              created_at: "2026-01-03T00:00:00Z",
              path: "internal/issuefiles/write.go",
              line: 53,
            },
          ]),
        };
      }
      if (path?.endsWith("/pulls/3")) {
        return {
          stdout: JSON.stringify({
            number: 3,
            state: "open",
            merged_at: null,
            head: { ref: "agent-issue-1" },
            base: { ref: "main" },
            user: { login: "bot-do-samuca" },
          }),
        };
      }
      return { stdout: "[]" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 1 });
    assert.ok(feedback.known);
    // only the speech-bearing review submission and the inline comment remain —
    // the null-body approval is gone, so no null body can reach the derivation
    assert.deepEqual(
      feedback.value.reviews.map((review) => review.body),
      ["LGTM", "inline: too many comments\n(internal/issuefiles/write.go:53)"],
    );
  });

  test("9a. readPrFeedback: no linked PR is known-null, comments still read", async () => {
    const { adapter } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/timeline")) return { stdout: "[]" };
      if (path?.includes("/comments")) {
        return { stdout: JSON.stringify([{ id: 1, user: { login: "samuca" }, body: "hi", created_at: "2026-01-01T00:00:00Z" }]) };
      }
      return { stdout: "" };
    });
    const feedback = await adapter.readPrFeedback({ repo: "Sanmoo/a", number: 1 });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr, null);
    assert.equal(feedback.value.comments[0]?.body, "hi");
  });

  test("9b. openPr: creates with head/base, 'Closes #N' linkage and the agent marker", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: JSON.stringify({ number: 12, state: "open" }) }));
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
    const api = ghCall(calls, () => true);
    assert.ok(api.args.some((a) => a.endsWith("/pulls")));
    assert.ok(api.args.includes("-X") && api.args.includes("POST"));
    assert.ok(api.input?.includes("Closes #5"));
    assert.ok(api.input?.includes(AGENT_MARKER));
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

describe("9c. credential bake: a reused clone with accumulated helpers ends with exactly one", () => {
  const exec = promisify(execFileCallback);

  /** A fixture "clone": a local repo whose config already accumulated helpers —
   * the clone-time pair plus a stale machine leftover (the smoke's exit-5 state). */
  async function fixtureCloneWithAccumulatedHelpers(): Promise<{ dir: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), "msf-credhelper-"));
    tempRoots.push(root);
    const dir = join(root, "clone");
    await exec("git", ["init", "-q", dir]);
    const cfg = (args: string[]) => exec("git", ["config", "--local", ...args], { cwd: dir });
    await cfg(["credential.helper", ""]);
    await cfg(["--add", "credential.helper", "!gh auth git-credential"]);
    await cfg(["--add", "credential.helper", "osxkeychain"]);
    await cfg(["credential.https://github.com.helper", "osxkeychain"]);
    return { dir, root };
  }

  /** Every local value of a config key, via the multivar-safe --null read. */
  async function localValues(dir: string, key: string): Promise<string[]> {
    const { stdout } = await exec("git", ["config", "--local", "--get-all", "--null", key], { cwd: dir });
    return stdout.split("\0").slice(0, -1);
  }

  const tempRoots: string[] = [];

  test.after(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  test("fixture pre-state: the bare set the smoke used fails with exit 5 on the multivar", async () => {
    const { dir } = await fixtureCloneWithAccumulatedHelpers();
    await assert.rejects(
      exec("git", ["config", "--local", "credential.helper", ""], { cwd: dir }),
      (error: unknown) => (error as { code?: number }).code === 5,
    );
  });

  test("a child that exits before the body lands is its exit code, never an unhandled EPIPE", async () => {
    // `git config --unset-all` answering exit 5 can close the pipe under the
    // write. The verdict of the call is the code; a stray EPIPE must not take
    // the process (and the test file running it) down.
    await assert.rejects(
      defaultCommandRunner("sh", ["-c", "exit 5"], { env: {}, input: "x".repeat(512 * 1024) }),
      (error: unknown) => (error as { exitCode?: number | null }).exitCode === 5,
    );
    const ok = await defaultCommandRunner("sh", ["-c", "cat >/dev/null; echo done"], {
      env: {},
      input: "body",
    });
    assert.equal(ok.stdout.trim(), "done", "a child that DOES read the body still receives it");
  });

  test("a clone with TWO-plus credential.helper values ends with exactly one (the intended)", async () => {
    const { dir } = await fixtureCloneWithAccumulatedHelpers();
    await bakeCredentialHelper(dir, { GIT_TERMINAL_PROMPT: "0" });
    const helpers = await localValues(dir, "credential.helper");
    assert.equal(helpers.length, 1, `expected exactly one credential.helper, got ${JSON.stringify(helpers)}`);
    assert.equal(helpers[0], "", "the surviving helper is the ambient-wipe empty value");
    const urlHelpers = await localValues(dir, "credential.https://github.com.helper");
    assert.equal(urlHelpers.length, 1, "exactly one URL-scoped helper survives");
    assert.equal(urlHelpers[0], "!gh auth git-credential");
  });

  test("the bake tolerates a clone with no helper keys at all (absent-key exit 5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "msf-credhelper-"));
    tempRoots.push(root);
    const dir = join(root, "pristine");
    await exec("git", ["init", "-q", dir]);
    await bakeCredentialHelper(dir, { GIT_TERMINAL_PROMPT: "0" });
    assert.equal((await localValues(dir, "credential.helper")).length, 1);
  });

  test("pushBranch (reused clone): unset-all precedes the set and tolerates the absent-key exit 5", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      // simulate the real git behavior of --unset-all on a key with no values
      if (call.file === "git" && call.args[0] === "config" && call.args.includes("--unset-all")) {
        const absent = new Error("git config --unset-all exited 5") as Error & { exitCode?: number | null };
        absent.exitCode = 5;
        throw absent;
      }
      return {};
    });
    // clonesDir has no clone: nothing below exercises the network — the fake
    // runner answers every call, so the command lines are all that is proven.
    const configCalls = () => calls.filter((c) => c.file === "git" && c.args[0] === "config");
    await adapter.pushBranch({ repo: "Sanmoo/a", branch: "agent-issue-3" }).catch(() => {});
    const configs = configCalls();
    const firstUnset = configs.findIndex((c) => c.args.includes("--unset-all"));
    const bakeSet = configs.findIndex((c) => c.args[2] === "credential.helper" && c.args[3] === "");
    assert.ok(firstUnset !== -1, "the bake starts by unsetting every local helper value");
    assert.ok(bakeSet > firstUnset, "the set comes only after the unset-all");
    assert.ok(
      configs.some((c) => c.args.includes("!gh auth git-credential")),
      "the intended helper is still baked",
    );
  });
});

describe("9e. readPrRepairFacts: the merge state and the required checks of the current head", () => {
  const pathOf = (call: Call) => call.args.find((a) => a.startsWith("repos/")) ?? "";

  const basePull = {
    number: 42,
    state: "open",
    merged_at: null,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "agent-issue-7", sha: "head-sha" },
    base: { ref: "release/next", sha: "base-sha" },
    user: { login: "bot" },
  };

  function repairRoutes(overrides: {
    pull?: Record<string, unknown>;
    rules?: unknown;
    rulesFail?: boolean;
    checks?: unknown;
    statuses?: unknown;
    linked?: boolean;
  }) {
    return (call: Call) => {
      if (call.file !== "gh") return {};
      const path = pathOf(call);
      if (path.includes("/timeline")) {
        return {
          stdout: JSON.stringify(
            overrides.linked === false
              ? []
              : [{ event: "cross-referenced", source: { issue: { number: 42, pull_request: {} } } }],
          ),
        };
      }
      if (path.includes("/rules/branches/")) {
        if (overrides.rulesFail) return { fail: "Not Found", stderr: "gh: Not Found (HTTP 404)" };
        return { stdout: JSON.stringify(overrides.rules ?? []) };
      }
      if (/\/pulls\/42$/.test(path)) {
        return { stdout: JSON.stringify({ ...basePull, ...(overrides.pull ?? {}) }) };
      }
      if (path.includes("/check-runs")) {
        return { stdout: JSON.stringify(overrides.checks ?? { check_runs: [] }) };
      }
      if (path.endsWith("/status")) {
        return { stdout: JSON.stringify(overrides.statuses ?? { statuses: [] }) };
      }
      return { stdout: "{}" };
    };
  }

  test("maps dirty to a confirmed conflict and resolves the required checks by the applicable rules", async () => {
    const { adapter, calls } = await makeAdapter(
      repairRoutes({
        pull: { mergeable: false, mergeable_state: "dirty" },
        rules: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "build" }, { context: "e2e" }] },
          },
        ],
        checks: {
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "failure",
              details_url: "https://ci/build",
            },
            { name: "e2e", status: "in_progress", conclusion: null },
            { name: "optional", status: "completed", conclusion: "failure" },
          ],
        },
      }),
    );

    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.equal(facts.value.mergeState, "conflicting", "dirty confirms the conflict");
    assert.equal(facts.value.headSha, "head-sha");
    assert.equal(facts.value.baseSha, "base-sha");
    assert.equal(facts.value.baseBranch, "release/next", "the PR's current base, never the default");
    assert.equal(facts.value.requiredChecks?.length, 2, "only the rule-marked checks, never a name heuristic");
    const build = facts.value.requiredChecks?.find((check) => check.name === "build");
    assert.equal(build?.conclusion, "failure");
    assert.equal(build?.detailsUrl, "https://ci/build", "the evidence for investigating travels");
    assert.equal(facts.value.requiredChecks?.find((check) => check.name === "e2e")?.status, "in_progress");
    // The check-runs were read on the CURRENT head, and the rules on the PR base.
    assert.ok(calls.some((c) => pathOf(c).includes("/commits/head-sha/check-runs")));
    assert.ok(
      calls.some((c) => pathOf(c).includes(`/rules/branches/${encodeURIComponent("release/next")}`)),
      "the rules are read on the PR's base branch (URL-encoded)",
    );
  });

  test("an unknown merge state stays unknown — no conflict is inferred", async () => {
    const { adapter } = await makeAdapter(
      repairRoutes({ pull: { mergeable: null, mergeable_state: "unknown" }, rules: [] }),
    );
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.equal(facts.value.mergeState, "unknown");
    assert.deepEqual(facts.value.requiredChecks, [], "no applicable rule: known none");
  });

  test("a blocked merge state (review/check pending) is not a conflict", async () => {
    const { adapter } = await makeAdapter(
      repairRoutes({ pull: { mergeable: false, mergeable_state: "blocked" }, rules: [] }),
    );
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.equal(facts.value.mergeState, "mergeable", "blocked means pending approval/checks, never a conflict");
  });

  test("a rules read that cannot be resolved makes the required set unknown, never empty", async () => {
    const { adapter } = await makeAdapter(
      repairRoutes({ pull: { mergeable: false, mergeable_state: "dirty" }, rulesFail: true }),
    );
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.equal(facts.value.mergeState, "conflicting", "the mergeability read still resolves");
    assert.equal(facts.value.requiredChecks, null, "the required set is unknown");
  });

  test("a required check with no reported run is pending/unknown, never a failure", async () => {
    const { adapter } = await makeAdapter(
      repairRoutes({
        rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }],
        checks: { check_runs: [] },
      }),
    );
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.deepEqual(facts.value.requiredChecks, [{ name: "build", status: null, conclusion: null }]);
  });

  test("a legacy commit status serves the required context when no check run reported", async () => {
    const { adapter } = await makeAdapter(
      repairRoutes({
        rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci/status" }] } }],
        checks: { check_runs: [] },
        statuses: {
          statuses: [
            { context: "ci/status", state: "failure", target_url: "https://ci/status" },
          ],
        },
      }),
    );
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(facts.known);
    assert.equal(facts.value.requiredChecks?.[0]?.conclusion, "failure");
    assert.equal(facts.value.requiredChecks?.[0]?.detailsUrl, "https://ci/status");
  });

  test("no PR linked to the issue is unknown, not a clean bill", async () => {
    const { adapter } = await makeAdapter(repairRoutes({ linked: false }));
    const facts = await adapter.readPrRepairFacts({ repo: "Sanmoo/a", number: 7 });
    assert.ok(!facts.known);
  });
});

// the adapter type must remain a TrackerPort
const _typeCheck: TrackerPort = undefined as unknown as GitHubTrackerAdapter;
void _typeCheck;
