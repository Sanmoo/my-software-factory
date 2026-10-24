import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WORK_OPERATIONS, type LocalWorkFacts, type WorkOperation } from "../git/port.js";
import { WorkRecordError } from "./errors.js";

/**
 * The Repair part of a Work's record (issue 107, extended by 112): the
 * persisted round/fall budget and the attempt currently on disk — the remote
 * head observed before the intervention, the evidence it addressed and the
 * commit it produced. The RECONCILIATION that settles the attempt and the
 * budget rules that decide a round stay with the domain module
 * (pool/repair.ts); the file, its schema and the write that refuses an
 * unattributable attempt live here.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const REPAIR_FILENAME = "reparo.json";

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

/**
 * Persist the cycle before a round launches — the budget survives a death. An
 * attempt on disk must name the evidence it addresses and the head it observed:
 * a publication cannot be attributed to a round whose premise is anonymous.
 */
export async function writeRepairCycle(workDir: string, cycle: RepairCycle): Promise<void> {
  assertAttemptIsAttributable(cycle);
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, REPAIR_FILENAME), `${JSON.stringify(cycle, null, 2)}\n`, "utf8");
}

function assertAttemptIsAttributable(cycle: RepairCycle): void {
  if (!Number.isInteger(cycle.usedRounds) || cycle.usedRounds < 0) {
    throw new WorkRecordError(`the repair cycle's used rounds must be a non-negative integer, got ${String(cycle.usedRounds)}`);
  }
  if (!Number.isInteger(cycle.consecutiveFalls) || cycle.consecutiveFalls < 0) {
    throw new WorkRecordError(
      `the repair cycle's consecutive falls must be a non-negative integer, got ${String(cycle.consecutiveFalls)}`,
    );
  }
  const attempt = cycle.attempt;
  if (attempt === null) return;
  if (typeof attempt.evidence !== "string" || attempt.evidence === "") {
    throw new WorkRecordError("a repair attempt must name the evidence it addresses");
  }
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
    throw new WorkRecordError(`a repair attempt must name its attempt, got ${String(attempt.attempt)}`);
  }
  if (typeof attempt.observedHeadSha !== "string" || attempt.observedHeadSha === "") {
    throw new WorkRecordError("a repair attempt must name the head it observed before the intervention");
  }
  if (!isPublication(attempt.publication)) {
    throw new WorkRecordError(`unknown repair publication ${String(attempt.publication)}`);
  }
  if (attempt.localWork !== null && readLocalWork(attempt.localWork) === null) {
    throw new WorkRecordError("a repair attempt's local work must be the readable facts it recorded");
  }
}
