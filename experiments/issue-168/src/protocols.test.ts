import assert from "node:assert/strict";
import test from "node:test";
import { formatClaim, type ClaimRecord } from "./identity.js";
import { githubTicket } from "./explorer.js";
import { claimSequence, currentMark } from "./protocols.js";
import { SimTracker } from "./tracker.js";

const ticket = githubTicket("Sanmoo/fixture", 168);

function input(claim: ClaimRecord) {
  return { ticket, claim, actingAccount: "acting-account", destination: "Sanmoo/destination" };
}

test("claim-sequence authority is the installation identity of the winning record", () => {
  const tracker = new SimTracker(ticket);
  tracker.apply({ kind: "add-label", label: "agent-claimed" });
  tracker.apply({
    kind: "comment",
    author: "acting-account",
    body: formatClaim({ factoryId: "zeta", nonce: "zeta:1", ticket }),
  });

  // The same installation re-verifies with a different nonce (its reservation
  // was lost before it could record it): the earlier claim is still its own.
  assert.equal(
    claimSequence.decide(
      tracker.snapshot(),
      input({ factoryId: "zeta", nonce: "zeta:2", ticket }),
    ),
    "authorized",
  );

  // Another installation never inherits it, even though it shares the account.
  assert.equal(
    claimSequence.decide(
      tracker.snapshot(),
      input({ factoryId: "alpha", nonce: "alpha:1", ticket }),
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
