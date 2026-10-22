/**
 * The continuity guardrail that runs INSIDE the worker container (issue 119).
 *
 * It is executable code at the tool boundary, not a paragraph in the prompt:
 * before a bash call runs, the external effects it would have are journaled
 * (fsynced) so an interruption inside the window still leaves the intent on
 * disk; and on a resumed session an effect the host proved realized — or one a
 * previous round already attempted — is blocked before it can be repeated. The
 * prompt cannot make a worker safe by obedience; this can.
 *
 * It shares the classifier and the artifact layout with the host
 * (`runtime/effects.ts`, `runtime/continuity-artifacts.ts`), so "which effect
 * is this?" has one answer on both sides of the container boundary.
 *
 * Installed by the worker image at /opt/msf/guardrail/extension.js and loaded
 * with `--extension`; it reads the work mount from MSF_WORK_MOUNT.
 */

import { execFileSync } from "node:child_process";

import {
  classifyCommand,
  withObservedRef,
  type CommandSafety,
  type EffectAction,
} from "../effects.js";
import {
  GUARDRAIL_STATE_FILENAME,
  appendJournalIntent,
  appendJournalResult,
  appendJournalStart,
  readEffectJournal,
  readGuardrailState,
  type GuardrailState,
} from "../continuity-artifacts.js";

/** What Pi's `on()` returns: the function that removes the handler. */
export type GuardrailSubscription = () => void;

/** The slice of Pi's extension API the guardrail needs — structural so this
 *  module stays free of the CLI's runtime package. */
export interface GuardrailApi {
  on(
    event: "session_start",
    handler: (event: { type: "session_start"; reason: string }, ctx: ExtensionContextLike) => void | Promise<void>,
  ): GuardrailSubscription;
  on(
    event: "tool_call",
    handler: (event: ToolCallLike, ctx: ExtensionContextLike) => GuardrailBlock | undefined | Promise<GuardrailBlock | undefined>,
  ): GuardrailSubscription;
  on(
    event: "tool_result",
    handler: (event: ToolResultLike, ctx: ExtensionContextLike) => void | Promise<void>,
  ): GuardrailSubscription;
}

/** The context slice the handlers accept and ignore. */
export type ExtensionContextLike = { signal?: AbortSignal };

