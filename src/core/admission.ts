import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { Mergeability, PrFeedback, PrLookup, PrPort, PrSnapshot } from "../pr/port.js";
import type { ContinuationContext, IssueContext, Runner, RunnerContext, RunKind, RunnerOutput } from "../runtime/runner.js";
import { evaluateEligibility, type Verdict } from "./eligibility.js";
import type { CommandQueue, OperatorCommand } from "./commands.js";
import type { InstanceControl } from "./instance-control.js";
import { appendLog, holdsSlot, newJob, recordPrStatus, type Continuation, type Job, type JobState, type PrStatus } from "./job.js";
import {
  continuationCauses, describeItem, directedReply, judgeConflict, judgePrFeedback, needsTriage, noteManualResume,
  planCommands, planContinuation, planItems, receiveFeedback, recordTriageOutcome,
  resumeRefusal, triageInProgress, type DirectedReplyItem, type PlanStep, type TriageOutcome,
} from "./feedback.js";
import type { JobStore } from "./job-store.js";
import type { ProjectEligibility } from "./project-eligibility.js";
import { issueContextOf } from "./issue-context.js";
import { normalizePriority } from "./priority.js";
import { deliveryOf, judgeReadyPr, judgeTrackedPr, misplacedRepository, type Delivery } from "./pr-rules.js";
import { parseRunOutput, type PrRef } from "./result.js";
import { noopObserver, type FieldValue, type Observer } from "./observability.js";
import { triggerSummary } from "./ops-events.js";
import type { AttentionKeeper } from "./attention.js";
import { Announcements } from "./announcements.js";
import { JobRegistry } from "./job-registry.js";
import { IssueWrites, type IssueWritesContext } from "./issue-writes.js";
import type { AssistOperator, AssistOperatorResult } from "./assist-flow.js";
import { refKey, type IssueRef, type IssueSnapshot, type Known, type TrackerPort } from "../tracker/port.js";
import { messageOf } from "./values.js";

// The coordinator of one instance: admits eligible issues as jobs, keeps capacity
// and concurrency limits, runs the runner and records its result, and
// persists every change. Runners run in the background; `poll` returns once the
// admissions decided in that poll are dispatched.

export interface AdmissionDeps {
  instance: InstanceConfig;
  tracker: TrackerPort;
  runner: Runner;
  store: JobStore;
  commands: CommandQueue;
  control: InstanceControl;
  // Reads pull requests on github.com. It has no merge operation: the factory never merges.
  prs: PrPort;
  // The eligibility setup of each configured project, built by the configuration layer.
  eligibility: (project: ProjectConfig) => ProjectEligibility;
  // Commands the job store does not know may name an assisted session (ticket #56): the
  // assisted registry answers them here, so the queue keeps a single drain and one order.
  assistOperator?: AssistOperator;
  // Where the operational events go (main log and local history). Absent: nothing is observed.
  // Observing never changes what the admission does (issue #15).
  observer?: Observer;
  // The operator attention of ticket #59: agent help requests and human interventions of the
  // implementation flow raise persistent pendings (with a best-effort notification), and the
  // state changes that end them resolve them. Absent: no pendings are raised; the flow works
  // unchanged (attention is side plumbing, never core state).
  attention?: AttentionKeeper;
}

export interface CommandOutcome {
  id: string;
  type: OperatorCommand["type"];
  job?: string;
  status: "applied" | "rejected";
  reason?: string;
}

export interface PollReport {
  admitted: string[];
  skipped: Array<{ key: string; reason: string }>;
  errors: Array<{ key: string; message: string }>;
  commands: CommandOutcome[];
  // Whether the instance was paused when the poll ran. A paused poll admits nothing.
  paused: boolean;
}

export type ContinuationOutcome = { status: "queued" } | { status: "rejected"; reason: string };

// Commands that address one job; pause and unpause address the instance.
type JobCommand = Extract<OperatorCommand, { job: string }>;

// Continuations allowed from each state: a resume answers a help request or continues an
// interrupted job; a correction answers feedback on an open PR.
const CONTINUATIONS: Record<Continuation, readonly JobState[]> = {
  resume: ["waiting-for-help", "interrupted"],
  correction: ["waiting-for-pr"],
};

// Jobs an operator can release: none of them has an invocation running.
const RELEASABLE: readonly JobState[] = ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required"];

// Jobs whose issue is read for directed replies. A job that is done, released or needs
// intervention takes no input from the tracker.
const TRACKER_FEEDBACK_STATES: readonly JobState[] = ["waiting-for-help", "running", "interrupted", "waiting-for-pr"];

