import { existsSync, mkdirSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { workspaceLayout, workDir, WORKSPACE_SUBPATHS, type WorkspaceLayout } from "../layout.js";
import { readOutcomeRecord, type OutcomeRecord } from "../state/outcome.js";
import { readRepairCycle, type RepairCycle } from "./repair.js";
import { readWorkEvidence, type WorkEvidence } from "../state/evidence.js";
import type { IssueRef } from "../tracker/port.js";

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
  const logs = await attemptNumbers(workDir);
  if (hasAttemptEvidence(workDir, logs)) {
    return { attempt: logs.at(-1)! + 1, previousFall: true };
  }

  return { attempt: 1, previousFall: false };
}

/** The attempt evidence the runtime leaves at launch time: a per-attempt log
 *  or the session dir. Its absence is the bare reservation. */
function hasAttemptEvidence(workDir: string, logs: readonly number[]): boolean {
  return logs.length > 0 || existsSync(join(workDir, "sessao"));
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

/** The facts a sweep derives about an unreconciled fall (ticket 14): the
 * crashed attempt's number, and whether the session before it also fell. */
export interface ReconciliationFacts {
  /** The number of the last attempt (the one that fell unreconciled). */
  lastAttempt: number;
  /** True when the fall is a 2nd consecutive one: at least two attempts
   * without a record after the last record, or exactly one abrupt attempt
   * right after a recorded fall. */
  consecutiveFall: boolean;
}

/**
 * The crash footprint replayed from disk (ticket 05 Q3): the attempts are
 * the logs' numbers; the abrupt attempts are the ones after the last record.
 * The ruler applies from there — 1st fall releases, 2nd consecutive blocks.
 */
export async function readReconciliationFacts(workDir: string): Promise<ReconciliationFacts> {
  const { logs, record } = await attemptsAndRecord(workDir);
  const lastRecorded = record?.attempt ?? 0;
  const lastAttempt = lastAttemptOf(logs, record);
  const abruptCount = lastAttempt - lastRecorded;
  const lastRecordedFall = record?.class === "clean-without-pr";
  const consecutiveFall = abruptCount >= 2 || (abruptCount === 1 && lastRecordedFall);
  return { lastAttempt, consecutiveFall };
}

/**
 * The attempt ledger of one work (issue 112): the highest attempt the registry
 * numbers, and the attempt the outcome record on disk belongs to (null when no
 * record exists). The gap between the two is an attempt that wrote no record
 * of its own — the fall a repair reconciliation must settle.
 */
export interface AttemptLedger {
  lastAttempt: number;
  recordedAttempt: number | null;
}

export async function readAttemptLedger(dir: string): Promise<AttemptLedger> {
  const { logs, record } = await attemptsAndRecord(dir);
  return { lastAttempt: lastAttemptOf(logs, record), recordedAttempt: record?.attempt ?? null };
}

/**
 * The attempt a work is on right now (issue 102): the highest per-attempt log,
 * or the record's own number when the record is the latest evidence — read
 * from the registry that numbers attempts, never guessed from elsewhere. Null
 * when nothing on disk numbers an attempt (a work dir that is gone): the
 * registry invents no number.
 */
export async function readLastAttempt(workDir: string): Promise<number | null> {
  const { logs, record } = await attemptsAndRecord(workDir);
  const attempt = lastAttemptOf(logs, record);
  return attempt === 0 ? null : attempt;
}

function lastAttemptOf(logs: readonly number[], record: OutcomeRecord | null): number {
  return Math.max(logs.at(-1) ?? 0, record?.attempt ?? 0);
}

async function attemptsAndRecord(workDir: string): Promise<{
  logs: number[];
  record: OutcomeRecord | null;
}> {
  const [logs, record] = await Promise.all([attemptNumbers(workDir), readOutcomeRecord(workDir)]);
  return { logs, record };
}

// ---- the derivation's reserved-works scan + the done archive (ticket 14) ----

/** A reserved work as the registry sees it: its ref and where its artifacts live. */
export interface ReservedWorkEntry {
  ref: IssueRef;
  /** Absolute path of the work's registry dir (launches, archiving). */
  dir: string;
}

/** The work key of a registry dir name: "<repo>#<n>" — the repo keeps its slash. */
export function parseWorkKey(name: string): { repo: string; number: number } | null {
  const match = /^(.+)#(\d+)$/.exec(name);
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}

/**
 * The works the factory ever launched and still owns on disk: every
 * trabalhos/<repo>#<n> dir (recursively — the repo's slash nests the dir).
 * This is the derivation's source of "who is reserved": the tracker tells
 * the state, the registry tells WHO (ticket 14 — nothing but disk survives
 * a restart, and a released work keeps its dir until done).
 */
export async function scanReservedWorks(
  workspace: WorkspaceLayout | string,
): Promise<ReservedWorkEntry[]> {
  const works =
    typeof workspace === "string" ? join(workspace, WORKSPACE_SUBPATHS.works) : workspace.works;

  const entries: ReservedWorkEntry[] = [];
  for (const dir of await workDirs(works)) {
    const relativePath = relative(works, dir).split(sep).join("/");
    const parsed = parseWorkKey(relativePath);
    if (parsed === null) continue;
    entries.push({ ref: { repo: parsed.repo, number: parsed.number }, dir });
  }
  return entries.sort((a, b) => a.ref.repo.localeCompare(b.ref.repo) || a.ref.number - b.ref.number);
}

/**
 * Done-only disk duty (ticket 05 Q5, executed for real in 14): MOVE the
 * work's artifacts out of trabalhos/ into arquivo/<repo>#<n>-<date>/ —
 * nothing is deleted, the audit trail stays forever. Returns the archive
 * path, or null when there was nothing to move. A same-day re-archive (a
 * second run's artifacts) gets a fresh name — never overwritten.
 */
export async function archiveDoneWork(
  layout: WorkspaceLayout,
  ref: IssueRef,
): Promise<string | null> {
  const src = workDir(layout, ref.repo, ref.number);
  if (!existsSync(src)) return null;

  const date = new Date().toISOString().slice(0, 10);
  // The same nesting shape as workDir(): the repo's slash nests the dir —
  // arquivo/Sanmoo/a#1-<date>, a mirror of trabalhos/Sanmoo/a#1.
  let dest = join(layout.archive, `${ref.repo}#${ref.number}-${date}`);
  for (let suffix = 2; existsSync(dest); suffix += 1) {
    dest = join(layout.archive, `${ref.repo}#${ref.number}-${date}-${suffix}`);
  }
  mkdirSync(dest, { recursive: true });
  await rename(src, dest);
  return dest;
}

// ---- the status view (msf status) ----

export interface LastOutcomeEntry {
  /** "<repo>#<number>" — the relative path is the key itself. */
  key: string;
  workDir: string;
  record: OutcomeRecord;
}

/**
 * A work whose CURRENT attempt carries no outcome record of its own — the fall
 * awaiting reconciliation (issue 112). It is not the same thing as "no record
 * on disk": an older attempt's record may sit there as history, and it never
 * becomes this attempt's outcome (issue 103's rule, now visible here too).
 */
export interface AttemptWithoutOwnOutcome {
  key: string;
  /** The attempt that has no record of its own (the highest on disk). */
  attempt: number;
  /** The attempt the record on disk belongs to; null when there is no record. */
  recordedAttempt: number | null;
}

/** The repair cycle of a work as `msf status` reads it (issue 112). */
export interface RepairViewEntry {
  key: string;
  cycle: RepairCycle;
  /** The attempt's evidence locations, probed read-only; null without an attempt. */
  evidence: WorkEvidence | null;
}

/**
 * The local registry as seen with the factory stopped (ticket 07 Q7): a dir
 * with attempt evidence but no desfecho is an attempt whose outcome was never
 * recorded — Running while a live worker carries it, Orphaned otherwise (only
 * the liveness probe can tell the two apart); a dir created before any attempt
 * evidence is reserved without attempt (the claim landed, the worker has not —
 * common now that the reservation lands before the launch); with a desfecho,
 * the outcome of the last attempt; the archive holds the dones.
 */
export interface RegistryView {
  /** Dirs whose current attempt has no outcome record of its own (a log or the
   *  session dir as evidence) — a fall, whatever an older record says. */
  attemptsWithoutOwnOutcome: AttemptWithoutOwnOutcome[];
  /** Dirs with no outcome record and no attempt evidence — the reservation alone. */
  reservedWithoutAttempt: string[];
  lastOutcome: LastOutcomeEntry[];
  /** The repair cycle of every work that ran or is running an automatic round. */
  repair: RepairViewEntry[];
  /** Absolute paths of the archived works (moved there by the done — a later ticket). */
  archived: string[];
}

/**
 * Scan the workspace registry on real disk. Accepts the layout or a bare
 * workspace root; an absent workspace reads empty (status before any run).
 */
export async function scanRegistry(workspace: WorkspaceLayout | string): Promise<RegistryView> {
  const layout = typeof workspace === "string" ? workspaceLayout(workspace) : workspace;
  const { works, archive } = layout;

  const attemptsWithoutOwnOutcome: AttemptWithoutOwnOutcome[] = [];
  const reservedWithoutAttempt: string[] = [];
  const lastOutcome: LastOutcomeEntry[] = [];
  const repair: RepairViewEntry[] = [];
  for (const dir of await workDirs(works)) {
    const key = relativeKey(works, dir);
    const record = await readOutcomeRecord(dir);
    const logs = await attemptNumbers(dir);
    const lastAttempt = lastAttemptOf(logs, record);
    // The record never stops being history: a work whose record and whose
    // orphaned attempt coexist shows BOTH (issue 112) — the record is not
    // presented as the current attempt's result.
    if (record !== null) lastOutcome.push({ key, workDir: dir, record });
    if (record !== null) {
      if (record.attempt < lastAttempt) {
        attemptsWithoutOwnOutcome.push({ key, attempt: lastAttempt, recordedAttempt: record.attempt });
      }
    } else if (hasAttemptEvidence(dir, logs)) {
      attemptsWithoutOwnOutcome.push({ key, attempt: lastAttempt, recordedAttempt: null });
    } else {
      reservedWithoutAttempt.push(key);
    }

    const cycle = await readRepairCycle(dir);
    if (cycle.attempt !== null || cycle.usedRounds > 0 || cycle.consecutiveFalls > 0) {
      const attempt = cycle.attempt;
      const evidence =
        attempt === null ? null : await readWorkEvidence(layout, dir, attempt.attempt);
      repair.push({ key, cycle, evidence });
    }
  }
  const byKey = (a: string, b: string): number => a.localeCompare(b);
  attemptsWithoutOwnOutcome.sort((a, b) => byKey(a.key, b.key));
  reservedWithoutAttempt.sort(byKey);
  lastOutcome.sort((a, b) => a.key.localeCompare(b.key));
  repair.sort((a, b) => a.key.localeCompare(b.key));

  const archived = await workDirs(archive);
  return { attemptsWithoutOwnOutcome, reservedWithoutAttempt, lastOutcome, repair, archived };
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
