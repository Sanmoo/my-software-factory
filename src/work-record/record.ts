import {
  ownOutcomeRecord,
  ownWrittenOutcome,
  readOutcomeRecord,
  writeOutcomeRecord,
  type OutcomeRecord,
} from "./outcome.js";
import {
  appendSessionLink,
  clearPause,
  knownAttempt,
  readEffectJournal,
  readGuardrailState,
  pauseWaits,
  readPause,
  readSessionLinks,
  writePause,
  type EffectJournal,
  type GuardrailState,
  type PauseRecord,
  type SessionLink,
} from "./continuity.js";
import {
  clearWorkerStop,
  requestWorkerStop,
  workerStopRequested,
} from "./stop-request.js";
import {
  SESSIONS_SUBDIR,
  eventLogName,
  eventLogPath,
  sandcastleLogName,
  sandcastleLogPath,
  sessionsDir,
} from "./files.js";

/**
 * The Work record (issue #186): everything a Work persists on disk under its
 * registry dir — the attempt's outcome, the continuity pause, the effect
 * journal, the session links, the worker's stop request, the factory's logs and
 * the ledgers of the pool — read and written through one interface.
 *
 * A seam of ownership, not a merge into one file: the schemas keep their own
 * modules (outcome.ts, continuity.ts, the pool's ledgers) and the record
 * composes them, so the guardrail inside the container, the host runtime and
 * the pool cannot disagree about where a fact lives or what a cross reference
 * means. The ledgers' writes stay in the pool: the record owns their file names
 * (files.ts), never their budget policy.
 */
export interface WorkRecord {
  readonly dir: string;
  readonly sessionsDir: string;

  /** The outcome record as read from disk — it may belong to an EARLIER attempt. */
  outcome(): Promise<OutcomeRecord | null>;
  /** The outcome record OF THIS ATTEMPT, or null (the one attribution rule). */
  ownOutcome(attempt: number): Promise<OutcomeRecord | null>;
  /** The attempt's own written outcome, unless it is the blocked self-report
   *  the record-only ruling handles. */
  writtenOutcome(attempt: number): Promise<OutcomeRecord | null>;
  writeOutcome(record: OutcomeRecord): void;

  /** The persisted pause, or null; an unreadable record is the doubt it is. */
  pause(): PauseRecord | null;
  /** The attempt the pause names, or null when the record never named one. */
  pausedAttempt(): number | null;
  writePause(pause: PauseRecord): void;
  /** The attempt's end is settled, so its pause is history: an outcome, a block
   *  or a reservation of that attempt owns the current fact. */
  settlePause(): void;

  sessions(): { intact: boolean; links: SessionLink[] };
  /** Bind a session to its work, attempt and round (fsynced before the worker
   *  starts, so a recovery reads it back instead of guessing). */
  associateSession(link: SessionLink): void;

  effects(): EffectJournal;
  guardrailState(): GuardrailState | null;

  /** The operator's request that the Work's worker stop, bound to a session. */
  requestStop(sessionId: string): void;
  clearStopRequest(): void;
  stopRequested(sessionId: string): boolean;

  logPath(attempt: number): string;
  sandcastleLogPath(attempt: number): string;
}

/** Open the record of one Work: a thin handle over its dir, owning the naming
 *  and the cross references, never a cache of the facts on disk. */
export function openWorkRecord(dir: string): WorkRecord {
  return {
    dir,
    sessionsDir: sessionsDir(dir),
    outcome: () => readOutcomeRecord(dir),
    ownOutcome: async (attempt) => ownOutcomeRecord(await readOutcomeRecord(dir), attempt),
    writtenOutcome: async (attempt) => ownWrittenOutcome(await readOutcomeRecord(dir), attempt),
    writeOutcome: (record) => writeOutcomeRecord(dir, record),
    pause: () => readPause(dir),
    pausedAttempt: () => {
      const pause = readPause(dir);
      return pause === null ? null : knownAttempt(pause.attempt);
    },
    writePause: (pause) => writePause(dir, pause),
    settlePause: () => clearPause(dir),
    sessions: () => readSessionLinks(dir),
    associateSession: (link) => appendSessionLink(dir, link),
    effects: () => readEffectJournal(dir),
    guardrailState: () => readGuardrailState(dir),
    requestStop: (sessionId) => requestWorkerStop(dir, sessionId),
    clearStopRequest: () => clearWorkerStop(dir),
    stopRequested: (sessionId) => workerStopRequested(dir, sessionId),
    logPath: (attempt) => eventLogPath(dir, attempt),
    sandcastleLogPath: (attempt) => sandcastleLogPath(dir, attempt),
  };
}

/** The names the record owns, re-exported so a consumer needs one import. */
export {
  knownAttempt,
  pauseWaits,
  SESSIONS_SUBDIR,
  eventLogName,
  sandcastleLogName,
  sessionsDir,
  type EffectJournal,
  type GuardrailState,
  type PauseRecord,
  type SessionLink,
};
