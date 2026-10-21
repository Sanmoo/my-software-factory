import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { githubRepository, githubTicket, jiraTicket, type WorkIdentity } from "../tracker/identity.js";
import { cleanupFixture, seedFixtureRemote, type FixtureRemote } from "./local-fixtures.js";
import { localGitWork } from "./local.js";
import { branchOfWork, repoCloneDir, workBranchName, workerWorktreePath } from "./port.js";

const execFile = promisify(execFileCallback);

/**
 * The work branch/worktree identity for the expanded Work (issue 125):
 * different ticket sources aimed at the SAME repository must never share a
 * branch, and every existing GitHub branch must keep its name.
 */

const REPO = "Sanmoo/my-tasks";

function jiraWork(input: { site: string; stableId: string; key?: string }): WorkIdentity {
  return {
    ticket: jiraTicket({ site: input.site, stableId: input.stableId, key: input.key ?? "ABC-1" }),
    destination: githubRepository(REPO),
  };
}

function githubWork(number: number): WorkIdentity {
  return { ticket: githubTicket(REPO, number), destination: githubRepository(REPO) };
}

describe("git work identity — branches and worktrees per Work", () => {
  let root: string;
  let reposDir: string;
  let remote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-git-identity-"));
    reposDir = join(root, "repos");
    mkdirSync(reposDir, { recursive: true });
    remote = await seedFixtureRemote(root, REPO, { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(root);
    rmSync(root, { recursive: true, force: true });
  });

  function gitWork() {
    return localGitWork({ reposDir, remoteUrl: (repo) => remote.barePath(repo) });
  }

  test("the worktree path is injective — two branches never share a managed worktree dir", () => {
    const repoDir = join(root, "repos", "Sanmoo#my-tasks");
    assert.notEqual(workerWorktreePath(repoDir, "a/b"), workerWorktreePath(repoDir, "a-b"));
    assert.notEqual(workerWorktreePath(repoDir, "a%2Fb"), workerWorktreePath(repoDir, "a/b"));
    assert.equal(
      workerWorktreePath(repoDir, "agent-issue-7"),
      join(repoDir, ".sandcastle", "worktrees", "agent-issue-7"),
      "the legacy branch's worktree path is unchanged",
    );
  });

  test("a GitHub Work keeps the legacy branch — existing remote branches remain the work's own", () => {
    assert.equal(branchOfWork(githubWork(7)), workBranchName(7));
    assert.equal(branchOfWork(githubWork(7)), "agent-issue-7");
  });

  test("the same stable id on different sites gets different branches — a PR is never confused", () => {
    const alpha = jiraWork({ site: "alpha.atlassian.net", stableId: "10001" });
    const beta = jiraWork({ site: "beta.atlassian.net", stableId: "10001" });

    assert.notEqual(branchOfWork(alpha), branchOfWork(beta));
  });

  test("sanitization is injective: a site or id containing the separator never merges two Works", () => {
    const pairs = [
      [jiraWork({ site: "a", stableId: "b-c" }), jiraWork({ site: "a-b", stableId: "c" })],
      [jiraWork({ site: "a", stableId: "b.c" }), jiraWork({ site: "a.b", stableId: "c" })],
      [jiraWork({ site: "a", stableId: "b@c" }), jiraWork({ site: "a@b", stableId: "c" })],
      [jiraWork({ site: "a", stableId: "b/c" }), jiraWork({ site: "a/b", stableId: "c" })],
    ];
    for (const [left, right] of pairs) {
      assert.notEqual(branchOfWork(left!), branchOfWork(right!));
    }
  });

  test("a Jira ticket never borrows the GitHub branch of the same number", () => {
    assert.notEqual(branchOfWork(jiraWork({ site: "alpha.atlassian.net", stableId: "7" })), branchOfWork(githubWork(7)));
  });

  test("a GitHub site other than github.com never borrows github.com's legacy branch", () => {
    const enterprise: WorkIdentity = {
      ticket: { provider: "github", site: "ghe.example", repo: REPO, number: 7, stableId: "7", key: "#7" },
      destination: githubRepository(REPO),
    };
    const branch = branchOfWork(enterprise);
    assert.notEqual(branch, workBranchName(7), "the legacy branch belongs to github.com alone");
    assert.match(branch, /^agent-github\./);
  });

  test("two Works of the same repo prepare independent branches and worktrees, and a round in one never touches the other", async () => {
    const git = gitWork();
    const alpha = jiraWork({ site: "alpha.atlassian.net", stableId: "10001" });
    const beta = jiraWork({ site: "beta.atlassian.net", stableId: "10001" });

    const first = await git.prepareWorkFor(alpha);
    const second = await git.prepareWorkFor(beta);
    assert.notEqual(first.branch, second.branch);
    assert.ok(first.branchCreated && second.branchCreated);

    const cloneDir = repoCloneDir(reposDir, REPO);
    const branchOf = async (branch: string) =>
      (await execFile("git", ["rev-parse", `refs/heads/${branch}`], { cwd: cloneDir })).stdout.trim();
    const base = (await execFile("git", ["rev-parse", "origin/main"], { cwd: cloneDir })).stdout.trim();
    assert.equal(await branchOf(first.branch), base);
    assert.equal(await branchOf(second.branch), base);

    // Both Work branches checked out at once — one worktree each, at the path
    // Sandcastle manages, never the same one.
    const firstWorktree = workerWorktreePath(cloneDir, first.branch);
    const secondWorktree = workerWorktreePath(cloneDir, second.branch);
    assert.notEqual(firstWorktree, secondWorktree);
    await execFile("git", ["worktree", "add", "-q", firstWorktree, first.branch], { cwd: cloneDir });
    await execFile("git", ["worktree", "add", "-q", secondWorktree, second.branch], { cwd: cloneDir });

    assert.equal(
      (await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: firstWorktree })).stdout.trim(),
      first.branch,
    );
    assert.equal(
      (await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: secondWorktree })).stdout.trim(),
      second.branch,
    );

    // A round publishes to its own branch only.
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: firstWorktree });
    await execFile("git", ["config", "user.name", "worker"], { cwd: firstWorktree });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(firstWorktree, "round.txt"), "alpha\n", "utf8");
    await execFile("git", ["add", "round.txt"], { cwd: firstWorktree });
    await execFile("git", ["commit", "-q", "-m", "alpha round"], { cwd: firstWorktree });

    assert.notEqual(await branchOf(first.branch), base, "the alpha round advanced its own branch");
    assert.equal(await branchOf(second.branch), base, "beta's branch is untouched");
    assert.ok(existsSync(join(firstWorktree, "round.txt")));
    assert.ok(!existsSync(join(secondWorktree, "round.txt")));
  });

  test("the legacy IssueRef seam still prepares, observes and inspects the GitHub work exactly as before", async () => {
    const git = gitWork();
    const ref = { repo: REPO, number: 7 };

    const prepared = await git.prepareWork(ref);
    assert.equal(prepared.branch, workBranchName(7));
    assert.equal(prepared.branchCreated, true);
    assert.deepEqual(await git.inspectLocalWork(ref), {
      headSha: prepared.branchOnOrigin ? null : (await git.inspectLocalWork(ref)).headSha,
      commits: 0,
      uncommitted: false,
      operationInProgress: null,
    });
    assert.equal(await git.observeRemoteHead(ref), null);
    // The expanded seam addresses the same Work, so nothing was duplicated.
    const expanded = await git.prepareWorkFor(githubWork(7));
    assert.equal(expanded.branch, prepared.branch);
    assert.equal(expanded.branchCreated, false);
  });
});
