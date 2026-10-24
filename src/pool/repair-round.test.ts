import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LocalWorkFacts } from "../git/port.js";
import type { PrRepairFacts, RequiredCheckResult } from "../tracker/port.js";
import { known, notKnown } from "../tracker/port.js";
import type { RepairTrigger } from "../state/derive.js";
import type { RepairAttempt } from "./repair.js";
import { openRepairRound } from "./repair-round.js";

const BASE = "main";

function conflicting(headSha: string, baseBranch = BASE): PrRepairFacts {
  return { headSha, baseBranch, baseSha: "base-sha", mergeState: "conflicting", requiredChecks: [] };
}

function failingCheck(name: string): RequiredCheckResult {
  return { name, status: "completed", conclusion: "failure" };
}

function confirmedTrigger(facts: PrRepairFacts): RepairTrigger {
  return { reasons: ["conflicts"], facts, failingChecks: [] };
}

function attemptOn(observedHeadSha: string): RepairAttempt {
  const localWork: LocalWorkFacts = {
    headSha: "local-head",
    commits: 2,
    uncommitted: true,
    operationInProgress: "merge",
  };
  return {
    evidence: `Sanmoo/a#1|${observedHeadSha}|conflicts|`,
    attempt: 2,
    observedHeadSha,
    remoteHeadSha: observedHeadSha,
    publication: "not-published",
    localWork,
  };
}

describe("repair-round — opening a round reads the premise once", () => {
  test("a confirmed premise opens the round with the head the facts were read on", async () => {
    let premiseReads = 0;
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () => {
        premiseReads += 1;
        return known(conflicting("head-a"));
      },
      observeRemote: async () => ({ known: true, headSha: "head-a" }),
    });

    assert.equal(premiseReads, 1, "the opening reads the premise exactly once");
    assert.deepEqual(result, {
      kind: "opened",
      context: {
        trigger: { reasons: ["conflicts"], facts: conflicting("head-a"), failingChecks: [] },
        pinnedHeadSha: "head-a",
        baseBranch: BASE,
        resuming: null,
      },
    });
  });

  test("a fresh round follows the facts to the current head and pins it", async () => {
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-old")),
      resuming: null,
      readPremise: async () => known(conflicting("head-new", "release")),
      observeRemote: async () => ({ known: true, headSha: "head-new" }),
    });

    assert.equal(result.kind, "opened");
    if (result.kind !== "opened") return;
    assert.equal(result.context.pinnedHeadSha, "head-new", "the round opens where the facts read now");
    assert.equal(result.context.trigger.facts.headSha, "head-new");
    assert.equal(result.context.baseBranch, "release");
    assert.deepEqual(result.context.trigger.failingChecks, []);
  });

  test("a round opened on failing required checks pins the failing set it presents", async () => {
    const facts: PrRepairFacts = {
      headSha: "head-ci",
      baseBranch: BASE,
      baseSha: "base-sha",
      mergeState: "mergeable",
      requiredChecks: [failingCheck("build")],
    };
    const result = await openRepairRound({
      trigger: { reasons: ["required-checks"], facts, failingChecks: [failingCheck("build")] },
      resuming: null,
      readPremise: async () => known(facts),
      observeRemote: async () => ({ known: true, headSha: "head-ci" }),
    });

    assert.equal(result.kind, "opened");
    if (result.kind !== "opened") return;
    assert.deepEqual(result.context.trigger.reasons, ["required-checks"]);
    assert.deepEqual(result.context.trigger.failingChecks, [failingCheck("build")]);
    assert.equal(result.context.pinnedHeadSha, "head-ci");
  });

  test("an obsolete premise returns the round before reading the remote", async () => {
    let remoteReads = 0;
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () =>
        known({
          headSha: "head-a",
          baseBranch: BASE,
          baseSha: "base-sha",
          mergeState: "mergeable",
          requiredChecks: [],
        }),
      observeRemote: async () => {
        remoteReads += 1;
        return { known: true, headSha: "head-a" };
      },
    });

    assert.deepEqual(result, { kind: "returned", premise: "obsolete" });
    assert.equal(remoteReads, 0, "a returned round spends no remote read and opens no worker");
  });

  test("an unreadable premise holds instead of assuming it confirmed", async () => {
    let remoteReads = 0;
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () => notKnown,
      observeRemote: async () => {
        remoteReads += 1;
        return { known: true, headSha: "head-a" };
      },
    });

    assert.deepEqual(result, { kind: "held", because: "premise-unknown" });
    assert.equal(remoteReads, 0, "nothing is launched while the premise cannot be read");
  });

  test("an undetermined required set holds instead of inventing a clean bill", async () => {
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () =>
        known({
          headSha: "head-a",
          baseBranch: BASE,
          baseSha: "base-sha",
          mergeState: "mergeable",
          requiredChecks: null,
        }),
      observeRemote: async () => ({ known: true, headSha: "head-a" }),
    });

    assert.deepEqual(result, { kind: "held", because: "premise-unknown" });
  });

  test("an unreadable remote holds the round; uncertainty is never a skip", async () => {
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () => known(conflicting("head-a")),
      observeRemote: async () => ({ known: false }),
    });

    assert.deepEqual(result, { kind: "held", because: "remote-unreadable" });
  });

  test("a moved head skips a fresh round without settling anything", async () => {
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () => known(conflicting("head-a")),
      observeRemote: async () => ({ known: true, headSha: "collaborator" }),
    });

    assert.deepEqual(result, {
      kind: "skipped",
      observedHeadSha: "collaborator",
      pinnedHeadSha: "head-a",
      concurrentChange: null,
    });
  });

  test("a moved head during a resumption settles the attempt as concurrent-change", async () => {
    const resuming = attemptOn("head-a");
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming,
      readPremise: async () => known(conflicting("head-a")),
      observeRemote: async () => ({ known: true, headSha: "collaborator" }),
    });

    assert.equal(result.kind, "skipped");
    if (result.kind !== "skipped") return;
    assert.equal(result.pinnedHeadSha, "head-a", "the resumption never re-pins to the collaborator's head");
    assert.equal(result.observedHeadSha, "collaborator");
    assert.ok(result.concurrentChange !== null, "the attempt is settled, not left unresolved");
    assert.equal(result.concurrentChange.attempt, 2);
    assert.equal(result.concurrentChange.publication, "concurrent-change");
    assert.equal(result.concurrentChange.remoteHeadSha, "collaborator");
    assert.deepEqual(result.concurrentChange.localWork, resuming.localWork, "the local work is preserved");
  });

  test("a resumption keeps the head its fallen attempt observed, never the re-read one", async () => {
    const resuming = attemptOn("head-a");
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming,
      readPremise: async () => known(conflicting("head-new")),
      observeRemote: async () => ({ known: true, headSha: "head-a" }),
    });

    assert.equal(result.kind, "opened");
    if (result.kind !== "opened") return;
    assert.equal(result.context.pinnedHeadSha, "head-a");
    assert.deepEqual(result.context.trigger, confirmedTrigger(conflicting("head-a")));
    assert.equal(result.context.resuming, resuming);
  });

  test("a deleted remote branch matches no pin: the round skips", async () => {
    const result = await openRepairRound({
      trigger: confirmedTrigger(conflicting("head-a")),
      resuming: null,
      readPremise: async () => known(conflicting("head-a")),
      observeRemote: async () => ({ known: true, headSha: null }),
    });

    assert.deepEqual(result, {
      kind: "skipped",
      observedHeadSha: null,
      pinnedHeadSha: "head-a",
      concurrentChange: null,
    });
  });
});
