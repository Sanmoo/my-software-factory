/**
 * The model provider failure that ended an attempt's turn (issue 144), read
 * from the attempt's own stream log — never from generic stderr parsing.
 *
 * The runtime records pi's stdout verbatim in the attempt's event log
 * (`agent-raw` lines). An assistant message that ended in a model provider
 * failure carries `stopReason: "error"` and the model provider's
 * `errorMessage`; a turn pi retried and survived leaves earlier errors behind
 * it. Only the LAST assistant message of the current session counts: it is the
 * turn's actual ending, so an error the session outlived (a later assistant
 * message) never makes the attempt a model provider failure; a session killed
 * right after an error is read by that error — the last fact its stream
 * carries. A turn ended by anything else — an abort (the idle limit), a
 * completed turn — carries no model provider error.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { eventLogName } from "./logs.js";

/** The turn's ending, as the attempt's stream records it. */
export interface ModelProviderFailure {
  /** The model provider's own message, verbatim: the operator reads the incident. */
  message: string;
  /**
   * Identity of the failing turn: the assistant message's own timestamp, or
   * its line in the append-only log when the stream carries none. Both are
   * stable when the factory appends its own events after the turn, so the
   * persisted settlement is never double-counted after a restart.
   */
  identity: string;
}

/** The last model provider error of an attempt's turn, or null when the turn ended otherwise. */
export async function readTurnModelProviderError(
  workDir: string,
  attempt: number,
): Promise<ModelProviderFailure | null> {
  const path = join(workDir, eventLogName(attempt));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  const ending = lastAssistantMessage(raw);
  if (ending === null) return null;
  const { message: last } = ending;
  if (last.stopReason !== "error") return null;
  const message = typeof last.errorMessage === "string" ? last.errorMessage.trim() : "";
  if (message === "") return null;

  return { message, identity: failureIdentity(last, ending.lineIndex) };
}

/** The fields of an assistant message this reader depends on. */
interface AssistantMessage {
  stopReason: unknown;
  errorMessage: unknown;
  timestamp: unknown;
}

/** The turn's ending and the log line it was read from. */
interface EndingMessage {
  message: AssistantMessage;
  /** Index in the whole append-only log — stable when lines are appended. */
  lineIndex: number;
}

/**
 * The last assistant message in the stream, in file order. The message rides
 * `message_start` / `message_end` / `turn_end` as `message`, and `agent_end`
 * as the tail of its `messages` array; all of them repeat the same object, so
 * the last one seen is the turn's ending. Only the CURRENT session counts: the
 * attempt's log accumulates across retries, and an earlier session's error
 * must not be read as this session's ending (a retry killed before writing
 * anything is an interruption, not the old outage again).
 */
function lastAssistantMessage(raw: string): EndingMessage | null {
  const lines = raw.split("\n");
  let last: EndingMessage | null = null;
  for (let index = currentSessionStart(lines); index < lines.length; index += 1) {
    const event = parseJson(lines[index] ?? "");
    if (event === null || event["event"] !== "agent-raw") continue;
    const inner = parseJson(typeof event["line"] === "string" ? event["line"] : "");
    if (inner === null) continue;
    const message = inner["message"];
    if (isAssistant(message)) last = { message, lineIndex: index };
    const messages = inner["messages"];
    if (Array.isArray(messages)) {
      const tail = messages.at(-1);
      if (isAssistant(tail)) last = { message: tail, lineIndex: index };
    }
  }
  return last;
}

/** The index of the current session's first line: after the last start line
 *  (one attempt's log holds one session per launch), or the whole log for a
 *  legacy log written before the start line existed. */
function currentSessionStart(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseJson(lines[index] ?? "");
    if (event?.["event"] === "session-start") return index + 1;
  }
  return 0;
}

function isAssistant(value: unknown): value is AssistantMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)["role"] === "assistant"
  );
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The failure's identity: its own timestamp, or its line in the log. */
function failureIdentity(message: AssistantMessage, lineIndex: number): string {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : `line:${lineIndex}`;
}
