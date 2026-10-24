/**
 * The identities the protocol exchanges through the tracker (issue #168).
 *
 * A Ticket identity is provider + site + the provider's stable id (+ repo for
 * GitHub). The Destination is NOT part of it: two factories configured with
 * different Destinations still dispute the same Ticket. A factory id is the
 * installation's operator-assigned identity; it is not the Acting account,
 * because the same account may act for several factories.
 *
 * The module also owns the Claim record's wire format: the identity it carries
 * and the one-comment encoding travel together, so a reader cannot parse one
 * without the other.
 */

export const CLAIM_MARKER = "<!-- msf:claim -->";

/** The existing Claim mark; the protocol keeps it as presentation so the
 *  pool derivation and older installations still see the Ticket reserved. It
 *  is never the proof of authority: it carries no owner. */
export const PADLOCK_LABEL = "agent-claimed";

/** The label prefix a unique-label candidate uses. */
export const CLAIM_LABEL_PREFIX = "msf-claim-";

export interface TicketIdentity {
  readonly provider: "github";
  readonly site: string;
  readonly repo: string;
  readonly number: number;
}

export function ticketKey(ticket: TicketIdentity): string {
  return `${ticket.provider}:${ticket.site}:${ticket.repo}#${ticket.number}`;
}

export function sameTicket(left: TicketIdentity, right: TicketIdentity): boolean {
  return ticketKey(left) === ticketKey(right);
}

export interface ClaimRecord {
  /** Operator-assigned installation identity; unique among participants. */
  readonly factoryId: string;
  /** Unique id of this acquisition write. It distinguishes the retry of an
   *  uncertain write from a new claim, without being a lease. */
  readonly nonce: string;
  readonly ticket: TicketIdentity;
}

/** One issue comment carries the whole claim record: the smallest write the
 *  protocol needs. */
export function formatClaim(record: ClaimRecord): string {
  return [
    CLAIM_MARKER,
    `factory: ${record.factoryId}`,
    `claim: ${record.nonce}`,
    `ticket: ${ticketKey(record.ticket)}`,
    "",
  ].join("\n");
}

export type ClaimParse =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly record: ClaimRecord }
  | { readonly kind: "malformed"; readonly reason: string };

const TICKET_PATTERN = /^([^:\s]+):([^:\s]+):([^#\s]+)#(\d+)$/;

/**
 * A marked comment either parses completely or is a partial claim. A marker
 * with missing fields, a ticket it does not describe, or duplicate fields is
 * never "no claim": the reader cannot tell whether a winner wrote it.
 */
export function parseClaim(body: string): ClaimParse {
  const lines = body.split("\n").map((line) => line.trim());
  const marker = lines.findIndex((line) => line === CLAIM_MARKER);
  if (marker < 0) return { kind: "none" };

  const fields = new Map<string, string>();
  for (const line of lines.slice(marker + 1)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return { kind: "malformed", reason: `unreadable claim line: ${line}` };
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name !== "factory" && name !== "claim" && name !== "ticket") {
      return { kind: "malformed", reason: `unknown claim field: ${name}` };
    }
    if (fields.has(name)) {
      return { kind: "malformed", reason: `duplicate claim field: ${name}` };
    }
    if (value.length === 0) {
      return { kind: "malformed", reason: `empty claim field: ${name}` };
    }
    fields.set(name, value);
  }

  const factoryId = fields.get("factory");
  const nonce = fields.get("claim");
  const ticketText = fields.get("ticket");
  if (factoryId === undefined || nonce === undefined || ticketText === undefined) {
    return { kind: "malformed", reason: "incomplete claim record" };
  }

  const match = TICKET_PATTERN.exec(ticketText);
  if (match === null) {
    return { kind: "malformed", reason: `unreadable ticket identity: ${ticketText}` };
  }
  const [, provider, site, repo, number] = match;
  if (provider !== "github" || site === undefined || repo === undefined || number === undefined) {
    return { kind: "malformed", reason: `unsupported ticket identity: ${ticketText}` };
  }

  return {
    kind: "valid",
    record: {
      factoryId,
      nonce,
      ticket: { provider: "github", site, repo, number: Number(number) },
    },
  };
}
