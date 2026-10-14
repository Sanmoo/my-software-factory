import type { RunKind } from "../runtime/runner.js";
import type { Continuation, Job, Trigger } from "./job.js";
import type { FieldValue, Level, Observer } from "./observability.js";
import { digestOf, helpPending, interventionPending, type AttentionKeeper } from "./attention.js";
import { feedbackCause, type FeedbackItem } from "./feedback.js";
import { triggerSummary } from "./ops-events.js";

// Presentation and operator attention for jobs; the job keys arrive from the caller.
export class Announcements {
  private invocationSeq = 0;
  // Waits already announced, so a poll that finds the same wait again does not repeat the event.
  private readonly announcedWaits = new Set<string>();

  constructor(private readonly obs: Observer, private readonly attention?: AttentionKeeper) {}

  // One operational event of a job. Never throws: the observer reports its own failures.
  emitFor(
    key: string, kind: string, text: string, fields: Record<string, FieldValue> = {},
    extra: { lines?: string[] | undefined; invocation?: string | undefined; level?: Level; highlight?: boolean } = {},
  ): void {
    const { lines, invocation, level, highlight } = extra;
    this.obs.emit({
      kind, text, job: key, fields,
      ...(invocation === undefined ? {} : { invocation }),
      ...(lines === undefined ? {} : { lines }),
      ...(level === undefined ? {} : { level }),
      ...(highlight === undefined ? {} : { highlight }),
    });
  }

  clearWaits(key: string): void {
    for (const entry of this.announcedWaits) if (entry.startsWith(`${key}|`)) this.announcedWaits.delete(entry);
  }

  // A job that waits for a slot or another impediment keeps its original reason (decision 21).
  // Each distinct wait is announced once, not on every poll.
  announceWait(key: string, kind: Continuation | RunKind | "issue-elegível", impediment: string, triggers: readonly Trigger[]): void {
    const signature = `${kind}|${impediment}|${JSON.stringify(triggers)}`;
    if (this.announcedWaits.has(`${key}|${signature}`)) return;
    this.announcedWaits.add(`${key}|${signature}`);
    const reasons = triggers.length === 0 ? { fields: { motivo: "issue-elegível" } as Record<string, FieldValue>, lines: [] as string[] } : triggerSummary(triggers);
    this.emitFor(
      key, "invocação-aguardando", triggers.length === 0 ? "issue elegível aguardando vaga" : "invocação aguardando vaga",
      { ...reasons.fields, impedimento: impediment },
      { lines: reasons.lines.length > 1 ? reasons.lines : undefined },
    );
  }

  // The local pendings that need the operator (ticket #59): the caller persists the state
  // before announcing it, and raising is awaited so the state machine's order stays deterministic.
  private async raiseAttention(pendingFn: () => Parameters<AttentionKeeper["raise"]>[0]): Promise<void> {
    await this.attention?.raise(pendingFn());
  }

  // A state left the eventual state changes the operator resolves; nothing to raise.
  private async resolveAttention(key: string): Promise<void> {
    await this.attention?.resolve(key);
  }

