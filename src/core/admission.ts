import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { PrFeedback, PrLookup, PrPort, PrSnapshot } from "../pr/port.js";
import type { ContinuationContext, Runner, RunnerContext, RunKind, RunnerOutput } from "../runtime/runner.js";
import { evaluateEligibility, type Verdict } from "./eligibility.js";
import type { CommandQueue, OperatorCommand } from "./commands.js";
import type { InstanceControl } from "./instance-control.js";
import { appendLog, holdsSlot, newJob, recordPrStatus, transitionJob, type Continuation, type Job, type JobState, type PrStatus } from "./job.js";
import { directedReply, judgePrFeedback, receiveFeedback } from "./feedback.js";
import type { JobStore } from "./job-store.js";
import { projectEligibility, type ProjectEligibility } from "./project-eligibility.js";
import { normalizePriority } from "./priority.js";
import { deliveryOf, judgeReadyPr, judgeTrackedPr, misplacedRepository, type Delivery } from "./pr-rules.js";
import { parseRunOutput, type PrRef } from "./result.js";
import { refKey, type IssueRef, type IssueSnapshot, type Known, type TrackerPort } from "../tracker/port.js";

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const statusKey = (status: PrStatus): string => JSON.stringify([status.checks, status.review]);

const describeKnown = <T extends string>(label: string, known: Known<T>): string =>
  known.known ? `${label}: ${known.value}` : `${label}: desconhecido (${known.reason})`;

const describeStatus = (status: PrStatus): string =>
  `${describeKnown("CI", status.checks)}; ${describeKnown("review", status.review)}`;

// Job files are named after their key (see file-job-store), so an unreadable file still
// tells which issue it belongs to.
function keyFromFileName(name: string): string[] {
  try {
    return [decodeURIComponent(name.replace(/\.json$/, ""))];
  } catch {
    return [];
  }
}

export class Admission {
  readonly unreadable: readonly string[];
  private readonly jobs = new Map<string, Job>();
  // Keys of job files that could not be read: their issues stay tracked, never re-admitted.
  private readonly unreadableKeys: ReadonlySet<string>;
  private readonly runs = new Set<Promise<void>>();
  private readonly runErrors: unknown[] = [];

