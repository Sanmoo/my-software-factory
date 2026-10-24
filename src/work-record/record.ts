import { attemptNumbers } from "./attempts.js";
import {
  appendJournalIntent,
  appendJournalResult,
  appendJournalStart,
  appendSessionLink,
  clearPause,
  pauseWaits,
  readEffectJournal,
  readGuardrailState,
  readPause,
  readSessionLinks,
  writeGuardrailState,
  writePause,
  type EffectJournal,
  type GuardrailState,
  type JournalIntent,
  type JournalResult,
  type JournalSessionStart,
  type PauseRecord,
  type SessionLink,
  type SessionLinks,
} from "./continuity.js";
import { appendAttemptEvent } from "./logs.js";
import {
  readModelProviderLedger,
  writeModelProviderLedger,
  type ModelProviderLedger,
} from "./model-provider.js";
import {
  ownOutcomeRecord,
  readOutcomeRecord,
  writeOutcomeRecord,
  type OutcomeRecord,
} from "./outcome.js";
import {
  readRecoveryLedger,
  writeRecoveryLedger,
  type RecoveryLedger,
} from "./recovery.js";
import { readRepairCycle, writeRepairCycle, type RepairCycle } from "./repair.js";

/**
 * The Work record (issue 187): the one owner of the complete on-disk record of
 * a Work — its files, their schemas and the cross-references that bind them.
 *
 * A pause names the Attempt it waits for; a session link names its round; an
 * outcome settles the pause of its own attempt; a stop fact names the attempt it
 * ended; a repair attempt names the evidence it addresses and the head it
 * observed. Those are guarantees of the WRITE, checked here (or in the part
 * writer it calls) before the disk is touched, so they cannot depend on which
 * caller wrote the file.
 *
 * The domain modules keep their policy — the outcome ruler, the recovery
 * decision, the model-provider decision and the repair reconciliation — and
 * read the record through this interface. A part that is absent reads as the
 * documented initial state; a part that cannot be read is reported as the doubt
 * it is, never repaired into an invented fact.
 */

export interface WorkRecord {
  readonly workDir: string;
  /** Every part as the disk states it, in one read. */
  read(): Promise<WorkRecordSnapshot>;
  /** Persist one part; a write that would break a cross-reference is refused. */
  write(part: WorkRecordWrite): Promise<void>;
}

/** The record of one Work as read in a single pass. */
export interface WorkRecordSnapshot {
  workDir: string;
  /** The highest attempt the record numbers (event log or outcome); null when
   *  nothing on disk numbers one. */
  attempt: number | null;
  /** The outcome record on disk, possibly an earlier attempt's. */
  outcome: OutcomeRecord | null;
  /** The outcome OF {@link attempt}: a recorded verdict of another attempt is
   *  history, never this attempt's outcome. */
  ownOutcome: OutcomeRecord | null;
  /** The pause that still waits: a pause the record advanced past, or one its
   *  own attempt's outcome settled, is not waiting. */
  pause: PauseRecord | null;
  sessionLinks: SessionLinks;
  journal: EffectJournal;
  guardrail: GuardrailState | null;
  recovery: RecoveryLedger;
  modelProvider: ModelProviderLedger;
  repair: RepairCycle;
  /** Every attempt the record numbers, ascending. */
  attempts: number[];
}

/** One part of the record to persist. */
export type WorkRecordWrite =
  /** The attempt's verdict; it settles the pause of the same attempt. */
  | { part: "outcome"; record: OutcomeRecord }
  | { part: "pause"; pause: PauseRecord }
  | { part: "pause-resolved" }
  | { part: "session-link"; link: SessionLink }
  | { part: "journal-start"; entry: Omit<JournalSessionStart, "type" | "at">; at?: string }
  | { part: "journal-intent"; entry: Omit<JournalIntent, "type" | "at" | "seq">; at?: string }
  | { part: "journal-result"; entry: Omit<JournalResult, "type" | "at" | "seq">; at?: string }
  | { part: "guardrail-state"; state: GuardrailState }
  | { part: "recovery"; ledger: RecoveryLedger }
  | { part: "model-provider"; ledger: ModelProviderLedger }
  | { part: "repair"; cycle: RepairCycle }
  | { part: "attempt-event"; attempt: number; event: Record<string, unknown> };

export function openWorkRecord(workDir: string): WorkRecord {
  return {
    workDir,
    async read(): Promise<WorkRecordSnapshot> {
      const outcome = await readOutcomeRecord(workDir);
      const attempts = await attemptNumbers(workDir);
      const numbered = Math.max(attempts.at(-1) ?? 0, outcome?.attempt ?? 0);
      const attempt = numbered === 0 ? null : numbered;
      const ownOutcome = attempt === null ? null : ownOutcomeRecord(outcome, attempt);
      const [recovery, modelProvider, repair] = await Promise.all([
        readRecoveryLedger(workDir),
        readModelProviderLedger(workDir),
        readRepairCycle(workDir),
      ]);
      return {
        workDir,
        attempt,
        outcome,
        ownOutcome,
        pause: waitingPause(workDir, attempt, ownOutcome),
        sessionLinks: readSessionLinks(workDir),
        journal: readEffectJournal(workDir),
        guardrail: readGuardrailState(workDir),
        recovery,
        modelProvider,
        repair,
        attempts,
      };
    },
    async write(part: WorkRecordWrite): Promise<void> {
      switch (part.part) {
        case "outcome":
          writeOutcomeRecord(workDir, part.record);
          settlePauseForOutcome(workDir, part.record.attempt);
          return;
        case "pause":
          writePause(workDir, part.pause);
          return;
        case "pause-resolved":
          clearPause(workDir);
          return;
        case "session-link":
          appendSessionLink(workDir, part.link);
          return;
        case "journal-start":
          appendJournalStart(workDir, part.entry, part.at);
          return;
        case "journal-intent":
          appendJournalIntent(workDir, part.entry, part.at);
          return;
        case "journal-result":
          appendJournalResult(workDir, part.entry, part.at);
          return;
        case "guardrail-state":
          writeGuardrailState(workDir, part.state);
          return;
        case "recovery":
          await writeRecoveryLedger(workDir, part.ledger);
          return;
        case "model-provider":
          await writeModelProviderLedger(workDir, part.ledger);
          return;
        case "repair":
          await writeRepairCycle(workDir, part.cycle);
          return;
        case "attempt-event":
          appendAttemptEvent(workDir, part.attempt, part.event);
          return;
      }
    },
  };
}

/** An outcome settles the pause of its own attempt, and only that one: another
 *  attempt's pause waits for the facts that can still resolve it. */
function settlePauseForOutcome(workDir: string, attempt: number): void {
  const pause = readPause(workDir);
  if (pause !== null && pause.attempt === attempt) clearPause(workDir);
}

/** The pause that still waits for the attempt the record numbers. A record
 *  whose own attempt is unreadable (`attempt: 0`) waits for whichever attempt
 *  is current; an older attempt's pause is history. */
function waitingPause(
  workDir: string,
  attempt: number | null,
  ownOutcome: OutcomeRecord | null,
): PauseRecord | null {
  const pause = readPause(workDir);
  if (pause === null) return null;
  if (ownOutcome !== null && pause.attempt === ownOutcome.attempt) return null;
  if (attempt !== null && !pauseWaits(pause, attempt)) return null;
  return pause;
}