export interface ToolCallLike {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultLike {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface GuardrailBlock {
  block: true;
  reason: string;
}

export interface GuardrailOptions {
  /** Where the work dir is bound inside the container; defaults to /msf-work. */
  workMount?: string;
  /** Resolution of the worktree's branch/commit (injectable for tests). */
  observeRef?: (cwd: string) => { branch: string | null; sha: string | null };
}

const BLOCKED_PREAMBLE = "msf continuity guardrail:";

export function installGuardrail(pi: GuardrailApi, options: GuardrailOptions = {}): void {
  const workMount = options.workMount ?? process.env["MSF_WORK_MOUNT"] ?? "/msf-work";
  const observeRef = options.observeRef ?? observeWorktree;
  // Per-process memory of "allowed exactly once" verdicts and the state read
  // at session start; both are process facts, never persisted.
  let state: GuardrailState | null = null;
  const consumedAbsent = new Set<string>();

  pi.on("session_start", () => {
    state = readGuardrailState(workMount);
    if (state === null) return;
    appendJournalStart(workMount, { attempt: state.attempt, sessionId: state.sessionId });
  });

  pi.on("tool_call", (event) => {
    if (state === null) state = readGuardrailState(workMount);
    if (event.toolName !== "bash") {
      // Delegations are not recoverable state (issue 119, out of scope): an
      // interrupted one is an unknown effect, so a recovery pauses on it.
      if (event.toolName === "subagent" || event.toolName === "subagents_enable") {
        journalUnknown(workMount, state, event, `tool ${event.toolName} can produce effects outside the session`);
      }
      return undefined;
    }
    const command = typeof event.input["command"] === "string" ? event.input["command"] : "";
    const safety = classifyCommand(command);
    if (safety.safety === "safe") return undefined;

    if (safety.safety === "unknown") {
      journalUnknown(workMount, state, event, safety.reason, command);
      return undefined;
    }

    const cwd = typeof event.input["cwd"] === "string" && event.input["cwd"] !== "" ? event.input["cwd"] : process.cwd();
    const observed = observeRef(cwd);
    const actions = safety.actions.map((action) => withObservedRef(action, observed));

    const blocked = blockedAction(workMount, state, actions, consumedAbsent);
    if (blocked !== null) {
      return {
        block: true,
        reason:
          `${BLOCKED_PREAMBLE} ${blocked.detail} was already ${blocked.why}. Do not repeat it: ` +
          "continue with the remaining work, or write the outcome record and stop.",
      };
    }

    journalIntent(workMount, state, event, "effect", actions, command);
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (state === null) return;
    const journal = readEffectJournal(workMount);
    if (!journal.intents.some((intent) => intent.callId === event.toolCallId)) return;
    appendJournalResult(workMount, {
      attempt: state.attempt,
      sessionId: state.sessionId,
      callId: event.toolCallId,
      ok: !event.isError,
    });
  });
}

type Blocked = { detail: string; why: string };

/**
 * Decide whether one of the call's effects must not run:
 *   - the host proved it realized  → never again;
 *   - the host proved it absent    → exactly once, in this round;
 *   - a previous round already attempted it (pending, or reported success)
 *     → do not repeat it.
 */
function blockedAction(
  workMount: string,
  state: GuardrailState | null,
  actions: readonly EffectAction[],
  consumedAbsent: Set<string>,
): Blocked | null {
  const journal = readEffectJournal(workMount);
  const failed = new Set(journal.results.filter((result) => !result.ok).map((result) => result.callId));
  for (const action of actions) {
    const verdict = state?.verdicts[action.key];
    if (verdict === "realized") return { detail: action.detail, why: "realized before the interruption" };
    if (verdict === "absent") {
      // The host proved the effect did NOT happen: exactly one execution is
      // allowed in this round, and a second identical one is a duplicate.
      if (!consumedAbsent.has(action.key)) {
        consumedAbsent.add(action.key);
        continue;
      }
      return { detail: action.detail, why: "already attempted once in this round" };
    }
    const previous = journal.intents.find(
      (intent) => intent.actions.some((prior) => prior.key === action.key) && !failed.has(intent.callId),
    );
    if (previous !== undefined) {
      return { detail: action.detail, why: "already attempted by an earlier round" };
    }
  }
  return null;
}

function journalIntent(
  workMount: string,
  state: GuardrailState | null,
  event: ToolCallLike,
  safety: "effect" | "unknown",
  actions: EffectAction[],
  command: string,
  reason?: string,
): void {
  if (state === null) return;
  appendJournalIntent(workMount, {
    attempt: state.attempt,
    sessionId: state.sessionId,
    callId: event.toolCallId,
    tool: event.toolName,
    command,
    safety,
    actions,
    ...(reason === undefined ? {} : { reason }),
  });
}

function journalUnknown(
  workMount: string,
  state: GuardrailState | null,
  event: ToolCallLike,
  reason: string,
  command = "",
): void {
  journalIntent(workMount, state, event, "unknown", [], command, reason);
}

/** The worktree's branch and commit, read where the repository is. A failure
 *  leaves them unresolved: the host then treats the effect as unreconcilable
 *  instead of guessing. */
function observeWorktree(cwd: string): { branch: string | null; sha: string | null } {
  return {
    branch: gitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: gitValue(cwd, ["rev-parse", "HEAD"]),
  };
}

function gitValue(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" || out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}

export default function guardrailExtension(pi: GuardrailApi): void {
  installGuardrail(pi);
}

/** The prompt-side contract the guardrail enforces — exported so the worker
 *  prompt and this code cannot drift about what a block means. */
export const GUARDRAIL_STATE_READ = GUARDRAIL_STATE_FILENAME;

export type { CommandSafety };
