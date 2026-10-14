import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { PrPort } from "../pr/port.js";
import type { Runner } from "../runtime/runner.js";
import { evaluateEligibility, type Verdict } from "./eligibility.js";
import type { CommandQueue, OperatorCommand } from "./commands.js";
import type { InstanceControl } from "./instance-control.js";
import { appendLog, holdsSlot, newJob, type Continuation, type Job, type JobState } from "./job.js";
import {
  continuationCauses, noteManualResume,
  planCommands, planContinuation, planItems, recordTriageOutcome,
  resumeRefusal, triageInProgress, type PlanStep, type TriageOutcome,
} from "./feedback.js";
import type { JobStore } from "./job-store.js";
import type { ProjectEligibility } from "./project-eligibility.js";
import { issueContextOf } from "./issue-context.js";
import { normalizePriority } from "./priority.js";
import { deliveryOf, type Delivery } from "./pr-rules.js";
import { PrTracking } from "./pr-tracking.js";
import { OperatorInput } from "./operator-input.js";
import { noopObserver, type FieldValue, type Observer } from "./observability.js";
import { triggerSummary } from "./ops-events.js";
import type { AttentionKeeper } from "./attention.js";
import { Announcements } from "./announcements.js";
import { JobRegistry } from "./job-registry.js";
import { ExecutionLoop, type ExecutionOutcome } from "./execution-loop.js";
import { IssueWrites, type IssueWritesContext } from "./issue-writes.js";
import type { AssistOperator } from "./assist-flow.js";
import { refKey, type IssueRef, type IssueSnapshot, type TrackerPort } from "../tracker/port.js";
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

// Continuations allowed from each state: a resume answers a help request or continues an
// interrupted job; a correction answers feedback on an open PR.
const CONTINUATIONS: Record<Continuation, readonly JobState[]> = {
  resume: ["waiting-for-help", "interrupted"],
  correction: ["waiting-for-pr"],
};

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

export class Admission {
  readonly unreadable: readonly string[];
  private readonly registry: JobRegistry;
  private readonly loop: ExecutionLoop;
  private readonly prTracking: PrTracking;
  private readonly input: OperatorInput;
  private readonly obs: Observer;
  private readonly writes: IssueWrites;
  private readonly announcements: Announcements;

  private constructor(private readonly deps: AdmissionDeps, loaded: Job[], unreadable: string[]) {
    this.obs = deps.observer ?? noopObserver;
    this.announcements = new Announcements(this.obs, deps.attention);
    this.writes = new IssueWrites(deps.tracker, this.obs);
    this.registry = new JobRegistry(deps.store, deps.instance.maxConcurrent, this.announcements, loaded, unreadable);
    this.prTracking = new PrTracking(deps.prs, this.writes, this.registry, this.announcements, deps.runner);
    this.loop = new ExecutionLoop(deps.runner, this.registry, this.announcements,
      (key, outcome, delivery, invocation) => this.interpretExecution(key, outcome, delivery, invocation));
    this.input = new OperatorInput({
      commands: deps.commands, tracker: deps.tracker, registry: this.registry,
      announcements: this.announcements, writes: this.writes,
      requestContinuation: this.requestContinuation.bind(this), control: deps.control, observer: this.obs,
      ...(deps.assistOperator === undefined ? {} : { assistOperator: deps.assistOperator }),
    });
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

  // Waits for every dispatched run, including persistence of its result.
  async settle(): Promise<unknown[]> {
    return this.loop.settle();
  }

  // One polling cycle: operator commands in queue order, directed replies in the tracker,
  // then waiting PRs, whose feedback becomes corrections, then, unless paused,
  // continuations first and new work by priority.
  async poll(): Promise<PollReport> {
    const report: PollReport = { admitted: [], skipped: [], errors: [], commands: [], paused: false };
    const inputReport: Parameters<OperatorInput["processCommands"]>[0] = {
      comando: (outcome) => { report.commands.push(outcome); },
      pular: (key, reason) => { report.skipped.push({ key, reason }); },
      falhar: (key, message) => { report.errors.push({ key, message }); },
    };
    await this.input.processCommands(inputReport);
    await this.input.collectTrackerFeedback(inputReport);
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
      await this.guard(job.key, report, () => this.prTracking.trackPr(job, this.enabledProjectOf(job), {
        pular: (key, reason) => { report.skipped.push({ key, reason }); },
        falhar: (key, message) => { report.errors.push({ key, message }); },
      }));
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
    const blocked = this.registry.tryReserve(job);
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
    this.loop.dispatch(key, ref, "new", this.deps.instance.maxIterations, deliveryOf(candidate.project, ref), invocation, undefined, issueContextOf(snapshot));
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
    const blocked = this.registry.tryReserve(job);
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
    this.loop.dispatch(running.key, running.ref, kind, 1, deliveryOf(project, running.ref), invocation, { workspace, plan });
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

  // The loop reports a result, not a state change. PR validation goes to the tracking
  // module; job transitions are followed by recording how the triage step ended.
  private async interpretExecution(key: string, outcome: ExecutionOutcome, delivery: Delivery, invocation: string): Promise<void> {
    switch (outcome.status) {
      case "pr_ready":
        await this.prTracking.acceptPr(key, outcome.pr, delivery, invocation);
        break;
      case "needs_help":
        await this.registry.apply(key, "waiting-for-help", {
          message: `pedido de ajuda: ${outcome.question}`,
          question: outcome.question,
          context: outcome.context,
          invocation,
        });
        break;
      case "interrupted":
        await this.registry.apply(key, "interrupted", { message: `interrompido: ${outcome.reason}`, reason: outcome.reason, invocation });
        break;
      case "runner_failure": {
        const reason = "runner falhou sem resultado estruturado";
        await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
        break;
      }
      case "invalid":
      case "iteration_limit":
        await this.registry.apply(key, "intervention-required", { message: outcome.reason, reason: outcome.reason, invocation });
        break;
    }
    await this.settleTriage(key, outcome.triage.step, outcome.triage.outcome);
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
}
