import assert from "node:assert/strict";
import test from "node:test";
import { parseClaim, formatClaim, ticketKey } from "./identity.js";
import { githubTicket } from "./explorer.js";

const ticket = githubTicket("Sanmoo/fixture", 168);

test("a claim record round-trips through one comment body", () => {
  const parsed = parseClaim(
    formatClaim({ factoryId: "factory-a", nonce: "factory-a:1", ticket }),
  );
  assert.equal(parsed.kind, "valid");
  if (parsed.kind !== "valid") return;
  assert.equal(parsed.record.factoryId, "factory-a");
  assert.equal(parsed.record.nonce, "factory-a:1");
  assert.equal(ticketKey(parsed.record.ticket), ticketKey(ticket));
});

test("a body without the marker is not a claim", () => {
  assert.equal(parseClaim("a normal human comment").kind, "none");
});

test("an incomplete marker is malformed, never 'no claim'", () => {
  const parsed = parseClaim("<!-- msf:claim -->\nfactory: only-the-factory\n");
  assert.equal(parsed.kind, "malformed");
});

test("duplicate and unknown fields are malformed", () => {
  assert.equal(
    parseClaim(
      "<!-- msf:claim -->\nfactory: a\nfactory: b\nclaim: n\nticket: github:github.com:a/b#1\n",
    ).kind,
    "malformed",
  );
  assert.equal(
    parseClaim(
      "<!-- msf:claim -->\nfactory: a\nclaim: n\nticket: github:github.com:a/b#1\nlease: 1\n",
    ).kind,
    "malformed",
  );
});

test("a claim describing another ticket is still parsed, and the reader rejects it by identity", () => {
  const parsed = parseClaim(
    formatClaim({ factoryId: "other", nonce: "other:1", ticket: githubTicket("Sanmoo/fixture", 999) }),
  );
  assert.equal(parsed.kind, "valid");
  if (parsed.kind !== "valid") return;
  assert.notEqual(ticketKey(parsed.record.ticket), ticketKey(ticket));
});

test("Ticket identity does not include the Destination", () => {
  const a = githubTicket("Sanmoo/fixture", 168);
  const b = githubTicket("Sanmoo/fixture", 168);
  assert.equal(ticketKey(a), ticketKey(b));
  assert.notEqual(ticketKey(a), ticketKey(githubTicket("Sanmoo/other", 168)));
});