interface NewCandidate {
  ref: IssueRef;
  key: string;
  project: ProjectConfig;
  eligibility: ProjectEligibility;
  priority: number;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byPriorityThenIdentity = (a: NewCandidate, b: NewCandidate) =>
  a.priority - b.priority || byKey(a.key, b.key);

const statusKey = (status: PrStatus): string => JSON.stringify([status.checks, status.review, status.mergeable]);

const describeKnown = <T extends string>(label: string, known: Known<T>): string =>
  known.known ? `${label}: ${known.value}` : `${label}: desconhecido (${known.reason})`;

// Unknown mergeability is said as unknown: it is neither a conflict nor the absence of one.
const describeMergeable = (mergeable: Known<Mergeability>): string => {
  if (!mergeable.known) return `mergeabilidade desconhecida (${mergeable.reason})`;
  return mergeable.value === "conflicting" ? "PR em conflito" : "sem conflito";
};

const describeStatus = (status: PrStatus): string =>
  `${describeKnown("CI", status.checks)}; ${describeKnown("review", status.review)}; ${describeMergeable(status.mergeable)}`;

export class Admission {
  readonly unreadable: readonly string[];
  private readonly registry: JobRegistry;
  private readonly runs = new Set<Promise<void>>();
  private readonly runErrors: unknown[] = [];
  private readonly obs: Observer;
  private readonly writes: IssueWrites;
  private readonly announcements: Announcements;

  private constructor(private readonly deps: AdmissionDeps, loaded: Job[], unreadable: string[]) {
    this.obs = deps.observer ?? noopObserver;
    this.announcements = new Announcements(this.obs, deps.attention);
    this.writes = new IssueWrites(deps.tracker, this.obs);
    this.registry = new JobRegistry(deps.store, deps.instance.maxConcurrent, this.announcements, loaded, unreadable);
    this.unreadable = this.registry.unreadable;
  }

  // Opening recovers from a crash: any job that held a slot is interrupted and is not
  // executed again automatically.
  static async open(deps: AdmissionDeps): Promise<Admission> {
    const { jobs, unreadable } = await deps.store.load();
    const admission = new Admission(deps, jobs, unreadable);
    for (const job of jobs) {
      if (holdsSlot(job.state)) {
        await admission.registry.apply(job.key, "interrupted", {
          message: "orquestrador caiu com trabalho ativo; não reexecutado automaticamente",
          reason: "orquestrador caiu com trabalho ativo; não reexecutado automaticamente",
        });
      }
    }
    return admission;
  }

  job(key: string): Job | undefined {
    return this.registry.job(key);
  }

  allJobs(): Job[] {
    return this.registry.allJobs();
  }

  // Waits for every dispatched runner to finish; returns the errors of runs that failed
  // at the persistence level (runner failures are job results, not errors).
  async settle(): Promise<unknown[]> {
    while (this.runs.size > 0) await Promise.all(this.runs);
    return [...this.runErrors];
  }

  // One polling cycle: operator commands in queue order, directed replies in the tracker,
  // then waiting PRs, whose feedback becomes corrections, then, unless paused,
  // continuations first and new work by priority.
  async poll(): Promise<PollReport> {
    const report: PollReport = { admitted: [], skipped: [], errors: [], commands: [], paused: false };
    await this.processCommands(report);
    await this.collectTrackerFeedback(report);
    try {
      report.paused = await this.deps.control.isPaused();
    } catch (error) {
      // An unknown pause state admits nothing: unknown is not the same as not paused.
      report.errors.push({ key: "control", message: messageOf(error) });
      return report;
    }
    // A pause holds new invocations only: tracking of waiting PRs keeps observing and
    // confirming merges, as an active job would. Feedback found here is admitted by the
    // continuations below in the same poll, when a slot is free.
    for (const job of this.allJobs().filter((candidate) => candidate.state === "waiting-for-pr")) {
      await this.guard(job.key, report, () => this.trackPr(job, report));
    }
    const continuations = this.allJobs().filter((job) => job.pending !== undefined);
    if (!report.paused) {
      for (const job of continuations) {
        await this.guard(job.key, report, () => this.admitContinuation(job, report));
      }
    } else {
      // A pause is an impediment like a missing slot: the continuation waits and keeps its reason.
      for (const job of continuations) this.announcements.announceWait(job.key, job.pending!, "instância pausada", continuationCauses(job));
    }
    if (report.paused) return report;
    let candidates: NewCandidate[] = [];
    try {
      candidates = await this.discover(report);
    } catch (error) {
      report.errors.push({ key: "discovery", message: messageOf(error) });
    }
    for (const candidate of candidates) {
      await this.guard(candidate.key, report, () => this.admitNew(candidate, report));
    }
    return report;
  }

