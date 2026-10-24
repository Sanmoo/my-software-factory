/**
 * Test support for the continuity artifacts: what a real worker
 * launch leaves on disk — the session association and, when the session
 * actually started, its Pi-format file in the bind-mounted sessions dir.
 *
 * The fixtures write the REAL artifact shapes (`work-record/continuity.ts`,
 * `work-record/sessions.ts`), so a test that seeds an interrupted attempt
 * exercises the same readers the production recovery uses. No test bypasses
 * verification.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SESSIONS_SUBDIR } from "../layout.js";
import { appendSessionLink, type SessionLink } from "../work-record/continuity.js";
import {
  isLegacyWorkRef,
  workOfLegacyRef,
  type LegacyWorkRef,
  type WorkIdentity,
} from "../tracker/identity.js";

export interface SeededSession {
  sessionId: string;
  /** Absolute path of the session file inside the work dir. */
  file: string;
}

/**
 * Write the association and the session file of one launch. `attempt` is the
 * attempt the session carries; `round` distinguishes the launches of a same
 * attempt. `entries` is the number of assistant/user entries after the header
 * (a session killed early has few).
 */
export function seedSession(
  workDir: string,
  work: WorkIdentity | LegacyWorkRef,
  attempt: number,
  options: { round?: number; sessionId?: string; entries?: number; shortId?: string } = {},
): SeededSession {
  const sessionId = options.sessionId ?? `11111111-2222-3333-4444-${String(attempt).padStart(12, "0")}`;
  const round = options.round ?? 1;
  const linkedWork = isLegacyWorkRef(work) ? workOfLegacyRef(work) : work;
  const link: SessionLink = {
    version: 1,
    work: linkedWork,
    attempt,
    round,
    sessionId,
    at: "2026-01-01T00:00:00.000Z",
  };
  appendSessionLink(workDir, link);

  const dir = join(workDir, SESSIONS_SUBDIR, "--fake-worker--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${options.shortId ?? sessionId}.jsonl`);
  const header = { type: "session", version: 3, id: sessionId, cwd: "/fake/worker", timestamp: link.at };
  const lines = [JSON.stringify(header)];
  for (let index = 0; index < (options.entries ?? 1); index += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: link.at,
        message: { role: "user", content: `step ${index}` },
      }),
    );
  }
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { sessionId, file };
}

/** How one persisted `toolResult` reads. Pi's defaults are a plain success with
 *  no output; the fields here are what a refusal or a real failure add. */
export interface SeededCallResult {
  isError?: boolean;
  text?: string;
  /** A duration Pi records only for a call that EXECUTED; `undefined` is the
   *  shape of a call refused before execution. */
  durationMs?: number;
  tool?: string;
  /** Write the entry WITHOUT Pi's own `isError`, the shape of an "answered" or
   *  compatibility marker that never states an outcome. */
  omitOutcome?: boolean;
}

/** Append a bash tool call to a seeded session file, and — when `answered` —
 *  the terminal result Pi persisted for it, as `result` describes it. */
export function seedSessionToolCall(
  session: SeededSession,
  call: { callId: string; command: string; answered: boolean; tool?: string; input?: Record<string, unknown>; result?: SeededCallResult },
): void {
  const entries: Array<Record<string, unknown>> = [
    {
      type: "message",
      id: `${call.callId}-call`,
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: call.callId, name: call.tool ?? "bash", arguments: call.input ?? { command: call.command } },
        ],
      },
    },
  ];
  if (call.answered) entries.push(toolResultEntry(call.callId, call.result ?? {}));
  appendEntries(session, entries);
}

/** Append ONE more terminal result for a call id: the duplicate a broken writer
 *  can leave, which must never be read as unambiguous evidence. */
export function seedExtraToolResult(
  session: SeededSession,
  callId: string,
  result: SeededCallResult = {},
): void {
  appendEntries(session, [toolResultEntry(callId, result)]);
}

function toolResultEntry(callId: string, result: SeededCallResult): Record<string, unknown> {
  return {
    type: "message",
    id: `${callId}-result`,
    parentId: `${callId}-call`,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: result.tool ?? "bash",
      content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
      ...(result.omitOutcome === true ? {} : { isError: result.isError ?? false }),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    },
  };
}

function appendEntries(session: SeededSession, entries: Array<Record<string, unknown>>): void {
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(session.file, `${text}\n`, { encoding: "utf8", flag: "a" });
}
