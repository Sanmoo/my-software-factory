import type { TrackerPort } from "../tracker/port.js";
import type { Admission, CommandOutcome } from "./admission.js";
import type { Announcements } from "./announcements.js";
import type { AssistOperator, AssistOperatorResult } from "./assist-flow.js";
import type { CommandQueue, OperatorCommand } from "./commands.js";
import { directedReply, receiveFeedback, type DirectedReplyItem } from "./feedback.js";
import type { InstanceControl } from "./instance-control.js";
import type { IssueWrites } from "./issue-writes.js";
import type { Job, JobState } from "./job.js";
import type { JobRegistry } from "./job-registry.js";
import type { Observer } from "./observability.js";
import { messageOf } from "./values.js";

// Commands that address one job; pause and unpause address the instance.
type JobCommand = Extract<OperatorCommand, { job: string }>;

// Jobs an operator can release: none of them has an invocation running.
const RELEASABLE: readonly JobState[] = ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required"];

// Jobs whose issue is read for directed replies. A job that is done, released or needs
// intervention takes no input from the tracker.
const TRACKER_FEEDBACK_STATES: readonly JobState[] = ["waiting-for-help", "running", "interrupted", "waiting-for-pr"];

// Directed work input: the queue, terminal replies, tracker replies and release.
// Continuations remain Admission's decision; this module calls its bound function.
export class OperatorInput {
  constructor(private readonly deps: {
    commands: CommandQueue;
    tracker: Pick<TrackerPort, "readComments">;
    registry: Pick<JobRegistry, "job" | "allJobs" | "note" | "persist" | "apply">;
    announcements: Pick<Announcements, "emitFor" | "announceFeedback">;
    writes: Pick<IssueWrites, "release">;
    requestContinuation: Admission["requestContinuation"];
    control: Pick<InstanceControl, "setPaused">;
    observer: Pick<Observer, "emit">;
    assistOperator?: AssistOperator;
  }) {}

  // Applies the queued commands in order and removes each one once it has been applied.
  // A command whose application fails stays queued and is retried on the next poll.
  async processCommands(report: {
    comando: (outcome: CommandOutcome) => void;
    pular: (key: string, motivo: string) => void;
    falhar: (key: string, mensagem: string) => void;
  }): Promise<void> {
    let queued;
    try {
      queued = await this.deps.commands.pending();
    } catch (error) {
      report.falhar("commands", messageOf(error));
      return;
    }
    for (const name of queued.unreadable) {
      report.falhar("commands", `comando ilegível: ${name}`);
    }
    // `approve` is the assisted attendance's approval (ticket #55): not a job command. The
    // assisted flow consumes it on the same cycle, after its supervision; consuming it here
    // would reject as "trabalho desconhecido" what is not an implementation job.
    for (const command of queued.commands
      .filter((candidate) => candidate.type !== "approve" || this.deps.assistOperator === undefined)) {
      try {
        report.comando(await this.handleCommand(command));
        await this.deps.commands.done(command.id);
      } catch (error) {
        report.falhar(command.id, messageOf(error));
      }
    }
  }

  private async handleCommand(command: OperatorCommand): Promise<CommandOutcome> {
    const base = { id: command.id, type: command.type };
    if (command.type === "pause" || command.type === "unpause") {
      await this.deps.control.setPaused(command.type === "pause");
      this.deps.observer.emit({
        kind: "comando-aplicado", text: command.type === "pause" ? "instância pausada" : "instância despausada", fields: { comando: command.id },
        ...(command.type === "pause" ? { level: "atenção" as const } : {}),
      });
      return { ...base, status: "applied" };
    }
    const job = this.deps.registry.job(command.job);
    if (!job) {
      const assisted = await this.operateAssisted(command);
      if (assisted === undefined) return { ...base, job: command.job, status: "rejected", reason: "trabalho desconhecido" };
      if (assisted.status === "applied") {
        this.deps.announcements.emitFor(command.job, "comando-aplicado", `${command.type} aplicado no atendimento assistido`, { comando: command.id });
        return { ...base, job: command.job, status: "applied" };
      }
      this.deps.announcements.emitFor(command.job, "comando-rejeitado", `${command.type} rejeitado no atendimento assistido`, { comando: command.id, motivo: assisted.reason }, { level: "atenção" });
      return { ...base, job: command.job, status: "rejected", reason: assisted.reason };
    }
    const reason = await this.operate(job, command);
    if (reason === undefined) {
      // `reply aplicado` is the orchestrator taking the reply: neither delivery nor start of a run.
      this.deps.announcements.emitFor(job.key, "comando-aplicado", `${command.type} aplicado`, { comando: command.id });
      return { ...base, job: job.key, status: "applied" };
    }
    await this.deps.registry.note(job.key, `${command.type} rejeitado: ${reason}`);
    this.deps.announcements.emitFor(job.key, "comando-rejeitado", `${command.type} rejeitado`, { comando: command.id, motivo: reason }, { level: "atenção" });
    return { ...base, job: job.key, status: "rejected", reason };
  }

