import { readOutcomeRecord, ownOutcomeRecord, writeOutcomeRecord, type OutcomeRecord } from "./outcome.js";
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
 * This is a seam of OWNERSHIP, not a merge into one file: the schemas keep
 * their own modules (outcome.ts, continuity.ts, and the pool's ledgers) and the
 * record composes them. Consumers cross this interface, so the container
 * guardrail, the host runtime and the pool can never disagree about where a
 * fact lives or what a cross reference means:
 *
 *  - a pause NAMES its Attempt (and its Work) — a record that cannot name them
 *    is read as the doubt it is, never as a pause of a guessed attempt;
 *  - a session link NAMES its round;
 *  - an outcome SETTLES the pause of the same attempt (`settle`), and the
 *    attribution rule "is this record this attempt's?" lives in one place.
 *
 * The ledgers' writes stay in the pool (recovery, model provider, repair): the
 * record owns their file names (files.ts) and the reads the record itself
 * needs, never their budget policy.
 */
export interface WorkRecord {
  /** The Work's registry dir. */
  readonly dir: string;
  /** Where the attempt's Pi sessions live. */
  readonly sessionsDir: string;

  /** The outcome record as read from disk — it may belong to an EARLIER attempt. */
  outcome(): Promise<OutcomeRecord | null>;
  /** The outcome record OF THIS ATTEMPT, or null (the one attribution rule). */
  ownOutcome(attempt: number): Promise<OutcomeRecord | null>;
  writeOutcome(record: OutcomeRecord): void;

  /** The persisted pause, or null; an unreadable record is the doubt it is. */
  pause(): PauseRecord | null;
  /** The attempt the pause names, or null when the record never named one. */
  pausedAttempt(): number | null;
  writePause(pause: PauseRecord): void;
  /** The attempt's end is a settled fact: its pause is history, and the next
   *  cycle must not treat it as current. */
  settle(attempt: number): void;

  /** The session associations, in the order they were written. */
  sessions(): { intact: boolean; links: SessionLink[] };
  /** Bind a session to its work, attempt and round (fsynced before the worker
   *  starts, so a recovery reads it back instead of guessing). */
  associateSession(link: SessionLink): void;

  /** The external-effect journal the guardrail wrote. */
  effects(): EffectJournal;
  /** What the host reconciled before the launch (read by the guardrail). */
  guardrailState(): GuardrailState | null;

  /** The operator's request that the Work's worker stop, bound to a session. */
  requestStop(sessionId: string): void;
  clearStopRequest(): void;
  stopRequested(sessionId: string): boolean;

  /** The factory's own records of one attempt. */
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
    writeOutcome: (record) => writeOutcomeRecord(dir, record),
    pause: () => readPause(dir),
    pausedAttempt: () => {
      const pause = readPause(dir);
      return pause === null ? null : knownAttempt(pause.attempt);
    },
    writePause: (pause) => writePause(dir, pause),
    settle: (attempt) => {
      const pause = readPause(dir);
      // A pause that names a LATER attempt belongs to a launch this end does
      // not settle: only the pause of this attempt (or one the record cannot
      // name) is history now.
      if (pause !== null && pause.attempt > attempt) return;
      clearPause(dir);
    },
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
