import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WORK_OPERATIONS, type LocalWorkFacts, type WorkOperation } from "../git/port.js";
import type { RepairReason, RequiredCheckResult } from "../tracker/port.js";

/**
 * The durable repair cycle of a work (issue 107, extended by 112): how many
 * automatic repair rounds were DELIVERED since the last confirmed recovery,
 * which evidence was already consumed, how many repair attempts ended without
 * publishing, and the structured facts of the attempt currently on disk. It
 * lives next to the other artifacts of the work
 * (trabalhos/<repo>#<n>/reparo.json), so a sweep or a factory restart reads
 * the same budget instead of renewing it or repeating a consumed round.
 *
 * The two ledgers are independent (issue 112): the ROUND budget counts
 * published rounds (a fall before publishing is refunded, never a free retry
 * forever) and the FALL ledger counts consecutive unpublished attempts (two
 * block the work even with the PR open). The attempt facts are what make
 * publication attributable: the remote head observed before the intervention,
 * the evidence it addressed, and the commit the attempt produced on disk.
 *
 * The VERDICTS on a round (open, confirm, settle) live in repair/round.ts
 * (issue #186): this module keeps the ledger, its budget and the schema, so the
 * policy has one home and the persistence another.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const REPAIR_FILENAME = "reparo.json";

/** The joint cap: conflicts and CI failures share the same two rounds. */
export const MAX_REPAIR_ROUNDS = 2;

/** Separate from the round budget on purpose: returning an undelivered round
 *  must never authorize an unbounded number of retries. */
export const MAX_REPAIR_FALLS = 2;

/**
 * The publication verdict of one attempt, as structured facts alone can say it:
 * `published` (the remote carries the commit the attempt produced),
 * `not-published` (nothing of the attempt reached the remote — the remote is
 * still where it was, holds no such branch, or moved while the round's premise
 * was already gone), `concurrent-change` (the remote moved to something the
 * attempt did not produce while the impediment stood) and the two honest
 * uncertainties (`unknown` before the first reconciliation, `pending` while the
 * remote, the local work or the premise cannot be read). Whether the end counts
 * as a fall is the FALL LEDGER's business, never this verdict's.
 */
export type RepairPublication =
  | "unknown"
  | "pending"
  | "published"
  | "not-published"
  | "concurrent-change";

/** Every verdict, so a persisted one can be validated on read. */
const REPAIR_PUBLICATIONS: readonly RepairPublication[] = [
  "unknown",
  "pending",
  "published",
  "not-published",
  "concurrent-change",
];

/**
 * The renewed reading of the premise that opened a repair round (issue 149),
 * re-derived from the PR's current facts before the round spends work and
 * before the factory asks for help. `obsolete` means no confirmed impediment
 * remains — the PR is mergeable and the required set is KNOWN (the empty set
 * of a repository without CI is known); `persisting` means a confirmed
 * impediment is still there; `unknown` is an unreadable fact, and it is never
 * a licence to conclude either way.
 */
export type RepairPremise = "obsolete" | "persisting" | "unknown";
/** The attempt a repair round put on disk, enough to attribute its publication
 *  later — after a death that wrote no outcome record. */
export interface RepairAttempt {
  /** The evidence signature this attempt addresses — the round's ticket. */
  evidence: string;
  /** The registry attempt number that carried the round (the desfecho numbering). */
  attempt: number;
  /** The remote head observed before the intervention — the lease value. */
  observedHeadSha: string;
  /** The head the remote held when the attempt was settled. */
  remoteHeadSha: string | null;
  publication: RepairPublication;
  /** The work branch as the host last saw it; null when it could not be read. */
  localWork: LocalWorkFacts | null;
}

export interface RepairCycle {
  /** Delivered rounds since the last confirmed recovery (0, 1 or 2). */
  usedRounds: number;
  /** The evidence signature of the last launched round, so re-finding the
   *  same failure without new evidence never opens another session. */
  lastEvidence: string | null;
  /** Repair attempts in a row that ended without publishing (issue 112). */
  consecutiveFalls: number;
  /** The current (or last) attempt of the cycle; null for a legacy file. */
  attempt: RepairAttempt | null;
}