  // The operational event of a state the job has just entered. Waiting for help keeps the whole
  // question and context in the history and says how to answer (issue #15, decisions 3, 5, 6).
  async announceState(job: Job, details: { reason?: string; question?: string; context?: string; invocation?: string }, keys: readonly string[]): Promise<void> {
    const { key } = job;
    const { invocation } = details;
    switch (job.state) {
      case "waiting-for-help": {
        const commands = this.obs.commands(key, keys);
        const lines = [
          `pergunta: ${details.question ?? ""}`,
          ...(details.context ? [`contexto: ${details.context}`] : []),
          ...(commands ? [`responder: ${commands.reply}`, `histórico: ${commands.logs}`, ...(commands.detail ? [`log detalhado: ${commands.detail}`] : [])] : []),
        ];
        this.emitFor(key, "ajuda-solicitada", "ajuda solicitada", {}, { lines, invocation, level: "atenção", highlight: true });
        await this.raiseAttention(() => helpPending({
          key, ref: job.ref, repository: job.repository, question: details.question, context: details.context,
        }, new Date().toISOString()));
        return;
      }
      case "interrupted":
        // How to resume and how to see what happened; releasing is not offered ready to paste, so a
        // paste does not end the follow-up by mistake.
        this.emitFor(key, "trabalho-interrompido", "trabalho interrompido", { motivo: details.reason }, {
          invocation, level: "atenção", lines: this.interruptedCommands(key, keys),
        });
        // A stop needs the operator (spec #48, ticket #59): a persisted pending, digest per
        // interruption reason, in the same signaling the assisted flow uses.
        await this.raiseAttention(() => interventionPending(
          { key, ref: job.ref, repository: job.repository },
          "trabalho interrompido: retomada pedida", new Date().toISOString(),
          digestOf(["interrompido", details.reason ?? ""]), { reason: details.reason, actions: ["reply", "resume", "logs"] }));
        return;
      case "intervention-required":
        this.emitFor(key, "intervenção-necessária", "intervenção necessária", { motivo: details.reason }, { invocation, level: "atenção" });
        await this.raiseAttention(() => interventionPending(
          { key, ref: job.ref, repository: job.repository },
          "intervenção necessária", new Date().toISOString(),
          digestOf(["intervenção", details.reason ?? ""]), { reason: details.reason }));
        return;
      case "waiting-for-pr":
        this.emitFor(key, "pr-aceito", "PR aceito para acompanhamento; o trabalho não está concluído", {
          pr: job.pr === undefined ? undefined : `${job.pr.repository}#${job.pr.number}`,
        }, { invocation, level: "progresso" });
        // The PR wait needs no human action; any pending of the work is ended.
        await this.resolveAttention(key);
        return;
      case "done":
        this.emitFor(key, "trabalho-concluído", "trabalho concluído", { done: "confirmado" }, { level: "progresso" });
        await this.resolveAttention(key);
        return;
      case "released":
        this.emitFor(key, "trabalho-liberado", "trabalho liberado", { motivo: details.reason });
        await this.resolveAttention(key);
        return;
      case "running":
        // Back to running (a resume after help/intervention): the take-up ends the pendings.
        await this.resolveAttention(key);
        return;
    }
  }

  private interruptedCommands(key: string, keys: readonly string[]): string[] {
    const commands = this.obs.commands(key, keys);
    if (!commands) return [];
    return [`retomar: ${commands.resume}`, `histórico: ${commands.logs}`, ...(commands.detail ? [`log detalhado: ${commands.detail}`] : [])];
  }

  private newInvocation(): string {
    this.invocationSeq += 1;
    return `inv-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${this.invocationSeq}`;
  }

  // Feedback taken by the job: each input is announced once, when it is consumed, with its reason
  // and a short reference. The invocation it motivates is announced when it starts.
  announceFeedback(key: string, inputs: readonly FeedbackItem[]): void {
    for (const input of inputs) {
      this.emitFor(key, "feedback-recebido", "feedback recebido", triggerSummary([feedbackCause(input)]).fields);
    }
  }

  // The invocation that is about to run, announced with its operational reason (issue #15).
  startInvocation(key: string, kind: RunKind, triggers: readonly Trigger[], extra: Record<string, FieldValue>): string {
    const invocation = this.newInvocation();
    const reasons = kind === "new"
      ? { fields: { motivo: "issue-elegível" } as Record<string, FieldValue>, lines: [] as string[] }
      : triggerSummary(triggers);
    this.emitFor(
      key,
      kind === "new" ? "invocação-iniciada" : "invocação-retomada",
      kind === "new" ? "invocação iniciada" : "invocação retomada",
      { tipo: kind === "new" ? "nova" : kind === "resume" ? "retomada" : "correção", ...reasons.fields, ...extra },
      { lines: reasons.lines.length > 1 ? reasons.lines : undefined, invocation },
    );
    return invocation;
  }

  // The impediment is announced once per distinct reason, not on every poll that finds it again.
  announceRuntimeBlock(key: string, reason: string): void {
    const signature = `${key}|perfil-de-runtime|${reason}`;
    if (this.announcedWaits.has(signature)) return;
    this.announcedWaits.add(signature);
    this.emitFor(key, "admissão-bloqueada", "issue elegível não admitida: perfil de runtime incompleto", { motivo: reason }, { level: "atenção" });
  }
}
