import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { ensureWorkspace, type WorkspaceLayout } from "../layout.js";
import {
  githubRepository,
  githubTicket,
  jiraTicket,
  pullRequestIdentity,
  type PullRequestIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";
import {
  PR_ASSOCIATIONS_FILENAME,
  activePullRequest,
  activePullRequestOf,
  readPrAssociations,
  recordPrAssociation,
} from "./pr-association.js";
import { reservationRecordOf, reserveWork } from "./reservation.js";

/**
 * The PR association on REAL disk: which PR belongs to which Work, kept with
 * its Attempt history so a restart (or a later attempt) correlates the PR
 * instead of asking the current configuration.
 */

const REPO = "Sanmoo/my-tasks";

function jiraWork(site: string, stableId: string, key: string): WorkIdentity {
  return {
    ticket: jiraTicket({ site, stableId, key }),
    destination: githubRepository(REPO),
  };
}

function pr(number: number): PullRequestIdentity {
  return pullRequestIdentity(githubRepository(REPO), number);
}

describe("PR association — the Work's persisted PR history", () => {
  let root: string;
  let layout: WorkspaceLayout;
  let dir: string;
  let work: WorkIdentity;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "msf-pr-assoc-"));
    layout = ensureWorkspace(join(root, "ws"));
    work = jiraWork("alpha.atlassian.net", "10001", "ABC-1");
    dir = (reserveWork(layout, reservationRecordOf(work))).dir;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a PR is associated with its Work and read back after a restart", async () => {
    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1, openedAt: "2026-01-01T00:00:00.000Z" });

    const read = readPrAssociations(dir);
    assert.equal(read.state, "persisted");
    if (read.state !== "persisted") return;
    assert.equal(activePullRequest(read.record)?.number, 42);
    assert.deepEqual(read.record.associations[0]!.pullRequest, pr(42));
    assert.equal(read.record.associations[0]!.attempt, 1);
  });

  test("a later PR of a later attempt is kept beside the earlier one — history is never overwritten", async () => {
    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1 });
    recordPrAssociation(dir, { work, pullRequest: pr(77), attempt: 3 });

    const read = readPrAssociations(dir);
    assert.equal(read.state, "persisted");
    if (read.state !== "persisted") return;
    assert.equal(activePullRequest(read.record)?.number, 77);
    // Both associations survive: the replaced PR stays inspectable.
    assert.deepEqual(
      read.record.associations.map((entry) => [entry.pullRequest.number, entry.attempt, entry.state]),
      [
        [42, 1, "historical"],
        [77, 3, "active"],
      ],
    );
  });

  test("re-recording the same association is idempotent — a feedback or repair round adds no noise", async () => {
    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1, openedAt: "2026-01-01T00:00:00.000Z" });
    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 2, openedAt: "2026-01-02T00:00:00.000Z" });

    const read = readPrAssociations(dir);
    assert.equal(read.state, "persisted");
    if (read.state !== "persisted") return;
    assert.equal(read.record.associations.length, 1);
    assert.equal(read.record.associations[0]!.attempt, 1, "the opening attempt is the association's own fact");
    assert.equal(read.record.associations[0]!.openedAt, "2026-01-01T00:00:00.000Z");
  });

  test("a different Work can never inherit the association file", async () => {
    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1 });
    const other = jiraWork("beta.atlassian.net", "10001", "ABC-1");

    assert.throws(
      () => recordPrAssociation(dir, { work: other, pullRequest: pr(42), attempt: 1 }),
      /different Work/,
    );
    // A PR of another destination is not this Work's association.
    const elsewhere = pullRequestIdentity(githubRepository("Sanmoo/other-tasks"), 42);
    assert.throws(
      () => recordPrAssociation(dir, { work, pullRequest: elsewhere, attempt: 1 }),
      /destination/,
    );
  });

  test("an unreadable association file is surfaced and refused, never replaced", async () => {
    writeFileSync(join(dir, PR_ASSOCIATIONS_FILENAME), "{ broken", "utf8");

    const read = readPrAssociations(dir);
    assert.equal(read.state, "unreadable");
    assert.throws(() => recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1 }), /unreadable/);
  });

  test("an absent association file is the honest empty state, not an unreadable one", async () => {
    const read = readPrAssociations(dir);
    assert.equal(read.state, "absent");
    // The dir exists (a reservation without a PR yet).
    assert.equal(basename(dir).length > 0, true);
  });

  test("two sites reserving the same readable key keep their PRs apart", async () => {
    const alpha = work;
    const beta = jiraWork("beta.atlassian.net", "10001", "ABC-1");
    const alphaDir = (reserveWork(layout, reservationRecordOf(alpha))).dir;
    const betaDir = (reserveWork(layout, reservationRecordOf(beta))).dir;
    assert.notEqual(alphaDir, betaDir);

    recordPrAssociation(alphaDir, { work: alpha, pullRequest: pr(1), attempt: 1 });
    recordPrAssociation(betaDir, { work: beta, pullRequest: pr(2), attempt: 1 });

    const alphaRead = readPrAssociations(alphaDir);
    const betaRead = readPrAssociations(betaDir);
    assert.equal(alphaRead.state === "persisted" ? activePullRequest(alphaRead.record)?.number : null, 1);
    assert.equal(betaRead.state === "persisted" ? activePullRequest(betaRead.record)?.number : null, 2);
    // GitHub legacy works stay correlation-compatible with the same file.
    const legacy: WorkIdentity = { ticket: githubTicket(REPO, 7), destination: githubRepository(REPO) };
    const legacyDir = (reserveWork(layout, reservationRecordOf(legacy))).dir;
    recordPrAssociation(legacyDir, { work: legacy, pullRequest: pr(1), attempt: 1 });
    const legacyRead = readPrAssociations(legacyDir);
    assert.equal(legacyRead.state === "persisted" ? activePullRequest(legacyRead.record)?.number : null, 1);
  });
  test("the active association read is null for absent and unreadable, and the identity when persisted", () => {
    assert.equal(activePullRequestOf(dir), null, "absent is the honest empty state");

    recordPrAssociation(dir, { work, pullRequest: pr(42), attempt: 1 });
    assert.equal(activePullRequestOf(dir)?.number, 42);

    writeFileSync(join(dir, PR_ASSOCIATIONS_FILENAME), "{not json", "utf8");
    assert.equal(activePullRequestOf(dir), null, "unreadable is never invented as an association");
  });

});