/** The initial budget — exported so every reset writes the same shape. */
export const EMPTY_REPAIR_CYCLE: RepairCycle = {
  usedRounds: 0,
  lastEvidence: null,
  consecutiveFalls: 0,
  attempt: null,
};

/**
 * Read the cycle; an absent or corrupt file is the honest initial state. A
 * file written before issue 112 carries only usedRounds/lastEvidence: it is
 * read as it stands — no attempt, no falls, and nothing renewed or deleted
 * silently because the older shape lacks the newer facts.
 */
export async function readRepairCycle(workDir: string): Promise<RepairCycle> {
  try {
    const raw = await readFile(join(workDir, REPAIR_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...EMPTY_REPAIR_CYCLE };
    const record = parsed as Record<string, unknown>;
    const usedRounds = typeof record["usedRounds"] === "number" ? record["usedRounds"] : 0;
    const lastEvidence = typeof record["lastEvidence"] === "string" ? record["lastEvidence"] : null;
    const consecutiveFalls =
      typeof record["consecutiveFalls"] === "number" ? record["consecutiveFalls"] : 0;
    return {
      usedRounds: Math.max(0, Math.floor(usedRounds)),
      lastEvidence,
      consecutiveFalls: Math.max(0, Math.floor(consecutiveFalls)),
      attempt: readAttempt(record["attempt"]),
    };
  } catch {
    return { ...EMPTY_REPAIR_CYCLE };
  }
}

/** The attempt record of a reparo.json file; anything unrecognizable is null. */
function readAttempt(value: unknown): RepairAttempt | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const evidence = record["evidence"];
  const attempt = record["attempt"];
  const observedHeadSha = record["observedHeadSha"];
  const publication = record["publication"];
  if (typeof evidence !== "string" || typeof attempt !== "number") return null;
  if (typeof observedHeadSha !== "string" || typeof publication !== "string") return null;
  if (!isPublication(publication)) return null;
  const remoteHeadSha = record["remoteHeadSha"];
  return {
    evidence,
    attempt: Math.max(1, Math.floor(attempt)),
    observedHeadSha,
    remoteHeadSha: typeof remoteHeadSha === "string" ? remoteHeadSha : null,
    publication,
    localWork: readLocalWork(record["localWork"]),
  };
}

function isPublication(value: string): value is RepairPublication {
  return REPAIR_PUBLICATIONS.includes(value as RepairPublication);
}

/** True when the attempt's publication is a terminal verdict — a settlement
 *  that must never be repeated (no double charge, refund or fall count). */
export function isSettledPublication(publication: RepairPublication): boolean {
  return (
    publication === "published" ||
    publication === "not-published" ||
    publication === "concurrent-change"
  );
}

/** True while the attempt's publication is unknown or pending: no worker of
 *  any kind may start and no budget may return until a sweep settles it. */
export function hasPendingReconciliation(attempt: RepairAttempt): boolean {
  return !isSettledPublication(attempt.publication);
}

/** A record written by another version may carry fewer facts: an unreadable
 *  local state is null (unverified), never an invented clean branch. */
function readLocalWork(value: unknown): LocalWorkFacts | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const headSha = record["headSha"];
  const commits = record["commits"];
  const uncommitted = record["uncommitted"];
  const operation = record["operationInProgress"];
  if (headSha !== null && typeof headSha !== "string") return null;
  if (typeof commits !== "number" || typeof uncommitted !== "boolean") return null;
  if (operation !== null && !WORK_OPERATIONS.includes(operation as WorkOperation)) return null;
  return {
    headSha,
    commits: Math.max(0, Math.floor(commits)),
    uncommitted,
    operationInProgress: operation as LocalWorkFacts["operationInProgress"],
  };
}

/** Persist the cycle before a round launches — the budget survives a death. */
export async function writeRepairCycle(workDir: string, cycle: RepairCycle): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, REPAIR_FILENAME), `${JSON.stringify(cycle, null, 2)}\n`, "utf8");
}