  // A manual resume (or a correction asked by hand) is a trigger of its own: it is kept with
  // the others until the invocation starts (issue #15).
  async requestContinuation(key: string, kind: Continuation, command?: string): Promise<ContinuationOutcome> {
    const job = this.registry.job(key);
    if (!job) return { status: "rejected", reason: "trabalho desconhecido" };
    // The triage ends only with the operator's answer: a resume while it waits is refused.
    if (kind === "resume") {
      const refusal = resumeRefusal(job);
      if (refusal !== undefined) return { status: "rejected", reason: refusal };
    }
    // A manual resume is a cause of its own, kept with the items until the invocation starts.
    const queued = noteManualResume(job, command);
    if (job.pending !== undefined) {
      if (command !== undefined) await this.registry.persist(queued);
      return { status: "queued" };
    }
    // A listing that failed with `intervention-required` left the triage in the `listing` phase: the
    // resume that redoes it is accepted from that state too. No other state gains a resume.
    if (!CONTINUATIONS[kind].includes(job.state)
      && !(kind === "resume" && job.state === "intervention-required" && triageInProgress(job))) {
      return { status: "rejected", reason: `${kind} não se aplica ao estado ${job.state}` };
    }
    await this.registry.persist({ ...appendLog(queued, `${kind} solicitado; aguarda vaga`), pending: kind });
    this.announcements.emitFor(key, "feedback-recebido", "retomada solicitada", triggerSummary(continuationCauses(queued)).fields);
    return { status: "queued" };
  }

  // What the IssueWrites module needs to know about a write it will make: the job, why, and the
  // evidence. The ref and the abstract operation belong to the module (ADR 0001).
  private writeContext(job: Job, reason: string, invocation?: string, refs?: Record<string, FieldValue>): IssueWritesContext {
    return { job: job.key, reason, ...(invocation === undefined ? {} : { invocation }), ...(refs === undefined ? {} : { refs }) };
  }

  // Applies the queued commands in order and removes each one once it has been applied.
  // A command whose application fails stays queued and is retried on the next poll.
  private async processCommands(report: PollReport): Promise<void> {
    let queued;
    try {
      queued = await this.deps.commands.pending();
    } catch (error) {
      report.errors.push({ key: "commands", message: messageOf(error) });
      return;
    }
    for (const name of queued.unreadable) {
      report.errors.push({ key: "commands", message: `comando ilegível: ${name}` });
    }
    // `approve` is the assisted attendance's approval (ticket #55): not a job command. The
    // assisted flow consumes it on the same cycle, after its supervision; consuming it here
    // would reject as "trabalho desconhecido" what is not an implementation job.
    for (const command of queued.commands
      .filter((candidate) => candidate.type !== "approve" || this.deps.assistOperator === undefined)) {
      try {
        report.commands.push(await this.handleCommand(command));
        await this.deps.commands.done(command.id);
      } catch (error) {
        report.errors.push({ key: command.id, message: messageOf(error) });
      }
    }
  }

  private async handleCommand(command: OperatorCommand): Promise<CommandOutcome> {
    const base = { id: command.id, type: command.type };
    if (command.type === "pause" || command.type === "unpause") {
      await this.deps.control.setPaused(command.type === "pause");
      this.obs.emit({
        kind: "comando-aplicado", text: command.type === "pause" ? "instância pausada" : "instância despausada", fields: { comando: command.id },
        ...(command.type === "pause" ? { level: "atenção" as const } : {}),
      });
      return { ...base, status: "applied" };
    }
    const job = this.registry.job(command.job);
    if (!job) {
      const assisted = await this.operateAssisted(command);
      if (assisted === undefined) return { ...base, job: command.job, status: "rejected", reason: "trabalho desconhecido" };
      if (assisted.status === "applied") {
        this.announcements.emitFor(command.job, "comando-aplicado", `${command.type} aplicado no atendimento assistido`, { comando: command.id });
        return { ...base, job: command.job, status: "applied" };
      }
      this.announcements.emitFor(command.job, "comando-rejeitado", `${command.type} rejeitado no atendimento assistido`, { comando: command.id, motivo: assisted.reason }, { level: "atenção" });
      return { ...base, job: command.job, status: "rejected", reason: assisted.reason };
    }
    const reason = await this.operate(job, command);
    if (reason === undefined) {
      // `reply aplicado` is the orchestrator taking the reply: neither delivery nor start of a run.
      this.announcements.emitFor(job.key, "comando-aplicado", `${command.type} aplicado`, { comando: command.id });
      return { ...base, job: job.key, status: "applied" };
    }
    await this.registry.note(job.key, `${command.type} rejeitado: ${reason}`);
    this.announcements.emitFor(job.key, "comando-rejeitado", `${command.type} rejeitado`, { comando: command.id, motivo: reason }, { level: "atenção" });
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
        const outcome = await this.requestContinuation(job.key, "resume", command.id);
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
    await this.registry.persist(outcome.job);
    return undefined;
  }

