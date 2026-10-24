import { existsSync, mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join, relative, sep, basename } from "node:path";

import {
  SESSIONS_SUBDIR,
  workDirOfKey,
  workspaceLayout,
  type WorkspaceLayout,
} from "../layout.js";
import { isRecordedFailure } from "../state/outcome.js";
import { openWorkRecord } from "../work-record/record.js";
import { pauseWaits, readPause, type PauseRecord } from "../work-record/continuity.js";
import { readWorkEvidence, type WorkEvidence } from "../work-record/evidence.js";
import type { OutcomeRecord } from "../work-record/outcome.js";
import type { RepairCycle } from "../work-record/repair.js";
import type { ModelProviderLedger, ModelProviderSettlement } from "../work-record/model-provider.js";
import type { RecoveryLedger } from "../work-record/recovery.js";
import { hasRepairCycle } from "./repair.js";
import { isModelProviderFailureSettled } from "./model-provider.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { workKeyOf } from "./work-key.js";
import { workDirCandidates } from "./reservation.js";

/**
 * The registry (ticket 13): the reader of what survives a process death.
 * Slots are only in memory (pool/slots.ts); everything else about a work is
 * an artifact in real disk under <workspace>/trabalhos/<repo>#<n>/ —
 * desfecho.json (written by the runtime when it can; its absence is an
 * INTERRUPTION of the attempt — issue 123), log-<n>.jsonl (the attempt's event
 * log), sessao/ (the session dir) and recuperacao.json (the recovery budget) —
 * and the reconciliation of a restart is nothing but reading them back here
 * (ticket 05 Q3). The record's parts are read through their owner
 * (`openWorkRecord`); this module keeps the VIEW built on them. Names on disk
 * stay PT-BR.
 */

/** The facts a launch derives from the registry before a worker is born. */
export interface LaunchFacts {
  /** 1st, 2nd... attempt on the same branch (WorkRequest.attempt). */
  attempt: number;
  /** True when the previous attempt on this branch ended in a WRITTEN failure
   * (a recorded failure/abandon outcome). An interruption — an attempt with no
   * outcome record — never sets it: it never enters the fall ruler (issue 123). */
  previousFall: boolean;
}

/**
 * Read the launch facts of a work from its registry dir. A work that never
 * launched (no dir, no evidence) is attempt 1 with no prior fall; a recorded
 * previous attempt numbers the next one. A previous attempt with logs but no
 * record was INTERRUPTED: it does not number a new attempt by itself — a
 * recovery continues it (pass `continueAttempt`, issue 123) — and it is not a
 * fall.
 */
export async function readLaunchFacts(
  workDir: string,
  continueAttempt?: number,
): Promise<LaunchFacts> {
  if (!existsSync(workDir)) return { attempt: continueAttempt ?? 1, previousFall: false };

  const snapshot = await openWorkRecord(workDir).read();
  const { outcome: record, attempts: logs } = snapshot;
  // The last RECORDED attempt is the only fall fact: an interrupted attempt
  // writes nothing, so it neither resets nor feeds the consecutive count.
  const previousFall = isRecordedFailure(record);

  if (continueAttempt !== undefined) {
    // A recovery continues the interrupted attempt: the SAME number in the
    // artifact, the branch preserved. A record of an earlier attempt is
    // history and never makes this attempt's continuation a fall.
    const recordPrecedes = (record?.attempt ?? 0) < continueAttempt;
    return { attempt: continueAttempt, previousFall: previousFall && recordPrecedes };
  }

  if (record) {
    // A stale record: an attempt started (logs) after the last recorded one.
    // Its consecutiveness is still the record's — the extra attempt without
    // a record only exists mid-flight or as an interruption recovery.
    const attempt = Math.max(record.attempt + 1, (logs.at(-1) ?? 0) + 1);
    return { attempt, previousFall };
  }

  // No record: either nothing ever happened (a bare reservation) or the
  // previous attempt was interrupted. The session dir and the per-attempt
  // logs are the evidence the runtime leaves at launch time.
  if (hasAttemptEvidence(workDir, logs)) {
    return { attempt: logs.at(-1)! + 1, previousFall: false };
  }

  return { attempt: 1, previousFall: false };
}

