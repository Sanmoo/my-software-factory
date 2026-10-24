import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupFixture, commitFileIn, seedFixtureRemote, type FixtureRemote } from "./local-fixtures.js";
import { localGitWork } from "./local.js";
import { repoCloneDir, workBranchName, type GitWork } from "./port.js";
import { githubWork } from "../e2e/work-fixtures.js";

const execFile = promisify(execFileCallback);

/**
 * The git host side, exercised with local git fixtures: bare remotes in a
 * temp workspace — no GitHub, no network. Every behavioral decision of the git
 * host shows up here as an observable git fact of the clone on disk.
 */

describe("git host — one clone per target repo", () => {
  let root: string;
  let reposDir: string;
  let remote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-git-"));
    reposDir = join(root, "repos");
    mkdirSync(reposDir, { recursive: true });
    remote = await seedFixtureRemote(root, "Sanmoo/my-tasks", { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(root);
    rmSync(root, { recursive: true, force: true });
  });

  function gitWork(): GitWork {
    return localGitWork({ reposDir, remoteUrl: (repo) => remote.barePath(repo) });
  }

  test("first work clones the remote into repos/<owner>#<name>; second work of the same repo never re-clones, only fetches delta", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    assert.ok(existsSync(join(cloneDir, ".git")), "the single clone exists under repos/");

    // A marker inside the clone proves no re-clone happened afterwards.
    writeFileSync(join(cloneDir, "marker.txt"), "keep", "utf8");

    // The remote advances; the second work must reach it by delta fetch.
    await remote.commitFile("main", "file.txt", "v2\n", "advance base");
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 8));

    assert.equal(readFileSync(join(cloneDir, "marker.txt"), "utf8"), "keep", "never re-cloned");
    const fetched = await execFile("git", ["rev-parse", "origin/main"], { cwd: cloneDir });
    const expected = await execFile("git", ["rev-parse", "main"], { cwd: remote.seedDir });
    assert.equal(fetched.stdout.trim(), expected.stdout.trim(), "delta fetch brought the new base");
  });

  test("the work branch is born from the default branch revealed by the clone itself — no API, no config", async () => {
    const trunk = await seedFixtureRemote(root, "Sanmoo/trunk-repo", { defaultBranch: "trunk" });
    const git = localGitWork({
      reposDir,
      remoteUrl: (repo) => (repo === "Sanmoo/trunk-repo" ? trunk.barePath(repo) : remote.barePath(repo)),
    });

    await git.prepareWorkFor(githubWork("Sanmoo/trunk-repo", 3));

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/trunk-repo");
    const branchBase = await execFile("git", ["rev-parse", workBranchName(3)], { cwd: cloneDir });
    const originDefault = await execFile("git", ["rev-parse", "origin/trunk"], { cwd: cloneDir });
    assert.equal(branchBase.stdout.trim(), originDefault.stdout.trim());
  });

  test("relaunch reuses the existing branch — worker commits survive, never recreated", async () => {
    const git = gitWork();
    const first = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.ok(first.branchCreated, "first launch creates the branch");

    // The worker's round: a commit on the work branch (the memory of the work).
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: cloneDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: cloneDir });
    await execFile("git", ["checkout", "-q", workBranchName(7)], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "worker round 1\n", "round 1");
    const workerHead = await execFile("git", ["rev-parse", workBranchName(7)], { cwd: cloneDir });

    const second = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    assert.equal(second.branchCreated, false, "relaunch reuses, never recreates");
    assert.equal(second.branch, first.branch);
    const afterRelaunch = await execFile("git", ["rev-parse", workBranchName(7)], { cwd: cloneDir });
    assert.equal(afterRelaunch.stdout.trim(), workerHead.stdout.trim(), "worker commits intact");
  });

  test("prepare reveals whether the work branch is on origin — the fact behind a relaunch's fetch", async () => {
    const git = gitWork();
    const first = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.equal(first.branchCreated, true);
    assert.equal(first.branchOnOrigin, false, "born from the base is not the same as published");

    // The worker's round without publishing — a blocked self-report or an
    // abrupt death leaves the branch only in the clone.
    const unpublished = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.equal(unpublished.branchCreated, false);
    assert.equal(unpublished.branchOnOrigin, false, "a relaunch has nothing to fast-forward");

    // The worker published (push + PR): the retomada now has something to fetch.
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });
    const published = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.equal(published.branchOnOrigin, true);

    // The remote branch is gone (deleted by hand): the truth comes from the
    // remote itself, never from a stale local remote-tracking ref.
    await execFile("git", ["push", "-q", "origin", "--delete", workBranchName(7)], { cwd: cloneDir });
    const deleted = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.equal(deleted.branchOnOrigin, false, "a deleted remote branch is not on origin");
  });

  test("observeRemoteHead reports the remote branch SHA — the lease value observed before a repair", async () => {
    const git = gitWork();
    const ref = githubWork("Sanmoo/my-tasks", 7);
    await git.prepareWorkFor(ref);
    assert.equal(await git.observeRemoteHeadFor(ref), null, "not yet published: nothing to lease against");

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: cloneDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: cloneDir });
    await execFile("git", ["checkout", "-q", workBranchName(7)], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "round 1\n", "round 1");
    const firstHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });

    assert.equal(await git.observeRemoteHeadFor(ref), firstHead, "the observed head is the pinned lease value");

    // A concurrent collaborator pushes: the remote moves, so the pinned value
    // is stale — the very mismatch the repair launch checks before acting.
    await commitFileIn(cloneDir, "other.txt", "concurrent\n", "concurrent");
    const movedHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });

    const observedNow = await git.observeRemoteHeadFor(ref);
    assert.equal(observedNow, movedHead, "the remote moved");
    assert.notEqual(observedNow, firstHead, "the stale lease would no longer match");
  });

  test("a force-with-lease pinned to the OBSERVED head never overwrites a concurrent push", async () => {
    const git = gitWork();
    const ref = githubWork("Sanmoo/my-tasks", 7);
    await git.prepareWorkFor(ref);

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: cloneDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: cloneDir });
    await execFile("git", ["checkout", "-q", workBranchName(7)], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "round 1\n", "round 1");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });
    const observed = await git.observeRemoteHeadFor(ref);
    assert.ok(observed);

    // A concurrent collaborator rewrites the remote branch.
    await commitFileIn(cloneDir, "other.txt", "concurrent\n", "concurrent");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });

    // The worker's rebase produced a rewritten history; it pushes with the
    // lease pinned to the observed SHA — the push MUST be rejected.
    await execFile("git", ["reset", "--hard", observed], { cwd: cloneDir });
    await commitFileIn(cloneDir, "rebase.txt", "rebased\n", "rebased");
    await assert.rejects(
      execFile(
        "git",
        ["push", `--force-with-lease=${workBranchName(7)}:${observed}`, "origin", workBranchName(7)],
        { cwd: cloneDir },
      ),
      "the lease rejects the push — the concurrent commit is never overwritten",
    );

    // The concurrent commit is intact on the remote.
    const { stdout } = await execFile("git", ["ls-remote", "origin", `refs/heads/${workBranchName(7)}`], {
      cwd: cloneDir,
    });
    assert.notEqual(stdout.trim().split(/\s+/)[0], observed, "the remote still holds the concurrent work");
  });

  test("a rebase onto the advanced base publishes with the lease when the observed head is unchanged", async () => {
    const git = gitWork();
    const ref = githubWork("Sanmoo/my-tasks", 7);
    await git.prepareWorkFor(ref);

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: cloneDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: cloneDir });
    await execFile("git", ["checkout", "-q", workBranchName(7)], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "round 1\n", "round 1");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });
    const observed = await git.observeRemoteHeadFor(ref);
    assert.ok(observed);

    // The base advances; the worker rebases onto the PR's current base.
    await remote.commitFile("main", "file.txt", "v2\n", "advance base");
    await execFile("git", ["fetch", "-q", "origin"], { cwd: cloneDir });
    await execFile("git", ["rebase", "-q", "origin/main"], { cwd: cloneDir });

    // The remote did not move: the lease pinned to the observed head is accepted.
    await execFile(
      "git",
      ["push", `--force-with-lease=${workBranchName(7)}:${observed}`, "origin", workBranchName(7)],
      { cwd: cloneDir },
    );
    const published = await git.observeRemoteHeadFor(ref);
    assert.ok(published && published !== observed, "the rebased head is published on the same branch");
  });

  test("the base advanced between rounds — the work branch is untouched, no rebase, no merge", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    // Worker commits; then the human merges something and the default advances.
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: cloneDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: cloneDir });
    await execFile("git", ["checkout", "-q", workBranchName(7)], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "worker\n", "round 1");
    const workerHead = await execFile("git", ["rev-parse", workBranchName(7)], { cwd: cloneDir });

    await remote.commitFile("main", "file.txt", "v2\n", "advance base");
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const after = await execFile("git", ["rev-parse", workBranchName(7)], { cwd: cloneDir });
    assert.equal(after.stdout.trim(), workerHead.stdout.trim(), "branch left alone");
  });

  test("two parallel works in the same repo get distinct branches off the same single clone", async () => {
    const git = gitWork();
    const a = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    const b = await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 8));

    assert.notEqual(a.branch, b.branch, "agent-issue-7 vs agent-issue-8");
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    for (const branch of [a.branch, b.branch]) {
      await execFile("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: cloneDir });
    }
  });

  test("non-done states clean nothing — preparing a work never deletes branches", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 8));

    // More rounds of prepare (claims, retomadas, feedback) — nothing is removed.
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 8));

    const branches = await execFile(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: repoCloneDir(reposDir, "Sanmoo/my-tasks") },
    );
    assert.deepEqual(branches.stdout.trim().split("\n").sort(), [
      "agent-issue-7",
      "agent-issue-8",
      "main", // the default, checked out by the clone itself — untouched
    ]);
    const remoteBranches = await execFile("git", ["ls-remote", "--heads", "origin"], {
      cwd: repoCloneDir(reposDir, "Sanmoo/my-tasks"),
    });
    assert.ok(
      !remoteBranches.stdout.includes("agent-issue-"),
      "nothing was pushed behind the factory's back",
    );
  });
});

