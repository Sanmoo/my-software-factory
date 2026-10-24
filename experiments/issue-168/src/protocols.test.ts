import assert from "node:assert/strict";
import test from "node:test";
import { FactoryInstance } from "./factory.js";
import { formatClaim, type ClaimRecord } from "./identity.js";
import { FIXTURE_TICKET, githubTicket } from "./explorer.js";
import { claimSequence, currentMark } from "./protocols.js";
import { SimTracker } from "./tracker.js";
import { WorkerRegistry } from "./workers.js";

const ticket = githubTicket("Sanmoo/fixture", 168);

function input(claim: ClaimRecord) {
  return { ticket, claim, actingAccount: "acting-account", destination: "Sanmoo/destination" };
}

test("claim-sequence authorizes only the exact claim record this acquisition holds", () => {
  const tracker = new SimTracker(ticket);
  tracker.apply({ kind: "add-label", label: "agent-claimed" });
  tracker.apply({
    kind: "comment",
    author: "acting-account",
    body: formatClaim({ factoryId: "zeta", nonce: "zeta:inc-1:1", ticket }),
  });

  // The record this acquisition wrote is the smallest: authority.
  assert.equal(
    claimSequence.decide(
      tracker.snapshot(),
      input({ factoryId: "zeta", nonce: "zeta:inc-1:1", ticket }),
    ),
    "authorized",
  );

  // The same installation in another acquisition (or after losing its
  // workspace) holds no record of its own: the existing Claim is not proof.
  assert.equal(
    claimSequence.decide(
      tracker.snapshot(),
      input({ factoryId: "zeta", nonce: "zeta:inc-2:1", ticket }),
    ),
    "unavailable",
  );

  // Another installation never inherits it, even though it shares the account.
  assert.equal(
    claimSequence.decide(
      tracker.snapshot(),
      input({ factoryId: "alpha", nonce: "alpha:inc-1:1", ticket }),
    ),
    "unavailable",
  );
});

test("the current mark cannot tell the two installations apart", () => {
  const tracker = new SimTracker(ticket);
  for (const factoryId of ["zeta", "alpha"]) {
    tracker.apply({ kind: "add-label", label: "agent-claimed" });
    tracker.apply({ kind: "add-assignee", login: "acting-account" });
    tracker.apply({
      kind: "comment",
      author: "acting-account",
      body: formatClaim({ factoryId, nonce: `${factoryId}:1`, ticket }),
    });
  }
  const snapshot = tracker.snapshot();
  assert.equal(currentMark.decide(snapshot, input({ factoryId: "zeta", nonce: "zeta:1", ticket })), "authorized");
  assert.equal(currentMark.decide(snapshot, input({ factoryId: "alpha", nonce: "alpha:1", ticket })), "authorized");
});

test("one authorization launches one Worker, not two", () => {
  const tracker = new SimTracker(FIXTURE_TICKET);
  const workers = new WorkerRegistry();
  const factory = new FactoryInstance("zeta", "acting-account", "Sanmoo/destination", claimSequence);
  assert.equal(factory.observe(tracker, FIXTURE_TICKET, { kind: "all" }).decision, "free");
  assert.equal(factory.write(tracker, FIXTURE_TICKET).status, "applied");
  assert.equal(factory.verify(tracker, FIXTURE_TICKET, { kind: "all" }), "authorized");
  assert.notEqual(factory.launch(workers, FIXTURE_TICKET), undefined);
  assert.equal(factory.launch(workers, FIXTURE_TICKET), undefined);
  assert.equal(factory.attempts(FIXTURE_TICKET), 1);
  assert.equal(workers.liveFor(FIXTURE_TICKET).length, 1);
});