  private constructor(private readonly deps: AdmissionDeps, loaded: Job[], unreadable: string[]) {
    for (const job of loaded) this.jobs.set(job.key, job);
    this.unreadable = unreadable;
    this.unreadableKeys = new Set(unreadable.flatMap(keyFromFileName));
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
    if (!report.paused) {
      const continuations = this.allJobs().filter((job) => job.pending !== undefined);
      for (const job of continuations) {
        await this.guard(job.key, report, () => this.admitContinuation(job, report));
      }
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

  async requestContinuation(key: string, kind: Continuation): Promise<ContinuationOutcome> {
    const job = this.jobs.get(key);
    if (!job) return { status: "rejected", reason: "trabalho desconhecido" };
    if (job.pending !== undefined) return { status: "queued" };
    if (!CONTINUATIONS[kind].includes(job.state)) {
      return { status: "rejected", reason: `${kind} não se aplica ao estado ${job.state}` };
    }
    await this.persist({ ...appendLog(job, `${kind} solicitado; aguarda vaga`), pending: kind });
    return { status: "queued" };
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
      return { ...base, status: "applied" };
    }
    const job = this.jobs.get(command.job);
    if (!job) return { ...base, job: command.job, status: "rejected", reason: "trabalho desconhecido" };
    const reason = await this.operate(job, command);
    if (reason === undefined) return { ...base, job: job.key, status: "applied" };
    await this.note(job.key, `${command.type} rejeitado: ${reason}`);
    return { ...base, job: job.key, status: "rejected", reason };
  }

  // Returns the reason a command was refused, or undefined when it was applied.
  private async operate(job: Job, command: JobCommand): Promise<string | undefined> {
    switch (command.type) {
      case "reply":
        return this.reply(job, command.message);
      case "resume": {
        const outcome = await this.requestContinuation(job.key, "resume");
        return outcome.status === "rejected" ? outcome.reason : undefined;
      }
      case "release":
        return this.release(job);
    }
  }

  // A terminal reply is directed input with no tracker event behind it (R09). It takes the same
  // path as an `agent:` comment, so both have the same effect (CA11).
  private async reply(job: Job, message: string): Promise<string | undefined> {
    if (message.trim() === "") return "resposta vazia";
    const outcome = receiveFeedback(job, [{ message }], "resposta recebida");
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
      });
    }
  }

  // Removes the claim and ends tracking; area, session and PR stay on the job. Never moves
  // the issue to done and never touches the PR (R09, CA19). A write whose answer was lost is
  // confirmed by rereading the tracker (P02).
  private async release(job: Job): Promise<string | undefined> {
    if (!RELEASABLE.includes(job.state)) return `release não se aplica ao estado ${job.state}`;
    try {
      await this.deps.tracker.releaseClaim(job.ref);
    } catch (error) {
      if (!(await this.claimRemoved(job.ref))) return `liberação não confirmada pelo tracker: ${messageOf(error)}`;
    }
    await this.apply(job.key, "released", {
      message: "claim removido pelo operador; acompanhamento encerrado; área, sessão e PR preservados",
      reason: "liberado pelo operador",
    });
    return undefined;
  }

  private async claimRemoved(ref: IssueRef): Promise<boolean> {
    try {
      const snapshot = await this.deps.tracker.readIssue(ref);
      return snapshot.claimed.known && !snapshot.claimed.value;
    } catch {
      return false;
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
      const eligibility = projectEligibility(this.deps.instance, project);
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
      report.skipped.push({ key, reason: blocked });
      return;
    }
    await this.persist(job);
    await this.note(key, "vaga reservada; claim solicitado");

    let claimed;
    try {
      claimed = await this.deps.tracker.claim(ref);
    } catch {
      await this.afterClaimWriteError(key, ref, report);
      return;
    }
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
    this.dispatch(key, ref, "new", this.deps.instance.maxIterations, deliveryOf(candidate.project, ref));
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
    const blocked = this.reserve(job);
    if (blocked) {
      report.skipped.push({ key: job.key, reason: blocked });
      return;
    }
    const replies = job.replies ?? [];
    const delivered = replies.length > 0 ? `; ${replies.length} resposta(s) entregue(s)` : "";
    const running = await this.apply(job.key, "running", { message: `${kind} admitido; limite de 1 iteração${delivered}` });
    report.admitted.push(job.key);
    this.dispatch(running.key, running.ref, kind, 1, deliveryOf(project, running.ref), { workspace, replies });
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
    continuation?: ContinuationContext,
  ): void {
    const run: Promise<void> = this.execute(key, ref, kind, maxIterations, delivery, continuation).catch((error: unknown) => {
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
    continuation?: ContinuationContext,
  ): Promise<void> {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      let output: RunnerOutput;
      const context: RunnerContext = {
        jobId: key,
        ref,
        kind,
        iteration,
        maxIterations,
        ...(continuation ? { continuation } : {}),
      };
      try {
        output = await this.deps.runner.run(context);
      } catch {
        await this.apply(key, "intervention-required", {
          message: "runner falhou sem resultado estruturado",
          reason: "runner falhou sem resultado estruturado",
        });
        return;
      }
      if (output.workspace) await this.update(key, { workspace: output.workspace });
      if (output.kind === "continue") {
        if (iteration < maxIterations) {
          await this.note(key, `iteração ${iteration}/${maxIterations} (${kind}) sem resultado final; nova iteração`);
        }
        continue;
      }
      const parsed = parseRunOutput(output.results);
      if (!parsed.ok) {
        const reason = `resultado inválido: ${parsed.reason}`;
        await this.apply(key, "intervention-required", { message: reason, reason });
        return;
      }
      const result = parsed.result;
      switch (result.status) {
        case "needs_help":
          await this.apply(key, "waiting-for-help", {
            message: `pedido de ajuda: ${result.question}`,
            question: result.question,
            context: result.context,
          });
          return;
        case "pr_ready":
          await this.acceptPr(key, result.pr, delivery);
          return;
        case "interrupted":
          await this.apply(key, "interrupted", { message: `interrompido: ${result.reason}`, reason: result.reason });
          return;
      }
    }
    const reason = `limite de iterações (${maxIterations}) atingido sem resultado válido`;
    await this.apply(key, "intervention-required", { message: reason, reason });
  }

  private enabledProjectOf(job: Job): ProjectConfig | undefined {
    return this.deps.instance.projects.find((candidate) => candidate.repository === job.repository && candidate.enabled);
  }

  // A "PR pronto" result is accepted only after the PR port confirms it (R08, CA19). An
  // invalid PR is a help request. A PR that cannot be read is neither success nor help: the
  // operator decides (P02), so the job needs intervention.
  private async acceptPr(key: string, pr: PrRef, delivery: Delivery): Promise<void> {
    const misplaced = misplacedRepository(pr, delivery);
    if (misplaced !== undefined) {
      await this.refusePr(key, pr, misplaced);
      return;
    }
    let lookup: PrLookup;
    try {
      lookup = await this.deps.prs.readPr(pr);
    } catch (error) {
      await this.apply(key, "intervention-required", {
        message: `PR não pôde ser confirmado: ${messageOf(error)}`,
        reason: `PR não pôde ser confirmado no github.com: ${messageOf(error)}`,
      });
      return;
    }
    const verdict = judgeReadyPr(lookup, delivery);
    if (!verdict.valid) {
      await this.refusePr(key, pr, verdict.reason);
      return;
    }
    await this.apply(key, "waiting-for-pr", { message: `PR validado: ${pr.repository}#${pr.number}`, pr });
    if (lookup.status === "found") await this.observe(key, lookup.pr);
  }

  private async refusePr(key: string, pr: PrRef, reason: string): Promise<void> {
    await this.apply(key, "waiting-for-help", {
      message: `PR pronto recusado: ${reason}`,
      question: `PR pronto não confirmado (${pr.repository}#${pr.number}): ${reason}. Corrija o PR ou informe o próximo passo.`,
      context: "",
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
        await this.collectPrFeedback(job, pr, report);
        return;
      case "merged":
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

  // Feedback on an open PR (R10, CA12): human reviews and comments, and failing checks, become
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
    if (judgement.inputs.length === 0) return;
    const consumed = judgement.inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
    if (judgement.undecidable === undefined) {
      const outcome = receiveFeedback(current, judgement.inputs, "feedback do PR recebido");
      if ("reason" in outcome) {
        report.skipped.push({ key: job.key, reason: `feedback do PR ${outcome.reason}` });
        return;
      }
      await this.persist(outcome.job);
      return;
    }
    const items = judgement.inputs.map((input) => input.message).join("; ");
    await this.apply(job.key, "waiting-for-help", {
      message: `feedback do PR exige decisão humana: ${judgement.undecidable}`,
      question: `Feedback do PR (${pr.repository}#${pr.number}) não pode ser decidido pela factory: ${judgement.undecidable}. `
        + `Itens: ${items}. Responda com a orientação ou libere o trabalho.`,
      context: "",
      consumed,
    });
  }

  // Merge confirmed by the PR port: the issue is done only when the tracker confirms it by
  // reread (R11). Until then the job keeps waiting and the next poll tries again.
  private async complete(job: Job, report: PollReport, targetBranch: string): Promise<void> {
    let confirmed = false;
    let why = "";
    try {
      const outcome = await this.deps.tracker.markDone(job.ref);
      if (outcome.status === "not-confirmed") {
        why = outcome.reason;
      } else {
        const snapshot = await this.deps.tracker.readIssue(job.ref);
        confirmed = snapshot.statusCategory.known && snapshot.statusCategory.value === "done";
        if (!confirmed) why = "releitura não mostra done";
      }
    } catch (error) {
      why = messageOf(error);
    }
    if (!confirmed) {
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
    const status: PrStatus = { checks: pr.checks, review: pr.review };
    if (current.prStatus && statusKey(current.prStatus) === statusKey(status)) return;
    await this.persist(recordPrStatus(current, status, describeStatus(status)));
  }

  // `consumed` records feedback taken by this same transition, so the state and the record
  // are written together.
  private async apply(
    key: string,
    to: JobState,
    details: { message: string; reason?: string; question?: string; context?: string; pr?: Job["pr"]; consumed?: string[] },
  ): Promise<Job> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const base: Job = details.consumed
      ? { ...current, consumed: [...(current.consumed ?? []), ...details.consumed] }
      : current;
    const next = transitionJob(base, to, details);
    await this.persist(next);
    return next;
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
