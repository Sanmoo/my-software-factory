import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { Mergeability, PrFeedback, PrLookup, PrPort, PrSnapshot } from "../pr/port.js";
import type { ContinuationContext, IssueContext, Runner, RunnerContext, RunKind, RunnerOutput } from "../runtime/runner.js";
import { evaluateEligibility, type Verdict } from "./eligibility.js";
import type { CommandQueue, OperatorCommand } from "./commands.js";
import type { InstanceControl } from "./instance-control.js";
import { appendLog, holdsSlot, newJob, recordPrStatus, transitionJob, type Continuation, type HeldFeedback, type Job, type JobState, type PrStatus, type Trigger } from "./job.js";
import { directedReply, judgeConflict, judgePrFeedback, needsTriage, planContinuation, receiveFeedback } from "./feedback.js";
import { unreadableKeys, type JobStore } from "./job-store.js";
import type { ProjectEligibility } from "./project-eligibility.js";
import { issueContextOf } from "./issue-context.js";
import { normalizePriority } from "./priority.js";
import { deliveryOf, judgeReadyPr, judgeTrackedPr, misplacedRepository, type Delivery } from "./pr-rules.js";
import { parseRunOutput, type PrRef } from "./result.js";
import { noopObserver, type FieldValue, type Level, type Observer } from "./observability.js";
import { issueChangeEvent, issueWriteAttempt, issueWriteFailure, triggerSummary, type IssueWriteContext } from "./ops-events.js";
import { PartialWriteError, refKey, type IssueChange, type IssueRef, type IssueSnapshot, type Known, type TrackerPort } from "../tracker/port.js";
import { messageOf } from "./values.js";

// The coordinator of one instance: admits eligible issues as jobs (R04), keeps capacity
// and concurrency limits (R05), runs the runner and records its result (R08, R09), and
// persists every change (P01). Runners run in the background; `poll` returns once the
// admissions decided in that poll are dispatched.

export interface AdmissionDeps {
  instance: InstanceConfig;
  tracker: TrackerPort;
  runner: Runner;
  store: JobStore;
  commands: CommandQueue;
  control: InstanceControl;
  // Reads pull requests on github.com. It has no merge operation: the factory never merges (R11).
  prs: PrPort;
  // The eligibility setup of each configured project, built by the configuration layer.
  eligibility: (project: ProjectConfig) => ProjectEligibility;
  // Where the operational events go (main log and local history). Absent: nothing is observed.
  // Observing never changes what the admission does (issue #15).
  observer?: Observer;
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
  // Whether the instance was paused when the poll ran (R09). A paused poll admits nothing.
  paused: boolean;
}

export type ContinuationOutcome = { status: "queued" } | { status: "rejected"; reason: string };

// Commands that address one job; pause and unpause address the instance.
type JobCommand = Extract<OperatorCommand, { job: string }>;

// Continuations allowed from each state: a resume answers a help request or continues an
// interrupted job; a correction answers feedback on an open PR (R09, R10).
const CONTINUATIONS: Record<Continuation, readonly JobState[]> = {
  resume: ["waiting-for-help", "interrupted"],
  correction: ["waiting-for-pr"],
};

// Jobs an operator can release: none of them has an invocation running (R09).
const RELEASABLE: readonly JobState[] = ["waiting-for-help", "waiting-for-pr", "interrupted", "intervention-required"];

// A removal the reread shows as done: the label is no longer on the issue, or the account is no
// longer among its assignees. Each change is judged by its own field, so a removal the reread
// cannot see, or a change without a target, stays attempted.
const removalConfirmedByReread = (change: IssueChange, snapshot: IssueSnapshot | undefined): boolean => {
  if (snapshot === undefined || change.result !== "attempted" || change.target === undefined) return false;
  if (change.operation === "remover-label") return snapshot.labels.known && !snapshot.labels.value.includes(change.target);
  if (change.operation === "remover-atribuição") return snapshot.assignees.known && !snapshot.assignees.value.includes(change.target);
  return false;
};

// The reread shows the claim gone: neither the label nor an assignee is left on the issue.
const claimGone = (snapshot: IssueSnapshot | undefined): boolean =>
  snapshot !== undefined && snapshot.claimed.known && !snapshot.claimed.value;

// Jobs whose issue is read for directed replies (CA11). A job that is done, released or needs
// intervention takes no input from the tracker.
const TRACKER_FEEDBACK_STATES: readonly JobState[] = ["waiting-for-help", "running", "interrupted", "waiting-for-pr"];

const UNRESOLVED_START = "início não confirmado pelo tracker: claim e doing não estão visíveis";

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