describe("git host — cleanup only on done", () => {
  let root: string;
  let reposDir: string;
  let remote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-git-done-"));
    reposDir = join(root, "repos");
    mkdirSync(reposDir, { recursive: true });
    remote = await seedFixtureRemote(root, "Sanmoo/my-tasks", { defaultBranch: "main" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function gitWork(): GitWork {
    return localGitWork({ reposDir, remoteUrl: (repo) => remote.barePath(repo) });
  }

  test("done: remote branch deleted, local branch deleted, refs pruned — idempotent", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    // The worker pushed the branch; the human merged it (merge left the remote branch).
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });
    assert.ok((await execFile("git", ["ls-remote", "--heads", "origin"], { cwd: cloneDir })).stdout.includes(workBranchName(7)));

    await git.cleanupDoneWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const remoteAfter = await execFile("git", ["ls-remote", "--heads", "origin"], { cwd: cloneDir });
    assert.ok(!remoteAfter.stdout.includes(workBranchName(7)), "remote branch deleted");
    const localAfter = await execFile("git", ["for-each-ref", "refs/heads"], { cwd: cloneDir });
    assert.ok(!localAfter.stdout.includes(workBranchName(7)), "local branch deleted");
    const tracking = await execFile("git", ["for-each-ref", "refs/remotes/origin"], { cwd: cloneDir });
    assert.ok(!tracking.stdout.includes(workBranchName(7)), "remote-tracking ref pruned");

    // Done is terminal: a second cleanup (re-derivation) changes nothing.
    await git.cleanupDoneWorkFor(githubWork("Sanmoo/my-tasks", 7));
  });

  test("done after the merge already auto-deleted the remote branch: local branch still cleaned, no error", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    await git.cleanupDoneWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    const localAfter = await execFile("git", ["for-each-ref", "refs/heads"], { cwd: cloneDir });
    assert.ok(!localAfter.stdout.includes(workBranchName(7)), "local branch deleted");
  });

  test("done with the worktree Sandcastle left behind: the branch is checked out there, cleanup still lands", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    // The launch runs the worker in Sandcastle's own worktree on the work
    // branch (branchStrategy "branch"); the worker pushed the branch (the PR)
    // and left the worktree DIRTY, which makes Sandcastle PRESERVE it — the
    // branch stays checked out after the run, so a plain `git branch -D`
    // refuses to delete it.
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    const worktreeDir = join(cloneDir, ".sandcastle", "worktrees", workBranchName(7));
    await execFile("git", ["worktree", "add", "-q", worktreeDir, workBranchName(7)], { cwd: cloneDir });
    writeFileSync(join(worktreeDir, "uncommitted.txt"), "dirty round\n", "utf8");
    await execFile("git", ["push", "-q", "origin", workBranchName(7)], { cwd: cloneDir });

    await git.cleanupDoneWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const localAfter = await execFile("git", ["for-each-ref", "refs/heads"], { cwd: cloneDir });
    assert.ok(!localAfter.stdout.includes(workBranchName(7)), "local branch deleted despite the worktree");
    assert.ok(!existsSync(worktreeDir), "the preserved worktree is gone too");
    const remoteAfter = await execFile("git", ["ls-remote", "--heads", "origin"], { cwd: cloneDir });
    assert.ok(!remoteAfter.stdout.includes(workBranchName(7)), "remote branch deleted");
  });

  test("cleanup on a repo that was never cloned is a no-op — nothing created, no error", async () => {
    const git = gitWork();

    await git.cleanupDoneWorkFor(githubWork("Sanmoo/never-touched", 7));

    assert.ok(!existsSync(repoCloneDir(reposDir, "Sanmoo/never-touched")));
  });

  test("diffWork returns the work branch's own changes against its base — the prompt's diff", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    // The branch has no changes yet; the base advancing alone must not leak into the diff.
    assert.equal(await git.diffWorkFor(githubWork("Sanmoo/my-tasks", 7)), "");

    // The work's own commit shows up; a later base advance does not.
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    await execFile("git", ["checkout", "-q", "agent-issue-7"], { cwd: cloneDir });
    await commitFileIn(cloneDir, "work.txt", "the work\n", "the work");
    await remote.commitFile("main", "file.txt", "v2\n", "advance base");
    await execFile("git", ["fetch", "-q", "origin"], { cwd: cloneDir });

    const diff = await git.diffWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.match(diff, /the work/);
    assert.doesNotMatch(diff, /v2/);
  });

  test("cleanup never touches other works' branches", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 8));

    await git.cleanupDoneWorkFor(githubWork("Sanmoo/my-tasks", 7));

    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    const branches = await execFile("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
      cwd: cloneDir,
    });
    assert.ok(branches.stdout.includes("agent-issue-8"), "in-flight work keeps its branch");
  });
});

