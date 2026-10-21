import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readActivityStamp, type ActivityDirs } from "../runtime/activity.js";
import { EVENT_LOG_PATTERN, SANDCASTLE_LOG_PATTERN } from "../runtime/attempt-logs.js";
import type { LiveWorker } from "../state/liveness.js";

/**
 * The survivor ledger of the operational cycle (issue 118): the workers a
 * reliable liveness probe shows but THIS process did not launch — the workers
 * that outlived a factory death. Recognition is observation only: nothing is
 * relaunched, attached to, killed or given a new attempt while a survivor
 * lives. The ledger is process-local on purpose; a restart re-reads the same
 * facts from Docker, and a work whose exit is confirmed is reconciled from
 * disk + tracker by the ordinary ruler.
 *
 * The verifiable-activity observation is the one the runtime already uses
 * (runtime/activity.ts): what the agents write counts, the factory's own logs
 * never do. For a survivor the limit only WARNS — the factory ends nothing it
 * did not launch.
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

/**
 * The dirs whose files prove a surviving worker is working: its session dir
 * and the work dir, minus the factory's own derived logs (the attempt's event
 * log and Sandcastle's stdout log) — those only echo the agent and would turn
 * any line the factory writes into false proof of life.
 */
async function survivorActivityDirs(dir: string): Promise<ActivityDirs> {
  const sessions = join(dir, "sessao");
  const [workNames, sessionNames] = await Promise.all([namesOf(dir), namesOf(sessions)]);
  const exclude = [
    ...workNames.filter((name) => EVENT_LOG_PATTERN.test(name)).map((name) => join(dir, name)),
    ...sessionNames
      .filter((name) => SANDCASTLE_LOG_PATTERN.test(name))
      .map((name) => join(sessions, name)),
  ];
  return { dirs: [sessions, dir], exclude };
}

/** The entries of a dir; one that cannot be read proves no activity. */
async function namesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** One observation of a survivor's verifiable activity. */
export async function observeSurvivorActivity(
  record: SurvivorRecord,
  now: number,
): Promise<SurvivorRecord> {
  const stamp = await readActivityStamp(await survivorActivityDirs(record.dir));
  // The first observation is the baseline: the artifacts a previous attempt
  // left are not this worker's activity.
  if (record.activityStamp === null) {
    return { ...record, activityStamp: stamp, lastActivityAt: now };
  }
  if (stamp === record.activityStamp) return record;
  return { ...record, activityStamp: stamp, lastActivityAt: now };
}
