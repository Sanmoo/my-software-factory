import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RequiredCheckResult } from "../tracker/port.js";

/**
 * The durable repair cycle of a work (issue 107): how many consecutive
 * automatic repair rounds ran without recovering the open PR, and which
 * evidence was already consumed. It lives next to the other artifacts of the
 * work (trabalhos/<repo>#<n>/reparo.json), so a sweep or a factory restart
 * reads the same budget instead of renewing it or repeating a consumed round.
 *
 * Only two automatic rounds are granted; a confirmed recovery (no conflicts
 * and every required check approved) or a human unblock resets the count.
 * New commits or a partial fix never do.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const REPAIR_FILENAME = "reparo.json";

/** The joint cap: conflicts and CI failures share the same two rounds. */
export const MAX_REPAIR_ROUNDS = 2;

export interface RepairCycle {
  /** Rounds launched since the last confirmed recovery (0, 1 or 2). */
  failedRounds: number;
  /** The evidence signature of the last launched round, so re-finding the
   *  same failure without new evidence never opens another session. */
  lastEvidence: string | null;
}

const EMPTY_CYCLE: RepairCycle = { failedRounds: 0, lastEvidence: null };

/** Read the cycle; an absent or corrupt file is the honest initial state. */
export async function readRepairCycle(workDir: string): Promise<RepairCycle> {
  try {
    const raw = await readFile(join(workDir, REPAIR_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...EMPTY_CYCLE };
    const record = parsed as Record<string, unknown>;
    const failedRounds = typeof record["failedRounds"] === "number" ? record["failedRounds"] : 0;
    const lastEvidence = typeof record["lastEvidence"] === "string" ? record["lastEvidence"] : null;
    return { failedRounds: Math.max(0, Math.floor(failedRounds)), lastEvidence };
  } catch {
    return { ...EMPTY_CYCLE };
  }
}

/** Persist the cycle before a round launches — the budget survives a death. */
export async function writeRepairCycle(workDir: string, cycle: RepairCycle): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  await writeFile(join(workDir, REPAIR_FILENAME), `${JSON.stringify(cycle, null, 2)}\n`, "utf8");
}

/** The evidence that makes a trigger new: the head it concerns and the exact
 *  failing checks. A different head, or a different failing check on the same
 *  head, is new evidence; the same failure is consumed. */
export function repairEvidenceSignature(input: {
  ref: { repo: string; number: number };
  headSha: string;
  conflicting: boolean;
  failingChecks: readonly RequiredCheckResult[];
}): string {
  const checks = input.failingChecks
    .map((check) => `${check.name}:${check.conclusion ?? "unknown"}`)
    .sort()
    .join(",");
  return [
    `${input.ref.repo}#${input.ref.number}`,
    input.headSha,
    input.conflicting ? "conflicts" : "no-conflicts",
    checks,
  ].join("|");
}