describe("git host — the local work a resumption must preserve", () => {
  let root: string;
  let reposDir: string;
  let remote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-git-local-"));
    reposDir = join(root, "repos");
    mkdirSync(reposDir, { recursive: true });
    remote = await seedFixtureRemote(root, "Sanmoo/my-tasks", { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(root);
    rmSync(root, { recursive: true, force: true });
  });

  function gitWork(): GitWork {
    return localGitWork({ reposDir, remoteUrl: (repo) => remote.barePath(repo) });
  }

  /** The worktree Sandcastle runs the worker in, with git identity to commit. */
  async function sandcastleWorktree(number: number): Promise<string> {
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    const worktreeDir = join(cloneDir, ".sandcastle", "worktrees", workBranchName(number));
    await execFile("git", ["worktree", "add", "-q", worktreeDir, workBranchName(number)], { cwd: cloneDir });
    await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: worktreeDir });
    await execFile("git", ["config", "user.name", "worker"], { cwd: worktreeDir });
    return worktreeDir;
  }

  test("a branch with no commits reports an empty local state — nothing invented", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));

    assert.deepEqual(await git.inspectLocalWorkFor(githubWork("Sanmoo/my-tasks", 7)), {
      headSha: (await execFile("git", ["rev-parse", "agent-issue-7"], {
        cwd: repoCloneDir(reposDir, "Sanmoo/my-tasks"),
      })).stdout.trim(),
      commits: 0,
      uncommitted: false,
      operationInProgress: null,
    });
  });

  test("a repo never cloned reports an empty local state, never an error", async () => {
    const git = gitWork();
    assert.deepEqual(await git.inspectLocalWorkFor(githubWork("Sanmoo/my-tasks", 7)), {
      headSha: null,
      commits: 0,
      uncommitted: false,
      operationInProgress: null,
    });
  });

  test("commits, uncommitted changes and an interrupted rebase are all read from the worktree", async () => {
    const git = gitWork();
    await git.prepareWorkFor(githubWork("Sanmoo/my-tasks", 7));
    const worktreeDir = await sandcastleWorktree(7);

    // The fallen attempt's own commits — the work a resumption must reuse.
    await commitFileIn(worktreeDir, "file.txt", "the work, part 1\n", "work part 1");
    await commitFileIn(worktreeDir, "extra.txt", "the work, part 2\n", "work part 2");

    // A change the session never committed.
    writeFileSync(join(worktreeDir, "unfinished.txt"), "half done\n", "utf8");

    // The base moved with a conflict; the rebase stops and stays in progress.
    await remote.commitFile("main", "file.txt", "the base moved\n", "advance base");
    await execFile("git", ["fetch", "-q", "origin"], { cwd: worktreeDir });
    await assert.rejects(execFile("git", ["rebase", "origin/main"], { cwd: worktreeDir }));

    const facts = await git.inspectLocalWorkFor(githubWork("Sanmoo/my-tasks", 7));
    const cloneDir = repoCloneDir(reposDir, "Sanmoo/my-tasks");
    const tip = await execFile("git", ["rev-parse", "refs/heads/agent-issue-7"], { cwd: cloneDir });
    assert.equal(facts.headSha, tip.stdout.trim(), "the branch tip is the attempt's produced commit");
    assert.equal(facts.commits, 2, "the branch's own commits are counted against the base");
    assert.equal(facts.uncommitted, true, "the conflicted and untracked files are uncommitted work");
    assert.equal(facts.operationInProgress, "rebase", "an interrupted rebase is never mistaken for a clean tree");

    // Inspection alone changes nothing: the rebase is still there to be finished.
    assert.ok(existsSync(join(worktreeDir, ".git")) || (await execFile("git", ["status", "--porcelain"], { cwd: worktreeDir })).stdout !== "");
    const again = await git.inspectLocalWorkFor(githubWork("Sanmoo/my-tasks", 7));
    assert.deepEqual(again, facts, "reading the local state is idempotent");
  });
});
