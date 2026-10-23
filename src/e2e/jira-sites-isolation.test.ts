import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  githubRepository,
  githubTicket,
  jiraTicket,
  pullRequestIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";
import { cleanupFixture, seedFixtureRemote, type FixtureRemote } from "../git/local-fixtures.js";
import { localGitWork } from "../git/local.js";
import { branchOfWork, repoCloneDir, workerWorktreePath } from "../git/port.js";
import { readAttemptLedger, readLaunchFacts } from "../pool/registry.js";
import { reservationRecordOf, reserveWork, scanReservations } from "../pool/reservation.js";
import { activePullRequest, readPrAssociations, recordPrAssociation } from "../pool/pr-association.js";
import { readOutcomeRecord } from "../state/outcome.js";

const execFile = promisify(execFileCallback);

/**
 * The whole second slice on REAL disk and real local git remotes (issue 125):
 * two Jira sites delivering to the SAME repository, with the same readable key
 * and the same stable ticket id, are reserved, prepared, published, read back
 * after a restart and never mixed — while a pre-existing GitHub reservation
 * and its branch keep working where they are.
 *
 * No filesystem mock, no GitHub, no Jira: the workspace is a temp dir and the
 * "remote" is a bare repository on the same disk.
 */

const REPO = "Sanmoo/my-tasks";
const OTHER_REPO = "Sanmoo/other-tasks";

function jiraWork(input: { site: string; stableId: string; key: string; repo?: string }): WorkIdentity {
  return {
    ticket: jiraTicket({ site: input.site, stableId: input.stableId, key: input.key }),
    destination: githubRepository(input.repo ?? REPO),
  };
}

function githubWork(repo: string, number: number): WorkIdentity {
  return { ticket: githubTicket(repo, number), destination: githubRepository(repo) };
}

/** The artifact contract of the worker's ruler, written where the runtime writes it. */
function writeAttempt(dir: string, attempt: number, prNumber: number, branch: string): void {
  writeFileSync(join(dir, `log-${attempt}.jsonl`), "", "utf8");
  writeFileSync(
    join(dir, "desfecho.json"),
    `${JSON.stringify({
      class: "pr-open",
      attempt,
      pr: { repo: REPO, number: prNumber, branch },
    })}\n`,
    "utf8",
  );
}

