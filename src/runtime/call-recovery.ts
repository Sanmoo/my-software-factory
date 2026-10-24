import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { workKeyOf } from "../pool/work-key.js";
import type { WorkIdentity } from "../tracker/identity.js";
import {
  callKey, linkForAttempt, readEffectJournal, readPause, readSessionLinks,
  type EffectJournal, type JournalIntent,
} from "../work-record/continuity.js";
import { findSessionFile, inspectSessionFile, sessionToolCalls, sessionToolResults } from "./session-log.js";
import { parseJsonObject, type JsonValue } from "./json-line.js";

export const CALL_RECOVERY_FILENAME = "recuperacoes.jsonl";
export const DUPLICATE_RISK_WARNING = "The call may have executed partially. Repeating it can duplicate effects. This authorization is NOT evidence of success, failure, or absence of effects.";

export interface CallRecovery {
  version: 1;
  id: string;
  at: string;
  actor: string;
  reason: string;
  acceptedDuplicateRisk: true;
  workKey: string;
  pauseId: string;
  attempt: number;
  sessionId: string;
  callId: string;
  intentSeq: number;
  command: string;
  tool?: "subagent" | "subagents_enable";
  input?: string;
  cwd: string;
  review: string;
  requestId?: string;
  /** A guarded child's exact call is replayed by the owning Work session. */
  executorSessionId?: string;
}

export function readCallRecoveries(workDir: string): CallRecovery[] {
  let raw: string;
  try {
    raw = readFileSync(join(workDir, CALL_RECOVERY_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("call recovery journal cannot be read");
  }
  if (raw !== "" && !raw.endsWith("\n")) throw new Error("call recovery journal is incomplete");
  const records: CallRecovery[] = [];
  for (const line of raw.split("\n").filter((line) => line.trim() !== "")) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("call recovery journal is unparseable"); }
    if (!isRecovery(value)) throw new Error("call recovery journal has an invalid authorization");
    if (records.some((entry) => entry.id === value.id || callKey(entry.sessionId, entry.callId) === callKey(value.sessionId, value.callId))) {
      throw new Error("call recovery journal has duplicate authorizations");
    }
    records.push(value);
  }
  return records;
}

/** A consumption IS the next intent: one fsynced record precedes dispatch,
 * so a crash cannot leave a spent grant looking available. */
export function recoveryConsumption(journal: EffectJournal, recovery: CallRecovery): JournalIntent | undefined {
  const matches = journal.intents.filter((intent) => intent.retryAuthorization === recovery.id);
  if (matches.length > 1) throw new Error("call retry authorization was consumed more than once");
  const consumed = matches[0];
  if (consumed !== undefined && (consumed.sessionId !== (recovery.executorSessionId ?? recovery.sessionId) || consumed.attempt !== recovery.attempt || consumed.command !== recovery.command || consumed.tool !== (recovery.tool ?? "bash") || (recovery.tool !== undefined && consumed.retryInput !== recovery.input) || consumed.callId === recovery.callId || consumed.seq <= recovery.intentSeq)) {
    throw new Error("call retry consumption does not match its authorization");
  }
  return consumed;
}

export function recoveryForIntent(recoveries: readonly CallRecovery[], intent: JournalIntent): CallRecovery | undefined {
  return recoveries.find((entry) => entry.sessionId === intent.sessionId && entry.callId === intent.callId && entry.attempt === intent.attempt && entry.intentSeq === intent.seq && entry.command === intent.command && intent.tool === (entry.tool ?? "bash") && intent.safety === "unknown" && intent.actions.length === 0);
}

export function pendingCallRecovery(workDir: string, work: WorkIdentity): CallRecovery | undefined {
  const journal = readEffectJournal(workDir);
  const recoveries = readCallRecoveries(workDir);
  if (!journal.intact && recoveries.length > 0) throw new Error("effect journal cannot establish call retry consumption");
  const pending: CallRecovery[] = [];
  for (const entry of recoveries) {
    if (entry.workKey !== workKeyOf(work)) throw new Error("call recovery belongs to another work");
    const original = journal.intents.find((intent) => recoveryForIntent([entry], intent) !== undefined);
    if (original === undefined) throw new Error("call recovery has no matching original intent");
    if (recoveryConsumption(journal, entry) === undefined && !journal.results.some((result) => result.sessionId === entry.sessionId && result.callId === entry.callId)) pending.push(entry);
  }
  if (pending.length > 1) throw new Error("more than one call retry is pending");
  return pending[0];
}

export interface RecoveryReview {
  intent: JournalIntent;
  pauseId: string;
  review: string;
  cwd: string;
  input?: string;
  executorSessionId: string;
}

/** No heuristics: only an intact, associated tool call with no terminal result
 * is eligible. A different doubt still requires evidence, not consent. */
