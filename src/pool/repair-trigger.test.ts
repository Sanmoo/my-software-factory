import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { githubRepository, githubTicket } from "../tracker/identity.js";
import type { PrRepairFacts, RequiredCheckResult } from "../tracker/port.js";
import { known } from "../tracker/port.js";
import {
  confirmedRepairTrigger,
  isFailingRequiredCheck,
  readRepairPremise,
  repairSignature,
} from "./repair-trigger.js";

/**
 * The ONE owner of "this PR needs Repair" (two review findings). The trigger
 * had two byte-identical copies — one in the derivation,
 * one in the Work state — and the launch hashes whichever reaches it into the
 * DURABLE repair evidence, so a divergence between the copies would have
 * changed a persisted signature across restarts. These tests pin the policy and
 * the signature where the copies now meet.
 */

const WORK = { ticket: githubTicket("my-tasks", 7), destination: githubRepository("my-tasks") };

function facts(overrides: Partial<PrRepairFacts> = {}): PrRepairFacts {
  return { headSha: "head-a", baseBranch: "main", baseSha: "base-sha", mergeState: "mergeable", requiredChecks: [], ...overrides };
}

function check(name: string, status: RequiredCheckResult["status"], conclusion: RequiredCheckResult["conclusion"] = null): RequiredCheckResult {
  return { name, status, conclusion };
}

describe("the repair trigger — one predicate, one signature ", () => {
  test("only a concluded failure or timeout reacts; every other check state is silent", () => {
    assert.equal(isFailingRequiredCheck(check("unit", "completed", "failure")), true);
    assert.equal(isFailingRequiredCheck(check("unit", "completed", "timed_out")), true);

    for (const silent of [
      check("unit", "completed", "success"),
      check("unit", "completed", "neutral"),
      check("unit", "completed", "skipped"),
      check("unit", "completed", "cancelled"),
      check("unit", "completed", null),
      check("unit", "in_progress", null),
      check("unit", "queued", null),
    ]) {
      assert.equal(
        isFailingRequiredCheck(silent),
        false,
        `${silent.status}/${silent.conclusion} is not a confirmed impediment`,
      );
    }
  });

  test("a conflict, a failing required check, or both — never a clean or pending PR", () => {
    assert.equal(confirmedRepairTrigger(facts()), null, "a clean PR confirms nothing");
    assert.equal(confirmedRepairTrigger(facts({ mergeState: "unknown" })), null, "unknown mergeability is not a conflict");
    assert.deepEqual(confirmedRepairTrigger(facts({ mergeState: "conflicting" }))?.reasons, ["conflicts"]);

    const failing = confirmedRepairTrigger(facts({ requiredChecks: [check("unit", "completed", "failure")] }));
    assert.deepEqual(failing?.reasons, ["required-checks"]);
    assert.deepEqual(failing?.failingChecks.map((entry) => entry.name), ["unit"]);

    const both = confirmedRepairTrigger(
      facts({ mergeState: "conflicting", requiredChecks: [check("unit", "completed", "timed_out")] }),
    );
    assert.deepEqual(both?.reasons, ["conflicts", "required-checks"]);
    assert.equal(both?.facts.headSha, "head-a", "the trigger carries the facts it was read from");
  });

  test("the required set is nullable: absent checks are read as none, never as a confirmation", () => {
    assert.equal(confirmedRepairTrigger(facts({ requiredChecks: null })), null);
  });

  test("the signature names the Work, the head, the reason and the failing checks — the durable evidence of a round", () => {
    const trigger = confirmedRepairTrigger(
      facts({ headSha: "head-b", requiredChecks: [check("unit", "completed", "failure")] }),
    );
    assert.ok(trigger);

    const signature = repairSignature(WORK, trigger);
    assert.equal(signature, "my-tasks#7|head-b|no-conflicts|unit:failure");
    assert.equal(repairSignature(WORK, trigger), signature, "the same evidence is the same signature");

    // A new head or a different failing check is NEW evidence: the round is not
    // the same round, which is what makes the reset and the resumption safe.
    const movedHead = confirmedRepairTrigger(facts({ headSha: "head-c", requiredChecks: trigger.failingChecks }));
    assert.notEqual(repairSignature(WORK, movedHead!), signature);
    const otherCheck = confirmedRepairTrigger(facts({ headSha: "head-b", requiredChecks: [check("lint", "completed", "failure")] }));
    assert.notEqual(repairSignature(WORK, otherCheck!), signature);
  });

  test("the premise of a round: a confirmed trigger persists, an unreadable read proves nothing", () => {
    assert.deepEqual(readRepairPremise({ known: false }), { premise: "unknown" });
    assert.deepEqual(readRepairPremise(known(facts({ mergeState: "conflicting" }))).premise, "persisting");
    assert.deepEqual(readRepairPremise(known(facts())), { premise: "obsolete" });
    assert.deepEqual(
      readRepairPremise(known(facts({ mergeState: "unknown" }))),
      { premise: "unknown" },
      "an unknown mergeability is never an obsolete premise",
    );
    assert.deepEqual(
      readRepairPremise(known(facts({ requiredChecks: null }))),
      { premise: "unknown" },
      "an undetermined required set is never an obsolete premise",
    );
  });
});