  // Directed replies in the tracker: a human comment without marker that starts with
  // `agent:`. Each comment is consumed once, by its id and revision.
  private async collectTrackerFeedback(report: PollReport): Promise<void> {
    for (const candidate of this.allJobs().filter((job) => TRACKER_FEEDBACK_STATES.includes(job.state))) {
      await this.guard(candidate.key, report, async () => {
        const comments = await this.deps.tracker.readComments(candidate.ref);
        const current = this.registry.job(candidate.key);
        if (!current) return;
        const consumed = new Set(current.consumed ?? []);
        const inputs = comments.flatMap((comment) => {
          const input = directedReply(candidate.ref.tracker, comment);
          return input !== undefined && input.key !== undefined && !consumed.has(input.key) ? [input] : [];
        });
        if (inputs.length === 0) return;
        const outcome = receiveFeedback(current, inputs, "resposta dirigida recebida na issue");
        if ("reason" in outcome) {
          report.skipped.push({ key: current.key, reason: `feedback da issue ${outcome.reason}` });
          return;
        }
        await this.registry.persist(outcome.job);
        this.announcements.announceFeedback(current.key, inputs);
      });
    }
  }

  // Removes the claim and ends tracking; area, session and PR stay on the job. Never moves
  // the issue to done and never touches the PR. The write sequence and its
  // reconciliation after an error belong to IssueWrites (ADR 0001).
  private async release(job: Job, command?: string): Promise<string | undefined> {
    if (!RELEASABLE.includes(job.state)) return `release não se aplica ao estado ${job.state}`;
    const context = this.writeContext(job, "liberado-pelo-operador", undefined, command === undefined ? undefined : { comando: command });
    const decision = await this.writes.release(job.ref, context);
    if (decision.status === "not-confirmed") return decision.reason;
    await this.registry.apply(job.key, "released", {
      message: "claim removido pelo operador; acompanhamento encerrado; área, sessão e PR preservados",
      reason: "liberado pelo operador",
    });
    return undefined;
  }

  private async guard(key: string, report: PollReport, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      report.errors.push({ key, message: messageOf(error) });
    }
  }

  private async discover(report: PollReport): Promise<NewCandidate[]> {
    const candidates: NewCandidate[] = [];
    for (const project of this.deps.instance.projects) {
      if (!project.enabled) continue;
      const eligibility = this.deps.eligibility(project);
      const refs = await this.deps.tracker.discoverCandidates(eligibility.scope);
      for (const ref of refs) {
        const key = refKey(ref);
        if (this.registry.job(key)) continue;
        if (this.registry.unreadableKeys.has(key)) {
          report.skipped.push({ key, reason: "arquivo do trabalho ilegível; não readmitido" });
          continue;
        }
        const snapshot = await this.deps.tracker.readIssue(ref);
        const verdict = this.verdictFor(eligibility, snapshot, this.registry.trackedKeys());
        if (!verdict.eligible) {
          report.skipped.push({ key, reason: this.describe(verdict) });
          continue;
        }
        candidates.push({ ref, key, project, eligibility, priority: normalizePriority(snapshot.priority) });
      }
    }
    return candidates.sort(byPriorityThenIdentity);
  }

  private verdictFor(eligibility: ProjectEligibility, snapshot: IssueSnapshot, tracked: ReadonlySet<string>): Verdict {
    return evaluateEligibility({ project: eligibility.project, issue: snapshot, tracked }, eligibility.rules);
  }

  private describe(verdict: Verdict): string {
    return verdict.eligible ? "" : verdict.rejections.map((rejection) => rejection.reason).join("; ");
  }

  // Admission sequence: reread eligibility, reserve the slot, persist the job, claim,
  // confirm claim and doing state, and only then dispatch the runner.
  private async admitNew(candidate: NewCandidate, report: PollReport): Promise<void> {
    const { ref, key } = candidate;
    if (this.registry.isTracked(key)) {
      report.skipped.push({ key, reason: "já acompanhada pelo script" });
      return;
    }
    const snapshot = await this.deps.tracker.readIssue(ref);
    const verdict = this.verdictFor(candidate.eligibility, snapshot, this.registry.trackedKeys());
    if (!verdict.eligible) {
      report.skipped.push({ key, reason: this.describe(verdict) });
      return;
    }
    // Fail fast (ADR 0002): a required item of the runtime profile missing means no claim, no slot, no job.
    const runtimeBlock = await this.runtimeBlocker(candidate.project.repository, ref);
    if (runtimeBlock !== undefined) {
      this.announcements.announceRuntimeBlock(key, runtimeBlock);
      report.skipped.push({ key, reason: `perfil de runtime: ${runtimeBlock}` });
      return;
    }
    const job = newJob({ ref, repository: candidate.project.repository });
    const blocked = this.registry.reserve(job);
    if (blocked) {
      this.announcements.announceWait(key, "issue-elegível", blocked, []);
      report.skipped.push({ key, reason: blocked });
      return;
    }
    await this.registry.persist(job);
    await this.registry.note(key, "vaga reservada; claim solicitado");

    const context = this.writeContext(job, "admissão");
    const decision = await this.writes.start(ref, context);
    if (decision.status === "refused") {
      await this.registry.forget(key);
      report.skipped.push({ key, reason: `claim recusado pelo tracker: ${decision.reason}` });
      return;
    }
    if (decision.status === "retry") {
      // Nothing was written: the job is forgotten and the next poll tries again.
      await this.registry.forget(key);
      report.errors.push({ key, message: decision.reason });
      return;
    }
    if (decision.status === "intervention") {
      // The issue may hold a claim the factory did not prove it made: an operator decides.
      await this.registry.apply(key, "intervention-required", { message: decision.reason, reason: decision.reason });
      if (decision.kind === "unconfirmed-start") report.errors.push({ key, message: decision.reason });
      return;
    }
    await this.registry.note(key, `início confirmado; runner disparado (${this.deps.instance.maxIterations} iterações)`);
    report.admitted.push(key);
    // `trabalho admitido` is only for this first admission; later starts say why they continue.
    this.announcements.emitFor(key, "trabalho-admitido", "trabalho admitido", { motivo: "issue-elegível" });
    this.announcements.clearWaits(key);
    const invocation = this.announcements.startInvocation(key, "new", [], {});
    this.dispatch(key, ref, "new", this.deps.instance.maxIterations, deliveryOf(candidate.project, ref), invocation, undefined, issueContextOf(snapshot));
  }

