/**
 * Test support for the continuity artifacts (issue 119): what a real worker
 * launch leaves on disk — the session association and, when the session
 * actually started, its Pi-format file in the bind-mounted sessions dir.
 *
 * The fixtures write the REAL artifact shapes (`continuity-artifacts.ts`,
 * `session-log.ts`), so a test that seeds an interrupted attempt exercises the
 * same readers the production recovery uses. No test bypasses verification.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SESSIONS_SUBDIR } from "../layout.js";
import { appendSessionLink, type SessionLink } from "../runtime/continuity-artifacts.js";
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

/** Append a bash tool call and its result to a seeded session file. */
export function seedSessionToolCall(
  session: SeededSession,
  call: { callId: string; command: string; answered: boolean },
): void {
  const entries: Array<Record<string, unknown>> = [
    {
      type: "message",
      id: `${call.callId}-call`,
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: call.callId, name: "bash", arguments: { command: call.command } }],
      },
    },
  ];
  if (call.answered) {
    entries.push({
      type: "message",
      id: `${call.callId}-result`,
      parentId: `${call.callId}-call`,
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: call.callId, toolName: "bash", content: [], isError: false },
    });
  }
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(session.file, `${text}\n`, { encoding: "utf8", flag: "a" });
}