async function gitAsync(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

describe("e2e: distinct ticket sources, one destination repository (issue 125)", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let remote: FixtureRemote;
  let otherRemote: FixtureRemote;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-jira-sites-"));
    layout = ensureWorkspace(join(root, "ws"));
    remote = await seedFixtureRemote(root, REPO, { defaultBranch: "main" });
    otherRemote = await seedFixtureRemote(root, OTHER_REPO, { defaultBranch: "main" });
  });

  afterEach(() => {
    cleanupFixture(root);
    rmSync(root, { recursive: true, force: true });
  });

  function gitWork() {
    return localGitWork({
      reposDir: layout.repos,
      remoteUrl: (repo) => (repo === OTHER_REPO ? otherRemote.barePath(repo) : remote.barePath(repo)),
    });
  }

  test("two sites with the same readable key survive a restart with their attempts, outcomes, PRs and branches apart", async () => {
    const alpha = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" });
    const beta = jiraWork({ site: "beta.atlassian.net", stableId: "10001", key: "ABC-1" });

    const alphaReservation = reserveWork(
      layout,
      reservationRecordOf(alpha, {
        title: "Alpha request",
        url: "https://alpha.atlassian.net/browse/ABC-1",
      }),
    );
    const betaReservation = reserveWork(
      layout,
      reservationRecordOf(beta, {
        title: "Beta request",
        url: "https://beta.atlassian.net/browse/ABC-1",
      }),
    );
    assert.notEqual(alphaReservation.dir, betaReservation.dir, "same key/stable id, different site: different dirs");

    // Git preparation on the SAME destination repository — real clone, real branches.
    const git = gitWork();
    const alphaPrepared = await git.prepareWorkFor(alpha);
    const betaPrepared = await git.prepareWorkFor(beta);
    assert.notEqual(alphaPrepared.branch, betaPrepared.branch, "one branch per Work, never a shared one");

    const cloneDir = repoCloneDir(layout.repos, REPO);
    const alphaWorktree = workerWorktreePath(cloneDir, alphaPrepared.branch);
    const betaWorktree = workerWorktreePath(cloneDir, betaPrepared.branch);
    assert.notEqual(alphaWorktree, betaWorktree, "one worktree per Work");
    await execFile("git", ["worktree", "add", "-q", alphaWorktree, alphaPrepared.branch], { cwd: cloneDir });
    await execFile("git", ["worktree", "add", "-q", betaWorktree, betaPrepared.branch], { cwd: cloneDir });

    // Each Work publishes its own round to its own branch and its own PR.
    const rounds = [
      { branch: alphaPrepared.branch, worktree: alphaWorktree, file: "alpha.txt" },
      { branch: betaPrepared.branch, worktree: betaWorktree, file: "beta.txt" },
    ];
    for (const round of rounds) {
      await execFile("git", ["config", "user.email", "worker@example.com"], { cwd: round.worktree });
      await execFile("git", ["config", "user.name", "worker"], { cwd: round.worktree });
      writeFileSync(join(round.worktree, round.file), "a round\n", "utf8");
      await execFile("git", ["add", round.file], { cwd: round.worktree });
      await execFile("git", ["commit", "-q", "-m", round.file], { cwd: round.worktree });
      await execFile("git", ["push", "-q", "origin", `HEAD:refs/heads/${round.branch}`], { cwd: round.worktree });
    }

    // The worker's artifacts and the persisted PR association, written per dir.
    writeAttempt(alphaReservation.dir, 1, 41, alphaPrepared.branch);
    writeAttempt(betaReservation.dir, 1, 42, betaPrepared.branch);
    recordPrAssociation(alphaReservation.dir, {
      work: alpha,
      pullRequest: pullRequestIdentity(githubRepository(REPO), 41),
      attempt: 1,
    });
    recordPrAssociation(betaReservation.dir, {
      work: beta,
      pullRequest: pullRequestIdentity(githubRepository(REPO), 42),
      attempt: 1,
    });

    // ---- RESTART: nothing but disk and the registry reader ----
    const afterRestart = await scanReservations(layout);
    assert.equal(afterRestart.length, 2);
    const bySite = new Map(afterRestart.map((entry) => [entry.anchor.site, entry]));
    const alphaEntry = bySite.get("alpha.atlassian.net")!;
    const betaEntry = bySite.get("beta.atlassian.net")!;
    assert.ok(alphaEntry.work !== null && betaEntry.work !== null, "a persisted reservation names its Work");
    assert.deepEqual(alphaEntry.work, alpha);
    assert.deepEqual(betaEntry.work, beta);
    assert.equal(alphaEntry.reservation.state, "persisted");
    assert.equal(
      alphaEntry.reservation.state === "persisted" ? alphaEntry.reservation.record.presentation.title : null,
      "Alpha request",
    );
    assert.equal(
      betaEntry.reservation.state === "persisted" ? betaEntry.reservation.record.presentation.url : null,
      "https://beta.atlassian.net/browse/ABC-1",
    );

    // Attempts and outcomes stay correlated to their own Work.
    assert.deepEqual(await readAttemptLedger(alphaEntry.dir), { lastAttempt: 1, recordedAttempt: 1 });
    assert.deepEqual(await readAttemptLedger(betaEntry.dir), { lastAttempt: 1, recordedAttempt: 1 });
    assert.equal((await readOutcomeRecord(alphaEntry.dir))?.pr?.number, 41);
    assert.equal((await readOutcomeRecord(betaEntry.dir))?.pr?.number, 42);
    assert.equal((await readOutcomeRecord(alphaEntry.dir))?.pr?.branch, alphaPrepared.branch);
    assert.equal((await readOutcomeRecord(betaEntry.dir))?.pr?.branch, betaPrepared.branch);

    // PR associations stay correlated too.
    const alphaPrs = readPrAssociations(alphaEntry.dir);
    const betaPrs = readPrAssociations(betaEntry.dir);
    assert.equal(alphaPrs.state === "persisted" ? activePullRequest(alphaPrs.record)?.number : null, 41);
    assert.equal(betaPrs.state === "persisted" ? activePullRequest(betaPrs.record)?.number : null, 42);

    // The branches and their own commits are still there, and each remote head
    // is its own.
    const alphaFacts = await git.inspectLocalWorkFor(alpha);
    const betaFacts = await git.inspectLocalWorkFor(beta);
    assert.equal(alphaFacts.commits, 1);
    assert.equal(betaFacts.commits, 1);
    const alphaRemoteHead = await git.observeRemoteHeadFor(alpha);
    const betaRemoteHead = await git.observeRemoteHeadFor(beta);
    assert.ok(alphaRemoteHead !== null && betaRemoteHead !== null);
    assert.notEqual(alphaRemoteHead, betaRemoteHead, "two Works, two branches on the remote");
    assert.equal(await gitAsync(["rev-parse", alphaPrepared.branch], cloneDir), alphaRemoteHead);
    assert.equal(await gitAsync(["rev-parse", betaPrepared.branch], cloneDir), betaRemoteHead);
  });

  test("an interrupted non-GitHub attempt resumes in the same dir, with the same attempt and branch", async () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" });
    const { dir } = reserveWork(layout, reservationRecordOf(work));
    const git = gitWork();
    const prepared = await git.prepareWorkFor(work);

    // The attempt started and died with no outcome record: the interruption's
    // own footprint on real disk (issue 123), never a fall.
    writeFileSync(join(dir, "log-1.jsonl"), "", "utf8");
    mkdirSync(join(dir, "sessao"), { recursive: true });

    // A restart continues the SAME attempt; the branch is reused untouched and
    // the Work still reads as itself from its reservation.
    const facts = await readLaunchFacts(dir, 1);
    assert.deepEqual(facts, { attempt: 1, previousFall: false });
    const recovered = await git.prepareWorkFor(work);
    assert.equal(recovered.branch, prepared.branch, "the interrupted branch is the same branch");
    assert.equal(recovered.branchCreated, false, "recovery never recreates it");
    assert.deepEqual(await readAttemptLedger(dir), { lastAttempt: 1, recordedAttempt: null });

    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.work !== null && entries[0]!.dir === dir);
    assert.deepEqual(entries[0]!.work, work);
  });

  test("a later attempt of the same Work appends its PR while the earlier one stays readable", async () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" });
    const { dir } = reserveWork(layout, reservationRecordOf(work));

    writeAttempt(dir, 1, 41, branchOfWork(work));
    recordPrAssociation(dir, {
      work,
      pullRequest: pullRequestIdentity(githubRepository(REPO), 41),
      attempt: 1,
    });
    writeAttempt(dir, 2, 42, branchOfWork(work));
    recordPrAssociation(dir, {
      work,
      pullRequest: pullRequestIdentity(githubRepository(REPO), 42),
      attempt: 2,
    });

    assert.deepEqual(await readAttemptLedger(dir), { lastAttempt: 2, recordedAttempt: 2 });
    const prs = readPrAssociations(dir);
    assert.equal(prs.state, "persisted");
    if (prs.state !== "persisted") return;
    assert.equal(activePullRequest(prs.record)?.number, 42);
    assert.deepEqual(
      prs.record.associations.map((entry) => [entry.pullRequest.number, entry.attempt, entry.state]),
      [
        [41, 1, "historical"],
        [42, 2, "active"],
      ],
    );
  });

  test("a config change that routes the same ticket to another repo leaves the old reservation in place", async () => {
    const ticket = { site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" };
    const original = jiraWork(ticket);
    const rerouted = jiraWork({ ...ticket, repo: OTHER_REPO });

    const first = reserveWork(layout, reservationRecordOf(original, { title: "original destination" }));
    writeAttempt(first.dir, 1, 41, branchOfWork(original));
    const beforeKeys = (await scanReservations(layout)).map((entry) => entry.key);

    const second = reserveWork(layout, reservationRecordOf(rerouted, { title: "new destination" }));
    assert.notEqual(second.dir, first.dir);

    // The earlier reservation is not moved, renamed or rewritten.
    const entries = await scanReservations(layout);
    const kept = entries.find((entry) => entry.dir === first.dir)!;
    assert.deepEqual(kept.work, original);
    assert.equal(
      kept.reservation.state === "persisted" ? kept.reservation.record.presentation.title : null,
      "original destination",
    );
    assert.equal((await readOutcomeRecord(kept.dir))?.pr?.number, 41, "its evidence is intact");
    assert.ok(beforeKeys.every((key) => entries.some((entry) => entry.key === key)));

    // The rerouted ticket is a different Work with its own branch in its own repo.
    const git = gitWork();
    const originalPrepared = await git.prepareWorkFor(original);
    const reroutedPrepared = await git.prepareWorkFor(rerouted);
    assert.equal(existsSync(repoCloneDir(layout.repos, REPO)), true);
    assert.equal(existsSync(repoCloneDir(layout.repos, OTHER_REPO)), true);
    assert.notEqual(originalPrepared.repoDir, reroutedPrepared.repoDir);
    assert.equal(originalPrepared.branch, branchOfWork(original));
    assert.equal(reroutedPrepared.branch, branchOfWork(rerouted));
  });

  test("an existing GitHub reservation and its legacy branch keep working where they are", async () => {
    const legacy = githubWork(REPO, 7);
    const legacyDir = workDir(layout, REPO, 7);
    mkdirSync(legacyDir, { recursive: true });
    writeAttempt(legacyDir, 1, 41, "agent-issue-7");

    // The expanded registry reads it as a GitHub Work with no record — the
    // pre-record dir is legible and usable, never relocated.
    const entries = await scanReservations(layout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.dir, legacyDir);
    assert.equal(entries[0]!.reservation.state, "absent");
    assert.deepEqual(entries[0]!.work, legacy);
    assert.equal((await readOutcomeRecord(legacyDir))?.pr?.number, 41);

    // The legacy git seam still prepares the same branch.
    const git = gitWork();
    const prepared = await git.prepareWork({ repo: REPO, number: 7 });
    assert.equal(prepared.branch, "agent-issue-7");
    const expanded = await git.prepareWorkFor(legacy);
    assert.equal(expanded.branch, "agent-issue-7", "the expanded seam addresses the same work");
    assert.equal(expanded.branchCreated, false, "the branch existed already, never recreated");

    // Persisting the facts for the next launch writes into the SAME dir.
    const written = reserveWork(layout, reservationRecordOf(legacy, { url: "https://github.com/Sanmoo/my-tasks/issues/7" }));
    assert.equal(written.dir, legacyDir);
    assert.equal(written.created, true);
    const read = await scanReservations(layout);
    assert.equal(read[0]!.reservation.state, "persisted");
    assert.equal((await readAttemptLedger(legacyDir)).recordedAttempt, 1);
  });

  test("an unreadable reservation stays visible and never blocks the other Works", async () => {
    const broken = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1" });
    const healthy = jiraWork({ site: "beta.atlassian.net", stableId: "10001", key: "ABC-1" });
    const brokenDir = (reserveWork(layout, reservationRecordOf(broken))).dir;
    const healthyDir = (reserveWork(layout, reservationRecordOf(healthy))).dir;
    writeFileSync(join(brokenDir, "reserva.json"), "{ truncated", "utf8");

    const entries = await scanReservations(layout);
    assert.equal(entries.length, 2, "the unreadable one is surfaced, not dropped");
    const brokenEntry = entries.find((entry) => entry.dir === brokenDir)!;
    const healthyEntry = entries.find((entry) => entry.dir === healthyDir)!;
    assert.equal(brokenEntry.reservation.state, "unreadable");
    assert.equal(brokenEntry.anchor.site, "alpha.atlassian.net", "the dir key still anchors the Work");
    assert.equal(brokenEntry.work, null, "with no readable key on disk, no Work is invented");
    assert.equal(healthyEntry.reservation.state, "persisted");
    assert.deepEqual(healthyEntry.work, healthy);

    // The git seam still prepares the healthy Work, with its own branch.
    const prepared = await gitWork().prepareWorkFor(healthy);
    assert.equal(prepared.branch, branchOfWork(healthy));
  });
});
