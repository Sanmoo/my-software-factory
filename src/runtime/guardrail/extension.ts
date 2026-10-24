/**
 * The continuity guardrail that runs INSIDE the worker container.
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
 * Installed by the worker image at /opt/msf/runtime/guardrail/extension.js and loaded
 * with `--extension`; it reads the work mount from MSF_WORK_MOUNT.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseJsonObject } from "../json-line.js";
import { watchWorkerStop, workerStopRequested } from "../stop-request.js";
import { tryJournalLock } from "./journal-lock.js";
import { childGuardrailRegistrar, guardedDelegation, type RegisterChildGuardrail, type ChildGuardrailRegistration } from "./delegation.js";

import { classifyCommand, withObservedRef, type EffectAction } from "../effects.js";
import { exactToolInput, readCallRecoveries, recoveryConsumption, recoveryForIntent } from "../call-recovery.js";
import {
  appendJournalIntent,
  appendJournalResult,
  appendJournalStart,
  callKey,
  readEffectJournal,
  readGuardrailState,
  type GuardrailState,
} from "../continuity-artifacts.js";

/** What Pi's `on()` returns: the function that removes the handler. */
export type GuardrailSubscription = () => void;

/** The slice of Pi's extension API the guardrail needs — structural so this
 *  module stays free of the CLI's runtime package. */
export interface GuardrailApi {
  on(event: "session_shutdown", handler: () => void): GuardrailSubscription;
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

/** The context needed to cancel tools and bind native child sessions. */
export type ExtensionContextLike = {
  signal?: AbortSignal;
  abort?: () => void;
  sessionManager?: { getSessionId(): string; getHeader?(): { parentSession?: string } | null };
};

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
  registerChildren?: RegisterChildGuardrail;
  requireChildren?: boolean;
}

const BLOCKED_PREAMBLE = "msf continuity guardrail:";