  private async admitContinuation(job: Job, report: PollReport): Promise<void> {
    const kind = job.pending!;
    const project = this.enabledProjectOf(job);
    if (!project) {
      report.skipped.push({ key: job.key, reason: "projeto do trabalho não está habilitado na instância" });
      return;
    }
    const snapshot = await this.deps.tracker.readIssue(job.ref);
    if (!snapshot.claimed.known || !snapshot.statusCategory.known) {
      report.skipped.push({ key: job.key, reason: "estado externo ilegível; nova leitura no próximo polling" });
      return;
    }
    if (!snapshot.claimed.value) {
      await this.registry.apply(job.key, "intervention-required", {
        message: "claim não está mais registrado no tracker; não reclamado automaticamente",
        reason: "claim não está mais registrado no tracker; não reclamado automaticamente",
      });
      return;
    }
    if (snapshot.statusCategory.value === "done") {
      await this.registry.apply(job.key, "intervention-required", {
        message: "issue terminal no tracker", reason: "issue terminal no tracker",
      });
      return;
    }
    const workspace = job.workspace;
    const missing = [workspace === undefined ? "sessão e área" : undefined, project.runtimeProfile.trim() === "" ? "perfil" : undefined]
      .filter((item): item is string => item !== undefined)
      .join(" e ");
    if (missing !== "" || workspace === undefined) {
      // No conversation is started silently: the operator decides what happens next.
      await this.registry.apply(job.key, "waiting-for-help", {
        message: `${kind} sem ${missing}: pedido de ajuda; nenhuma conversa nova foi iniciada`,
        question: `${kind} solicitado, mas falta ${missing} para continuar a sessão anterior: responda com a orientação ou libere o trabalho`,
        context: "nenhuma conversa nova foi iniciada",
      });
      return;
    }
    // The same block holds for work already admitted: no container is created, the operator is asked.
    const runtimeBlock = await this.runtimeBlocker(job.repository, job.ref);
    if (runtimeBlock !== undefined) {
      await this.registry.apply(job.key, "waiting-for-help", {
        message: `${kind} bloqueado pelo perfil de runtime: ${runtimeBlock}`,
        question: `${kind} solicitado, mas o perfil de runtime não pode ser reproduzido: ${runtimeBlock}.`
          + " Nenhum container foi criado. Corrija o perfil e responda para retomar, ou libere o trabalho.",
        context: "nenhum container foi criado",
      });
      return;
    }
    const blocked = this.registry.reserve(job);
    if (blocked) {
      this.announcements.announceWait(job.key, kind, blocked, continuationCauses(job));
      report.skipped.push({ key: job.key, reason: blocked });
      return;
    }
    // The plan consumes the pending items: this invocation delivers them, and the triage phase
    // advances or stays according to the outcome of this invocation.
    const { job: planned, plan, causes } = planContinuation(job, kind);
    await this.registry.persist(planned);
    const count = planItems(plan).length;
    const delivered = count > 0 ? `; ${count} item(ns) de feedback entregue(s)` : "";
    const triage = plan.step === "continue" ? undefined : plan.step;
    const how = triage === "list" ? " (triagem do feedback do PR)" : triage === "apply" ? " (aplica a escolha da triagem)" : "";
    const running = await this.registry.apply(job.key, "running", {
      message: `${kind} admitido${how}; limite de 1 iteração${delivered}`,
    });
    report.admitted.push(job.key);
    this.announcements.clearWaits(job.key);
    const commands = planCommands(plan);
    const invocation = this.announcements.startInvocation(job.key, kind, causes, { sessão: workspace.session, área: workspace.area });
    for (const command of commands) {
      this.announcements.emitFor(job.key, "resposta-incluída", "resposta incluída na retomada", { comando: command }, { invocation });
    }
    // The runner receives the typed plan; it derives the conflict and the commands from its items.
    this.dispatch(running.key, running.ref, kind, 1, deliveryOf(project, running.ref), invocation, { workspace, plan });
  }

