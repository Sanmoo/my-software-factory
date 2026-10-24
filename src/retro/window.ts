import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeClass } from "../state/outcome.js";
import { readAttemptLedger, scanRegistry } from "../pool/registry.js";
import { anchorOfKey } from "../pool/work-key.js";
import { scanReservations } from "../pool/reservation.js";
import { readRepairCycle } from "../pool/repair.js";
import { readRecoveryLedger } from "../pool/recovery.js";
import { readModelProviderLedger } from "../pool/model-provider.js";
import {
  RETRO_MOUNT_PATHS,
  type WorkspaceLayout,
} from "../layout.js";
import { OPERATIONAL_LOG_FILENAME } from "../log.js";

/**
 * The retrospective window (issue 141): the finished works a round analyzes —
 * delivered, cancelled and blocked alike, anything with attempt history and no
 * live worker. Works whose current attempt has no outcome record of its own
 * (pending reconciliation) are deferred, never analyzed as if they had ended.
 *
 * Finish time is the outcome record's own mtime: it orders the window and it
 * is the boundary the report marker advances.
 */

export const RETRO_REPORT_SUFFIX = "-retro.md";
export const RETRO_RESULT_SUFFIX = "-resultado.json";

/** The first round has no marker: it covers the last ten works, not one. */
export const FIRST_WINDOW_SIZE = 10;

/** One finished work, as the window and the launch request carry it. */
export interface FinishedWork {
  /** The registry key (the name of the work's dir) — the report's identity. */
  key: string;
  /** The destination repository the work changed: "owner/name". */
  repo: string;
  /** Absolute dir of the work's artifacts (transcripts, logs, outcome record). */
  dir: string;
  /** The dir as the round's container sees it (a mounted read-only path). */
  evidencePath: string;
  archived: boolean;
  outcome: OutcomeClass;
  attempt: number;
  /** Epoch milliseconds of the outcome record — the finish time. */
  completedAt: number;
}

/** The round id in the report's file name: an ISO instant, filename-safe and
 *  millisecond-precise, so two rounds can never overwrite each other's report. */
export function roundId(at: Date): string {
  return at.toISOString().replace(/[:.]/g, "-");
}

export function reportFileName(round: string): string {
  return `${round}${RETRO_REPORT_SUFFIX}`;
}

export function resultFileName(round: string): string {
  return `${round}${RETRO_RESULT_SUFFIX}`;
}

/**
 * Every finished work of the workspace, oldest first: the archived dones plus
 * the works still under trabalhos/ whose current attempt settled (a blocked
 * work is never archived). An attempt without its own outcome record is
 * pending reconciliation and stays out; a work a live container carries is
 * excluded by the caller's live keys.
 */
export async function collectFinishedWorks(
  layout: WorkspaceLayout,
  liveKeys: ReadonlySet<string> = new Set(),
): Promise<FinishedWork[]> {
  const finished: FinishedWork[] = [];
  const seen = new Set<string>();

  for (const dir of (await scanRegistry(layout)).archived) {
    const key = archivedKey(layout.archive, dir);
    if (key === null || liveKeys.has(key)) continue;
    seen.add(key);
    const entry = await finishedEntry(layout, key, dir, true);
    if (entry !== null) finished.push(entry);
  }

  for (const reservation of await scanReservations(layout)) {
    if (seen.has(reservation.key) || liveKeys.has(reservation.key)) continue;
    const entry = await finishedEntry(layout, reservation.key, reservation.dir, false);
    if (entry !== null) finished.push(entry);
  }

  return finished.sort((a, b) => a.completedAt - b.completedAt || a.key.localeCompare(b.key));
}

/** The registry key an archived dir names: `<archive>/<key>-<date>[-<suffix>]`. */
export function archivedKey(archiveRoot: string, dir: string): string | null {
  const key = relative(archiveRoot, dir)
    .split(sep)
    .join("/")
    .replace(/-\d{4}-\d{2}-\d{2}(?:-\d+)?$/, "");
  // A key that anchors no Work of this factory is not a report subject: the
  // round could not route its items.
  return anchorOfKey(key) === null ? null : key;
}

