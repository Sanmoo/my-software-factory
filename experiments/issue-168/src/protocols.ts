/**
 * The minimum tracker-only candidates examined for issue #168. Each candidate
 * is expressed as the three phases a factory really has: what it reads before
 * writing, the blind writes it performs, and the decision it derives from the
 * verification read. The decision vocabulary is the one the spec requires:
 * confirmed exclusive authority, Ticket unavailable, or an uncertain result —
 * only the first may start a Worker.
 *
 * None of these classes carries coordination state. The only shared medium is
 * the tracker passed in by the caller.
 */

import {
  CLAIM_LABEL_PREFIX,
  PADLOCK_LABEL,
  formatClaim,
  parseClaim,
  sameTicket,
  type ClaimRecord,
  type TicketIdentity,
} from "./identity.js";
import type { IssueSnapshot, Mutation } from "./tracker.js";

export type Decision = "authorized" | "unavailable" | "uncertain";
export type ObservationDecision = "free" | "unavailable" | "uncertain";

export interface Observation {
  readonly decision: ObservationDecision;
  readonly reason: string;
}

export interface ProtocolInput {
  readonly ticket: TicketIdentity;
  readonly claim: ClaimRecord;
  readonly actingAccount: string;
  /** Presentation only: a different Destination never changes Ticket identity. */
  readonly destination: string;
}

export interface ClaimProtocol {
  readonly name: string;
  readonly summary: string;
  /** The pre-write read: is this Ticket free for this acquisition? */
  observe(snapshot: IssueSnapshot, input: ProtocolInput): Observation;
  /** The blind writes, in order. A caller may stop between any two of them. */
  writes(input: ProtocolInput): readonly Mutation[];
  /** The post-write verification read's decision. */
  decide(snapshot: IssueSnapshot, input: ProtocolInput): Decision;
}

interface SeenClaim {
  readonly record: ClaimRecord;
  readonly commentId: number;
}

interface ClaimView {
  readonly valid: readonly SeenClaim[];
  readonly malformed: number;
  readonly padlock: boolean;
}

/** Everything a candidate may learn from one snapshot about claims on THIS
 *  ticket. A marked comment for another ticket is malformed here: the reader
 *  cannot safely ignore a marker it does not understand. */
function claimView(snapshot: IssueSnapshot, ticket: TicketIdentity): ClaimView {
  const valid: SeenClaim[] = [];
  let malformed = 0;
  for (const comment of snapshot.comments) {
    const parsed = parseClaim(comment.body);
    if (parsed.kind === "none") continue;
    if (parsed.kind === "malformed") {
      malformed += 1;
      continue;
    }
    if (!sameTicket(parsed.record.ticket, ticket)) {
      malformed += 1;
      continue;
    }
    valid.push({ record: parsed.record, commentId: comment.id });
  }
  return { valid, malformed, padlock: snapshot.labels.includes(PADLOCK_LABEL) };
}

