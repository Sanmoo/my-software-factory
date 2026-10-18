import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  bakeCredentialHelper,
  createGitHubAdapter,
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
  test("1. listCandidates: plain open-issues listing, ready label matched CLIENT-SIDE, PRs excluded via the open-PRs listing", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.includes("/pulls?")) return { stdout: "[]" };
      return {
        stdout:
          call.file === "gh"
            ? `[{"number":7,"title":"do it","created_at":"2026-01-02T00:00:00Z","labels":[{"name":"ready-for-agent"}]},{"number":8,"title":"a pr","created_at":"2026-01-03T00:00:00Z","pull_request":{},"labels":[{"name":"ready-for-agent"}]},{"number":9,"title":"unlabeled","created_at":"2026-01-04T00:00:00Z","labels":[]},{"number":10,"title":"other label","created_at":"2026-01-05T00:00:00Z","labels":[{"name":"other"}]}]`
            : "",
      };
    });
    const candidates = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");
    assert.deepEqual(candidates, [
      { ref: { repo: "Sanmoo/a", number: 7 }, title: "do it", createdAt: "2026-01-02T00:00:00Z" },
    ]);
    const gh = ghCall(calls, (c) => c.args[0] === "api");
    const path = gh.args.find((a) => a.startsWith("repos/"));
    assert.ok(path?.includes("state=open"));
    // the dialect (ticket 16 smoke fix): NO labels query param — GitHub's
    // label-filtered listing is search-index-backed and lags minutes behind a
    // fresh label; the filter happens in the adapter instead
    assert.ok(!path?.includes("labels="), "the labels query param is never sent");
    assert.ok(!gh.args.includes("issue"), "gh issue list (GraphQL) is never touched");
  });

  test("1. listCandidates: an issue linked by an OPEN PR's body is excluded (only sem-PR issues enter the pool — ticket 12)", async () => {
    const { adapter, calls } = await makeAdapter((call) => {
      const path = call.args.find((a) => a.startsWith("repos/"));
      if (path?.endsWith("/issues") || path?.includes("/issues?")) {
        return {
          stdout: JSON.stringify([
            { number: 7, title: "has a PR", created_at: "2026-01-02T00:00:00Z", labels: [{ name: "ready-for-agent" }] },
            { number: 8, title: "no PR", created_at: "2026-01-03T00:00:00Z", labels: [{ name: "ready-for-agent" }] },
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
    const candidates = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");
    assert.deepEqual(
      candidates.map((c) => c.ref.number),
      [8],
      "#7 (Closes #7) is excluded; #8 (fixes #8) is excluded too — only sem-PR issues remain",
    );
    const pulls = calls.find(
      (c) => c.file === "gh" && (c.args.find((a) => a.startsWith("repos/")) ?? "").includes("/pulls?"),
    );
    assert.ok(pulls, "the open-PRs listing is read");
    const pullsPath = pulls?.args.find((a) => a.startsWith("repos/"));
    assert.match(pullsPath ?? "", /state=open/);
    assert.equal(
      calls.filter(
        (c) => c.file === "gh" && (c.args.find((a) => a.startsWith("repos/")) ?? "").includes("/pulls?"),
      ).length,
      1,
      "the open-PRs listing is read ONCE, not per candidate",
    );
  });

  test("1. listCandidates: an EMPTY issues listing never reads the open-PRs listing (nothing to filter)", async () => {
    const { adapter, calls } = await makeAdapter(() => ({ stdout: "[]" }));
    const candidates = await adapter.listCandidates("Sanmoo/a", "ready-for-agent");
    assert.deepEqual(candidates, []);
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
    let deletes = 0;
    const { adapter, calls } = await makeAdapter((call) => {
      if (call.args.includes("-X") && call.args.includes("DELETE")) {
        deletes += 1;
        if (deletes === 1) return { fail: "gh: Not Found (HTTP 404)" }; // absent claim label
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

  test("9a. readPrFeedback: an approval-only review (body null) is dropped — no crash, the inline comment still counts", async () => {
    // Spec #7: GitHub returns body: null for approval-only reviews. The
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

// the adapter type must remain a TrackerPort
const _typeCheck: TrackerPort = undefined as unknown as GitHubTrackerAdapter;
void _typeCheck;