  // Why the runtime profile of a job cannot be reproduced, or undefined. A check that fails is a block: an
  // unknown profile is not a complete one.
  private async runtimeBlocker(repository: string, ref: IssueRef): Promise<string | undefined> {
    try {
      return await this.deps.runner.runtimeBlocker?.({ ref, repository });
    } catch (error) {
      return `o perfil não pôde ser verificado: ${messageOf(error)}`;
    }
  }

  private dispatch(
    key: string,
    ref: IssueRef,
    kind: RunKind,
    maxIterations: number,
    delivery: Delivery,
    invocation: string,
    continuation?: ContinuationContext,
    issue?: IssueContext,
  ): void {
    const run: Promise<void> = this.execute(key, ref, kind, maxIterations, delivery, invocation, continuation, issue).catch((error: unknown) => {
      this.runErrors.push(error);
    });
    this.runs.add(run);
    void run.then(() => this.runs.delete(run));
  }

  // Up to maxIterations invocations of the runner. A final output that is absent,
  // ambiguous or invalid is never success and stops the job at once.
  private async execute(
    key: string,
    ref: IssueRef,
    kind: RunKind,
    maxIterations: number,
    delivery: Delivery,
    invocation: string,
    continuation?: ContinuationContext,
    issue?: IssueContext,
  ): Promise<void> {
    const step: PlanStep | undefined = continuation?.plan.step;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      let output: RunnerOutput;
      const context: RunnerContext = {
        jobId: key,
        ref,
        repository: delivery.repository,
        kind,
        iteration,
        maxIterations,
        invocation,
        ...(continuation ? { continuation } : {}),
        ...(issue ? { issue } : {}),
      };
      try {
        output = await this.deps.runner.run(context);
      } catch {
        this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "falha-do-runner" }, { invocation, level: "erro" });
        await this.registry.apply(key, "intervention-required", {
          message: "runner falhou sem resultado estruturado",
          reason: "runner falhou sem resultado estruturado",
          invocation,
        });
        await this.settleTriage(key, step, "incomplete");
        return;
      }
      if (output.workspace) await this.registry.update(key, { workspace: output.workspace });
      if (output.kind === "continue") {
        this.announcements.emitFor(key, "invocação-encerrada", "iteração encerrada sem resultado final", { iteração: `${iteration}/${maxIterations}`, resultado: "sem-resultado" }, { invocation, level: "atenção" });
        if (iteration < maxIterations) {
          await this.registry.note(key, `iteração ${iteration}/${maxIterations} (${kind}) sem resultado final; nova iteração`);
        }
        continue;
      }
      const parsed = parseRunOutput(output.results);
      if (!parsed.ok) {
        const reason = `resultado inválido: ${parsed.reason}`;
        this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "inválido" }, { invocation, level: "atenção" });
        await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
        await this.settleTriage(key, step, "incomplete");
        return;
      }
      const result = parsed.result;
      this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: result.status }, { invocation });
      switch (result.status) {
        case "needs_help":
          await this.registry.apply(key, "waiting-for-help", {
            message: `pedido de ajuda: ${result.question}`,
            question: result.question,
            context: result.context,
            invocation,
          });
          await this.settleTriage(key, step, "help");
          return;
        case "pr_ready":
          if (step === "list") {
            // The operator has not chosen yet: a PR taken as ready now would drop the triaged comments.
            const reason = "triagem terminou com PR pronto em vez de pedido de ajuda; os comentários não foram escolhidos pelo operador";
            await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
            await this.settleTriage(key, step, "incomplete");
            return;
          }
          await this.acceptPr(key, result.pr, delivery, invocation);
          await this.settleTriage(key, step, "complete");
          return;
        case "interrupted":
          await this.registry.apply(key, "interrupted", { message: `interrompido: ${result.reason}`, reason: result.reason, invocation });
          await this.settleTriage(key, step, "incomplete");
          return;
      }
    }
    const reason = `limite de iterações (${maxIterations}) atingido sem resultado válido`;
    await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
    await this.settleTriage(key, step, "incomplete");
  }

  // Records how the invocation that carries a triage step ended: the phase advances, stays or is
  // cleared by the module that owns it (issue #21).
  private async settleTriage(key: string, step: PlanStep | undefined, outcome: TriageOutcome): Promise<void> {
    if (step === undefined) return;
    const current = this.registry.job(key);
    if (!current) return;
    const next = recordTriageOutcome(current, step, outcome);
    if (next !== current) await this.registry.persist(next);
  }

  private enabledProjectOf(job: Job): ProjectConfig | undefined {
    return this.deps.instance.projects.find((candidate) => candidate.repository === job.repository && candidate.enabled);
  }

  // A "PR pronto" result is accepted only after the PR port confirms it. An
  // invalid PR is a help request. A PR that cannot be read is neither success nor help: the
  // operator decides, so the job needs intervention.
  private async acceptPr(key: string, pr: PrRef, delivery: Delivery, invocation?: string): Promise<void> {
    const misplaced = misplacedRepository(pr, delivery);
    if (misplaced !== undefined) {
      await this.refusePr(key, pr, misplaced, invocation);
      return;
    }
    let lookup: PrLookup;
    try {
      lookup = await this.deps.prs.readPr(pr);
    } catch (error) {
      await this.registry.apply(key, "intervention-required", {
        message: `PR não pôde ser confirmado: ${messageOf(error)}`,
        reason: `PR não pôde ser confirmado no github.com: ${messageOf(error)}`,
        invocation,
      });
      return;
    }
    const verdict = judgeReadyPr(lookup, delivery);
    if (!verdict.valid) {
      await this.refusePr(key, pr, verdict.reason, invocation);
      return;
    }
    await this.registry.apply(key, "waiting-for-pr", { message: `PR validado: ${pr.repository}#${pr.number}`, pr, invocation });
    if (lookup.status === "found") await this.observe(key, lookup.pr);
  }

  private async refusePr(key: string, pr: PrRef, reason: string, invocation?: string): Promise<void> {
    await this.registry.apply(key, "waiting-for-help", {
      message: `PR pronto recusado: ${reason}`,
      question: `PR pronto não confirmado (${pr.repository}#${pr.number}): ${reason}. Corrija o PR ou informe o próximo passo.`,
      context: "",
      invocation,
    });
  }

  // Polling of a PR the job waits for: CI and review are recorded, a merge into
  // the target branch completes the job, and a PR closed without merge interrupts it.
  private async trackPr(job: Job, report: PollReport): Promise<void> {
    const project = this.enabledProjectOf(job);
    if (!project) {
      report.skipped.push({ key: job.key, reason: "projeto do trabalho não está habilitado na instância" });
      return;
    }
    const pr = job.pr;
    if (!pr) {
      await this.registry.apply(job.key, "intervention-required", {
        message: "trabalho aguardando PR sem referência de PR",
        reason: "trabalho aguardando PR sem referência de PR",
      });
      return;
    }
    let lookup: PrLookup;
    try {
      lookup = await this.deps.prs.readPr(pr);
    } catch (error) {
      report.errors.push({ key: job.key, message: `PR não pôde ser lido: ${messageOf(error)}` });
      return;
    }
    const verdict = judgeTrackedPr(lookup, deliveryOf(project, job.ref));
    switch (verdict.kind) {
      case "open":
        await this.observe(job.key, verdict.pr);
        // Comments first: a batch with a human comment waits for its triage, and a job that went to the
        // human because of it takes no conflict (issue #21).
        await this.collectPrFeedback(job, pr, report);
        await this.collectConflict(job, verdict.pr, report);
        return;
      case "merged":
        await this.announceMerge(job, pr, project.targetBranch);
        await this.complete(job, report, project.targetBranch);
        return;
      case "closed": {
        const reason = `PR fechado sem merge: ${pr.repository}#${pr.number}; não reaberto, issue fora de done`;
        await this.registry.apply(job.key, "interrupted", { message: reason, reason });
        return;
      }
      case "invalid": {
        const reason = `PR acompanhado não confere: ${verdict.reason}`;
        await this.registry.apply(job.key, "intervention-required", { message: reason, reason });
        return;
      }
    }
  }

  // A conflict of the open PR with its target branch becomes a correction with a slot and
  // a reason of its own. It is judged on the commits read now, so a failing feedback read never hides it.
  private async collectConflict(job: Job, snapshot: PrSnapshot, report: PollReport): Promise<void> {
    const current = this.registry.job(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const input = judgeConflict(snapshot, new Set(current.consumed ?? []));
    if (input === undefined) return;
    const outcome = receiveFeedback(current, [input], "conflito do PR recebido");
    if ("reason" in outcome) {
      report.skipped.push({ key: current.key, reason: `conflito do PR ${outcome.reason}` });
      return;
    }
    await this.registry.persist(outcome.job);
    this.announcements.announceFeedback(current.key, [input]);
  }

  // Feedback on an open PR: human comments (conversation, inline, review bodies), and failing checks, become
  // a correction with a slot and priority. A case the factory cannot decide goes to the human,
  // and its items are consumed so they are not asked again.
  private async collectPrFeedback(job: Job, pr: PrRef, report: PollReport): Promise<void> {
    let feedback: PrFeedback;
    try {
      feedback = await this.deps.prs.readFeedback(pr);
    } catch (error) {
      report.errors.push({ key: job.key, message: `feedback do PR não pôde ser lido: ${messageOf(error)}` });
      return;
    }
    const current = this.registry.job(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const judgement = judgePrFeedback(feedback, new Set(current.consumed ?? []), pr);
    if (judgement.inputs.length === 0 && judgement.undecidable === undefined) return;
    const consumed = judgement.inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
    if (judgement.undecidable === undefined) {
      if (needsTriage(judgement.inputs)) {
        // A human comment is never corrected without its triage (issue #21): without the skill the
        // operator is asked, and nothing is consumed, so the comments come back with the PR.
        const unavailable = await this.deps.runner.triageUnavailable?.({ ref: current.ref, repository: current.repository });
        if (unavailable !== undefined) {
          await this.registry.apply(job.key, "waiting-for-help", {
            message: `triagem do feedback do PR indisponível: ${unavailable}`,
            question: `Há comentário humano novo no PR (${pr.repository}#${pr.number}) e a triagem com /skill:gh-address-comments não pode rodar: ${unavailable}.`
              + " Nenhuma correção foi feita e nenhum item foi consumido: eles voltam a ser lidos quando o PR for acompanhado de novo."
              + " Resolva a causa e responda para retomar, ou libere o trabalho.",
            context: "",
          });
          return;
        }
      }
      const outcome = receiveFeedback(current, judgement.inputs, "feedback do PR recebido");
      if ("reason" in outcome) {
        report.skipped.push({ key: job.key, reason: `feedback do PR ${outcome.reason}` });
        return;
      }
      await this.registry.persist(outcome.job);
      this.announcements.announceFeedback(job.key, judgement.inputs);
      return;
    }
    const items = judgement.inputs.length === 0 ? "" : ` Itens: ${judgement.inputs.map(describeItem).join("; ")}.`;
    await this.registry.apply(job.key, "waiting-for-help", {
      message: `feedback do PR exige decisão humana: ${judgement.undecidable}`,
      question: `Feedback do PR (${pr.repository}#${pr.number}) não pode ser decidido pela factory: ${judgement.undecidable}.`
        + `${items} Responda com a orientação ou libere o trabalho.`,
      context: "",
      consumed,
    });
  }

  // The external merge of the linked PR, seen once: recorded on the job before it is announced,
  // so the next polls (while `done` is still pending) do not repeat it. The factory never merges.
  private async announceMerge(job: Job, pr: PrRef, targetBranch: string): Promise<void> {
    const current = this.registry.job(job.key) ?? job;
    if (current.mergeDetected !== undefined) return;
    await this.registry.persist({ ...current, mergeDetected: new Date().toISOString() });
    this.announcements.emitFor(job.key, "merge-detectado", "merge detectado", {
      pr: `${pr.repository}#${pr.number}`, destino: targetBranch, origem: "externa",
    }, { level: "progresso" });
  }

  // Merge confirmed by the PR port: the issue is done only when the tracker confirms it by
  // reread. Until then the job keeps waiting and the next poll tries again.
  private async complete(job: Job, report: PollReport, targetBranch: string): Promise<void> {
    const decision = await this.writes.complete(job.ref, this.writeContext(job, "conclusão-após-merge"));
    if (decision.status === "pending") {
      this.announcements.emitFor(job.key, "conclusão-pendente", "merge confirmado; done ainda não confirmado", {
        motivo: decision.reason, próximo: "nova tentativa no próximo polling",
      }, { level: "atenção" });
      report.errors.push({
        key: job.key,
        message: `PR mesclado; done ainda não confirmado pelo tracker (${decision.reason}): nova tentativa no próximo polling`,
      });
      return;
    }
    await this.registry.apply(job.key, "done", {
      message: `PR mesclado em ${targetBranch}: issue done confirmada por releitura`,
    });
  }

  // Stores the latest PR observation; the log gets a line only when CI or review changed.
  private async observe(key: string, pr: PrSnapshot): Promise<void> {
    const current = this.registry.job(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const status: PrStatus = { checks: pr.checks, review: pr.review, mergeable: pr.mergeable };
    if (current.prStatus && statusKey(current.prStatus) === statusKey(status)) return;
    await this.registry.persist(recordPrStatus(current, status, describeStatus(status)));
    this.announcements.emitFor(key, "acompanhamento-pr", "acompanhamento do PR alterado", {
      pr: `${pr.ref.repository}#${pr.ref.number}`,
      ci: status.checks.known ? status.checks.value : `desconhecido (${status.checks.reason})`,
      review: status.review.known ? status.review.value : `desconhecido (${status.review.reason})`,
      mergeabilidade: describeMergeable(status.mergeable),
    });
  }
}