function ownClaim(view: ClaimView, input: ProtocolInput): SeenClaim | undefined {
  return view.valid.find(
    (seen) =>
      seen.record.nonce === input.claim.nonce && seen.record.factoryId === input.claim.factoryId,
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freeOrBlocked(snapshot: IssueSnapshot, input: ProtocolInput): Observation {
  const view = claimView(snapshot, input.ticket);
  if (view.malformed > 0) {
    return { decision: "uncertain", reason: "a claim marker could not be read completely" };
  }
  if (view.valid.length > 0) {
    return { decision: "unavailable", reason: "a claim record already reserves this ticket" };
  }
  if (view.padlock) {
    return { decision: "unavailable", reason: "the padlock is present without a readable claim" };
  }
  return { decision: "free", reason: "no claim on this ticket" };
}

function claimComment(input: ProtocolInput): Mutation {
  return { kind: "comment", author: input.actingAccount, body: formatClaim(input.claim) };
}

function padlock(): Mutation {
  return { kind: "add-label", label: PADLOCK_LABEL };
}

function assignment(input: ProtocolInput): Mutation {
  return { kind: "add-assignee", login: input.actingAccount };
}

function claimLabel(input: ProtocolInput): string {
  return `${CLAIM_LABEL_PREFIX}${input.claim.factoryId}`;
}

/** The labels C2/C3 write: the shared padlock first, then the factory's own. */
function uniqueLabelPlan(input: ProtocolInput): readonly Mutation[] {
  return [padlock(), { kind: "add-label", label: claimLabel(input) }, claimComment(input)];
}

/**
 * C1 — the current Claim, in protocol terms: the padlock label plus assignment
 * to the Acting account. The verification read only proves that the shared
 * mark exists and that this account is assigned — it never proves WHICH factory
 * wrote it.
 */
export const currentMark: ClaimProtocol = {
  name: "current-mark",
  summary: "padlock label + assignment to the Acting account, re-read for the same mark",
  observe: freeOrBlocked,
  writes(input) {
    return [padlock(), assignment(input)];
  },
  decide(snapshot, input) {
    const hasMark = snapshot.labels.includes(PADLOCK_LABEL);
    const assigned = snapshot.assignees.includes(input.actingAccount);
    return hasMark && assigned ? "authorized" : "uncertain";
  },
};

/**
 * C2 — a factory-unique label, and the verification read authorises only when
 * NO other claim is visible. It is safe against every read projection that
 * cannot hide an earlier claim behind a later one, but two simultaneous claims
 * both become invisible to each other's decision and the Ticket deadlocks with
 * no winner (nobody may clean the other claim).
 */
export const strictUnique: ClaimProtocol = {
  name: "strict-unique",
  summary: "factory-unique label; authorize only when no other claim is visible",
  observe: freeOrBlocked,
  writes: uniqueLabelPlan,
  decide(snapshot, input) {
    const view = claimView(snapshot, input.ticket);
    if (view.malformed > 0) return "uncertain";
    if (view.valid.length === 0) return "uncertain";
    if (ownClaim(view, input) === undefined) return "uncertain";
    return view.valid.length === 1 ? "authorized" : "unavailable";
  },
};

/**
 * C3 — factory-unique labels with a client-chosen tie-break: the smallest label
 * wins. The key is not assigned by the provider, so a factory that verifies
 * before a later writer can authorize a key the later writer supersedes.
 */
export const minLabel: ClaimProtocol = {
  name: "min-label",
  summary: "factory-unique label; the lexicographically smallest claim label wins",
  observe: freeOrBlocked,
  writes: uniqueLabelPlan,
  decide(snapshot, input) {
    const view = claimView(snapshot, input.ticket);
    if (view.malformed > 0) return "uncertain";
    const own = ownClaim(view, input);
    if (own === undefined) return "uncertain";
    const labels = view.valid
      .map((seen) => `${CLAIM_LABEL_PREFIX}${seen.record.factoryId}`)
      .sort(compareText);
    return labels[0] === claimLabel(input) ? "authorized" : "unavailable";
  },
};

/**
 * C4 — the conversation lock. Locking is a shared, ownerless state; the
 * verification read cannot tell who locked it.
 */
export const conversationLock: ClaimProtocol = {
  name: "conversation-lock",
  summary: "lock the conversation; re-read the lock and the writer's own comment",
  observe(snapshot, input) {
    if (snapshot.locked) return { decision: "unavailable", reason: "the conversation is locked" };
    return freeOrBlocked(snapshot, input);
  },
  writes(input) {
    return [{ kind: "lock" }, claimComment(input)];
  },
  decide(snapshot, input) {
    if (!snapshot.locked) return "uncertain";
    const view = claimView(snapshot, input.ticket);
    return ownClaim(view, input) === undefined ? "uncertain" : "authorized";
  },
};

/**
 * C5 — the Claim sequence. One marked comment carries the claim record; the
 * provider-assigned comment id orders the claims, and the smallest id wins.
 * The padlock lands first so every reader (including the current pool
 * derivation) sees the Ticket reserved even if the record is not visible yet.
 *
 * The padlock and the assignment to the Acting account land first, so the
 * result is a Claim in the glossary's sense (mark + assignment) and the pool
 * derivation keeps seeing the Ticket reserved; neither is authority. Safety
 * needs two facts GitHub does NOT document: (P1) ids are assigned in
 * the order the writes are applied, and (P2) no read shows a later claim while
 * hiding an earlier one (fresh reads, or at least prefix visibility). Without
 * P1 the later writer can hold the smaller id; without P2 a verifier can miss
 * a claim that was already applied. The harness demonstrates both failures.
 */
export const claimSequence: ClaimProtocol = {
  name: "claim-sequence",
  summary: "one marked comment; the provider-assigned comment id orders claims, smallest wins",
  observe: freeOrBlocked,
  writes(input) {
    return [padlock(), assignment(input), claimComment(input)];
  },
  decide(snapshot, input) {
    const view = claimView(snapshot, input.ticket);
    if (view.malformed > 0) return "uncertain";
    if (view.valid.length === 0) return "uncertain";
    const own = ownClaim(view, input);
    // A Claim is this acquisition's own only when its RECORD (factory id and
    // nonce) is the one this acquisition holds. A record left by the same
    // installation but a different acquisition — including a lost workspace —
    // is not proof: the operator decides, never an autonomous takeover.
    if (own === undefined) return "unavailable";
    const first = view.valid.reduce((left, right) =>
      left.commentId <= right.commentId ? left : right,
    );
    return first.commentId === own.commentId ? "authorized" : "unavailable";
  },
};

export const PROTOCOLS: readonly ClaimProtocol[] = [
  currentMark,
  strictUnique,
  minLabel,
  conversationLock,
  claimSequence,
];
