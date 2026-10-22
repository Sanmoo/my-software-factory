/**
 * Reading a persisted Pi session (issue 119): the file the interrupted attempt
 * owns, its identity, the intact prefix of entries, and the tool calls the
 * prefix records. Nothing here rewrites, truncates or "repairs" the file — a
 * corrupted session is evidence, not something to hide, and the decision about
 * whether a usable point exists belongs to `continuity.ts`.
 *
 * The parser is strict on purpose: a permissive JSONL scanner that silently
 * drops the broken line would present a corrupted tail as a complete history.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseJsonObject, type JsonValue } from "./json-line.js";

export interface SessionHeader {
  version: number;
  id: string;
  cwd: string;
  timestamp: string;
}

export type SessionStatus = "intact" | "partial" | "missing" | "identity-mismatch" | "unreadable";

export interface SessionInspection {
  status: SessionStatus;
  /** The header, when the first line parsed and named a session. */
  header: SessionHeader | null;
  /** How many entries after the header are complete and parseable. */
  intactEntries: number;
  /** Bytes of the unparseable tail this file ends with (0 when intact). */
  tailBytes: number;
  /** The operator's diagnosis; never the file's contents. */
  detail?: string;
}

/** The session file of a given id anywhere under the sessions dir, or null.
 *  Pi groups session files by working directory, which differs between the
 *  host and the container, so the id — not the path — is the identity. */
export function findSessionFile(sessionsDir: string, sessionId: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (stats.isFile() && entry.endsWith(`_${sessionId}.jsonl`)) {
        return path;
      } else if (stats.isFile() && entry === `${sessionId}.jsonl`) {
        return path;
      }
    }
  }
  return null;
}

/** Inspect a session file against the id the factory recorded for it. */
export function inspectSessionFile(path: string, expectedId: string): SessionInspection {
  if (!existsSync(path)) {
    return { status: "missing", header: null, intactEntries: 0, tailBytes: 0, detail: `no file at ${path}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { status: "unreadable", header: null, intactEntries: 0, tailBytes: 0, detail: "the session file could not be read" };
  }
  if (raw === "") {
    return { status: "unreadable", header: null, intactEntries: 0, tailBytes: 0, detail: "the session file is empty" };
  }

  const segments = raw.split("\n");
  const trailing = segments.pop() ?? "";
  // Pi writes one newline per entry: a file ending with a newline has no
  // partial tail. A non-empty trailing segment without a newline is an
  // interrupted write unless it happens to parse as complete JSON.
  const complete = trailing.trim() === "" || parses(trailing);
  const lines = complete && trailing.trim() !== "" ? [...segments, trailing] : segments;

  const header = parseHeader(lines[0] ?? null);
  if (header === null) {
    return { status: "unreadable", header: null, intactEntries: 0, tailBytes: Buffer.byteLength(raw), detail: "the first line is not a session header" };
  }
  // Identity comes FIRST: the id in the header is readable even when the rest
  // of the history is not, and a file that belongs to another session is not
  // this attempt's to continue — a partial tail must not hide that.
  if (header.id !== expectedId) {
    return {
      status: "identity-mismatch",
      header,
      intactEntries: 0,
      tailBytes: 0,
      detail: `the session belongs to ${header.id}, not to the recorded ${expectedId}`,
    };
  }

  let intactEntries = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") {
      // A blank line inside the file is not a Pi entry; it ends the intact prefix.
      return {
        status: "unreadable",
        header,
        intactEntries,
        tailBytes: Buffer.byteLength(lines.slice(index).join("\n")),
        detail: `a blank line at entry ${index} breaks the history`,
      };
    }
    if (!parses(line)) {
      const rest = lines.slice(index).join("\n");
      if (index === lines.length - 1) {
        return {
          status: "partial",
          header,
          intactEntries,
          tailBytes: Buffer.byteLength(rest),
          detail: "the file ends with an incomplete entry",
        };
      }
      return {
        status: "unreadable",
        header,
        intactEntries,
        tailBytes: Buffer.byteLength(rest),
        detail: `an unparseable entry at line ${index} is followed by more history`,
      };
    }
    intactEntries += 1;
  }

  if (!complete) {
    return {
      status: "partial",
      header,
      intactEntries,
      tailBytes: Buffer.byteLength(trailing),
      detail: "the file ends with an incomplete entry",
    };
  }
  return { status: "intact", header, intactEntries, tailBytes: 0 };
}

/** One bash call the session prefix records, with its recorded result. */
export interface SessionToolCall {
  callId: string;
  tool: string;
  command: string;
  /** True when the transcript holds a tool result for this call. */
  answered: boolean;
}

/**
 * The tool calls the intact prefix records, in order. Only the entries that
 * parsed are read: a discarded tail contributes nothing it cannot prove.
 */
export function sessionToolCalls(path: string, intactEntries: number): SessionToolCall[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const segments = raw.split("\n");
  const trailing = segments.pop() ?? "";
  if (trailing.trim() !== "" && parses(trailing)) segments.push(trailing);

  const calls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  const answered = new Set<string>();
  for (let index = 1; index <= intactEntries && index < segments.length; index += 1) {
    const entry = parseEntry(segments[index]!);
    if (entry === null) continue;
    if (entry.type === "message") {
      const body = entry["message"];
      if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) continue;
      const message = body as Record<string, JsonValue>;
      const role = message["role"];
      if (role === "assistant" && Array.isArray(message["content"])) {
        for (const block of message["content"]) {
          if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
          const record = block as Record<string, JsonValue>;
          if (record["type"] !== "toolCall") continue;
          const callId = typeof record["id"] === "string" ? record["id"] : null;
          const name = typeof record["name"] === "string" ? record["name"] : null;
          const args = record["arguments"];
          const command =
            args !== null && args !== undefined && typeof args === "object" && !Array.isArray(args) && typeof args["command"] === "string"
              ? (args["command"] as string)
              : "";
          if (callId === null || name === null) continue;
          const call: SessionToolCall = { callId, tool: name, command, answered: false };
          calls.push(call);
          byId.set(callId, call);
        }
      } else if (role === "toolResult" && typeof message["toolCallId"] === "string") {
        answered.add(message["toolCallId"]);
      }
    }
  }
  for (const call of calls) call.answered = answered.has(call.callId);
  return calls;
}

function parseHeader(line: string | null): SessionHeader | null {
  if (line === null) return null;
  const entry = parseEntry(line);
  if (entry === null || entry["type"] !== "session") return null;
  const id = entry["id"];
  const cwd = entry["cwd"];
  const version = entry["version"];
  if (typeof id !== "string" || typeof cwd !== "string" || typeof version !== "number") return null;
  return {
    version,
    id,
    cwd,
    timestamp: typeof entry["timestamp"] === "string" ? entry["timestamp"] : "",
  };
}

function parseEntry(line: string): Record<string, JsonValue> | null {
  return parseJsonObject(line);
}

function parses(line: string): boolean {
  return parseEntry(line) !== null;
}