/** One finished work, or null while its current attempt has no own record. */
async function finishedEntry(
  layout: WorkspaceLayout,
  key: string,
  dir: string,
  archived: boolean,
): Promise<FinishedWork | null> {
  const [{ lastAttempt }, record] = await Promise.all([readAttemptLedger(dir), readOutcomeRecord(dir)]);
  if (record === null || lastAttempt === 0 || record.attempt !== lastAttempt) return null;
  const repo = anchorOfKey(key)?.repo;
  if (repo === undefined) return null;
  return {
    key,
    repo,
    dir,
    evidencePath: `${archived ? RETRO_MOUNT_PATHS.archive : RETRO_MOUNT_PATHS.works}/${relative(
      archived ? layout.archive : layout.works,
      dir,
    )
      .split(sep)
      .join("/")}`,
    archived,
    outcome: record.class,
    attempt: record.attempt,
    completedAt: await completedAtOf(dir),
  };
}

/** The outcome record's mtime is the work's finish time; the dir is the fallback. */
async function completedAtOf(dir: string): Promise<number> {
  try {
    return (await stat(`${dir}/${DESFECHO_FILENAME}`)).mtimeMs;
  } catch {
    try {
      return (await stat(dir)).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/**
 * The factual summary the synthesis opens with (issue 141): counts from the
 * window's records and ledgers plus what the factory's own operational log
 * says about these works — numbers, never impressions. The agent verifies it
 * against the evidence and corrects it in the report if they disagree.
 */
export async function renderWindowSummary(
  layout: WorkspaceLayout,
  works: readonly FinishedWork[],
): Promise<string> {
  const outcomes = new Map<OutcomeClass, number>();
  const repos = new Set<string>();
  let attempts = 0;
  let repairRounds = 0;
  let repairFalls = 0;
  let recoveries = 0;
  let modelProviderRetries = 0;
  for (const work of works) {
    outcomes.set(work.outcome, (outcomes.get(work.outcome) ?? 0) + 1);
    repos.add(work.repo);
    attempts += work.attempt;
    const [repair, recovery, modelProvider] = await Promise.all([
      readRepairCycle(work.dir),
      readRecoveryLedger(work.dir),
      readModelProviderLedger(work.dir),
    ]);
    repairRounds += repair.usedRounds;
    repairFalls += repair.consecutiveFalls;
    recoveries += recovery.consumed;
    modelProviderRetries += modelProvider.consumed;
  }

  const count = (outcome: OutcomeClass): number => outcomes.get(outcome) ?? 0;
  return [
    `Window: ${works.length} finished work(s) from ${repos.size} repo(s) — ` +
      `delivered ${count("pr-open")}, clean-without-pr ${count("clean-without-pr")}, ` +
      `blocked ${count("blocked-self-report")}.`,
    `Operational facts: ${attempts} attempt(s) across the window; ${repairRounds} automatic repair round(s) ` +
      `(${repairFalls} ended without publishing); ${recoveries} interruption recoveries; ` +
      `${modelProviderRetries} model provider retries.`,
    await operationalLogFacts(layout, works),
  ].join("\n");
}

/** How often the factory's own log spoke of these works — the factory-axis
 *  anchor, read from the persisted operational log when it exists. */
async function operationalLogFacts(
  layout: WorkspaceLayout,
  works: readonly FinishedWork[],
): Promise<string> {
  let raw: string;
  try {
    // The tail is enough for the anchor and bounds the read of a long-lived log.
    raw = (await readFile(`${layout.root}/${OPERATIONAL_LOG_FILENAME}`, "utf8")).slice(-1_000_000);
  } catch {
    return "Operational log: absent — the window's records are the only evidence of this round.";
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const keys = works.map((work) => work.key);
  const mentions = lines.filter((line) => keys.some((key) => line.includes(key)));
  const last = mentions.at(-1);
  return (
    `Operational log: ${mentions.length} line(s) mention the window's works of ${lines.length} recorded ` +
    `line(s)` +
    (last === undefined ? "." : `; the last one: "${last.slice(0, 300)}".`)
  );
}
