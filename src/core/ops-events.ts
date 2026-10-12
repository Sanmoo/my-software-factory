import type { Trigger } from "./job.js";
import type { FieldValue, Level, OpsEvent } from "./observability.js";
import type { ChangeResult, IssueChange, IssueRef } from "../tracker/port.js";
import { refKey } from "../tracker/port.js";

// Wording and shape of the operational events shared by the orchestrator and the runner
// (issue #15). Pure: building an event never reads or writes anything.

const MAX_ORIGINS = 4;

const shortOrigin = (trigger: Trigger): string => {
  const parts = [trigger.ref ?? trigger.check ?? trigger.origin];
  if (trigger.command !== undefined) parts.push(`comando ${trigger.command}`);
  if (trigger.author !== undefined) parts.push(`(${trigger.author})`);
  return parts.join(" ");
};

const describeTrigger = (trigger: Trigger): string =>
  [
    `motivo=${trigger.reason}`,
    `origem=${trigger.origin}`,
    trigger.ref === undefined ? undefined : `ref=${trigger.ref}`,
    trigger.pr === undefined ? undefined : `pr=${trigger.pr}`,
    trigger.author === undefined ? undefined : `autor=${trigger.author}`,
    trigger.check === undefined ? undefined : `check=${trigger.check}`,
    trigger.command === undefined ? undefined : `comando=${trigger.command}`,
  ].filter((part) => part !== undefined).join(" ");

// The reasons of an invocation for the main line: one cause is spelled out; several are
// summarized with short references, and every cause goes whole to the history lines.
export function triggerSummary(triggers: readonly Trigger[]): { fields: Record<string, FieldValue>; lines: string[] } {
  const reasons = [...new Set(triggers.map((trigger) => trigger.reason))];
  const lines = triggers.map((trigger, index) => `causa ${index + 1}/${triggers.length}: ${describeTrigger(trigger)}`);
  if (triggers.length === 1) {
    const [only] = triggers as [Trigger];
    return {
      fields: {
        motivo: only.reason,
        origem: only.origin,
        pr: only.pr,
        autor: only.author,
        check: only.check,
        comando: only.command,
        ref: only.ref,
      },
      lines,
    };
  }
  const shown = triggers.slice(0, MAX_ORIGINS).map(shortOrigin);
  const more = triggers.length - shown.length;
  return {
    fields: {
      motivo: reasons.join("+"),
      causas: triggers.length,
      origens: `${shown.join("; ")}${more > 0 ? `; +${more}` : ""}`,
      pr: [...new Set(triggers.flatMap((trigger) => (trigger.pr === undefined ? [] : [trigger.pr])))].join(",") || undefined,
    },
    lines,
  };
}

const RESULT_LEVEL: Record<ChangeResult, Level> = { confirmed: "info", attempted: "atenção", unchanged: "info", failed: "erro" };

const RESULT_TEXT: Record<ChangeResult, string> = {
  confirmed: "alteração confirmada",
  attempted: "alteração tentada, não confirmada",
  unchanged: "nenhuma alteração",
  failed: "alteração falhou",
};

export interface IssueWriteContext {
  ref: IssueRef;
  job?: string;
  invocation?: string;
  // Who made the write: "orquestrador" or "agente".
  origin: string;
  // What the write was for, e.g. "admissão", "conclusão-após-merge".
  reason: string;
  // The abstract operation of the orchestrator, e.g. "claim", "release", "done".
  operation: string;
  // Short references to the evidence (command id, comment id, PR).
  refs?: Record<string, FieldValue>;
}

const eventBase = (context: IssueWriteContext) => ({
  ...(context.job === undefined ? {} : { job: context.job }),
  ...(context.invocation === undefined ? {} : { invocation: context.invocation }),
});

// The write is about to be attempted: an attempt is not a change (decision 24).
export function issueWriteAttempt(context: IssueWriteContext): OpsEvent {
  return {
    kind: "issue-escrita-tentativa",
    text: "tentativa de alteração na issue",
    ...eventBase(context),
    fields: { issue: refKey(context.ref), origem: context.origin, operação: context.operation, motivo: context.reason, ...context.refs },
  };
}

// One concrete change, with the before and after the adapter knows. Unknown values are left out.
export function issueChangeEvent(context: IssueWriteContext, change: IssueChange): OpsEvent {
  return {
    kind: `issue-alteração-${change.result}`,
    text: RESULT_TEXT[change.result],
    level: RESULT_LEVEL[change.result],
    ...eventBase(context),
    fields: {
      issue: refKey(context.ref),
      origem: context.origin,
      operação: change.operation,
      alvo: change.target,
      estado: change.before !== undefined || change.after !== undefined ? `${change.before ?? "?"}→${change.after ?? "?"}` : undefined,
      motivo: context.reason,
      detalhe: change.detail,
      ...context.refs,
    },
  };
}

// The write failed, or its result is uncertain, with nothing the adapter could confirm.
export function issueWriteFailure(context: IssueWriteContext, reason: string, uncertain: boolean): OpsEvent {
  return {
    kind: uncertain ? "issue-escrita-incerta" : "issue-escrita-falhou",
    text: uncertain ? "resultado da alteração incerto" : "alteração falhou",
    level: uncertain ? "atenção" : "erro",
    ...eventBase(context),
    fields: { issue: refKey(context.ref), origem: context.origin, operação: context.operation, motivo: context.reason, erro: reason, ...context.refs },
  };
}
