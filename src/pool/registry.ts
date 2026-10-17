import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { WORKSPACE_SUBPATHS, type WorkspaceLayout } from "../layout.js";
import { DESFECHO_FILENAME, readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";

/**
 * The registry (ticket 13): the reader of what survives a process death.
 * Slots are only in memory (pool/slots.ts); everything else about a work is
 * an artifact in real disk under <workspace>/trabalhos/<repo>#<n>/ —
 * desfecho.json (written by the runtime when it can; its absence is the
 * class "abrupt fall"), log-<n>.jsonl (the attempt's event log) and sessao/
 * (the session dir) — and the reconciliation of a restart is nothing but
 * reading them back here (ticket 05 Q3). Names on disk stay PT-BR.
 */

/** The facts a launch derives from the registry before a worker is born. */
export interface LaunchFacts {
  /** 1st, 2nd... attempt on the same branch (WorkRequest.attempt). */
  attempt: number;
  /** True when the previous attempt on this branch ended in a fall —
   * clean (recorded) or abrupt (evidence of an attempt without a record).
   * The ruler uses it for the 2-consecutive-falls → blocked transition; the
   * attempt numbers themselves cannot lie because desfecho.json + the
   * per-attempt logs are the previous attempt's own footprint. */
  previousFall: boolean;
}

/**
 * Read the launch facts of a work from its registry dir. A work that never
 * launched (no dir, no evidence) is attempt 1 with no prior fall; a recorded
 * previous attempt numbers the next one; a previous attempt with logs but no
 * record wrote nothing at its end — it abruptly fell.
 */
export async function readLaunchFacts(workDir: string): Promise<LaunchFacts> {
  if (!existsSync(workDir)) return { attempt: 1, previousFall: false };

  const record = await readOutcomeRecord(workDir);
  if (record) {
    const logs = await attemptNumbers(workDir);
    // A stale record: an attempt started (logs) after the last recorded one.
    // Its consecutiveness is still the record's — the extra attempt without
    // a record only exists mid-flight or after a PR-confirmed collection
    // (which is never a fall).
    const attempt = Math.max(record.attempt + 1, (logs.at(-1) ?? 0) + 1);
    return { attempt, previousFall: record.class === "clean-without-pr" };
  }

  // No record: either nothing ever happened (empty dir) or the previous
  // attempt died before writing — abrupt fall. The session dir and the
  // per-attempt logs are the evidence the runtime leaves at launch time.
  const hasEvidence = (await attemptNumbers(workDir)).length > 0 || existsSync(join(workDir, "sessao"));
  if (hasEvidence) return { attempt: (await attemptNumbers(workDir)).at(-1)! + 1, previousFall: true };

  return { attempt: 1, previousFall: false };
}

/** The attempt numbers present in the registry dir, ascending. */
async function attemptNumbers(workDir: string): Promise<number[]> {
  if (!existsSync(workDir)) return [];
  const entries = await readdir(workDir);
  const numbers: number[] = [];
  for (const entry of entries) {
    const match = /^log-(\d+)\.jsonl$/.exec(entry);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers.sort((a, b) => a - b);
}

// ---- the status view (msf status) ----

export interface LastOutcomeEntry {
  /** "<repo>#<number>" — the relative path is the key itself. */
  key: string;
  workDir: string;
  record: OutcomeRecord;
}

/**
 * The local registry as seen with the factory stopped (ticket 07 Q7): a work
 * dir without desfecho.json is in flight (orphan when the run is not up);
 * with it, the outcome of the last attempt; the archive holds the dones.
 */
export interface RegistryView {
  inFlight: string[];
  lastOutcome: LastOutcomeEntry[];
  /** Absolute paths of the archived works (moved there by the done — a later ticket). */
  archived: string[];
}

/**
 * Scan the workspace registry on real disk. Accepts the layout or a bare
 * workspace root; an absent workspace reads empty (status before any run).
 */
export async function scanRegistry(workspace: WorkspaceLayout | string): Promise<RegistryView> {
  const { works, archive } =
    typeof workspace === "string"
      ? {
          works: join(workspace, WORKSPACE_SUBPATHS.works),
          archive: join(workspace, WORKSPACE_SUBPATHS.archive),
        }
      : workspace;

  const inFlight: string[] = [];
  const lastOutcome: LastOutcomeEntry[] = [];
  for (const dir of await workDirs(works)) {
    const record = await readOutcomeRecord(dir);
    if (record) {
      lastOutcome.push({ key: relativeKey(works, dir), workDir: dir, record });
    } else {
      inFlight.push(relativeKey(works, dir));
    }
  }
  inFlight.sort();
  lastOutcome.sort((a, b) => a.key.localeCompare(b.key));

  const archived = await workDirs(archive);
  return { inFlight, lastOutcome, archived };
}

/** Directories under a registry root that look like <repo>#<n> work dirs. */
async function workDirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /#\d+(-.*)?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The work key of a registry dir: its path relative to the registry root
 * — the dir name is <repo>#<n> with the repo containing a "/", so the
 * relative path is the key itself ("Sanmoo/a#3"). */
function relativeKey(root: string, workDir: string): string {
  return relative(root, workDir).split(sep).join("/");
}
