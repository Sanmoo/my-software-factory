import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { githubRepository, githubTicket, jiraTicket, type WorkIdentity } from "../tracker/identity.js";
import { anchorOfKey, keyOfAnchor, anchorOfWork, workKeyOf, workOfAnchor } from "./work-key.js";

/**
 * The on-disk work key is the identity anchor a reservation is read back
 * from: the contract is that two Works share a dir only when they are the
 * same Work, and that a pre-existing GitHub dir keeps its key forever.
 */

function githubWork(repo: string, number: number): WorkIdentity {
  return { ticket: githubTicket(repo, number), destination: githubRepository(repo) };
}

function jiraWork(input: {
  site: string;
  stableId: string;
  key: string;
  repo: string;
}): WorkIdentity {
  return {
    ticket: jiraTicket({ site: input.site, stableId: input.stableId, key: input.key }),
    destination: githubRepository(input.repo),
  };
}

describe("work key — the registry's identity anchor", () => {
  test("a GitHub work keeps the legacy <repo>#<n> key — existing reservations are never relocated", () => {
    const work = githubWork("Sanmoo/my-tasks", 7);

    assert.equal(workKeyOf(work), "Sanmoo/my-tasks#7");
    const anchor = anchorOfKey("Sanmoo/my-tasks#7");
    assert.ok(anchor !== null);
    assert.deepEqual(workOfAnchor(anchor, "#7"), work);
  });

  test("two sites carrying the same readable key and stable ticket id get different dir keys", () => {
    const alpha = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const beta = jiraWork({ site: "beta.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });

    assert.notEqual(workKeyOf(alpha), workKeyOf(beta));
  });

  test("the repo, site and stable id cannot be recombined: every separator is encoded", () => {
    // Same shape, different split: "@" and "/" inside a component must never
    // read as the key's own separators.
    const recombined = jiraWork({ site: "a", stableId: "b@c", key: "ABC-1", repo: "x/y" });
    const other = jiraWork({ site: "a@b", stableId: "c", key: "ABC-1", repo: "x/y" });
    // "a%b" would become "a%25b"; a naive escape would collapse it with "a%".
    const percent = jiraWork({ site: "a%b", stableId: "c", key: "ABC-1", repo: "x/y" });
    const alreadyPercent = jiraWork({ site: "a%25b", stableId: "c", key: "ABC-1", repo: "x/y" });

    const keys = [recombined, other, percent, alreadyPercent].map(workKeyOf);
    assert.equal(new Set(keys).size, keys.length, `collision among ${keys.join(", ")}`);
    // A component's "/" cannot nest a directory: the key is one segment.
    assert.ok(!keys.some((key) => key.split("/").length !== 1));
  });

  test("the human-readable key never enters the dir key — a renamed Jira ticket cannot move a reservation", () => {
    const before = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const after = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-7", repo: "Sanmoo/my-tasks" });

    assert.equal(workKeyOf(before), workKeyOf(after));
    const anchor = anchorOfKey(workKeyOf(before));
    assert.ok(anchor !== null);
    assert.equal(anchor.stableId, "10001");
    assert.equal(anchor.site, "alpha.atlassian.net");
  });

  test("the key round-trips through its anchor without inventing presentation data", () => {
    const work = jiraWork({ site: "alpha.atlassian.net", stableId: "10001", key: "ABC-1", repo: "Sanmoo/my-tasks" });
    const key = workKeyOf(work);
    const anchor = anchorOfKey(key);
    assert.ok(anchor !== null);
    assert.deepEqual(anchorOfWork(work), anchor);
    assert.equal(keyOfAnchor(anchor), key);
    // The readable key is NOT inside the anchor: it is presentation, read from
    // the persisted reservation instead.
    assert.ok(!("key" in anchor));
    // The persisted reservation supplies the real readable key ("ABC-1");
    // the anchor alone can only carry the stable id.
    assert.equal(workOfAnchor(anchor, anchor.stableId).ticket.provider, "jira");
  });

  test("an unsupported GitHub site is named, never silently folded into github.com", () => {
    const enterprise: WorkIdentity = {
      ticket: { provider: "github", site: "ghe.example", repo: "Sanmoo/my-tasks", number: 7, stableId: "7", key: "#7" },
      destination: githubRepository("Sanmoo/my-tasks"),
    };
    assert.throws(() => workKeyOf(enterprise), /only github\.com is supported/);
  });

  test("unrecognized dir names are not works", () => {
    assert.equal(anchorOfKey("sessao"), null);
    assert.equal(anchorOfKey("Sanmoo/my-tasks#7/sessao"), null);
    assert.equal(anchorOfKey("jira@only-two@parts"), null);
  });
});