  // A command for the assisted registry, already applied. `undefined` names nothing here:
  // the job store said no and the assisted registry has no such session either.
  private async operateAssisted(command: JobCommand): Promise<AssistOperatorResult | undefined> {
    const operator = this.deps.assistOperator;
    if (operator === undefined || !(await operator.has(command.job))) return undefined;
    return command.type === "reply"
      ? operator.reply(command.job, command.message, command.id)
      : command.type === "resume"
        ? operator.resume(command.job, command.id)
        : operator.release(command.job, command.id);
  }

  // Returns the reason a command was refused, or undefined when it was applied.
  private async operate(job: Job, command: JobCommand): Promise<string | undefined> {
    switch (command.type) {
      case "reply":
        return this.reply(job, command.message, command.id);
      case "resume": {
        const outcome = await this.deps.requestContinuation(job.key, "resume", command.id);
        return outcome.status === "rejected" ? outcome.reason : undefined;
      }
      case "release":
        return this.release(job, command.id);
    }
  }

  // A terminal reply is directed input with no tracker event behind it. It takes the same
  // path as an `agent:` comment, so both have the same effect.
  private async reply(job: Job, message: string, command: string): Promise<string | undefined> {
    if (message.trim() === "") return "resposta vazia";
    const item: DirectedReplyItem = { kind: "directed-reply", origin: "terminal", message, command, ref: `comando ${command}` };
    const outcome = receiveFeedback(job, [item], "resposta recebida");
    if ("reason" in outcome) return `reply ${outcome.reason}`;
    await this.deps.registry.persist(outcome.job);
    return undefined;
  }

  // Directed replies in the tracker: a human comment without marker that starts with
  // `agent:`. Each comment is consumed once, by its id and revision.
  async collectTrackerFeedback(report: Pick<Parameters<OperatorInput["processCommands"]>[0], "pular" | "falhar">): Promise<void> {
    for (const candidate of this.deps.registry.allJobs().filter((job) => TRACKER_FEEDBACK_STATES.includes(job.state))) {
      try {
        const comments = await this.deps.tracker.readComments(candidate.ref);
        const current = this.deps.registry.job(candidate.key);
        if (!current) continue;
        const consumed = new Set(current.consumed ?? []);
        const inputs = comments.flatMap((comment) => {
          const input = directedReply(candidate.ref.tracker, comment);
          return input !== undefined && input.key !== undefined && !consumed.has(input.key) ? [input] : [];
        });
        if (inputs.length === 0) continue;
        const outcome = receiveFeedback(current, inputs, "resposta dirigida recebida na issue");
        if ("reason" in outcome) {
          report.pular(current.key, `feedback da issue ${outcome.reason}`);
          continue;
        }
        await this.deps.registry.persist(outcome.job);
        this.deps.announcements.announceFeedback(current.key, inputs);
      } catch (error) {
        report.falhar(candidate.key, messageOf(error));
      }
    }
  }

  // Removes the claim and ends tracking; area, session and PR stay on the job. Never moves
  // the issue to done and never touches the PR. The write sequence and its
  // reconciliation after an error belong to IssueWrites (ADR 0001).
  private async release(job: Job, command?: string): Promise<string | undefined> {
    if (!RELEASABLE.includes(job.state)) return `release não se aplica ao estado ${job.state}`;
    const context = { job: job.key, reason: "liberado-pelo-operador", ...(command === undefined ? {} : { refs: { comando: command } }) };
    const decision = await this.deps.writes.release(job.ref, context);
    if (decision.status === "not-confirmed") return decision.reason;
    await this.deps.registry.apply(job.key, "released", {
      message: "claim removido pelo operador; acompanhamento encerrado; área, sessão e PR preservados",
      reason: "liberado pelo operador",
    });
    return undefined;
  }
}