export function reviewCallRecovery(workDir: string, work: WorkIdentity, lastAttempt: number): RecoveryReview {
  const pause = readPause(workDir);
  if (pause?.reason !== "effect-unsupported" || !pause.id || !pause.sessionId) throw new Error("an identified effect-unsupported pause is required");
  if (pause.work !== undefined && workKeyOf(pause.work) !== workKeyOf(work)) throw new Error("pause belongs to another work");
  const journal = readEffectJournal(workDir);
  if (!journal.intact) throw new Error("effect journal is unreadable");
  const recoveries = readCallRecoveries(workDir);
  const pending = journal.pending.filter((intent) => intent.delegation === undefined &&
    intent.safety === "unknown" && intent.actions.length === 0 && recoveryForIntent(recoveries, intent) === undefined);
  if (pending.length !== 1) throw new Error("recovery requires exactly one unresolved call");
  const intent = pending[0]!;
  const supported = intent.tool === "bash" ? Boolean(intent.command) : intent.tool === "subagent" || intent.tool === "subagents_enable";
  if (!supported || intent.delegation !== undefined || intent.safety !== "unknown" || intent.actions.length !== 0 || intent.sessionId !== pause.sessionId || intent.attempt !== lastAttempt) throw new Error("the paused call is not eligible for an exact retry of the current attempt");
  const links = readSessionLinks(workDir);
  const link = links.intact ? linkForAttempt(links.links, work, intent.attempt) : null;
  if (link === null || (link.sessionId !== intent.sessionId && !journal.sessions.some((entry) =>
    entry.sessionId === intent.sessionId && entry.attempt === intent.attempt && entry.childOf === link.sessionId))) {
    throw new Error("the interrupted attempt's session association is not intact");
  }
  const executorSessionId = link.sessionId;
  const file = findSessionFile(join(workDir, "sessao"), intent.sessionId);
  if (file === null) throw new Error("the interrupted session is missing");
  const inspection = inspectSessionFile(file, intent.sessionId);
  if (inspection.status !== "intact") throw new Error("the interrupted session is not intact");
  const calls = sessionToolCalls(file, inspection.intactEntries).filter((call) => call.callId === intent.callId);
  if (calls.length !== 1 || calls[0]!.command !== intent.command || calls[0]!.tool !== intent.tool) throw new Error("session call does not match the effect intent");
  const input = intent.tool === "bash" ? undefined : exactToolInput(calls[0]!.input);
  if (intent.tool !== "bash" && input === undefined) throw new Error("the interrupted tool input is missing");
  if (sessionToolResults(file, inspection.intactEntries).some((result) => result.callId === intent.callId)) throw new Error("a terminal result exists; let msf run reconcile it instead");
  if (recoveries.some((entry) => entry.sessionId === intent.sessionId && entry.callId === intent.callId)) throw new Error("this call already has a retry authorization");
  const header = parseJsonObject(readFileSync(file, "utf8").split("\n")[0]!);
  const headerCwd = header?.["cwd"];
  const cwd = calls[0]!.cwd ?? headerCwd;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("the original working directory is unknown");
  const review = createHash("sha256").update(JSON.stringify({
    work: workKeyOf(work), pause, intent, lastAttempt, executorSessionId,
    session: readFileSync(file, "utf8"),
    effects: readFileSync(join(workDir, "efeitos.jsonl"), "utf8"), recoveries,
  })).digest("hex");
  return { intent, pauseId: pause.id, review, cwd, executorSessionId, ...(input === undefined ? {} : { input }) };
}

/** Caller holds the run lock and has confirmed no surviving worker. */
export function authorizeCallRecovery(
  workDir: string, work: WorkIdentity, lastAttempt: number,
  consent: { review: string; reason: string; actor: string; acceptedDuplicateRisk: boolean; requestId?: string },
): CallRecovery {
  if (!consent.acceptedDuplicateRisk || !consent.reason.trim() || !consent.actor.trim()) throw new Error("explicit duplicate-risk acceptance, reason and operator identity are required");
  const reviewed = reviewCallRecovery(workDir, work, lastAttempt);
  if (consent.review !== reviewed.review) throw new Error("recovery review is stale; inspect the call again");
  const { intent } = reviewed;
  const record: CallRecovery = {
    version: 1, id: randomUUID(), at: new Date().toISOString(), actor: consent.actor,
    reason: consent.reason.trim(), acceptedDuplicateRisk: true, workKey: workKeyOf(work),
    pauseId: reviewed.pauseId, attempt: intent.attempt, sessionId: intent.sessionId,
    callId: intent.callId, intentSeq: intent.seq, command: intent.command, cwd: reviewed.cwd, review: reviewed.review,
    ...(reviewed.input === undefined ? {} : { tool: intent.tool as "subagent" | "subagents_enable", input: reviewed.input }),
    ...(consent.requestId === undefined ? {} : { requestId: consent.requestId }),
    ...(reviewed.executorSessionId === intent.sessionId ? {} : { executorSessionId: reviewed.executorSessionId }),
  };
  const fd = openSync(join(workDir, CALL_RECOVERY_FILENAME), "a", 0o600);
  try { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(workDir, "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return record;
}

export function exactToolInput(input: unknown): string | undefined {
  let parsed: Record<string, JsonValue> | null;
  try { parsed = parseJsonObject(JSON.stringify(input)); } catch { return undefined; }
  if (parsed === null) return undefined;
  const canonical = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  };
  return JSON.stringify(canonical(parsed));
}

function isRecovery(value: unknown): value is CallRecovery {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["version"] === 1 && record["acceptedDuplicateRisk"] === true &&
    (record["requestId"] === undefined || (typeof record["requestId"] === "string" && /^[0-9a-f-]{36}$/.test(record["requestId"]))) &&
    (record["executorSessionId"] === undefined || (typeof record["executorSessionId"] === "string" && record["executorSessionId"].trim() !== "")) &&
    Number.isSafeInteger(record["attempt"]) && Number(record["attempt"]) > 0 &&
    Number.isSafeInteger(record["intentSeq"]) && Number(record["intentSeq"]) > 0 &&
    typeof record["command"] === "string" &&
    (record["tool"] === undefined
      ? record["command"].trim() !== "" && record["input"] === undefined
      : (record["tool"] === "subagent" || record["tool"] === "subagents_enable") &&
        typeof record["input"] === "string" && exactToolInput(parseJsonObject(record["input"])) === record["input"]) &&
    ["id", "at", "actor", "reason", "workKey", "pauseId", "sessionId", "callId", "cwd", "review"].every((key) => typeof record[key] === "string" && record[key].trim() !== "");
}