/**
 * Charge one automatic repair round before its session: the budget, the consumed
 * evidence and the attempt's own facts persist on disk, so a restart neither
 * renews the cap nor repeats the same round, and a death is attributable once
 * the remote answers (issue 112). The verdict that opened the round is the
 * Repair module's; the ledger write is this module's.
 */
export async function chargeRepairRound(
  workDir: string,
  input: {
    /** The consumed-evidence signature the round addresses. */
    signature: string;
    /** The registry attempt number carrying the round. */
    attempt: number;
    /** The head the facts were read on — the lease value. */
    observedHeadSha: string;
    localWork: LocalWorkFacts | null;
  },
): Promise<void> {
  const cycle = await readRepairCycle(workDir);
  await writeRepairCycle(workDir, {
    usedRounds: cycle.usedRounds + 1,
    lastEvidence: input.signature,
    consecutiveFalls: cycle.consecutiveFalls,
    attempt: {
      evidence: input.signature,
      attempt: input.attempt,
      observedHeadSha: input.observedHeadSha,
      remoteHeadSha: null,
      publication: "unknown",
      localWork: input.localWork,
    },
  });
}

/** The evidence that makes a trigger new: the Work it belongs to, the head it
 *  concerns and the exact failing checks. A different head, or a different
 *  failing check on the same head, is new evidence; the same failure is
 *  consumed. The first component is the registry Work key, so two Works of one
 *  repository never share a consumed signature. */
export function repairEvidenceSignature(input: {
  /** The registry key of the Work ("<repo>#<n>" for GitHub, the encoded Work key otherwise). */
  workKey: string;
  headSha: string;
  reasons: readonly RepairReason[];
  failingChecks: readonly RequiredCheckResult[];
}): string {
  const checks = input.failingChecks
    .map((check) => `${check.name}:${check.conclusion ?? "unknown"}`)
    .sort()
    .join(",");
  return [
    input.workKey,
    input.headSha,
    input.reasons.includes("conflicts") ? "conflicts" : "no-conflicts",
    checks,
  ].join("|");
}

/**
 * The observed head a signature was built on: component 2 of the signature
 * (Work key | headSha | reasons | checks). Legacy reparo.json files carry only
 * the signature, so this is how the incident's state is reconciled without
 * metadata that did not exist when it was written. Null for a signature of an
 * unknown shape — never a guessed SHA.
 */
export function observedHeadShaOfSignature(signature: string): string | null {
  const parts = signature.split("|");
  if (parts.length < 2) return null;
  const headSha = parts[1] ?? "";
  return headSha === "" ? null : headSha;
}

/** What the remote says right now: a SHA, "no such branch" (null), or that it
 *  could not be asked — the third case is uncertainty, never absence. */
export type RemoteObservation = { known: true; headSha: string | null } | { known: false };

/**
 * The attempt a legacy cycle implies (issue 112): a budget that was charged
 * and a registry attempt AFTER the last recorded outcome means a repair round
 * ran and fell before writing its own record. Its observed head comes from the
 * signature; its local work from the host. Nothing is charged or refunded
 * here — the reconciliation decides with the remote in hand.
 */
export function legacyRepairAttempt(input: {
  cycle: RepairCycle;
  lastAttempt: number;
  recordedAttempt: number | null;
}): RepairAttempt | null {
  const { cycle } = input;
  if (cycle.attempt !== null) return null;
  if (cycle.usedRounds === 0 || cycle.lastEvidence === null) return null;
  const headSha = observedHeadShaOfSignature(cycle.lastEvidence);
  if (headSha === null) return null;
  if (input.lastAttempt <= (input.recordedAttempt ?? 0)) return null;
  return {
    evidence: cycle.lastEvidence,
    attempt: input.lastAttempt,
    observedHeadSha: headSha,
    remoteHeadSha: null,
    publication: "unknown",
    localWork: null,
  };
}

/** True when the cycle carries an attempt on disk — the status and the
 *  reconciliation agree on what "this work ran a repair round" means. */
export function hasRepairCycle(cycle: RepairCycle): boolean {
  return cycle.attempt !== null || cycle.usedRounds > 0 || cycle.consecutiveFalls > 0;
}