/** The attempt evidence the runtime leaves at launch time: a per-attempt log
 *  or the session dir. Its absence is the bare reservation. */
function hasAttemptEvidence(workDir: string, logs: readonly number[]): boolean {
  return logs.length > 0 || existsSync(join(workDir, SESSIONS_SUBDIR));
}

// ---- the done archive (ticket 14) ----

/** The work key of a registry dir name: "<repo>#<n>" — the repo keeps its slash. */
export function parseWorkKey(name: string): { repo: string; number: number } | null {
  const match = /^(.+)#(\d+)$/.exec(name);
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}

/**
 * Done-only disk duty addressed by the explicit Work identity (issue 126):
 * MOVE the Work's artifacts out of trabalhos/<work key> into
 * arquivo/<work key>-<date>/ — nothing is deleted, the audit trail stays
 * forever. Returns the archive path, or null when there was nothing to move.
 * A same-day re-archive gets a fresh name — never overwritten.
 */
export async function archiveDoneWorkFor(
  layout: WorkspaceLayout,
  work: WorkIdentity,
): Promise<string | null> {
  const key = workKeyOf(work);
  const src = workDirOfKey(layout, key);
  if (!existsSync(src)) return null;

  const date = new Date().toISOString().slice(0, 10);
  let dest = join(layout.archive, `${key}-${date}`);
  for (let suffix = 2; existsSync(dest); suffix += 1) {
    dest = join(layout.archive, `${key}-${date}-${suffix}`);
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
 * A work whose CURRENT attempt carries no outcome record of its own — the
 * interruption (or the repair fall, issue 112) awaiting reconciliation. It is
 * not the same thing as "no record on disk": an older attempt's record may sit
 * there as history, and it never becomes this attempt's outcome (issue 103's
 * rule, now visible here too).
 */
export interface AttemptWithoutOwnOutcome {
  key: string;
  /** The attempt that has no record of its own (the highest on disk). */
  attempt: number;
  /** The attempt the record on disk belongs to; null when there is no record. */
  recordedAttempt: number | null;
}

/** A work's interruption-recovery ledger as `msf status` reads it (issue 123). */
export interface RecoveryViewEntry {
  key: string;
  ledger: RecoveryLedger;
}

/** A work's model provider failure ledger as `msf status` reads it (issue 144). */
export interface ModelProviderViewEntry {
  key: string;
  /** The attempt the registry numbers right now — the awaiting is scoped to it. */
  attempt: number;
  ledger: ModelProviderLedger;
  /** The settled failure of that attempt, as the current session's ending. */
  last: ModelProviderSettlement;
}

/** A persisted continuity pause as `msf status` reads it (issue 119). */
export interface ContinuityPauseEntry {
  key: string;
  pause: PauseRecord;
  /** The attempt the ledger evidences on disk — the pause's own number is the
   *  attempt its launch planned (issue 175), so the view can say both instead
   *  of rewriting either. */
  lastAttempt: number;
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
   *  session dir as evidence) — an interruption, whatever an older record says. */
  attemptsWithoutOwnOutcome: AttemptWithoutOwnOutcome[];
  /** Dirs with no outcome record and no attempt evidence — the reservation alone. */
  reservedWithoutAttempt: string[];
  lastOutcome: LastOutcomeEntry[];
  /** The repair cycle of every work that ran or is running an automatic round. */
  repair: RepairViewEntry[];
  /** Works that went through an interruption: the budget spent and what ended
   *  the last attempt (issue 123) — absent for works never interrupted. */
  recovery: RecoveryViewEntry[];
  /** Works whose last attempt ended by a model provider failure: the retries
   *  spent and the provider's own message (issue 144). */
  modelProvider: ModelProviderViewEntry[];
  /** Works waiting for the operator because their interrupted attempt cannot
   *  be continued safely (issue 119): the persisted pause, with its reason. */
  continuityPauses: ContinuityPauseEntry[];
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
  const recovery: RecoveryViewEntry[] = [];
  const modelProvider: ModelProviderViewEntry[] = [];
  const continuityPauses: ContinuityPauseEntry[] = [];
  for (const dir of await workDirs(works)) {
    const key = relativeKey(works, dir);
    const record = openWorkRecord(dir);
    const snapshot = await record.read();
    const lastAttempt = snapshot.attempt ?? 0;
    // The record never stops being history: a work whose record and whose
    // orphaned attempt coexist shows BOTH (issue 112) — the record is not
    // presented as the current attempt's result.
    if (snapshot.outcome !== null) {
      lastOutcome.push({ key, workDir: dir, record: snapshot.outcome });
      // The same criterion the ruler and the collection apply (issue 143).
      if (snapshot.ownOutcome === null) {
        attemptsWithoutOwnOutcome.push({ key, attempt: lastAttempt, recordedAttempt: snapshot.outcome.attempt });
      }
    } else if (hasAttemptEvidence(dir, snapshot.attempts)) {
      attemptsWithoutOwnOutcome.push({ key, attempt: lastAttempt, recordedAttempt: null });
    } else {
      reservedWithoutAttempt.push(key);
    }

    const cycle = snapshot.repair;
    if (hasRepairCycle(cycle)) {
      const attempt = cycle.attempt;
      const evidence =
        attempt === null ? null : await readWorkEvidence(layout, dir, attempt.attempt);
      repair.push({ key, cycle, evidence });
    }

    // A legacy work dir has no recovery ledger and is not shown here: nothing
    // is invented for a work that was never interrupted under this budget.
    const ledger = snapshot.recovery;
    if (ledger.consumed > 0 || ledger.lastStop !== null) recovery.push({ key, ledger });

    // A work that never met a model provider failure has no ledger and is not
    // shown here either (issue 144). Only the CURRENT attempt's unresolved
    // model provider failure, still the current session's ending, is the
    // work's condition: a later outcome, a new attempt, or a later plain
    // interruption settles it (the attempt's log stays as the history).
    const modelProviderLedger = snapshot.modelProvider;
    const last = modelProviderLedger.last;
    if (last !== null && snapshot.ownOutcome === null) {
      const ending = await record.readModelProviderFailure(lastAttempt);
      if (ending !== null && isModelProviderFailureSettled(modelProviderLedger, lastAttempt, ending)) {
        modelProvider.push({ key, attempt: lastAttempt, ledger: modelProviderLedger, last });
      }
    }
    // A pause the ledger has not advanced beyond — the attempt it planned may
    // be exactly the current one, or one no log evidences yet (issue 175):
    // only a pause left BEHIND by a later attempt is history.
    const pause = readPause(dir);
    if (pause !== null && pauseWaits(pause, lastAttempt)) continuityPauses.push({ key, pause, lastAttempt });
  }
  const byKey = (a: string, b: string): number => a.localeCompare(b);
  const byEntryKey = <T extends { key: string }>(a: T, b: T): number => byKey(a.key, b.key);
  attemptsWithoutOwnOutcome.sort(byEntryKey);
  reservedWithoutAttempt.sort(byKey);
  lastOutcome.sort(byEntryKey);
  repair.sort(byEntryKey);
  recovery.sort(byEntryKey);
  modelProvider.sort(byEntryKey);
  continuityPauses.sort(byEntryKey);

  const archived = await workDirs(archive);
  return {
    attemptsWithoutOwnOutcome,
    reservedWithoutAttempt,
    lastOutcome,
    repair,
    recovery,
    modelProvider,
    continuityPauses,
    archived,
  };
}

/** This status view reads the dirs that carry a legacy "<repo>#<n>" name,
 *  dated archive copies included. It stays GitHub-only: the expanded registry
 *  (pool/reservation.ts scanReservations) is the reader that also names
 *  reservations of other sources, and both traverse through the same
 *  depth-bounded workDirCandidates. */
async function workDirs(root: string): Promise<string[]> {
  const isStatusWorkDir = (name: string): boolean => /#\d+(-.*)?$/.test(name);
  const candidates = await workDirCandidates(root, isStatusWorkDir);
  return candidates.filter((dir) => isStatusWorkDir(basename(dir))).sort();
}

/** The work key of a registry dir: its path relative to the registry root
 * — the dir name is <repo>#<n> with the repo containing a "/", so the
 * relative path is the key itself ("Sanmoo/a#3"). */
function relativeKey(root: string, workDir: string): string {
  return relative(root, workDir).split(sep).join("/");
}