// Unknown mergeability is said as unknown: it is neither a conflict nor the absence of one (R10).
const describeMergeable = (mergeable: Known<Mergeability>): string => {
  if (!mergeable.known) return `mergeabilidade desconhecida (${mergeable.reason})`;
  return mergeable.value === "conflicting" ? "PR em conflito" : "sem conflito";
};

const describeStatus = (status: PrStatus): string =>
  `${describeKnown("CI", status.checks)}; ${describeKnown("review", status.review)}; ${describeMergeable(status.mergeable)}`;

export class Admission {
  readonly unreadable: readonly string[];
  private readonly jobs = new Map<string, Job>();
  // Keys of job files that could not be read: their issues stay tracked, never re-admitted.
  private readonly unreadableKeys: ReadonlySet<string>;
  private readonly runs = new Set<Promise<void>>();
  private readonly runErrors: unknown[] = [];
  private readonly obs: Observer;
  private invocationSeq = 0;
  // Waits already announced, so a poll that finds the same wait again does not repeat the event.
  private readonly announcedWaits = new Set<string>();

  private constructor(private readonly deps: AdmissionDeps, loaded: Job[], unreadable: string[]) {
    this.obs = deps.observer ?? noopObserver;
    for (const job of loaded) this.jobs.set(job.key, job);
    this.unreadable = unreadable;
    this.unreadableKeys = new Set(unreadableKeys(unreadable));
  }

  // Opening recovers from a crash: any job that held a slot is interrupted and is not
  // executed again automatically (R12).
  static async open(deps: AdmissionDeps): Promise<Admission> {
    const { jobs, unreadable } = await deps.store.load();
    const admission = new Admission(deps, jobs, unreadable);
    for (const job of jobs) {
      if (holdsSlot(job.state)) {
        await admission.apply(job.key, "interrupted", {
          message: "orquestrador caiu com trabalho ativo; não reexecutado automaticamente",
          reason: "orquestrador caiu com trabalho ativo; não reexecutado automaticamente",
        });
      }
    }
    return admission;
  }

  job(key: string): Job | undefined {
    return this.jobs.get(key);
  }

  allJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => byKey(a.key, b.key));
  }

  // Waits for every dispatched runner to finish; returns the errors of runs that failed
  // at the persistence level (runner failures are job results, not errors).
  async settle(): Promise<unknown[]> {
    while (this.runs.size > 0) await Promise.all([...this.runs]);
    return [...this.runErrors];
  }

  // One polling cycle: operator commands in queue order (R09), directed replies in the tracker
  // (R10), then waiting PRs (R11), whose feedback becomes corrections, then, unless paused,
  // continuations first (CA07) and new work by priority (P05).
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
    // A pause holds new invocations only: tracking of waiting PRs (R11) keeps observing and
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
      for (const job of continuations) this.announceWait(job.key, job.pending!, "instância pausada", this.triggersOf(job, job.pending!));
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
    const job = this.jobs.get(key);
    if (!job) return { status: "rejected", reason: "trabalho desconhecido" };
    const trigger: Trigger = {
      reason: "retomada-manual", origin: command === undefined ? "operador" : "terminal",
      ...(command === undefined ? {} : { command, ref: `comando ${command}` }),
    };
    if (job.pending !== undefined) {
      if (command !== undefined) await this.persist({ ...job, triggers: [...(job.triggers ?? []), trigger] });
      return { status: "queued" };
    }
    if (!CONTINUATIONS[kind].includes(job.state)) {
      return { status: "rejected", reason: `${kind} não se aplica ao estado ${job.state}` };
    }
    await this.persist({ ...appendLog(job, `${kind} solicitado; aguarda vaga`), pending: kind, triggers: [...(job.triggers ?? []), trigger] });
    this.emitFor(key, "feedback-recebido", "retomada solicitada", triggerSummary([trigger]).fields);
    return { status: "queued" };
  }

  // One operational event of a job. Never throws: the observer reports its own failures.
  private emitFor(
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

  // A tracker write made by the orchestrator: the attempt is announced before, the concrete
  // changes the adapter reports after, and a failure keeps whatever was written before it.
  // The write itself is never repeated because of what is observed.
  private async writeIssue<T extends { changes?: IssueChange[] } | void>(
    context: IssueWriteContext,
    write: () => Promise<T>,
  ): Promise<T> {
    this.obs.emit(issueWriteAttempt(context));
    try {
      return await write();
    } catch (error) {
      if (error instanceof PartialWriteError) this.reportChanges(context, error.changes);
      this.obs.emit(issueWriteFailure(context, messageOf(error), true));
      throw error;
    }
  }

  private reportChanges(context: IssueWriteContext, changes: readonly IssueChange[] | undefined): void {
    for (const change of changes ?? []) this.obs.emit(issueChangeEvent(context, change));
  }

  private writeContext(job: { key: string; ref: IssueRef }, operation: string, reason: string, invocation?: string, refs?: Record<string, FieldValue>): IssueWriteContext {
    return { ref: job.ref, job: job.key, origin: "orquestrador", operation, reason, ...(invocation === undefined ? {} : { invocation }), ...(refs === undefined ? {} : { refs }) };
  }

  private newInvocation(): string {
    this.invocationSeq += 1;
    return `inv-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${this.invocationSeq}`;
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
    for (const command of queued.commands) {
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
    const job = this.jobs.get(command.job);
    if (!job) return { ...base, job: command.job, status: "rejected", reason: "trabalho desconhecido" };
    const reason = await this.operate(job, command);
    if (reason === undefined) {
      // `reply aplicado` is the orchestrator taking the reply: neither delivery nor start of a run.
      this.emitFor(job.key, "comando-aplicado", `${command.type} aplicado`, { comando: command.id });
      return { ...base, job: job.key, status: "applied" };
    }
    await this.note(job.key, `${command.type} rejeitado: ${reason}`);
    this.emitFor(job.key, "comando-rejeitado", `${command.type} rejeitado`, { comando: command.id, motivo: reason }, { level: "atenção" });
    return { ...base, job: job.key, status: "rejected", reason };
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

  // A terminal reply is directed input with no tracker event behind it (R09). It takes the same
  // path as an `agent:` comment, so both have the same effect (CA11).
  private async reply(job: Job, message: string, command: string): Promise<string | undefined> {
    if (message.trim() === "") return "resposta vazia";
    const trigger: Trigger = { reason: "resposta-humana", origin: "terminal", command, ref: `comando ${command}` };
    const outcome = receiveFeedback(job, [{ message, trigger }], "resposta recebida");
    if ("reason" in outcome) return `reply ${outcome.reason}`;
    await this.persist(outcome.job);
    return undefined;
  }

  // Directed replies in the tracker (CA11): a human comment without marker that starts with
  // `agent:`. Each comment is consumed once, by its id and revision (R10).
  private async collectTrackerFeedback(report: PollReport): Promise<void> {
    for (const candidate of this.allJobs().filter((job) => TRACKER_FEEDBACK_STATES.includes(job.state))) {
      await this.guard(candidate.key, report, async () => {
        const comments = await this.deps.tracker.readComments(candidate.ref);
        const current = this.jobs.get(candidate.key);
        if (!current) return;
        const consumed = new Set(current.consumed ?? []);
        const inputs = comments.flatMap((comment) => {
          const input = directedReply(candidate.ref.tracker, comment);
          return input !== undefined && !consumed.has(input.key) ? [input] : [];
        });
        if (inputs.length === 0) return;
        const outcome = receiveFeedback(current, inputs, "resposta dirigida recebida na issue");
        if ("reason" in outcome) {
          report.skipped.push({ key: current.key, reason: `feedback da issue ${outcome.reason}` });
          return;
        }
        await this.persist(outcome.job);
        this.announceFeedback(current.key, inputs);
      });
    }
  }

  // Feedback taken by the job: each input is announced once, when it is consumed, with its reason
  // and a short reference. The invocation it motivates is announced when it starts.
  private announceFeedback(key: string, inputs: readonly { trigger?: Trigger }[]): void {
    for (const input of inputs) {
      if (input.trigger === undefined) continue;
      this.emitFor(key, "feedback-recebido", "feedback recebido", triggerSummary([input.trigger]).fields);
    }
  }

  // Removes the claim and ends tracking; area, session and PR stay on the job. Never moves
  // the issue to done and never touches the PR (R09, CA19). A write whose answer was lost is
  // confirmed by rereading the tracker (P02).
  private async release(job: Job, command?: string): Promise<string | undefined> {
    if (!RELEASABLE.includes(job.state)) return `release não se aplica ao estado ${job.state}`;
    const context = this.writeContext(job, "release", "liberado-pelo-operador", undefined, command === undefined ? undefined : { comando: command });
    let changes: IssueChange[] | undefined;
    let snapshot: IssueSnapshot | undefined;
    try {
      const outcome = await this.writeIssue(context, async () => this.deps.tracker.releaseClaim(job.ref));
      changes = outcome?.changes;
      snapshot = await this.reread(job.ref);
    } catch (error) {
      snapshot = await this.reread(job.ref);
      if (!claimGone(snapshot)) return `liberação não confirmada pelo tracker: ${messageOf(error)}`;
      // The write failed or its answer was lost, and the reread shows the claim gone: the uncertainty
      // is resolved by evidence, not by assumption.
      this.obs.emit(issueChangeEvent(context, {
        operation: "remover-label", result: "confirmed", after: "ausente", detail: "confirmada por releitura após erro de escrita",
      }));
    }
    // The reread decides what each change was: an accepted call alone is only an attempt.
    if (changes !== undefined) {
      this.reportChanges(context, changes.map((change) =>
        removalConfirmedByReread(change, snapshot) ? { ...change, result: "confirmed" as const } : change));
    }
    // A claim the reread still shows, or a reread that failed, is not a release: the job keeps its
    // state, so the claim is not left on the issue with the tracking already ended.
    if (!claimGone(snapshot)) {
      return `liberação não confirmada pelo tracker: ${snapshot === undefined ? "releitura indisponível" : "claim ainda visível na releitura"}`;
    }
    await this.apply(job.key, "released", {
      message: "claim removido pelo operador; acompanhamento encerrado; área, sessão e PR preservados",
      reason: "liberado pelo operador",
    });
    return undefined;
  }

  // Rereads the issue: undefined when the reread itself fails, so nothing is confirmed by it.
  private async reread(ref: IssueRef): Promise<IssueSnapshot | undefined> {
    try {
      return await this.deps.tracker.readIssue(ref);
    } catch {
      return undefined;
    }
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
        if (this.jobs.has(key)) continue;
        if (this.unreadableKeys.has(key)) {
          report.skipped.push({ key, reason: "arquivo do trabalho ilegível; não readmitido" });
          continue;
        }
        const snapshot = await this.deps.tracker.readIssue(ref);
        const verdict = this.verdictFor(eligibility, snapshot, this.trackedKeys());
        if (!verdict.eligible) {
          report.skipped.push({ key, reason: this.describe(verdict) });
          continue;
        }
        candidates.push({ ref, key, project, eligibility, priority: normalizePriority(snapshot.priority) });
      }
    }
    return candidates.sort(byPriorityThenIdentity);
  }

  private isTracked(key: string): boolean {
    return this.jobs.has(key) || this.unreadableKeys.has(key);
  }

  private trackedKeys(): ReadonlySet<string> {
    return new Set([...this.jobs.keys(), ...this.unreadableKeys]);
  }

  private verdictFor(eligibility: ProjectEligibility, snapshot: IssueSnapshot, tracked: ReadonlySet<string>): Verdict {
    return evaluateEligibility({ project: eligibility.project, issue: snapshot, tracked }, eligibility.rules);
  }

  private describe(verdict: Verdict): string {
    return verdict.eligible ? "" : verdict.rejections.map((rejection) => rejection.reason).join("; ");
  }

  // Sequence of R04: reread eligibility, reserve the slot, persist the job, claim,
  // confirm claim and doing state, and only then dispatch the runner.
  private async admitNew(candidate: NewCandidate, report: PollReport): Promise<void> {
    const { ref, key } = candidate;
    if (this.isTracked(key)) {
      report.skipped.push({ key, reason: "já acompanhada pelo script" });
      return;
    }
    const snapshot = await this.deps.tracker.readIssue(ref);
    const verdict = this.verdictFor(candidate.eligibility, snapshot, this.trackedKeys());
    if (!verdict.eligible) {
      report.skipped.push({ key, reason: this.describe(verdict) });
      return;
    }
    const job = newJob({ ref, repository: candidate.project.repository });
    const blocked = this.reserve(job);
    if (blocked) {
      this.announceWait(key, "issue-elegível", blocked, []);
      report.skipped.push({ key, reason: blocked });
      return;
    }
    await this.persist(job);
    await this.note(key, "vaga reservada; claim solicitado");

    const context = this.writeContext(job, "claim", "admissão");
    let claimed;
    try {
      claimed = await this.writeIssue(context, () => this.deps.tracker.claim(ref));
    } catch {
      await this.afterClaimWriteError(key, ref, report);
      return;
    }
    this.reportChanges(context, claimed.changes);
    if (claimed.status === "rejected") {
      await this.forget(key);
      report.skipped.push({ key, reason: `claim recusado pelo tracker: ${claimed.reason}` });
      return;
    }
    if (!(await this.startConfirmed(ref))) {
      await this.apply(key, "intervention-required", { message: UNRESOLVED_START, reason: UNRESOLVED_START });
      report.errors.push({ key, message: UNRESOLVED_START });
      return;
    }
    await this.note(key, `início confirmado; runner disparado (${this.deps.instance.maxIterations} iterações)`);
    report.admitted.push(key);
    // `trabalho admitido` is only for this first admission; later starts say why they continue.
    this.emitFor(key, "trabalho-admitido", "trabalho admitido", { motivo: "issue-elegível" });
    this.clearWaits(key);
    const invocation = this.startInvocation(key, "new", [], {});
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
      await this.apply(job.key, "intervention-required", {
        message: "claim não está mais registrado no tracker; não reclamado automaticamente",
        reason: "claim não está mais registrado no tracker; não reclamado automaticamente",
      });
      return;
    }
    if (snapshot.statusCategory.value === "done") {
      await this.apply(job.key, "intervention-required", {
        message: "issue terminal no tracker", reason: "issue terminal no tracker",
      });
      return;
    }
    const workspace = job.workspace;
    const missing = [workspace === undefined ? "sessão e área" : undefined, project.runtimeProfile.trim() === "" ? "perfil" : undefined]
      .filter((item): item is string => item !== undefined)
      .join(" e ");
    if (missing !== "" || workspace === undefined) {
      // No conversation is started silently: the operator decides what happens next (P03).
      await this.apply(job.key, "waiting-for-help", {
        message: `${kind} sem ${missing}: pedido de ajuda; nenhuma conversa nova foi iniciada`,
        question: `${kind} solicitado, mas falta ${missing} para continuar a sessão anterior: responda com a orientação ou libere o trabalho`,
        context: "nenhuma conversa nova foi iniciada",
      });
      return;
    }
    const triggers = this.triggersOf(job, kind);
    const blocked = this.reserve(job);
    if (blocked) {
      this.announceWait(job.key, kind, blocked, triggers);
      report.skipped.push({ key: job.key, reason: blocked });
      return;
    }
    const plan = planContinuation(job, kind, triggers);
    const delivered = plan.replies.length > 0 ? `; ${plan.replies.length} resposta(s) entregue(s)` : "";
    const how = plan.triage === "list" ? " (triagem do feedback do PR)" : plan.triage === "apply" ? " (aplica a escolha da triagem)" : "";
    const running = await this.apply(job.key, "running", {
      message: `${kind} admitido${how}; limite de 1 iteração${delivered}`,
      ...(plan.held === undefined ? {} : { afterTriage: plan.held }),
    });
    report.admitted.push(job.key);
    this.clearWaits(job.key);
    const commands = triggers.flatMap((trigger) => (trigger.reason === "resposta-humana" && trigger.command !== undefined ? [trigger.command] : []));
    const invocation = this.startInvocation(job.key, kind, plan.triggers, { sessão: workspace.session, área: workspace.area });
    for (const command of commands) {
      this.emitFor(job.key, "resposta-incluída", "resposta incluída na retomada", { comando: command }, { invocation });
    }
    this.dispatch(running.key, running.ref, kind, 1, deliveryOf(project, running.ref), invocation,
      {
        workspace, replies: plan.replies,
        ...(plan.conflict ? { conflict: true } : {}),
        ...(plan.triage === undefined ? {} : { triage: plan.triage }),
      }, undefined, commands);
  }

  // The causes of the pending continuation of a job. One asked before triggers existed (an older state
  // file) still says why, by the kind it was asked as, instead of inventing a cause.
  private triggersOf(job: Job, kind: Continuation): Trigger[] {
    return job.triggers !== undefined && job.triggers.length > 0
      ? job.triggers
      : [{ reason: kind === "correction" ? "feedback-pr" : "retomada-manual", origin: "desconhecida" }];
  }

  // The invocation that is about to run, announced with its operational reason (issue #15).
  private startInvocation(key: string, kind: RunKind, triggers: readonly Trigger[], extra: Record<string, FieldValue>): string {
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

  private clearWaits(key: string): void {
    for (const entry of [...this.announcedWaits]) if (entry.startsWith(`${key}|`)) this.announcedWaits.delete(entry);
  }

  // A job that waits for a slot or another impediment keeps its original reason (decision 21).
  // Each distinct wait is announced once, not on every poll.
  private announceWait(key: string, kind: Continuation | RunKind | "issue-elegível", impediment: string, triggers: readonly Trigger[]): void {
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

  // Capacity and repository check. Synchronous with the reservation it guards, so
  // parallel polls cannot exceed N or start two implementations in one repository.
  private reserve(job: Job): string | undefined {
    const active = [...this.jobs.values()].filter((other) => holdsSlot(other.state));
    if (active.length >= this.deps.instance.maxConcurrent) return "sem vaga livre";
    if (active.some((other) => other.repository === job.repository)) {
      return `repositório ${job.repository} já tem implementação ativa`;
    }
    this.jobs.set(job.key, job);
    return undefined;
  }

  private async startConfirmed(ref: IssueRef): Promise<boolean> {
    try {
      const snapshot = await this.deps.tracker.readIssue(ref);
      return snapshot.claimed.known && snapshot.claimed.value
        && snapshot.statusCategory.known && snapshot.statusCategory.value === "in-progress";
    } catch {
      return false;
    }
  }

  // After a write error the external state is reread before anything else (P02).
  private async afterClaimWriteError(key: string, ref: IssueRef, report: PollReport): Promise<void> {
    let snapshot;
    try {
      snapshot = await this.deps.tracker.readIssue(ref);
    } catch {
      await this.apply(key, "intervention-required", {
        message: "erro de escrita no claim e estado externo ilegível",
        reason: "erro de escrita no claim e estado externo ilegível",
      });
      return;
    }
    if (snapshot.claimed.known && snapshot.claimed.value) {
      const reason = "erro de escrita no claim; tracker mostra claim com origem não comprovada: não iniciar";
      await this.apply(key, "intervention-required", { message: reason, reason });
      return;
    }
    if (snapshot.claimed.known) {
      await this.forget(key);
      report.errors.push({ key, message: "erro de escrita no claim; nada registrado no tracker, nova tentativa no próximo polling" });
      return;
    }
    const reason = "erro de escrita no claim e estado externo desconhecido";
    await this.apply(key, "intervention-required", { message: reason, reason });
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
    replyCommands?: string[],
  ): void {
    const run: Promise<void> = this.execute(key, ref, kind, maxIterations, delivery, invocation, continuation, issue, replyCommands).catch((error: unknown) => {
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
    replyCommands?: string[],
  ): Promise<void> {
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
        ...(replyCommands !== undefined && replyCommands.length > 0 ? { replyCommands } : {}),
      };
      try {
        output = await this.deps.runner.run(context);
      } catch {
        this.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "falha-do-runner" }, { invocation, level: "erro" });
        await this.apply(key, "intervention-required", {
          message: "runner falhou sem resultado estruturado",
          reason: "runner falhou sem resultado estruturado",
          invocation,
        });
        return;
      }
      if (output.workspace) await this.update(key, { workspace: output.workspace });
      if (output.kind === "continue") {
        this.emitFor(key, "invocação-encerrada", "iteração encerrada sem resultado final", { iteração: `${iteration}/${maxIterations}`, resultado: "sem-resultado" }, { invocation, level: "atenção" });
        if (iteration < maxIterations) {
          await this.note(key, `iteração ${iteration}/${maxIterations} (${kind}) sem resultado final; nova iteração`);
        }
        continue;
      }
      const parsed = parseRunOutput(output.results);
      if (!parsed.ok) {
        const reason = `resultado inválido: ${parsed.reason}`;
        this.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "inválido" }, { invocation, level: "atenção" });
        await this.apply(key, "intervention-required", { message: reason, reason, invocation });
        return;
      }
      const result = parsed.result;
      this.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: result.status }, { invocation });
      switch (result.status) {
        case "needs_help":
          await this.apply(key, "waiting-for-help", {
            message: `pedido de ajuda: ${result.question}`,
            question: result.question,
            context: result.context,
            invocation,
          });
          return;
        case "pr_ready":
          if (continuation?.triage === "list") {
            // The operator has not chosen yet: a PR taken as ready now would drop the triaged comments.
            const reason = "triagem terminou com PR pronto em vez de pedido de ajuda; os comentários não foram escolhidos pelo operador";
            await this.apply(key, "intervention-required", { message: reason, reason, invocation });
            return;
          }
          await this.acceptPr(key, result.pr, delivery, invocation);
          return;
        case "interrupted":
          await this.apply(key, "interrupted", { message: `interrompido: ${result.reason}`, reason: result.reason, invocation });
          return;
      }
    }
    const reason = `limite de iterações (${maxIterations}) atingido sem resultado válido`;
    await this.apply(key, "intervention-required", { message: reason, reason, invocation });
  }

  private enabledProjectOf(job: Job): ProjectConfig | undefined {
    return this.deps.instance.projects.find((candidate) => candidate.repository === job.repository && candidate.enabled);
  }

  // A "PR pronto" result is accepted only after the PR port confirms it (R08, CA19). An
  // invalid PR is a help request. A PR that cannot be read is neither success nor help: the
  // operator decides (P02), so the job needs intervention.
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
      await this.apply(key, "intervention-required", {
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
    await this.apply(key, "waiting-for-pr", { message: `PR validado: ${pr.repository}#${pr.number}`, pr, invocation });
    if (lookup.status === "found") await this.observe(key, lookup.pr);
  }

  private async refusePr(key: string, pr: PrRef, reason: string, invocation?: string): Promise<void> {
    await this.apply(key, "waiting-for-help", {
      message: `PR pronto recusado: ${reason}`,
      question: `PR pronto não confirmado (${pr.repository}#${pr.number}): ${reason}. Corrija o PR ou informe o próximo passo.`,
      context: "",
      invocation,
    });
  }

  // Polling of a PR the job waits for (R11, R12): CI and review are recorded, a merge into
  // the target branch completes the job, and a PR closed without merge interrupts it.
  private async trackPr(job: Job, report: PollReport): Promise<void> {
    const project = this.enabledProjectOf(job);
    if (!project) {
      report.skipped.push({ key: job.key, reason: "projeto do trabalho não está habilitado na instância" });
      return;
    }
    const pr = job.pr;
    if (!pr) {
      await this.apply(job.key, "intervention-required", {
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
        await this.apply(job.key, "interrupted", { message: reason, reason });
        return;
      }
      case "invalid": {
        const reason = `PR acompanhado não confere: ${verdict.reason}`;
        await this.apply(job.key, "intervention-required", { message: reason, reason });
        return;
      }
    }
  }

  // A conflict of the open PR with its target branch (R10, CA12) becomes a correction with a slot and
  // a reason of its own. It is judged on the commits read now, so a failing feedback read never hides it.
  private async collectConflict(job: Job, snapshot: PrSnapshot, report: PollReport): Promise<void> {
    const current = this.jobs.get(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const input = judgeConflict(snapshot, new Set(current.consumed ?? []));
    if (input === undefined) return;
    const outcome = receiveFeedback(current, [input], "conflito do PR recebido");
    if ("reason" in outcome) {
      report.skipped.push({ key: current.key, reason: `conflito do PR ${outcome.reason}` });
      return;
    }
    await this.persist(outcome.job);
    this.announceFeedback(current.key, [input]);
  }

  // Feedback on an open PR (R10, CA12): human comments (conversation, inline, review bodies), and failing checks, become
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
    const current = this.jobs.get(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const judgement = judgePrFeedback(feedback, new Set(current.consumed ?? []));
    if (judgement.inputs.length === 0 && judgement.undecidable === undefined) return;
    const consumed = judgement.inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
    if (judgement.undecidable === undefined) {
      if (needsTriage(judgement.inputs.flatMap((input) => (input.trigger === undefined ? [] : [input.trigger])))) {
        // A human comment is never corrected without its triage (issue #21): without the skill the
        // operator is asked, and nothing is consumed, so the comments come back with the PR.
        const unavailable = await this.deps.runner.triageUnavailable?.({ ref: current.ref, repository: current.repository });
        if (unavailable !== undefined) {
          await this.apply(job.key, "waiting-for-help", {
            message: `triagem do feedback do PR indisponível: ${unavailable}`,
            question: `Há comentário humano novo no PR (${pr.repository}#${pr.number}) e a triagem com /skill:gh-address-comments não pode rodar: ${unavailable}.`
              + " Nenhuma correção foi feita e nenhum item foi consumido: eles voltam a ser lidos quando o PR for acompanhado de novo."
              + " Resolva a causa e responda para retomar, ou libere o trabalho.",
            context: "",
          });
          return;
        }
      }
      const prRef = `#${pr.number}`;
      const inputs = judgement.inputs.map((input) =>
        input.trigger === undefined ? input : { ...input, trigger: { ...input.trigger, pr: prRef } });
      const outcome = receiveFeedback(current, inputs, "feedback do PR recebido");
      if ("reason" in outcome) {
        report.skipped.push({ key: job.key, reason: `feedback do PR ${outcome.reason}` });
        return;
      }
      await this.persist(outcome.job);
      this.announceFeedback(job.key, inputs);
      return;
    }
    const items = judgement.inputs.length === 0 ? "" : ` Itens: ${judgement.inputs.map((input) => input.message).join("; ")}.`;
    await this.apply(job.key, "waiting-for-help", {
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
    const current = this.jobs.get(job.key) ?? job;
    if (current.mergeDetected !== undefined) return;
    await this.persist({ ...current, mergeDetected: new Date().toISOString() });
    this.emitFor(job.key, "merge-detectado", "merge detectado", {
      pr: `${pr.repository}#${pr.number}`, destino: targetBranch, origem: "externa",
    }, { level: "progresso" });
  }

  // Merge confirmed by the PR port: the issue is done only when the tracker confirms it by
  // reread (R11). Until then the job keeps waiting and the next poll tries again.
  private async complete(job: Job, report: PollReport, targetBranch: string): Promise<void> {
    let confirmed = false;
    let why = "";
    const context = this.writeContext(job, "done", "conclusão-após-merge");
    try {
      const outcome = await this.writeIssue(context, () => this.deps.tracker.markDone(job.ref));
      if (outcome.status === "not-confirmed") {
        why = outcome.reason;
        this.reportChanges(context, outcome.changes);
      } else {
        const snapshot = await this.deps.tracker.readIssue(job.ref);
        confirmed = snapshot.statusCategory.known && snapshot.statusCategory.value === "done";
        if (!confirmed) why = "releitura não mostra done";
        // The reread is the evidence: an adapter that only attempted the write is confirmed by it.
        this.reportChanges(context, outcome.changes?.map((change) =>
          confirmed && change.result === "attempted" ? { ...change, result: "confirmed" as const } : change));
      }
    } catch (error) {
      why = messageOf(error);
    }
    if (!confirmed) {
      this.emitFor(job.key, "conclusão-pendente", "merge confirmado; done ainda não confirmado", {
        motivo: why, próximo: "nova tentativa no próximo polling",
      }, { level: "atenção" });
      report.errors.push({
        key: job.key,
        message: `PR mesclado; done ainda não confirmado pelo tracker (${why}): nova tentativa no próximo polling`,
      });
      return;
    }
    await this.apply(job.key, "done", {
      message: `PR mesclado em ${targetBranch}: issue done confirmada por releitura`,
    });
  }

  // Stores the latest PR observation; the log gets a line only when CI or review changed.
  private async observe(key: string, pr: PrSnapshot): Promise<void> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const status: PrStatus = { checks: pr.checks, review: pr.review, mergeable: pr.mergeable };
    if (current.prStatus && statusKey(current.prStatus) === statusKey(status)) return;
    await this.persist(recordPrStatus(current, status, describeStatus(status)));
    this.emitFor(key, "acompanhamento-pr", "acompanhamento do PR alterado", {
      pr: `${pr.ref.repository}#${pr.ref.number}`,
      ci: status.checks.known ? status.checks.value : `desconhecido (${status.checks.reason})`,
      review: status.review.known ? status.review.value : `desconhecido (${status.review.reason})`,
      mergeabilidade: describeMergeable(status.mergeable),
    });
  }

  // `consumed` records feedback taken by this same transition, so the state and the record
  // are written together.
  private async apply(
    key: string,
    to: JobState,
    details: { message: string; reason?: string; question?: string; context?: string; pr?: Job["pr"]; consumed?: string[]; invocation?: string; afterTriage?: HeldFeedback[] },
  ): Promise<Job> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const base: Job = details.consumed
      ? { ...current, consumed: [...(current.consumed ?? []), ...details.consumed] }
      : current;
    const next = transitionJob(base, to, details);
    await this.persist(next);
    this.announceState(next, details);
    return next;
  }

  // The operational event of a state the job has just entered. Waiting for help keeps the whole
  // question and context in the history and says how to answer (issue #15, decisions 3, 5, 6).
  private announceState(job: Job, details: { reason?: string; question?: string; context?: string; invocation?: string }): void {
    const { key } = job;
    const { invocation } = details;
    switch (job.state) {
      case "waiting-for-help": {
        const commands = this.obs.commands(key, [...this.jobs.keys()]);
        const lines = [
          `pergunta: ${details.question ?? ""}`,
          ...(details.context ? [`contexto: ${details.context}`] : []),
          ...(commands ? [`responder: ${commands.reply}`, `histórico: ${commands.logs}`, ...(commands.detail ? [`log detalhado: ${commands.detail}`] : [])] : []),
        ];
        this.emitFor(key, "ajuda-solicitada", "ajuda solicitada", {}, { lines, invocation, level: "atenção", highlight: true });
        return;
      }
      case "waiting-for-pr":
        this.emitFor(key, "pr-aceito", "PR aceito para acompanhamento; o trabalho não está concluído", {
          pr: job.pr === undefined ? undefined : `${job.pr.repository}#${job.pr.number}`,
        }, { invocation, level: "progresso" });
        return;
      case "interrupted":
        // How to resume and how to see what happened; releasing is not offered ready to paste, so a
        // paste does not end the follow-up by mistake.
        this.emitFor(key, "trabalho-interrompido", "trabalho interrompido", { motivo: details.reason }, {
          invocation, level: "atenção", lines: this.interruptedCommands(key),
        });
        return;
      case "intervention-required":
        this.emitFor(key, "intervenção-necessária", "intervenção necessária", { motivo: details.reason }, { invocation, level: "atenção" });
        return;
      case "done":
        this.emitFor(key, "trabalho-concluído", "trabalho concluído", { done: "confirmado" }, { level: "progresso" });
        return;
      case "released":
        this.emitFor(key, "trabalho-liberado", "trabalho liberado", { motivo: details.reason });
        return;
      case "running":
        return;
    }
  }

  private interruptedCommands(key: string): string[] {
    const commands = this.obs.commands(key, [...this.jobs.keys()]);
    if (!commands) return [];
    return [`retomar: ${commands.resume}`, `histórico: ${commands.logs}`, ...(commands.detail ? [`log detalhado: ${commands.detail}`] : [])];
  }

  private async note(key: string, message: string): Promise<void> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    await this.persist(appendLog(current, message));
  }

  private async update(key: string, changes: Partial<Pick<Job, "workspace">>): Promise<void> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    await this.persist({ ...current, ...changes });
  }

  private async persist(job: Job): Promise<void> {
    this.jobs.set(job.key, job);
    await this.deps.store.save(job);
  }

  private async forget(key: string): Promise<void> {
    this.jobs.delete(key);
    await this.deps.store.remove(key);
  }
}