export function installGuardrail(pi: GuardrailApi, options: GuardrailOptions = {}): void {
  // /msf-work is the mount the runtime declares (WORK_MOUNT in
  // runtime/prompt.ts) and passes here as MSF_WORK_MOUNT: the literal is
  // spelled out instead of imported because this module is staged into the
  // image on its own (`scripts/stage-guardrail.mjs` follows relative imports
  // only) and must not drag the runtime's prompt in.
  const workMount = options.workMount ?? process.env["MSF_WORK_MOUNT"] ?? "/msf-work";
  const observeRef = options.observeRef ?? observeWorktree;
  // Per-process memory of "allowed exactly once" verdicts and the state read
  // at session start; both are process facts, never persisted.
  let state: GuardrailState | null = null;
  const consumedAbsent = new Set<string>();
  let stopWatching: (() => void) | undefined;
  let children: ChildGuardrailRegistration | undefined;
  let rootSessionId: string | undefined;
  pi.on("session_shutdown", () => { stopWatching?.(); children?.dispose(); });

  pi.on("session_start", (_event, ctx) => {
    stopWatching?.();
    children?.dispose();
    children = undefined;
    state = readGuardrailState(workMount);
    if (state === null) return;
    rootSessionId = state.sessionId;
    const actualSession = ctx?.sessionManager?.getSessionId() ?? state.sessionId;
    if (actualSession !== rootSessionId && parentSessionId(ctx) !== rootSessionId) {
      state = null;
      return; // An unexpected root session is not evidence of a delegated child.
    }
    state = { ...state, sessionId: actualSession };
    appendJournalStart(workMount, {
      attempt: state.attempt, sessionId: state.sessionId,
      ...(actualSession === rootSessionId ? {} : { childOf: rootSessionId }),
    });
    try { if (state.generation !== undefined) children = options.registerChildren?.(actualSession); } catch { /* Delegation fails closed below. */ }
    if (ctx?.abort !== undefined) {
      stopWatching = watchWorkerStop(workMount, rootSessionId, () => ctx.abort!());
    }
  });

  pi.on("tool_call", (event) => {
    if (state === null) state = readGuardrailState(workMount);
    // The state is the contract that makes a resumed effect safe: the verdicts
    // of the host's reconciliation, the attempt and the session this call
    // belongs to. Absent or unreadable, nothing can be authorized — a resumed
    // session must never run unguarded — so every bash call the
    // classifier does not prove local, and every delegation, is refused until
    // the state is readable. The file tools stay allowed: they edit the clone
    // (the branch is that record) and they are how a worker writes its outcome
    // record, including the blocked self-report this refusal asks for.
    if (state === null) return refuseWithoutState(event, workMount);
    if (workerStopRequested(workMount, rootSessionId ?? state.sessionId)) {
      return { block: true, reason: `${BLOCKED_PREAMBLE} the operator requested a stop; do not start another tool` };
    }
    const release = state.generation === undefined ? () => {} : tryJournalLock(workMount, state.generation);
    if (release === null) return { block: true, reason: `${BLOCKED_PREAMBLE} another guarded dispatch is in progress; this call did not run` };
    try {
      const needsJournal = event.toolName === "subagent" || event.toolName === "subagents_enable" ||
        (event.toolName === "bash" && classifyCommand(typeof event.input["command"] === "string" ? event.input["command"] : "").safety !== "safe");
      if (needsJournal && !readEffectJournal(workMount).intact) {
        return { block: true, reason: `${BLOCKED_PREAMBLE} effect journal is unreadable; no effect may run` };
      }
      const retry = guardCallRetry(workMount, state, event);
      if (retry !== null) return retry;
      if (event.toolName !== "bash") {
        if (event.toolName === "subagent" || event.toolName === "subagents_enable") {
          if (options.requireChildren && children === undefined) {
            return { block: true, reason: `${BLOCKED_PREAMBLE} child guardrail registration is unavailable; no unguarded delegation may run` };
          }
          if (event.toolName === "subagent" && children !== undefined && guardedDelegation(event.input)) {
            appendJournalIntent(workMount, {
              attempt: state.attempt, sessionId: state.sessionId, callId: event.toolCallId,
              tool: "subagent", command: "", safety: "unknown", actions: [], delegation: "guarded-v1",
              ...(state.generation === undefined ? {} : { generation: state.generation }),
            });
          } else {
            journalUnknown(workMount, state, event, `tool ${event.toolName} can produce effects outside the session`);
          }
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
    } finally { release(); }
  });

  pi.on("tool_result", (event) => {
    if (state === null) return;
    const journal = readEffectJournal(workMount);
    // The call id belongs to the session that issued it; another round's
    // "call-1" is not this one.
    if (!journal.intents.some((intent) => intent.sessionId === state!.sessionId && intent.callId === event.toolCallId && intent.tool === event.toolName)) return;
    appendJournalResult(workMount, {
      attempt: state.attempt,
      sessionId: state.sessionId,
      callId: event.toolCallId,
      ok: !event.isError,
    });
  });
}

/** null follows the ordinary guardrail; undefined has already journaled the
 * exact retry. The persisted intent, not process memory, consumes permission. */
function guardCallRetry(workMount: string, state: GuardrailState, event: ToolCallLike): GuardrailBlock | undefined | null {
  const block = (reason: string): GuardrailBlock => ({ block: true, reason: `${BLOCKED_PREAMBLE} ${reason}` });
  try {
    const recoveries = readCallRecoveries(workMount);
    if (recoveries.length === 0) return null;
    const journal = readEffectJournal(workMount);
    if (!journal.intact) return block("cannot establish call retry consumption: effect journal is unreadable");
    const current = recoveries.filter((entry) => (entry.executorSessionId ?? entry.sessionId) === state.sessionId && entry.attempt === state.attempt);
    for (const entry of current) {
      if (!journal.intents.some((intent) => recoveryForIntent([entry], intent) !== undefined)) return block("retry authorization has no matching original intent");
    }
    const command = typeof event.input["command"] === "string" ? event.input["command"] : "";
    const available = current.find((entry) => recoveryConsumption(journal, entry) === undefined && !journal.results.some((result) => result.sessionId === entry.sessionId && result.callId === entry.callId));
    const matches = (entry: (typeof current)[number]): boolean => entry.tool === undefined
      ? event.toolName === "bash" && command === entry.command
      : event.toolName === entry.tool && exactToolInput(event.input) === entry.input;
    if (available !== undefined && matches(available)) {
      const cwd = typeof event.input["cwd"] === "string" ? event.input["cwd"] : process.cwd();
      if (cwd !== available.cwd) return block("the exact retry must use its original working directory");
      if (journal.intents.some((intent) => intent.sessionId === state.sessionId && intent.callId === event.toolCallId)) return block("a retry needs a new tool call identity");
      appendJournalIntent(workMount, {
        attempt: state.attempt, sessionId: state.sessionId, callId: event.toolCallId,
        tool: event.toolName, command, safety: "unknown", actions: [],
        reason: "operator-authorized exact retry; the original outcome remains unknown",
        retryAuthorization: available.id,
        ...(available.input === undefined ? {} : { retryInput: available.input }),
        ...(state.generation === undefined ? {} : { generation: state.generation }),
      });
      return undefined;
    }
    if (current.some((entry) => matches(entry) && recoveryConsumption(journal, entry) !== undefined)) {
      return block("this exact retry authorization was already consumed; another repetition needs a new operator decision");
    }
    const unsettled = available !== undefined || current.some((entry) => {
      const consumed = recoveryConsumption(journal, entry);
      return consumed !== undefined && !journal.results.some((result) => result.sessionId === consumed.sessionId && result.callId === consumed.callId);
    });
    if (unsettled && ((event.toolName === "bash" && classifyCommand(command).safety !== "safe") || event.toolName === "subagent" || event.toolName === "subagents_enable")) {
      return block("an operator-authorized retry is pending; only that exact tool call may run before other effects. Do not rewrite it or work around this block");
    }
    return null;
  } catch {
    return block("call recovery journal cannot establish an authorization; no effect is allowed");
  }
}

/**
 * No readable state: the call cannot be journaled, checked against the host's
 * verdicts, or proven free of an already-realized effect. A provably local
 * command still runs (reading and local git change nothing outside the
 * worktree); anything else is refused, which the worker reports as blocked —
 * a pause the operator sees, never a silent repetition.
 */
function refuseWithoutState(event: ToolCallLike, workMount: string): GuardrailBlock | undefined {
  const delegation = event.toolName === "subagent" || event.toolName === "subagents_enable";
  if (event.toolName !== "bash" && !delegation) return undefined;
  if (event.toolName === "bash") {
    const command = typeof event.input["command"] === "string" ? event.input["command"] : "";
    if (classifyCommand(command).safety === "safe") return undefined;
  }
  return {
    block: true,
    reason:
      `${BLOCKED_PREAMBLE} the continuity state at ${workMount} cannot be read (the host's ` +
      "reconciliation and this attempt's session are unknown), so no external effect can be " +
      "authorized. Do not retry it: self-report blocked, naming what you were about to do.",
  };
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
  state: GuardrailState,
  actions: readonly EffectAction[],
  consumedAbsent: Set<string>,
): Blocked | null {
  const journal = readEffectJournal(workMount);
  // Scoped to the session: a call id repeats across the attempt's rounds.
  const failed = new Set(
    journal.results.filter((result) => !result.ok).map((result) => callKey(result.sessionId, result.callId)),
  );
  for (const action of actions) {
    const verdict = state.verdicts[action.key];
    if (verdict === "realized") return { detail: action.detail, why: "realized before the interruption" };
    if (verdict === "absent") {
      // The host proved the effect did NOT happen: exactly one execution is
      // allowed in this round, and a second identical one is a duplicate.
      const alreadyDispatched = state.generation !== undefined && journal.intents.some((intent) =>
        intent.generation === state.generation && intent.actions.some((prior) => prior.key === action.key));
      if (!consumedAbsent.has(action.key) && !alreadyDispatched) {
        consumedAbsent.add(action.key);
        continue;
      }
      return { detail: action.detail, why: "already attempted once in this round" };
    }
    const previous = journal.intents.find(
      (intent) =>
        intent.actions.some((prior) => prior.key === action.key) &&
        !failed.has(callKey(intent.sessionId, intent.callId)),
    );
    if (previous !== undefined) {
      return { detail: action.detail, why: "already attempted by an earlier round" };
    }
  }
  return null;
}

function journalIntent(
  workMount: string,
  state: GuardrailState,
  event: ToolCallLike,
  safety: "effect" | "unknown",
  actions: EffectAction[],
  command: string,
  reason?: string,
): void {
  appendJournalIntent(workMount, {
    attempt: state.attempt,
    sessionId: state.sessionId,
    callId: event.toolCallId,
    tool: event.toolName,
    command,
    safety,
    actions,
    ...(state.generation === undefined ? {} : { generation: state.generation }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function journalUnknown(
  workMount: string,
  state: GuardrailState,
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

function parentSessionId(ctx: ExtensionContextLike): string | null {
  const file = ctx?.sessionManager?.getHeader?.()?.parentSession;
  if (file === undefined) return null;
  try {
    const header = parseJsonObject(readFileSync(file, "utf8").split("\n")[0]!);
    return header?.["type"] === "session" && typeof header["id"] === "string" ? header["id"] : null;
  } catch { return null; }
}

export default async function guardrailExtension(pi: GuardrailApi): Promise<void> {
  let registerChildren: RegisterChildGuardrail | undefined;
  try { registerChildren = await childGuardrailRegistrar(); } catch { /* Keep the parent guarded; delegation is refused. */ }
  installGuardrail(pi, { requireChildren: true, ...(registerChildren === undefined ? {} : { registerChildren }) });
}
