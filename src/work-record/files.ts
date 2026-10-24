import { join } from "node:path";

/**
 * The Work record's files, named once (issue #186). A Work's record lives
 * entirely under its registry dir (`trabalhos/<key>/`): the attempt's outcome,
 * the ledgers, the pause, the effect journal, the session links, the logs and
 * the stop request. Every reader and writer of the record takes the name from
 * here, so a rename or a new artifact has one place to land — and the container
 * guardrail, the host runtime and the pool can never disagree about where a
 * fact lives.
 *
 * Disk names are taken decisions and stay in PT-BR.
 */
export const WORK_RECORD_FILES = {
  /** The attempt's written outcome — the artifact contract between the rulers. */
  outcome: "desfecho.json",
  /** The Work's reservation: its source and destination facts. */
  reservation: "reserva.json",
  /** The PR associations of the Work, with the attempt that opened each. */
  prAssociations: "associacoes-pr.json",
  /** The recovery budget and the last stop of the Work. */
  recovery: "recuperacao.json",
  /** The model provider budget of the Work. */
  modelProvider: "provedor.json",
  /** The repair cycle: the round/fall ledgers and the attempt's facts. */
  repair: "reparo.json",
  /** The continuity pause that survives a restart. */
  pause: "pausa.json",
  /** The effect journal: intents before they run, results after. */
  effects: "efeitos.jsonl",
  /** One line per session CREATED for the Work, naming its attempt and round. */
  sessionLinks: "sessao-vinculos.jsonl",
  /** What the host reconciled before the launch (read by the guardrail). */
  guardrailState: "continuidade.json",
  /** The operator's request to stop the Work's worker. */
  stopRequest: "parar.json",
} as const;

/** A key of {@link WORK_RECORD_FILES}: one artifact kind of the record. */
export type WorkRecordFile = keyof typeof WORK_RECORD_FILES;

/** The Work's session subdir, on disk as decided: `<work dir>/sessao`. */
export const SESSIONS_SUBDIR = "sessao";

/** The absolute path of one record file inside a Work's dir. */
export function recordPath(dir: string, file: WorkRecordFile): string {
  return join(dir, WORK_RECORD_FILES[file]);
}

/** The dir of the Work's Pi session files. */
export function sessionsDir(dir: string): string {
  return join(dir, SESSIONS_SUBDIR);
}

/** The factory's own event log of one attempt (the JSONL the loop and the
 *  runtime append to). */
export const eventLogName = (attempt: number): string => `log-${attempt}.jsonl`;

/** Sandcastle's stdout log of one attempt. */
export const sandcastleLogName = (attempt: number): string => `sandcastle-${attempt}.log`;

/** The event log's name pattern — its number is the attempt it belongs to. */
export const EVENT_LOG_PATTERN = /^log-(\d+)\.jsonl$/;

/** Sandcastle's stdout log, matched by shape (it carries the attempt too). */
export const SANDCASTLE_LOG_PATTERN = /^sandcastle-.*\.log$/;

/** The absolute path of one attempt's event log. */
export function eventLogPath(dir: string, attempt: number): string {
  return join(dir, eventLogName(attempt));
}

/** The absolute path of one attempt's Sandcastle log. */
export function sandcastleLogPath(dir: string, attempt: number): string {
  return join(dir, sandcastleLogName(attempt));
}
