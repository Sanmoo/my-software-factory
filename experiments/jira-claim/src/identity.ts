/**
 * Ticket identity and the Claim record the Jira protocol writes.
 *
 * The factory's production identity rules (src/tracker/identity.ts) are the
 * reference: provider + site + the provider's stable id. The readable key
 * ("OPS-1") is presentation only — it is repeated across sites and can change
 * on a Jira move. The Claim record below therefore carries the stable identity,
 * never the presentation key, and the same record format is parsed by every
 * participant.
 */

import type { JsonValue } from "./json.js";

export const CLAIM_PROTOCOL = "msf-jira-claim/v1" as const;

export const CLAIM_PROPERTY_KEY = "com.sanmoo.msf.claim" as const;

export const CLAIMED_LABEL = "agent-claimed" as const;

export interface JiraTicket {
  provider: "jira";
  /** The Jira Cloud site host — identity is scoped by site, never by key. */
  site: string;
  /** Jira's immutable issue id, as text. */
  stableId: string;
  /** Human-readable key ("OPS-1"): presentation only. */
  key: string;
}

export interface Destination {
  provider: "github";
  site: string;
  repo: string;
}

export function jiraTicket(input: { site: string; stableId: string; key: string }): JiraTicket {
  return { provider: "jira", site: input.site, stableId: input.stableId, key: input.key };
}

/** The comparison key of a Ticket: provider + site + stable id, no presentation. */
export function ticketIdentityKey(ticket: JiraTicket): string {
  return `jira:${ticket.site}:${ticket.stableId}`;
}

/** The operator-facing name: readable key scoped by the site it came from. */
export function renderTicket(ticket: JiraTicket): string {
  return `${ticket.key} (jira:${ticket.site})`;
}

export function githubDestination(input: { site: string; repo: string }): Destination {
  return { provider: "github", site: input.site, repo: input.repo };
}

export function destinationKey(destination: Destination): string {
  return `${destination.provider}:${destination.site}:${destination.repo}`;
}

/**
 * What one acquisition writes into the issue property.
 *
 * `factory`, `nonce` and `ticket` are the claim. `account`, `destination` and
 * `createdAt` are audit facts: the first authenticates the write but never
 * identifies the instance (accounts may be shared), the second must NOT make
 * the claim invisible to a factory configured with another Destination, and
 * the third must never become an expiry.
 */
export type ClaimRecord = {
  protocol: typeof CLAIM_PROTOCOL;
  factory: string;
  nonce: string;
  ticket: string;
  account: string;
  destination: string;
  createdAt: string;
};

export function claimRecord(input: {
  factory: string;
  nonce: string;
  ticket: JiraTicket;
  account: string;
  destination: Destination;
  createdAt: string;
}): ClaimRecord {
  return {
    protocol: CLAIM_PROTOCOL,
    factory: input.factory,
    nonce: input.nonce,
    ticket: ticketIdentityKey(input.ticket),
    account: input.account,
    destination: destinationKey(input.destination),
    createdAt: input.createdAt,
  };
}

export type ParsedClaim =
  | { kind: "valid"; record: ClaimRecord }
  | { kind: "malformed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Strict parse of the property value. A property on OUR key that is not a
 * recognizable claim is malformed — uncertainty, never "free": it may be an
 * older participant's mark, and the protocol never clears what it cannot read.
 */
export function parseClaim(value: unknown, expectedTicket: string): ParsedClaim {
  if (!isRecord(value)) return { kind: "malformed", reason: "the value is not a JSON object" };
  if (value["protocol"] !== CLAIM_PROTOCOL) {
    return { kind: "malformed", reason: `unknown protocol ${String(value["protocol"])}` };
  }
  const fields = [
    "factory",
    "nonce",
    "ticket",
    "account",
    "destination",
    "createdAt",
  ] as const satisfies readonly Exclude<keyof ClaimRecord, "protocol">[];
  const strings = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    const raw = value[field];
    if (!nonEmptyString(raw)) {
      return { kind: "malformed", reason: `missing or empty "${field}"` };
    }
    strings[field] = raw;
  }
  if (strings.ticket !== expectedTicket) {
    return { kind: "malformed", reason: `the record names ${strings.ticket}, not ${expectedTicket}` };
  }
  return { kind: "valid", record: { protocol: CLAIM_PROTOCOL, ...strings } };
}
