import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS, type ScenarioResult } from "./scenarios.js";

const byName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));

function run(name: string): ScenarioResult {
  const scenario = byName.get(name);
  assert.ok(scenario, `missing scenario ${name}`);
  return scenario.run();
}

function observations(name: string): Readonly<Record<string, unknown>> {
  return run(name).observations;
}

test("a free Ticket starts exactly one Worker and spends one Attempt", () => {
  const o = observations("free-ticket-progress");
  assert.equal(o["decision"], "authorized");
  assert.equal(o["live"], 1);
  assert.equal(o["attempts"], 1);
  assert.equal(o["claims"], 1);
});

test("simultaneous acquisition authorizes the first claim and refuses the second", () => {
  const o = observations("simultaneous-acquisition");
  assert.equal(o["decisionA"], "authorized");
  assert.equal(o["decisionB"], "unavailable");
  assert.equal(o["live"], 1);
  assert.equal(o["attemptsA"], 1);
  assert.equal(o["attemptsB"], 0);
});

test("the current padlock+assignment mark authorizes both factories (finding)", () => {
  const o = observations("current-mark-double-authorization");
  assert.equal(o["decisionA"], "authorized");
  assert.equal(o["decisionB"], "authorized");
  assert.equal(o["live"], 2);
  assert.equal(o["maxLive"], 2);
});

test("the conversation lock authorizes both factories (finding)", () => {
  const o = observations("conversation-lock-double-authorization");
  assert.equal(o["decisionA"], "authorized");
  assert.equal(o["decisionB"], "authorized");
  assert.equal(o["live"], 2);
});

test("a different Destination does not bypass the Ticket Claim", () => {
  const o = observations("destinations-do-not-bypass");
  assert.equal(o["destinationsDiffer"], true);
  assert.equal(o["identityA"], o["identityB"]);
  assert.equal(o["observationB"], "unavailable");
  assert.equal(o["bWrote"], 0);
  assert.equal(o["workerB"], null);
  assert.equal(o["attemptsB"], 0);
  assert.equal(o["live"], 1);
});

test("distinct sub-issues run in parallel", () => {
  const o = observations("distinct-sub-issues-parallel");
  assert.equal(o["different"], true);
  assert.equal(o["liveParent"], 1);
  assert.equal(o["liveSibling"], 1);
  assert.equal(o["maxLivePerTicket"], 1);
});

test("an existing Claim with no local Reservation is not a takeover", () => {
  const o = observations("existing-claim-no-takeover");
  assert.equal(o["observation"], "unavailable");
  assert.equal(o["bWrote"], 0);
  assert.equal(o["worker"], null);
  assert.equal(o["attempts"], 0);
  assert.equal(o["claims"], 1);
});

test("a lost response neither launches, cleans nor spends an Attempt", () => {
  const o = observations("lost-response");
  assert.equal(o["writeStatus"], "lost");
  assert.equal(o["workerBeforeVerify"], null);
  assert.equal(o["attemptsBeforeVerify"], 0);
  assert.equal(o["observationB"], "unavailable");
  assert.equal(o["bWrote"], 0);
  assert.equal(o["workerB"], null);
  assert.equal(o["attemptsB"], 0);
  assert.equal(o["decision"], "authorized");
  assert.notEqual(o["workerAfterVerify"], null);
  assert.equal(o["attemptsA"], 1);
});

test("a failure before the write leaves the Ticket free for another factory", () => {
  const o = observations("failed-before-write");
  assert.equal(o["writeStatus"], "failed");
  assert.equal(o["applied"], 0);
  assert.equal(o["decisionA"], "uncertain");
  assert.equal(o["workerA"], null);
  assert.equal(o["attemptsA"], 0);
  assert.notEqual(o["workerB"], null);
  assert.equal(o["live"], 1);
});

test("a partial Claim is never authority and is not cleaned up", () => {
  const o = observations("partial-claim");
  assert.equal(o["writeStatus"], "lost");
  assert.equal(o["writeApplied"], 1);
  assert.equal(o["decisionA"], "uncertain");
  assert.equal(o["workerA"], null);
  assert.equal(o["observationB"], "unavailable");
  assert.equal(o["workerB"], null);
  assert.equal(o["attemptsA"], 0);
  assert.equal(o["attemptsB"], 0);
  assert.equal(o["padlock"], true);
  assert.equal(o["claims"], 0);
});

test("an unreadable claim marker is uncertain, never ignored", () => {
  const o = observations("unreadable-claim");
  assert.equal(o["observation"], "uncertain");
  assert.equal(o["worker"], null);
  assert.equal(o["attempts"], 0);
});

test("a read that omits an applied claim breaks the claim sequence (finding)", () => {
  const o = observations("stale-read-two-winners");
  assert.equal(o["decisionA"], "authorized");
  assert.equal(o["decisionB"], "authorized");
  assert.equal(o["live"], 2);
});

test("unordered comment ids break the claim sequence even with fresh reads (finding)", () => {
  const o = observations("unordered-ids-two-winners");
  assert.equal(o["decisionA"], "authorized");
  assert.equal(o["decisionB"], "authorized");
  assert.equal(o["live"], 2);
});

test("the strict no-other-claim rule is safe but deadlocks under contention", () => {
  const o = observations("strict-unique-deadlock");
  assert.equal(o["decisionA"], "unavailable");
  assert.equal(o["decisionB"], "unavailable");
  assert.equal(o["live"], 0);
  assert.equal(o["claims"], 2);
  assert.equal(o["attemptsA"], 0);
  assert.equal(o["attemptsB"], 0);
});

test("death, silence and elapsed time do not transfer the Ticket", () => {
  const o = observations("abandonment-does-not-transfer");
  assert.equal(o["sweeps"], "unavailable,unavailable,unavailable");
  assert.equal(o["workerB"], null);
  assert.equal(o["attemptsB"], 0);
  assert.equal(o["afterDeath"], "unavailable");
  assert.equal(o["workerAfterDeath"], null);
  assert.equal(o["liveAfter"], 0);
  assert.equal(o["firstWorkerEnded"], "interrupted");
});

test("manual release is refused while the previous Worker is alive", () => {
  const o = observations("manual-release-precondition");
  assert.equal(o["refusedWhileAlive"], true);
  assert.equal(o["claimWhileAlive"], 1);
  assert.equal(o["released"], 0);
  assert.equal(o["padlockAfter"], false);
  assert.notEqual(o["workerB"], null);
  assert.equal(o["live"], 1);
  assert.equal(o["firstWorkerEnded"], "interrupted");
});

test("local Recovery keeps the attempt number and does not open takeover", () => {
  const o = observations("local-recovery");
  assert.equal(o["decision"], "authorized");
  assert.notEqual(o["recovered"], null);
  assert.equal(o["attempts"], 1);
  assert.equal(o["observationB"], "unavailable");
  assert.equal(o["workerB"], null);
  assert.equal(o["live"], 1);
});

test("a prior Claim convention is respected until the operator releases it", () => {
  const o = observations("legacy-claim");
  assert.equal(o["observation"], "unavailable");
  assert.equal(o["worker"], null);
  assert.equal(o["bWrote"], 0);
  assert.equal(o["releasedPadlock"], false);
  assert.equal(o["afterRelease"], "free");
  assert.notEqual(o["workerB"], null);
});

test("a claim marker for another Ticket is uncertain on this one", () => {
  const o = observations("claim-for-another-ticket");
  assert.equal(o["observation"], "uncertain");
  assert.equal(o["worker"], null);
});
