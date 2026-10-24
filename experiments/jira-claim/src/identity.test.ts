import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  claimRecord,
  CLAIM_PROPERTY_KEY,
  CLAIM_PROTOCOL,
  githubDestination,
  jiraTicket,
  parseClaim,
  renderTicket,
  ticketIdentityKey,
  type ClaimRecord,
} from "./identity.js";

const ALPHA = "alpha.atlassian.net";
const BETA = "beta.atlassian.net";
const DEST_A = githubDestination({ site: "github.com", repo: "Sanmoo/repo-a" });
const DEST_B = githubDestination({ site: "github.com", repo: "Sanmoo/repo-b" });

function record(overrides?: Partial<ClaimRecord>): ClaimRecord {
  const base = claimRecord({
    factory: "factory-a",
    nonce: "nonce-1",
    ticket: jiraTicket({ site: ALPHA, stableId: "10001", key: "OPS-1" }),
    account: "shared-acting-account",
    destination: DEST_A,
    createdAt: "2026-10-24T12:00:00.000Z",
  });
  return { ...base, ...overrides };
}

describe("ticket identity", () => {
  test("the same readable key and even the same issue id on two sites are distinct Tickets", () => {
    const onAlpha = jiraTicket({ site: ALPHA, stableId: "10001", key: "OPS-1" });
    const onBeta = jiraTicket({ site: BETA, stableId: "10001", key: "OPS-1" });
    assert.notEqual(ticketIdentityKey(onAlpha), ticketIdentityKey(onBeta));
    assert.match(renderTicket(onAlpha), /jira:alpha\.atlassian\.net/);
    assert.match(renderTicket(onBeta), /jira:beta\.atlassian\.net/);
  });

  test("the readable key is presentation: two ids under the same key are distinct", () => {
    const first = jiraTicket({ site: ALPHA, stableId: "10001", key: "OPS-1" });
    const second = jiraTicket({ site: ALPHA, stableId: "10002", key: "OPS-1" });
    assert.notEqual(ticketIdentityKey(first), ticketIdentityKey(second));
  });

  test("the property key is the protocol's own namespaced key", () => {
    assert.equal(CLAIM_PROPERTY_KEY, "com.sanmoo.msf.claim");
    assert.equal(CLAIM_PROTOCOL, "msf-jira-claim/v1");
  });
});

describe("claim record", () => {
  const ticket = jiraTicket({ site: ALPHA, stableId: "10001", key: "OPS-1" });
  const expected = ticketIdentityKey(ticket);

  test("round-trips through the JSON value Jira stores", () => {
    const source = record();
    const parsed = parseClaim(source, expected);
    assert.equal(parsed.kind, "valid");
    if (parsed.kind === "valid") {
      assert.deepEqual(parsed.record, source);
      assert.equal(parsed.record.factory, "factory-a");
    }
  });

  test("a record for another Ticket is malformed, never a valid claim for this one", () => {
    const other = jiraTicket({ site: BETA, stableId: "10001", key: "OPS-1" });
    const parsed = parseClaim(
      claimRecord({
        factory: "factory-b",
        nonce: "n",
        ticket: other,
        account: "a",
        destination: DEST_A,
        createdAt: "2026-10-24T12:00:00.000Z",
      }),
      expected,
    );
    assert.equal(parsed.kind, "malformed");
    if (parsed.kind === "malformed") assert.match(parsed.reason, /names jira:beta/);
  });

  test("an unknown protocol, a missing field and a non-object are malformed", () => {
    assert.equal(parseClaim({ ...record(), protocol: "other/v1" }, expected).kind, "malformed");
    const missing: Record<string, unknown> = { ...record() };
    delete missing["factory"];
    assert.equal(parseClaim(missing, expected).kind, "malformed");
    assert.equal(parseClaim("a string", expected).kind, "malformed");
    assert.equal(parseClaim(null, expected).kind, "malformed");
  });

  test("the Destination is audit data: a claim from another Destination still names the same Ticket", () => {
    const fromA = record({ destination: `github:github.com:Sanmoo/repo-a` });
    const fromB = record({ destination: `github:github.com:Sanmoo/repo-b` });
    const parsedA = parseClaim(fromA, expected);
    const parsedB = parseClaim(fromB, expected);
    assert.equal(parsedA.kind, "valid");
    assert.equal(parsedB.kind, "valid");
    assert.equal(parsedA.kind === "valid" && parsedA.record.ticket, parsedB.kind === "valid" && parsedB.record.ticket);
  });

  test("the record is a plain JSON value and survives a JSON round trip", () => {
    const json = record();
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});
