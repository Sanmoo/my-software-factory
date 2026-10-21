import { join } from "node:path";

import { readActivityStamp, workActivityDirs } from "../runtime/activity.js";
import {
  occupiedSlots,
  type DuplicateWorkers,
  type LiveWorker,
} from "../state/liveness.js";

/**
 * The survivor ledger and policy of the operational cycle (issue 118): the
 * workers a reliable liveness probe shows but THIS process did not launch —
 * the workers that outlived a factory death. Recognition is observation only:
 * nothing is relaunched, attached to, killed or given a new attempt while a
 * survivor lives. The ledger is process-local on purpose; a restart re-reads
 * the same facts from Docker, and a work whose exit is confirmed is reconciled
 * from disk + tracker by the ordinary ruler.
 *
 * The decisions the cycle asks for live HERE, pure: which silence is owed a
 * warning, how many slots a live workforce exceeds, which duplicates are new.
 * The loop only logs and delivers what they return.
 *
 * The activity observation is the runtime's own (runtime/activity.ts): what
 * the agents write counts, the factory's derived logs never do. For a survivor
 * the limit only WARNS — the factory ends nothing it did not launch.
 */

/** One surviving worker as the cycle tracks it. */
export interface SurvivorRecord {
  key: string;
  /** The work's registry dir, where its attempt evidence and logs live. */
  dir: string;
  /** The activity stamp of the previous observation (null = baseline pending). */
  activityStamp: string | null;
  /** When verifiable activity was last seen (the cycle's clock). */
  lastActivityAt: number;
  /** The idle warning was already raised for this survivor. */
  idleWarned: boolean;
}

/** The works carried by a container this process did not launch. */
export function survivorWorkKeys(
  workers: readonly LiveWorker[],
  localWorkKeys: ReadonlySet<string>,
): string[] {
  return [...new Set(workers.map((worker) => worker.key))]
    .filter((key) => !localWorkKeys.has(key))
    .sort((a, b) => a.localeCompare(b));
}

/** One observation of a survivor's verifiable activity. */
export async function observeSurvivorActivity(
  record: SurvivorRecord,
  now: number,
): Promise<SurvivorRecord> {
  const stamp = await readActivityStamp(
    await workActivityDirs(record.dir, join(record.dir, "sessao")),
  );
  // The first observation is the baseline: the artifacts a previous attempt
  // left are not this worker's activity.
  if (record.activityStamp === null) {
    return { ...record, activityStamp: stamp, lastActivityAt: now };
  }
  if (stamp === record.activityStamp) return record;
  return { ...record, activityStamp: stamp, lastActivityAt: now };
}

/** The silence a survivor is owed a warning for — null while it is still
 *  working, or once the warning of this life was already raised. */
export function idleWarningDue(
  record: SurvivorRecord,
  now: number,
  idleLimitMs: number,
): number | null {
  if (record.idleWarned) return null;
  const idleMs = now - record.lastActivityAt;
  return idleMs >= idleLimitMs ? idleMs : null;
}

/** How many slots the live workforce exceeds the configured concurrency by
 *  (0 = within the limit): distinct containers, a local launch Docker already
 *  shows counted once. */
export function capacityExcess(
  workers: readonly LiveWorker[],
  localWorkKeys: ReadonlySet<string>,
  concurrency: number,
): number {
  return Math.max(0, occupiedSlots(workers, localWorkKeys) - concurrency);
}

/** The duplicates not announced yet — every appearance is said once. */
export function newDuplicates(
  announced: ReadonlySet<string>,
  duplicates: readonly DuplicateWorkers[],
): DuplicateWorkers[] {
  return duplicates.filter((duplicate) => !announced.has(duplicate.key));
}
