import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import type { LocalSettings } from "../cli/local-settings.js";
import { assistedRules, humanStatesIn } from "./assist-eligibility.js";
import { assistPrompt } from "./assist-prompts.js";
import {
  answerContinuity, appendSessionLog, askContinuity, consumeResume, holdsCapacity, interpretContinuityAnswer,
  openCount, refKeyOf, scheduleResume, sessionTrackedKeys, unconsumedResume,
  type AssistSession, type AssistSessionState, type AssistSessionStore, type LoadedAssistSessions,
} from "./assist-session.js";
import {
  recognizeAssistResult, type AssistResult, type RecognizedResult,
} from "./assist-result.js";
import {
  decisionPending, digestOf, interventionPending, sessionOpenPending,
  type AttentionKeeper, type AttentionPending, type PendingKind,
} from "./attention.js";
import { HUMAN_ASSISTED_LABEL } from "./assist-eligibility.js";
import { postFactoryComment } from "./markers.js";
import { isFactoryComment } from "./feedback.js";
import { evaluateEligibility, type EligibilityRule } from "./eligibility.js";
import { encodeRefPart, type Job } from "./job.js";
import type { InstanceControl } from "./instance-control.js";
import { noopObserver, type FieldValue, type Level, type Observer } from "./observability.js";
import { IssueWrites, type IssueWritesContext } from "./issue-writes.js";
import type { CommandQueue } from "./commands.js";
import { messageOf } from "./values.js";
import type { ProjectEligibility } from "./project-eligibility.js";
import type { IssueRef, IssueSnapshot, TrackerPort } from "../tracker/port.js";
import { refKey } from "../tracker/port.js";
import {
  resolveModelAuth, resolveRuntimeProfile, resolveRuntimeProfileDeclaration,
} from "../runtime/docker-config.js";
import { checkRequired, planSnapshot, writeSnapshot, type SnapshotPlan } from "../runtime/profile-snapshot.js";
import {
  assistContainerName, assistExecCommand, assistExitRecordPath,
} from "../runtime/assist-exec.js";
import { profileToolchain, type ProfileToolchain } from "../runtime/docker-invocation.js";
import type { AssistExecProbe, AssistExecObservation, AssistExecStop, AssistExecStopResult } from "../runtime/assist-exec-probe.js";
import type { HerdrBoundary } from "../runtime/herdr.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";

// The coordinator of the human-assisted attendance (spec #48, ticket #54). One polling cycle of
// the assisted flow, driven by the instance's loop next to the autonomous admission:
// revalidate the current conditions, prove what the environment can prove BEFORE the claim,
// reserve the second N limit (open assisted sessions), persist the work, claim through the
// core's single write mechanism (ADR 0001, IssueWrites), and only then open the tab and the exec.
// Failures after the claim land in `pending` with the claim preserved: nothing is concluded,
// nothing is replayed silently and no issue is closed by this flow.
//
// Two independent N limits: this flow counts assisted sessions only (maxAssisted); the
// implementation capacity (maxConcurrent, jobs that hold slots) is the autonomous admission's
// business, so implementations and attendances of different issues coexist in the same
// repository. A session only leaves its limit when the execution has really stopped
// (container-written exit record, never pane disappearance — ticket #52).
//
// The interruptions are decided by the operator (ticket #56): a pending interruption asks the
// continuity question once, keeps it in the session registry, and waits — never a new execution
// and never a freeze of the other works. The manual resume and the release happen by operator
// command: the admission (the command queue's single drain) delegates them here.

// The one question an interruption asks the operator: answered verbatim in the registry, it is
// never asked again; a new interruption asks a new one. Answering it only authorizes a future
// opening when a later slice (#57) schedules that; in this slice the manual resume and the
// release remain the operator's paths.
const CONTINUITY_QUESTION =
  "a execução terminou sem atendimento concluído; autoriza uma retomada futura desta mesma sessão?"
  + " (a mesma sessão e área são preservadas; responder por `reply`; `resume` e `release` seguem disponíveis)";

// One operator command over an assisted session, already applied or refused with its reason.
export type AssistOperatorResult = { status: "applied" } | { status: "rejected"; reason: string };

// What the admission calls when a queued command names a work its job store does not know
// (ticket #56): the assisted registry answers instead, so the queue keeps a single drain.
export interface AssistOperator {
  // Whether the registry keeps a session with this key: the admission asks before delegating.
  has(key: string): Promise<boolean>;
  resume(key: string, command: string): Promise<AssistOperatorResult>;
  release(key: string, command: string): Promise<AssistOperatorResult>;
  reply(key: string, message: string, command: string): Promise<AssistOperatorResult>;
}

// The resume revalidates the same assisted conditions, except `not-claimed`: the factory's own
// claim is expected to be visible on a parked attendance and is checked explicitly — a lost
// claim is reported, never reacquired silently.
const resumeRules: readonly EligibilityRule[] = assistedRules.filter((rule) => rule.name !== "not-claimed");

export interface AssistPorts {
  // Docker/image/token proof; it never runs anything.
  sandbox: Pick<SandboxBoundary, "preflight">;
  // Herdr host of the exec's tab and pane.
  herdr: HerdrBoundary;
  // The real-execution probe of the reconciliation (ticket #58): docker-inspect by the container
  // NAME recorded in the session, Never a PID alone nor the pane (the proof's rule, #52). It
  // observes nothing else: the reconciler is its only consumer.
  exec: AssistExecProbe;
  // The identity reclaim of the exec (ticket #56, spec #48 item 5): the #52 proof measured the
  // container alive after `herdr tab close`, so a gone tab makes the supervision REQUEST the
  // stop itself (`docker rm -f` by the recorded container name) and VERIFY the stop through the
  // end channels before anything is freed. Absent: a gone tab raises a persistent intervention
  // instead — a stop is never requested silently and the capacity stays held exactly as today.
  stopExec?: AssistExecStop;
}

// The verdict of the exec's container-written end record (ticket #52's proven channel): the
// parse of `runtime/assist-exec` shapes it once here, and no core caller re-derives it.
export type ExitRecordVerdict =
  | { kind: "running" }
  | { kind: "ended"; record: { exitCode: number; at: string } }
  | { kind: "unknown"; reason: string };

// The fs authority of the assisted session areas (spec #48): every host-file operation of the
// flow reads or writes through this port, so the core keeps no node runtime imports (the same
// pattern the attention store follows). The real implementation lives in `src/state/`
// (file-assist-area-fs.ts); tests run it against real tmpdir areas.
export interface AssistAreaFs {
  // The end-record channel: ENOENT is a live exec, an unreadable file is unknown — a missing
  // record is never reported as an end.
  readExitRecord(path: string): Promise<ExitRecordVerdict>;
  // The session text files the container wrote, recursively, sorted, unreadable ones empty.
  listSessionTexts(dir: string): Promise<string[]>;
  // A plain directory listing; a failure propagates (an unreadable area is reported, never guessed).
  listDir(path: string): Promise<string[]>;
  ensureDirs(paths: string[]): Promise<void>;
  // Removal of the session's end record: true when a record really left, ENOENT tolerated.
  removeExitRecord(session: AssistSession): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  // One attempt identity of a consumed resume authorization (single use, ticket #57).
  attemptUuid(): string;
}

export interface AssistFlowDeps {
  instance: InstanceConfig;
  config: MsfConfig;
  local: LocalSettings;
  tracker: TrackerPort;
  // The implementation jobs' store: their tracked keys (and their unreadable files') block a
  // second ticket of the same issue, and their slots are the other N limit (read, never written
  // by this flow).
  jobs: { load(): Promise<{ jobs: Job[]; unreadable: string[] }> };
  sessions: AssistSessionStore;
  // The fs authority of the assisted session areas (spec #48): the exit-record channel, the pi
  // session texts, the area directories and the attempt identities ride this port.
  areaFs: AssistAreaFs;
  // The operator's command queue: the approval of a proposed result arrives through it
  // (ticket #55) and is applied here, never by the implementation admission.
  commands: CommandQueue;
  control: InstanceControl;
  // The boundaries of the assisted opening: the sandbox proves Docker/image/token (it never
  // runs anything), and Herdr hosts the exec's tab and pane.
  ports: AssistPorts;
  // The eligibility setup of each configured project, built by the configuration layer (the
  // same shape the autonomous admission receives).
  eligibility: (project: ProjectConfig) => ProjectEligibility;
  observer?: Observer;
  // Host directory with the container scripts (src/runtime/docker-image), mounted read-only.
  runtimeImageDir: string;
  // Root of the persistent per-profile toolchains (ADR 0004), under the factory `--home`: the Pi package
  // tree and the mise data dir of the profile, shared by the autonomous jobs of the same profile.
  toolchainsDir: string;
  // State directory of the instance: the working directories of each session live in it.
  stateDir: string;
  // The operator attention of ticket #59: open sessions, decisions and interventions become
  // persistent pendings (consultable in status), with a best-effort desktop notification.
  // Absent: no pendings are raised — raising is side plumbing, never core state; the flow
  // works unchanged without it.
  attention?: AttentionKeeper;
  // Injectable clock; the default is the wall clock.
  now?: () => Date;
}

export interface AssistReasoned {
  key: string;
  reason: string;
}

// An error carries its subject: the key it concerns and the message the operator reads.
export interface AssistError {
  key: string;
  message: string;
}

// The startup reconciliation's report (ticket #58): what each persisted identity became now
// that a (re)started orchestrator looks at it again, before any new admission.
export interface AssistReconcileReport {
  // Executions proven alive by their container identity: back under supervision, capacity kept,
  // the agent never executed again.
  recovered: AssistReasoned[];
  // Executions the supervision cannot speak about right now (Docker Unreachable, or a young
  // session whose presence is still within its opening grace): intervention raised, capacity
  // RESERVED until clarification — never exceeded N, never freed a possibly-alive exec.
  unknown: AssistReasoned[];
  // Work that came back parked: never-launched openings and ended executions whose structured
  // result says interruption / nothing recognizable. The #56 decision paths apply from here.
  pending: AssistReasoned[];
  // `open` executions whose container-written end record exists (or whose end the delegation
  // covers): left for the regular supervision path, which verifies the structured result.
  ended: AssistReasoned[];
  errors: AssistError[];
}

export interface AssistPollReport {
  opened: string[];
  // The attendances that left the live window in this cycle: an exec ended without a recognized
  // attendance result, or an opening failure after the claim.
  pending: AssistReasoned[];
  // Attendances concluded on this cycle: the operator approved the proposed result, the result
  // was registered and the claim and human-assisted removals were confirmed by rereading. The
  // issue is never closed because the attendance ended.
  concluded: AssistReasoned[];
  // The authorized resume already attempted this cycle: one authorization, one opening (ticket
  // #57)
  resumed: AssistReasoned[];
  // Approvals the flow refused, each with the reason the operator reads.
  rejected: AssistReasoned[];
  skipped: AssistReasoned[];
  errors: AssistError[];
  paused: boolean;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The opening lag (image pull, container creation): a session recorded open small while ago may
// still be having its container born, so a proven absence is only decidable for older sessions
// (reconciliation review decision B). Until then the execution is unknown: capacity reserved.
const OPENING_GRACE_MS = 15 * 60 * 1000;

// The working directories of one assisted session, under the instance state; encoded per key,
// like the job store file names, so a session never collides with another.
const assistAreaDir = (stateDir: string, key: string): string =>
  [stateDir, "assist", encodeRefPart(key)].join("/");

// Host user the image was built for, keeping artifacts' ownership (the recipe of #52).
const agentIdentities = (): string =>
  `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;

// The opening verified before the claim: the host-resolved snapshot plan (ADR 0002), the identity of
// the host user for the container, and the persistent toolchain the container converges once (ADR 0004).
interface PreparedOpening {
  plan: SnapshotPlan;
  agentUidGid: string;
  toolchain: ProfileToolchain;
  requiredPackages: readonly string[];
  requiredTools: readonly string[];
}

export class AssistedAttendance implements AssistOperator {
  private readonly obs: Observer;
  // Reasons already announced, so a poll that finds the same wait again does not repeat it.
  private readonly announced = new Set<string>();

  // ── Startup reconciliation (ticket #58): recover supervision WITHOUT re-executing agents.
  // Before any admission of a restarted instance, every persisted identity is reconciled against
  // the REAL execution in the container: the recorded container name through docker inspect (with
  // the daemon's reachability judged in the same look) and the container-written end record —
  // never a PID alone, never the pane (ticket #52). Absent is only "proven" when the daemon
  // itself answered; otherwise the execution is unknown and its capacity stays RESERVED with a
  // persistent intervention until clarified. A proven-alive exec returns under supervision
  // without a second pi for the same work; an ended one has its STRUCTURED result verified
  // through the #55 recognizer (conclusion is never inferred from the process exiting).
  async reconcile(): Promise<AssistReconcileReport> {
    const report: AssistReconcileReport = { recovered: [], unknown: [], pending: [], ended: [], errors: [] };
    let loaded: LoadedAssistSessions;
    try {
      loaded = await this.deps.sessions.load();
    } catch (error) {
      report.errors.push({ key: "sessões", message: messageOf(error) });
      return report;
    }
    for (const name of loaded.unreadable) {
      report.errors.push({ key: "sessões", message: `arquivo de sessão assistida ilegível: ${name}` });
    }
    // The reconciliation is supervision recovery, not admission: it runs even on a paused
    // instance, like the approvals and conclusions it does not replace.
    for (const session of loaded.sessions.filter((candidate) => holdsCapacity(candidate))) {
      await this.guard(session.key, report, () => this.reconcileOne(session, report));
    }
    return report;
  }

  // One held-capacity identity at startup: `opening` or `open`. The probe decides.
  private async reconcileOne(session: AssistSession, report: AssistReconcileReport): Promise<void> {
    const key = session.key;
    if (session.containerName === undefined) {
      return this.announceUnknownSession(
        session, report,
        "o nome do container não está no registro da sessão",
      );
    }
    const observation = await this.deps.ports.exec.observe(session.containerName);
    if (observation.verdict === "unknown") {
      return this.announceUnknownSession(session, report, observation.detail);
    }
    if (observation.verdict === "running") {
      return this.recoverAlive(session, observation, report);
    }
    // Provenably not running (present-but-stopped or an absence the daemon itself reported):
    // an `opening` without a registered exec pane was never launched (the pane identity is
    // persisted right after the tab is created, before `pane run`); everything else really
    // ended, and its result is decided through the structured channel, never by the exiting.
    if (session.state === "opening" && (session.tabId === undefined || session.paneId === undefined)) {
      const reason = "abertura não concluída antes do reinício (nenhuma aba de execução registrada; o exec não foi lançado); " +
        "trabalho preservado para intervenção sem reexecução automática; o claim pode ter sido confirmado ou não antes da queda";
      const parked = toPending(appendSessionLog(session, `reconciliação pós-reinício: ${reason}`), reason);
      await this.deps.sessions.save(parked);
      report.pending.push({ key, reason });
      this.emit(key, "atendimento-pendente",
        "abertura assistida interrompida pelo reinício antes de lançar o exec; nada é reexecutado automaticamente", {
          motivo: reason, "claim confirmado": "não comprovado", "reexecutado": "não", "issue fechada": "não",
        }, "atenção", { highlight: true });
      await this.announceAttention(key, interventionPending(
        { key, ref: parked.ref, repository: parked.repository },
        "abertura assistida interrompida pelo reinício: intervenção pedida", this.hour(),
        digestOf(["abertura-não-lançada"]), { reason }));
      return;
    }
    return this.reconcileEnded(session, observation, report);
  }

  // Execução comprovadamente viva (decision C: the probe wins; a readable end record can only
  // be stale, so it is removed so a later genuine end writes a NEW one). Back under supervision
  // in the same session and area: no second pi, capacity kept, no authorization consumed.
  private async recoverAlive(
    session: AssistSession, observation: AssistExecObservation, report: AssistReconcileReport,
  ): Promise<void> {
    const record = await this.readExitRecord(session);
    if (record.kind === "ended") {
      // `resumeExec` always removes the old record before relaunching (ticket #56), so a record
      // under a LIVE exec is stale by construction: taking it as the new end would "end" a live
      // exec — the exact regression this guard closes.
      try {
        await this.deps.areaFs.removeExitRecord(session);
      } catch (error) {
        report.errors.push({ key: session.key, message: `registro de fim obsoleto não pôde sair: ${messageOf(error)}` });
      }
    }
    const reason = `execução comprovadamente viva (${observation.detail}); supervisão retomada; o agente não é reexecutado`;
    const recovered = appendSessionLog(session, `reconciliação pós-reinício: ${reason}`);
    if (recovered.state === "opening") {
      const opened = toOpen(recovered);
      await this.deps.sessions.save(opened);
    } else {
      await this.deps.sessions.save(recovered);
    }
    report.recovered.push({ key: session.key, reason });
    this.announceOnce(session.key, `recuperado|${observation.verdict}`, () =>
      this.emit(session.key, "atendimento-recuperado",
        "sessão assistida recuperada após o reinício: execução viva volta a ser acompanhada", {
          "container": observation.containerName, "reexecutado": "não", "capacidade": "mantida",
        }, "info", { highlight: true }));
    await this.resolveAttention(session.key, ["intervenção"]);
    await this.announceAttention(session.key, sessionOpenPending({
      key: session.key, ref: session.ref, repository: session.repository,
      model: session.model, cloneDir: session.cloneDir,
      tabId: session.tabId, paneId: session.paneId, containerName: session.containerName,
      label: session.label, resumes: session.resumes,
    }, this.hour()));
  }

  // Provenably ended (Docker said so, by identity) with the end channel not speaking — the record
  // is missing or illegible. What decides is the STRUCTURED result the exec left (#55); the exit
  // or the container's disappearance is never a conclusion. Young sessions inside the opening
  // grace stay unknown instead of being ended on a guess (decision B).
  private async reconcileEnded(
    session: AssistSession, observation: AssistExecObservation, report: AssistReconcileReport,
  ): Promise<void> {
    const record = await this.readExitRecord(session);
    if (record.kind === "ended") {
      // Executed before the crash, its end recorded (open state is likely lost too when the
      // state was `opening`) — the regular supervision path reads this very record and verifies
      // the structured result; delegating keeps one owner for the end-handling.
      const reason = `fim da execução registrado (exit ${record.record.exitCode}); resultado estruturado a verificar pela supervisão do ciclo`;
      report.ended.push({ key: session.key, reason });
      this.announceOnce(session.key, `aguardando-supervisão|exit${record.record.exitCode}`, () =>
        this.emit(session.key, "atendimento-pendente",
          "execução encerrada durante a indisponibilidade: o fim está registrado; a supervisão verifica o resultado", {
            fim: `exit ${record.record.exitCode}`, "resultado": "a verificar", "reexecutado": "não",
          }, "atenção", { highlight: true }));
      return;
    }
    // Opening lag (image pull, container creation): a young session whose presence cannot be
    // decided yet. Unknown, reserved, clarified on a later restart (decision B).
    const startedAt = Date.parse(session.startedAt);
    const byNow = (this.deps.now ?? (() => new Date()))().getTime();
    if (!Number.isNaN(startedAt) && byNow - startedAt < OPENING_GRACE_MS) {
      return this.announceUnknownSession(session, report,
        `a sessão é pequena demais para decidir (janela de graça de abertura): ${observation.detail}`);
    }
    const motive = record.kind === "unknown"
      ? `registro de fim ilegível (${record.reason}); fim comprovado pela identidade do container (${observation.detail})`
      : `registro de fim ausente; fim comprovado pela identidade do container (${observation.detail})`;
    const reconciled = appendSessionLog(session, `reconciliação pós-reinício: ${motive}`);
    const proposal = await this.readProposal(reconciled);
    if (proposal.kind === "none") {
      // The same pending the supervision would reach — with the identity proof and the missing
      // record spelled out as the end, since the record channel cannot name it. The continuity
      // question (#56) enforces the manual/authorized paths, never a new execution.
      return this.parkWithoutRecognizedResult(reconciled, `execução encerrada (${observation.detail}) sem registro de fim nem resultado de atendimento reconhecido;` +
        " atendimento pendente com sessão e contexto preservados", observation.detail, report);
    }
    await this.handleProposal(reconciled, observation.detail, undefined, proposal, report);
  }

  // Unknown execution: identity persisted but neither alive nor dead can be proven (Docker
  // could not be asked, or the session is inside its opening grace). Persistent intervention,
  // capacity RESERVED in the same states that hold it — never a second open, never a freeing.
  private async announceUnknownSession(
    session: AssistSession, report: AssistReconcileReport, why: string,
  ): Promise<void> {
    const reason = `execução desconhecida após o reinício: ${why}; capacidade mantida até esclarecimento`;
    const kept: AssistSession = {
      ...appendSessionLog(session, `reconciliação pós-reinício: ${reason}`),
      reason,
    };
    await this.deps.sessions.save(kept);
    report.unknown.push({ key: session.key, reason });
    this.announceOnce(session.key, `execução-desconhecida|${why}`, () =>
      this.emit(session.key, "atendimento-intervenção",
        "execução assistida desconhecida após o reinício; capacidade reservada até esclarecimento", {
          motivo: why, "capacidade": "reservada", "reexecutado": "não",
        }, "atenção", { highlight: true }));
    await this.announceAttention(session.key, interventionPending(
      { key: session.key, ref: session.ref, repository: session.repository },
      "execução desconhecida após o reinício: intervenção pedida; capacidade reservada", this.hour(),
      digestOf(["execução-desconhecida", why]), { reason: why, actions: ["logs"] }));
  }

  constructor(private readonly deps: AssistFlowDeps) {
    this.obs = deps.observer ?? noopObserver;
  }

  // The write mechanism is built per use, so the flow always writes through the tracker the
  // deps name: every orchestrator write on an issue rides this (ADR 0001).
  private get writes(): IssueWrites {
    return new IssueWrites(this.deps.tracker, this.obs);
  }

  // One polling cycle: supervise the running attendances first, then (unless paused) admit new
  // ones. Never throws: every failure lands in the report.
  async poll(): Promise<AssistPollReport> {
    const report: AssistPollReport = {
      opened: [], pending: [], concluded: [], resumed: [], rejected: [], skipped: [], errors: [], paused: false,
    };
    let loaded: LoadedAssistSessions;
    try {
      loaded = await this.deps.sessions.load();
    } catch (error) {
      report.errors.push({ key: "sessões", message: messageOf(error) });
      return report;
    }
    for (const name of loaded.unreadable) {
      report.errors.push({ key: "sessões", message: `arquivo de sessão assistida ilegível: ${name}` });
    }
    try {
      report.paused = await this.deps.control.isPaused();
    } catch (error) {
      // An unknown pause state opens nothing: unknown is not the same as not paused.
      report.errors.push({ key: "controle", message: messageOf(error) });
      return report;
    }
    for (const session of loaded.sessions.filter((candidate) => candidate.state === "open")) {
      await this.guard(session.key, report, () => this.superviseOne(session, report));
    }
    // The operator's approvals and the concluded attendances' cleanup are not admissions: they
    // run even on a paused instance (pause stops new openings, it does not hold approved work).
    await this.guard("aprovações", report, () => this.processApprovals(report));
    await this.guard("conclusões", report, () => this.finishConclusions(report));
    if (report.paused) {
      report.skipped.push({ key: "atendimento", reason: "instância pausada: nada novo é aberto" });
      return report;
    }
    // The scheduled authorized resumes come before the discovery of new attendances (spec #48,
    // item 5): the operator's decision for already-preserved work has priority over new opens,
    // both counted in the same assisted N limit.
    await this.guard("retomadas-agendadas", report, () => this.runScheduledResumes(report));
    let tracked;
    try {
      const jobs = await this.deps.jobs.load();
      for (const name of jobs.unreadable) {
        report.errors.push({ key: "trabalhos", message: `arquivo de trabalho ilegível: ${name}` });
      }
      tracked = new Set([
        ...jobs.jobs.map((job) => job.key),
        ...sessionTrackedKeys(loaded),
        ...unreadableKeysOf(jobs.unreadable),
      ]);
    } catch (error) {
      report.errors.push({ key: "trabalhos", message: messageOf(error) });
      return report;
    }
    await this.admit(tracked, report);
    return report;
  }

  // Supervision of one open attendance: the exec's real end arrives through the
  // container-written exit record (ticket #52's proven channel). Pane disappearance, tab state
  // and terminal text prove nothing here, and a session waiting for the human keeps its
  // capacity until the record lands: the execution having really stopped is what frees it.
  private async superviseOne(session: AssistSession, report: AssistPollReport): Promise<void> {
    const record = await this.readExitRecord(session);
    const current = (await this.deps.sessions.load()).sessions.find((candidate) => candidate.key === session.key);
    if (!current || current.state !== "open") return;
    if (record.kind === "running") {
      // The exec is active by every accepted proof. The cycle still re-checks the TWO
      // independent signals below — bounded look, same single-writer save discipline.
      await this.checkRevocation(current, report);
      await this.checkTabGone(current, report);
      return;
    }
    if (record.kind === "unknown") {
      // An exec the channel cannot speak about keeps its capacity reserved until clarified
      // (spec #48, item 5); the reason is announced once, not on every poll.
      this.announceOnce(current.key, `execução-ilegível|${record.reason}`,
        () => this.emit(current.key, "atendimento-intervenção",
          "execução assistida ilegível para a supervisão; capacidade mantida até esclarecimento",
          { motivo: record.reason }, "atenção"));
      await this.announceAttention(current.key, interventionPending(
        { key: current.key, ref: current.ref, repository: current.repository },
        "execução assistida ilegível: intervenção pedida; capacidade mantida até esclarecimento",
        this.hour(), digestOf(["execução-ilegível", record.reason]),
        { reason: record.reason }));
      return;
    }
    // Real end by the exit record: the attendance is NOT concluded by the stop itself, and an
    // exit code is never read as a success. What the ended execution left in its session channel
    // decides the next step: a recognized proposal waits for the operator's approval, and an
    // interruption or an absent result stays pending, asking the operator the continuity
    // question once (spec #48, item 5; scheduling an authorized resume is #57).
    const proposal = await this.readProposal(current);
    if (proposal.kind !== "none") {
      return this.handleProposal(current, `exit ${record.record.exitCode}`, record.record.exitCode, proposal, report);
    }
    return this.parkWithoutRecognizedResult(current, `execução encerrada (exit ${record.record.exitCode}) sem resultado de atendimento reconhecido;` +
      " atendimento pendente com sessão e contexto preservados", `exit ${record.record.exitCode}`, report);
  }

  // An end whose recognized result is none: the continuity question (spec #48 item 5) is asked
  // once in the registry and the attendance stays parked with its context preserved for the
  // operator's reply, resume or release. Shared by the exit-record supervision path and by the
  // reconciliation's and the reclaim's identity-proven ends, which carry the same discipline.
  private async parkWithoutRecognizedResult(
    session: AssistSession, reason: string, endOf: string, report: { pending: AssistReasoned[] },
  ): Promise<void> {
    const asked = askContinuity(
      toPending(appendSessionLog(session, `supervisão: ${reason}`), reason),
      CONTINUITY_QUESTION, (this.deps.now ?? (() => new Date()))().toISOString(),
    );
    await this.deps.sessions.save(asked);
    report.pending.push({ key: asked.key, reason });
    // A new interruption is a NEW occurrence for the operator (ticket #59): the open session's
    // pending takes over and the fresh decision raises with its own id (dedupe by digest of
    // question + reason).
    this.emit(asked.key, "atendimento-pendente",
      "execução assistida encerrada sem resultado reconhecido; o atendimento segue pendente", {
        motivo: reason, fim: endOf, "claim preservado": "sim", "issue fechada": "não",
      }, "atenção", { highlight: true });
    await this.announceAttention(asked.key, decisionPending({
      key: asked.key, ref: asked.ref, repository: asked.repository,
      question: asked.continuity?.question, reason,
    }, this.hour()));
  }

  // ── Active-session signals (spec #48 item 5; #57's "sessão já ativa" and #59's revocation
  // producer). The exec keeps running and keeps its capacity; the cycle adds two bounded,
  // independent re-checks that SIGNAL without touching the pi process and without presuming an
  // attended conclusion: the session keeps being supervised until a natural end or a decided
  // stop.

  // (a) Revocation of the live attendance's authorization: the issue snapshot is reread once
  // per cycle (the same `readIssue` seam admission/resume use) and every disappeared condition
  // is named. One pending per reason set: the same set re-demands nothing (dedupe by id in the
  // keeper), a NEW reason raises a NEW signal. A snapshot that cannot be read proves nothing
  // and raises nothing — unknown is never absence of the authorization.
  private async checkRevocation(session: AssistSession, report: AssistPollReport): Promise<void> {
    const reasons: string[] = [];
    const project = this.deps.instance.projects.find((candidate) => candidate.repository === session.repository);
    if (project === undefined) reasons.push("o projeto saiu da instância");
    else if (!project.enabled) reasons.push(`projeto ${project.name} desabilitado`);
    let snapshot: IssueSnapshot | undefined;
    try {
      snapshot = await this.deps.tracker.readIssue(session.ref);
    } catch {
      snapshot = undefined;
    }
    if (snapshot === undefined) {
      // The tracker cannot be asked: no revocation is proven.
    } else {
      if (snapshot.labels.known && !snapshot.labels.value.includes(HUMAN_ASSISTED_LABEL)) {
        reasons.push(`autorização revogada (label ${HUMAN_ASSISTED_LABEL} não está mais na issue)`);
      }
      if (snapshot.statusCategory.known && snapshot.statusCategory.value === "done") {
        reasons.push("issue terminal (done)");
      }
      if (snapshot.claimed.known && !snapshot.claimed.value) {
        reasons.push("claim da issue não está mais presente");
      }
    }
    if (reasons.length === 0) return;
    const reasonSet = reasons.join("; ");
    this.announceOnce(session.key, `revogação|${reasonSet}`, () =>
      this.emit(session.key, "atendimento-revogado",
        "autorização do atendimento revogada com a sessão ativa; a execução NÃO é morta e o atendimento NÃO é presumido concluído — a sessão segue acompanhada até o fim natural ou a parada decidida", {
          motivo: reasonSet, "processo morto": "não", "atendimento presumido concluído": "não",
          "sessão": "segura acompanhada", "capacidade": "mantida até a parada real",
        }, "atenção", { highlight: true }));
    await this.logRegistryOnce(session, `revogação sinalizada: ${reasonSet}`, report);
    // A persistent intervention WITHOUT a scripted action: the session is still ACTIVE, the
    // resume/release commands do not apply to it, and closing the exec's tab (which solicits
    // the stop) is a manual gesture, not a paste-ready command.
    await this.deps.attention?.raise(interventionPending(
      { key: session.key, ref: session.ref, repository: session.repository },
      "autorização revogada com a sessão ativa; a supervisão segue até o fim natural ou a parada decidida",
      this.hour(), digestOf(["revogação", reasonSet]),
      { reason: reasonSet, actions: [] }));
  }

  // A registry line written once per distinct signal: the record of the session stays honest
  // without growing on every cycle, and the save only happens while the session is still open.
  // Returns the record as it now stands (the freshest base for any immediate state change), or
  // the untouched session when nothing was written.
  private async logRegistryOnce(
    session: AssistSession, line: string, report: AssistPollReport,
  ): Promise<AssistSession> {
    const current = (await this.deps.sessions.load()).sessions.find((candidate) => candidate.key === session.key);
    if (current === undefined || current.state !== "open" || current.log.includes(line)) return session;
    try {
      const logged = appendSessionLog(current, line);
      await this.deps.sessions.save(logged);
      return logged;
    } catch (error) {
      report.errors.push({ key: session.key, message: `registro da sessão não pôde ser anotado: ${messageOf(error)}` });
      return session;
    }
  }

  // (b) The tab-close reclaim (ticket #56; the physical finding of the #52 proof is recorded
  // here too): Herdr dropping the pane does NOT itself stop the exec — when the supervision
  // proves the session's tab gone while the exit record is still absent, the orchestrator
  // REQUESTS the stop of the exec it supervises by container identity, then verifies the stop
  // through the end channels before anything is freed. The verification can only fail inside
  // the cycle: doubt keeps the intervention pending with its reason and the capacity reserved
  // (the unknown semantics of #58) — never a freeing on a guess, never a silent wait.
  private async checkTabGone(session: AssistSession, report: AssistPollReport): Promise<void> {
    if (session.tabId === undefined) return;
    let tabs: readonly string[];
    try {
      tabs = await this.deps.ports.herdr.tabIds();
    } catch (error) {
      // Herdr cannot be asked: the absence of the tab is unproven, so nothing is requested and
      // the exec's end keeps being decided by the exit record exactly as before.
      this.announceOnce(session.key, `aba-ilegível|${messageOf(error)}`, () =>
        this.emit(session.key, "atendimento-intervenção",
          "o Herdr não pôde ser perguntado sobre a aba da sessão; nada é presumido — a supervisão segue pelo canal de fim",
          { motivo: messageOf(error) }, "atenção"));
      return;
    }
    if (tabs.includes(session.tabId)) return;
    await this.reclaimTabGone(session, report);
  }

  private async reclaimTabGone(session: AssistSession, report: AssistPollReport): Promise<void> {
    const key = session.key;
    const containerName = session.containerName;
    const stop = this.deps.ports.stopExec;
    if (stop === undefined || containerName === undefined) {
      const reason = stop === undefined
        ? "aba do exec fechada, mas o canal de parada por identidade não está disponível: a parada não pode ser solicitada; capacidade mantida"
        : "aba do exec fechada, mas o nome do container não está registrado: a parada não pode ser solicitada; capacidade mantida";
      this.announceOnce(key, `recuperação-impossível|${reason}`, () =>
        this.emit(key, "atendimento-intervenção",
          "aba fechada sem parada comprovada do exec; capacidade mantida - intervenção pedida", {
            motivo: reason, "aba": session.tabId ?? "desconhecida", "capacidade": "mantida",
          }, "atenção", { highlight: true }));
      await this.logRegistryOnce(session, `aba fechada sem parada comprovada: ${reason}`, report);
      await this.deps.attention?.raise(interventionPending(
        { key, ref: session.ref, repository: session.repository },
        "aba do exec fechada sem parada comprovada: intervenção pedida; capacidade mantida",
        this.hour(), digestOf(["aba-fechada-sem-parada", reason]),
        { reason }));
      return;
    }
    // The compensating action, explicitly owned by the orchestrator: the tab's disappearance
    // itself proves nothing about the process.
    this.emit(key, "atendimento-recuperação",
      "aba do exec fechada (o fechamento da aba NÃO para o exec - prova #52); solicitando a parada do exec por identidade do container", {
        aba: session.tabId, container: containerName, "ação": "parada solicitada pela supervisão",
      }, "atenção", { highlight: true });
    let request: AssistExecStopResult;
    try {
      request = await stop.stop(containerName);
    } catch (error) {
      request = { kind: "failed", detail: `solicitação de parada falhou: ${messageOf(error)}` };
    }
    if (request.kind === "failed") {
      const reason = `aba fechada; a parada do exec ${containerName} não pôde ser solicitada (${request.detail}); capacidade reservada até nova tentativa`;
      this.announceOnce(key, `parada-recusada|${request.detail}`, () =>
        this.emit(key, "atendimento-intervenção",
          "solicitação de parada do exec não pôde ser feita; capacidade mantida - nada é liberado na dúvida", {
            motivo: request.detail, container: containerName, "capacidade": "reservada",
          }, "erro", { highlight: true }));
      await this.logRegistryOnce(session, reason, report);
      await this.deps.attention?.raise(interventionPending(
        { key, ref: session.ref, repository: session.repository },
        "parada do exec não pôde ser solicitada: intervenção pedida; capacidade reservada",
        this.hour(), digestOf(["parada-recusada", request.detail]), { reason }));
      return;
    }
    // Verification INSIDE the cycle: the exit record first (a genuine end that raced the stop
    // still speaks through its channel), then the identity probe of the same container. A stop
    // only frees anything when one of them proves it; doubt stays pending with its reason.
    const record = await this.readExitRecord(session);
    if (record.kind === "ended") {
      const reason = `aba fechada; exec ${containerName} terminou com registro do canal de fim (exit ${record.record.exitCode}); parada comprovada antes de liberar`;
      const logged = await this.logRegistryOnce(session, reason, report);
      return this.handleRealEnd(logged, `exit ${record.record.exitCode}`, record.record.exitCode, report);
    }
    const observation = await this.deps.ports.exec.observe(containerName);
    if (observation.verdict === "running" || observation.verdict === "unknown") {
      const reason = `aba fechada e parada solicitada (${request.detail}), mas a verificação não comprova a parada (${observation.detail}); capacidade reservada`;
      this.announceOnce(key, `parada-incomprovada|${observation.verdict}`, () =>
        this.emit(key, "atendimento-intervenção",
          "parada do exec solicitada mas não comprovada no ciclo; capacidade reservada até esclarecimento", {
            container: containerName, verificação: observation.detail, "capacidade": "reservada",
          }, "atenção", { highlight: true }));
      await this.logRegistryOnce(session, reason, report);
      await this.deps.attention?.raise(interventionPending(
        { key, ref: session.ref, repository: session.repository },
        "parada do exec solicitada mas não comprovada: intervenção pedida; capacidade reservada",
        this.hour(), digestOf(["parada-incomprovada", observation.verdict]), { reason }));
      return;
    }
    const confirmation = `identidade do container (${observation.detail})`;
    const logged = await this.logRegistryOnce(session,
      `aba fechada; parada do exec solicitada por identidade e comprovada por ${confirmation}; nada de atendimento concluído por isso`, report);
    return this.handleRealEnd(logged, confirmation, undefined, report);
  }

  // A stop the end channels can no longer dispute: the recognized result (if the exec left one
  // before the stop) decides by its own flow; none, the attendance stays parked with the
  // continuity question. What is NEVER claimed: that the forced stop concluded the attendance.
  private async handleRealEnd(
    session: AssistSession, endOf: string, exitCode: number | undefined, report: AssistPollReport,
  ): Promise<void> {
    const proposal = await this.readProposal(session);
    if (proposal.kind !== "none") {
      return this.handleProposal(session, endOf, exitCode, proposal, report);
    }
    const reason = `execução parada (${endOf}) sem resultado de atendimento reconhecido;` +
      " atendimento pendente com sessão e contexto preservados";
    return this.parkWithoutRecognizedResult(session, reason, endOf, report);
  }

  // A proposal only exists after the execution really stopped (the exit-record channel): the
  // recognition reads the session files the container wrote, never terminal text nor exit codes.
  private async readProposal(session: AssistSession): Promise<RecognizedResult> {
    if (session.sessionsDir === undefined) {
      return { kind: "none", reason: "diretório da sessão pi não registrado" };
    }
    const texts = await this.deps.areaFs.listSessionTexts(session.sessionsDir);
    if (texts.length === 0) return { kind: "none", reason: "nenhum arquivo de sessão pi escrito pelo container" };
    return recognizeAssistResult(texts);
  }

  // One recognized proposal: an interruption does not conclude the attendance (its handling is
  // the operator's decision, kept for the later resume/release delivery); concluded and external
  // wait are proposals that now wait for the operator's explicit approval. None of this writes
  // anything to the tracker. The end siting is the caller's evidence (`exit N` for the record
  // channel, with the reconciliation's identity proof spelled out for the recovery paths).
  private async handleProposal(
    session: AssistSession, endOf: string, exitCode: number | undefined,
    proposal: RecognizedResult, report: { pending: AssistReasoned[] },
  ): Promise<void> {
    if (proposal.kind === "invalid") {
      const reason = `proposta de resultado ilegível (${proposal.reason});` +
        " atendimento pendente com sessão e contexto preservados";
      const next = toPending(appendSessionLog(session, `supervisão: ${reason}`), reason);
      await this.deps.sessions.save(next);
      report.pending.push({ key: next.key, reason });
      this.emit(next.key, "atendimento-pendente",
        "proposta de resultado ilegível; o atendimento segue pendente", {
          motivo: reason, fim: endOf, ...(exitCode === undefined ? {} : { exit: exitCode }),
          "claim preservado": "sim", "issue fechada": "não",
        }, "atenção", { highlight: true });
      await this.announceAttention(next.key, interventionPending(
        { key: next.key, ref: next.ref, repository: next.repository },
        "proposta de resultado ilegível: intervenção pedida", this.hour(),
        digestOf(["proposta-ilegível", reason]), { reason }));
      return;
    }
    if (proposal.kind === "none") return;
    if (proposal.result.status === "interrupted") {
      const reason = `execução encerrada (${endOf}) com resultado reconhecido: interrompido (${proposal.result.reason});` +
        " atendimento pendente com sessão e contexto preservados para a decisão do operador";
      // A recognized interruption asks the continuity question once, too (spec #48, item 5):
      // the registry keeps it; the answer is the operator's own reply, not a new execution.
      const next = askContinuity(
        toPending(appendSessionLog(session, `supervisão: ${reason}`), reason),
        CONTINUITY_QUESTION, (this.deps.now ?? (() => new Date()))().toISOString(),
      );
      await this.deps.sessions.save(next);
      report.pending.push({ key: next.key, reason });
      this.emit(next.key, "atendimento-pendente",
        "execução assistida interrompida pelo resultado do atendimento; nada concluído", {
          motivo: reason, fim: endOf, ...(exitCode === undefined ? {} : { exit: exitCode }),
          resultado: "interrompido",
          "claim preservado": "sim", "issue fechada": "não",
        }, "atenção", { highlight: true });
      await this.announceAttention(next.key, decisionPending({
        key: next.key, ref: next.ref, repository: next.repository,
        question: next.continuity?.question, reason,
      }, this.hour()));
      return;
    }
    // Concluded or external wait: the capacity is already free (the execution really stopped);
    // the registration waits for the operator's explicit approval command.
    const next: AssistSession = {
      ...toProposed(appendSessionLog(session,
        `supervisão: resultado proposto (${proposal.result.status}); aguardando a aprovação do operador`)),
      result: proposal.result,
      resultPayload: proposal.payload,
      resultDigest: proposal.digest,
      endedAt: session.endedAt ?? new Date().toISOString(),
      reason: "resultado proposto; aguardando a aprovação do operador",
    };
    await this.deps.sessions.save(next);
    report.pending.push({ key: next.key, reason: next.reason! });
    this.emit(next.key, "atendimento-resultado",
      `resultado do atendimento proposto pelo agente (${statusName(proposal.result.status)});` +
      " aguardando a aprovação explícita do operador antes de registrar", {
        resultado: statusName(proposal.result.status), digest: proposal.digest,
        "registrado": "não", "aprovação humana": "pendente", "issue fechada": "não",
      }, "atenção", { highlight: true });
    await this.announceAttention(next.key, decisionPending({
      key: next.key, ref: next.ref, repository: next.repository,
      reason: `${statusName(proposal.result.status)} proposto pelo agente; aprovação pendente`,
      resultDigest: proposal.digest,
    }, this.hour()));
  }

  // The approval commands of this cycle, in queue order. `approve` is the operator's explicit
  // approval of one proposed result (the assisted key must exist); anything else is the
  // implementation admission's business and stays in the queue untouched. A refused approval is
  // consumed with its reason (never retried forever); an applied one is consumed too, because
  // the conclusion's retries live in the session record, not in the queue.
  private async processApprovals(report: AssistPollReport): Promise<void> {
    const queued = await this.deps.commands.pending();
    for (const name of queued.unreadable) {
      report.errors.push({ key: "comandos", message: `comando ilegível: ${name}` });
    }
    for (const command of queued.commands) {
      if (command.type === "pause" || command.type === "unpause" || command.type === "reply"
        || command.type === "resume" || command.type === "release") continue;
      if (command.type !== "approve") continue;
      await this.guard(command.job, report, () => this.applyApproval(command, report));
      try {
        await this.deps.commands.done(command.id);
      } catch (error) {
        report.errors.push({ key: command.job, message: `comando ${command.type} não pôde sair da fila: ${messageOf(error)}` });
      }
    }
  }

  private async applyApproval(
    command: { id: string; job: string }, report: AssistPollReport,
  ): Promise<void> {
    const loaded = await this.deps.sessions.load();
    const session = loaded.sessions.find((candidate) => candidate.key === command.job);
    if (session === undefined || session.state === "concluding") {
      const reason = session === undefined
        ? "atendimento assistido não encontrado (a sessão já não está acompanhada)"
        : "aprovação já em andamento: a conclusão continua sendo tentada; nada é registrado duas vezes";
      report.rejected.push({ key: command.job, reason });
      this.emit(command.job, "comando-rejeitado", "aprovação recusada", {
        comando: command.id, motivo: reason,
      }, "atenção");
      return;
    }
    if (session.state === "open" || session.state === "opening") {
      const reason = "execução ainda ativa: a capacidade assistida segue ocupada e o resultado só " +
        "é reconhecido depois que a execução realmente parar (canal de fim de execução)";
      report.rejected.push({ key: command.job, reason });
      this.emit(command.job, "comando-rejeitado", "aprovação recusada", {
        comando: command.id, motivo: reason,
      }, "atenção");
      return;
    }
    if (session.state === "pending" || session.result === undefined || session.resultDigest === undefined) {
      const reason = "sem resultado reconhecido para este atendimento; uma aprovação sem proposta não registra nada";
      report.rejected.push({ key: command.job, reason });
      this.emit(command.job, "comando-rejeitado", "aprovação recusada", {
        comando: command.id, motivo: reason,
      }, "atenção");
      return;
    }
    // Explicit approval: the approved result is persisted BEFORE any tracker write, so a crash
    // is a visible decision, never a silent one.
    const nowAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const approved: AssistSession = appendSessionLog(session,
      `aprovação aplicada (comando ${command.id}); conclusão do atendimento iniciada`);
    approved.approval = { at: nowAt, command: command.id };
    approved.state = "concluding";
    approved.reason = undefined;
    await this.deps.sessions.save(approved);
    this.emit(approved.key, "comando-aplicado", "aprovação do operador aplicada", {
      comando: command.id, resultado: statusName(approved.result!.status),
    }, "info");
    await this.concludeApproved(approved, report);
  }

  // The approved actions, each one an approved write confirmed by rereading (ADR 0001), run to
  // completion here and on every following poll for sessions still concluding: re-reading before
  // reconciling or repeating. The record is removed only when every action is confirmed, so a
  // cleanup never ends as confirmed and the issue never gets a second attendance mid-cleanup.
  private async finishConclusions(report: AssistPollReport): Promise<void> {
    const loaded = await this.deps.sessions.load();
    for (const session of loaded.sessions.filter((candidate) => candidate.state === "concluding")) {
      await this.guard(session.key, report, () => this.concludeApproved(session, report));
    }
  }

  private async concludeApproved(session: AssistSession, report: AssistPollReport): Promise<void> {
    const context: IssueWritesContext = { job: session.key, reason: "conclusão do atendimento assistido (aprovado)" };
    let current = session;
    // (1) The approved result is registered as the result's own comment, once: the re-read of the
    // comments is the evidence that avoids a duplicate registration, not the attempt's answer.
    if (current.resultCommentId === undefined) {
      const digest = current.resultDigest;
      const payload = current.resultPayload;
      if (digest === undefined || payload === undefined) {
        const reason = "resultado aprovado sem payload/digest registrado: registro adiado; intervenção pedida";
        await this.keepConcluding(current, reason, report, "registro-do-resultado");
        return;
      }
      try {
        const existing = (await this.deps.tracker.readComments(current.ref))
          .find((comment) => isFactoryComment(current.ref.tracker, comment.body) && comment.body.includes(`digest: ${digest}`));
        if (existing === undefined) {
          const body = [
            `Resultado do atendimento assistido (${current.key}), aprovado pelo operador:`,
            `<msf-result>${payload}</msf-result>`,
            `digest: ${digest}`,
          ].join("\n");
          await postFactoryComment(this.deps.tracker, current.ref, body, {
            observer: this.obs, job: current.key, reason: "registro do resultado aprovado do atendimento",
          });
        }
        const confirmed = (await this.deps.tracker.readComments(current.ref))
          .find((comment) => isFactoryComment(current.ref.tracker, comment.body) && comment.body.includes(`digest: ${digest}`));
        if (confirmed === undefined) {
          const reason = "registro do resultado não confirmado pela releitura dos comentários";
          await this.keepConcluding(current, reason, report, "registro-do-resultado");
          return;
        }
        current = { ...appendSessionLog(current, `resultado registrado no comentário ${confirmed.id} (confirmado por releitura)`), resultCommentId: confirmed.id };
        await this.deps.sessions.save(current);
      } catch (error) {
        const reason = `registro do resultado não confirmado: ${messageOf(error)}`;
        await this.keepConcluding(current, reason, report, "registro-do-resultado");
        return;
      }
    }
    // (2) The factory's claim mark leaves the issue with the conclusion (claim kept until
    // conclusion, ADR 0003). Not confirmed, the cleanup stays here.
    const release = await this.writes.release(current.ref, context);
    if (release.status !== "released") {
      await this.keepConcluding(current, release.reason, report, "remoção-do-claim");
      return;
    }
    // (3) The human-assisted authorization leaves too, and the approved forward (when the
    // approved result asks for the autonomous flow) is added; each change is judged by reread.
    const target = (this.deps.instance.projects.find((project) => project.repository === current.repository));
    const forward = current.result!.status === "concluded" && current.result!.forward === "ready-for-agent";
    if (forward && target === undefined) {
      await this.keepConcluding(current,
        "encaminhamento aprovado sem projeto configurado para o repositório; encaminhamento adiado", report, "encaminhamento");
      return;
    }
    const changes = forward
      ? { remove: [HUMAN_ASSISTED_LABEL], add: [target!.labels.ready] }
      : { remove: [HUMAN_ASSISTED_LABEL] };
    const labels = await this.writes.updateLabels(current.ref, changes, context);
    if (labels.status !== "confirmed") {
      await this.keepConcluding(current, labels.reason, report, "remoção-da-autorização");
      return;
    }
    // Every approved action confirmed: the attendance's tracking ends here, without closing the
    // issue and without a release of anything that was not part of the approved actions.
    const summary = `atendimento concluído (${statusName(current.result!.status)}): resultado registrado, ` +
      "claim removido, human-assisted removido; issue não fechada";
    await this.deps.sessions.remove(current.key);
    report.concluded.push({ key: current.key, reason: summary });
    this.emit(current.key, "atendimento-concluído", summary, {
      resultado: statusName(current.result!.status), registro: current.resultCommentId!,
      encaminhamento: forward ? target!.labels.ready : "nenhum",
      claim: "removido (confirmado pela releitura)", "human-assisted": "removido (confirmado pela releitura)",
      "issue fechada": "não", "sessão": "acompanhamento encerrado",
    }, "info", { highlight: true });
    await this.deps.attention?.resolve(current.key);
  }

  // A cleanup that could not be finished stays concluding with its reason; the intervention is
  // announced once per distinct reason, never repeated on every poll, and nothing is concluded.
  private async keepConcluding(
    session: AssistSession, reason: string, report: AssistPollReport, signature: string,
  ): Promise<void> {
    const kept: AssistSession = {
      ...appendSessionLog(session, `conclusão incompleta: ${reason}`),
      state: "concluding",
      reason,
    };
    await this.deps.sessions.save(kept);
    report.pending.push({ key: kept.key, reason });
    this.announceOnce(kept.key, signature,
      () => this.emit(kept.key, "atendimento-intervenção",
        `conclusão incompleta (${signature}); nada concluído como confirmado; nova tentativa no próximo ciclo`,
        { motivo: reason, "issue fechada": "não", "acompanhamento": "mantido até confirmar" }, "erro", { highlight: true }));
    await this.announceAttention(kept.key, interventionPending(
      { key: kept.key, ref: kept.ref, repository: kept.repository },
      "conclusão do atendimento incompleta: intervenção pedida", this.hour(),
      digestOf([signature, reason]), { reason }));
  }

  private async readExitRecord(
    session: AssistSession,
  ): Promise<ExitRecordVerdict> {
    if (session.execStateDir === undefined) {
      return { kind: "unknown", reason: "diretório do canal de fim de execução não registrado" };
    }
    return this.deps.areaFs.readExitRecord(assistExitRecordPath(session.execStateDir));
  }

  // ── Operator commands over the registry (ticket #56), the manual paths of an interrupted
  // attendance. The admission delegates them: it is the queue's single drain, and a command the
  // job store does not know may still name one of these sessions. Each one reads the registry
  // synchronously and acts synchronously, like the admission of #54: a duplicate or concurrent
  // command of the same cycle finds the state already changed and is refused, never a second
  // opening; other works of the instance are never touched.

  async has(key: string): Promise<boolean> {
    const loaded = await this.deps.sessions.load();
    return loaded.sessions.some((candidate) => candidate.key === key);
  }

  // Manual resume of one parked attendance (never automatic): the same session and area — pi -c
  // on the same pi session file, the same clone re-mounted — after the full revalidation of the
  // current conditions. A condition the tracker or the environment cannot confirm keeps the
  // work parked with a visible reason; a missing context asks for intervention instead of
  // starting a silent new conversation.
  async resume(key: string, command: string): Promise<AssistOperatorResult> {
    const loaded = await this.deps.sessions.load();
    const current = loaded.sessions.find((candidate) => candidate.key === key);
    if (current === undefined) return { status: "rejected", reason: "atendimento assistido desconhecido" };
    if (current.state !== "pending") {
      return { status: "rejected", reason: `resume não se aplica à sessão assistida em estado ${current.state}` };
    }
    const parked = async (reason: string): Promise<AssistOperatorResult> => {
      await this.deps.sessions.save(appendSessionLog(current, `retomada recusada: ${reason}`));
      return { status: "rejected", reason };
    };
    const conditions = await this.resumeConditions(current);
    if (typeof conditions === "string") return parked(conditions);
    return this.resumeExec(current, conditions, command);
  }

  // The full revalidation ONE opening (manual or scheduled) must pass before it launches
  // (ticket #57): authorization of the issue, non-contradictory human state, project, routing,
  // impediments/dependencies, claim, environment/runtimes and context; same session and area.
  // The reason the opening is refused — waiting for capacity or any failed predicate — never
  // consumes a scheduled authorization. The return is the prepared opening, or the reason.
  private async resumeConditions(current: AssistSession): Promise<PreparedOpening | string> {
    const key = current.key;
    const project = this.deps.instance.projects.find((candidate) => candidate.repository === current.repository);
    if (project === undefined) return `projeto ${current.repository} não faz parte da instância`;
    if (!project.enabled) return `projeto ${project.name} desabilitado`;
    let snapshot: IssueSnapshot;
    try {
      snapshot = await this.deps.tracker.readIssue(current.ref);
    } catch (error) {
      return `issue ilegível no tracker: ${messageOf(error)}`;
    }
    // The claim was preserved with the parked work; without it the resume does not reacquire by
    // itself (that would be a fresh admission): the absence stays visible for a decision.
    if (!(snapshot.claimed.known && snapshot.claimed.value)) {
      return "claim não está mais visível na issue; a retomada não readquire sem decisão";
    }
    let others: ReadonlySet<string>;
    try {
      const jobs = await this.deps.jobs.load();
      others = new Set([
        ...jobs.jobs.map((job) => job.key),
        ...[...sessionTrackedKeys(await this.deps.sessions.load())]
          .filter((other: string) => other !== refKeyOf(current)),
      ]);
    } catch (error) {
      return `trabalhos ilegíveis: ${messageOf(error)}`;
    }
    const verdict = evaluateEligibility({
      project: this.deps.eligibility(project).project, issue: snapshot, tracked: others,
    }, resumeRules);
    if (!verdict.eligible) return verdict.rejections.map((rejection) => rejection.reason).join("; ");
    // The environment and the assisted capacity of this moment (the two N limits keep their
    // own count): only what prepare proves now authorizes the opening.
    const prepared = await this.prepare(project, key);
    if (typeof prepared === "string") return prepared;
    // The context a resume continues: the pi session files of the preserved area. Without them
    // there is no conversation to continue; the intervention request is the answer and no
    // silent new conversation starts.
    const contextMiss = await this.missingContext(current);
    if (contextMiss !== undefined) {
      this.announceOnce(key, `contexto-ausente|${contextMiss}`, () => this.emit(key, "atendimento-intervenção",
        "retomada pede intervenção: contexto da mesma sessão ausente; nenhuma conversa nova é aberta em silêncio",
        { motivo: contextMiss }, "atenção", { highlight: true }));
      await this.announceAttention(key, interventionPending(
        { key, ref: current.ref, repository: current.repository },
        "retomada pede intervenção: contexto da mesma sessão ausente", this.hour(),
        digestOf(["contexto-ausente", contextMiss]), { reason: contextMiss }));
      return `contexto da sessão ausente (${contextMiss}); intervenção pedida`;
    }
    return prepared;
  }

  // The scheduled authorized resumes (ticket #57): pending sessions carrying an unconsumed
  // authorization, attempted BEFORE the new attendances are discovered (spec #48, item 5).
  // The authorization that waits for capacity or fails a pre-check stays unconsumed: every
  // poll retries with the same persistence the scheduling asked for.
  private async runScheduledResumes(report: AssistPollReport): Promise<void> {
    const loaded = await this.deps.sessions.load();
    const scheduled = loaded.sessions.filter((candidate) =>
      candidate.state === "pending" && unconsumedResume(candidate) !== undefined);
    for (const session of scheduled) {
      await this.guard(session.key, report, () => this.attemptScheduledResume(session, report));
    }
  }

  private async attemptScheduledResume(session: AssistSession, report: AssistPollReport): Promise<void> {
    const key = session.key;
    const conditions = await this.resumeConditions(session);
    if (typeof conditions === "string") {
      const signature = `retomada-agendada-bloqueada|${conditions}`;
      // The context-missing case already asks for the intervention by itself (the same
      // intervention the manual resume asks): announcing twice would be noise, not signal.
      const contextCase = conditions.startsWith("contexto da sessão ausente");
      if (!contextCase && !this.announced.has(`${key}|${signature}`)) {
        this.announced.add(`${key}|${signature}`);
        // The persistent signal of a blocked scheduled resume: reason in the record and in the
        // event stream, once per distinct reason, never consuming the authorization.
        await this.deps.sessions.save(appendSessionLog(session, `retomada agendada bloqueada: ${conditions}`));
        this.emit(key, "atendimento-intervenção",
          "retomada agendada bloqueada antes da abertura; a autorização não é consumida",
          { motivo: conditions, "autorização consumida": "não" }, "atenção");
      }
      report.skipped.push({ key, reason: `retomada agendada aguardando condições: ${conditions}` });
      return;
    }
    const outcome = await this.resumeExec(session, conditions, "retomada-agendada");
    if (outcome.status === "applied") {
      report.resumed.push({ key, reason: "retomada autorizada executada (consumo de uso único na abertura)" });
    } else {
      report.skipped.push({ key, reason: `retomada agendada não executada: ${outcome.reason}` });
    }
  }

  // The pi session files of the preserved area: what makes `pi -c` a continuation instead of
  // a silent new conversation.
  private async missingContext(session: AssistSession): Promise<string | undefined> {
    if (session.sessionsDir === undefined) return "diretório de sessões do pi não registrado";
    let names: string[];
    try {
      names = await this.deps.areaFs.listDir(session.sessionsDir);
    } catch (error) {
      return `diretório de sessões ilegível: ${messageOf(error)}`;
    }
    return names.length === 0 ? "nenhuma sessão de pi no diretório da área" : undefined;
  }

  // The opening of the resume: the old exit record is removed first (the supervision would read
  // the old end as the new one), the profile snapshot is rewritten from the current plan, and
  // the new tab/pane identity is persisted with the state `opening` before the exec launches —
  // a failure lands in pending again, claim preserved, exactly like the first opening.
  //
  // The single-use authorization (ticket #57), when one rides the session, is consumed in the
  // SAME save that records the opening attempt: consumption + attempt identity go together,
  // and the reread right after decides whose attempt won — an attempt that finds a different
  // attempt recorded aborts WITHOUT launching, so concurrent cycles or retries never start
  // two executions of the same authorization (the single-drain discipline of #54/#56 holds;
  // this reread is the mechanism that survives them).
  private async resumeExec(current: AssistSession, prepared: PreparedOpening, command: string): Promise<AssistOperatorResult> {
    const key = current.key;
    const herdr = this.deps.ports.herdr;
    // The freshest record of this attempt: failures after the consumption was persisted must
    // keep the consumption (the opening was ATTEMPTED), never restore an unconsumed snapshot.
    let opening: AssistSession = current;
    try {
      const recordRemoved = await this.deps.areaFs.removeExitRecord(current);
      await this.deps.areaFs.ensureDirs([current.profileDir!, prepared.toolchain.npm, prepared.toolchain.mise]);
      await writeSnapshot(prepared.plan, current.profileDir!);
      const now = this.deps.now ?? (() => new Date());
      const containerName = assistContainerName(key, now().toISOString());
      const resumes = (current.resumes ?? 0) + 1;
      const label = (`msf-assist-${encodeRefPart(key).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-r${resumes}`).slice(0, 64);
      opening = {
        ...appendSessionLog(current,
          `retomada (comando ${command}): mesma sessão e área preservadas; `
          + (recordRemoved ? "registro de fim da execução anterior removido antes de relançar" : "sem registro de fim anterior")),
        state: "opening", containerName, resumes, label, reason: undefined,
      };
      // The intake authorization leaves unconsumed and pending consumption (waiting for capacity
      // or failing a pre-check); from here on the opening is ATTEMPTED: the consumption is
      // persisted atomically with this attempt's identity.
      const pendingResume = unconsumedResume(current);
      let consumed: AssistSession | undefined;
      if (pendingResume !== undefined) {
        consumed = consumeResume(opening, `${label}#${this.deps.areaFs.attemptUuid()}`, now().toISOString());
        opening = consumed;
      }
      await this.deps.sessions.save(opening);
      if (consumed !== undefined) {
        const mine = consumed.scheduledResume!.consumed!.attempt;
        const still = (await this.deps.sessions.load()).sessions.find((candidate) => candidate.key === key);
        if (still === undefined || still.state !== "opening"
          || still.scheduledResume?.consumed === undefined || still.scheduledResume.consumed.attempt !== mine) {
          return { status: "rejected",
            reason: "outro ciclo consumiu esta autorização e registrou a tentativa de abertura; nenhuma segunda execução é iniciada" };
        }
      }
      const workspace = await herdr.currentWorkspace();
      const tab = await herdr.createTab({ workspace, cwd: current.cloneDir, label });
      // The new identity is persisted before anything else changes, like the first opening.
      opening = { ...opening, tabId: tab.tab.tabId, paneId: tab.tab.paneId };
      await this.deps.sessions.save(opening);
      this.emit(key, "atendimento-admitido", "sessão assistida retomada (aba própria, sem roubar foco; mesma sessão e área)", {
        aba: label, "aba id": tab.tab.tabId, pane: tab.tab.paneId, clone: current.cloneDir, container: containerName,
      }, "atenção", { highlight: true });
      const commandLine = assistExecCommand({
        name: containerName, image: current.image, model: current.model,
        agentUidGid: prepared.agentUidGid, startedAt: now().toISOString(),
        cloneHostDir: current.cloneDir, sessionsHostDir: current.sessionsDir!, stateHostDir: current.execStateDir!,
        snapshotHostDir: current.profileDir!, runtimeHostDir: this.deps.runtimeImageDir,
        npmHostDir: prepared.toolchain.npm, miseHostDir: prepared.toolchain.mise,
        requiredPackages: prepared.requiredPackages, requiredTools: prepared.requiredTools,
        // No new prompt: `pi -c` continues the same conversation of the same session file.
        resume: true,
      });
      await herdr.paneRun(tab.tab.paneId, commandLine);
      const opened = toOpen(appendSessionLog(opening, `exec retomado na pane ${tab.tab.paneId} (container ${containerName})`));
      await this.deps.sessions.save(opened);
      this.emit(key, "atendimento-aberto", "sessão assistida retomada e aberta (pi -c na mesma sessão, sem roubar foco)", {
        modelo: opened.model, container: containerName, aba: opened.tabId, sessão: opened.sessionsDir,
        espera: "aguardando o operador",
      }, "atenção");
      // The taken-up work ends its old decision/intervention pendings; the reopened session
      // raises a fresh occurrence (new digest over the resume count).
      await this.resolveAttention(key, ["decisão", "intervenção"]);
      await this.announceAttention(opened.key, sessionOpenPending({
        key: opened.key, ref: opened.ref, repository: opened.repository,
        model: opened.model, cloneDir: opened.cloneDir,
        tabId: opened.tabId, paneId: opened.paneId, containerName,
        label: opened.label, resumes: opened.resumes,
      }, this.hour()));
      return { status: "applied" };
    } catch (error) {
      const reason = `falha na retomada assistida: ${messageOf(error)}`;
      const kept = toPending(appendSessionLog(opening, reason), reason);
      await this.deps.sessions.save(kept);
      this.emit(key, "atendimento-falha", "falha na retomada assistida; nada concluído, preservado novamente para intervenção", {
        motivo: reason, "claim preservado": "sim", "issue fechada": "não",
      }, "erro", { highlight: true });
      return { status: "rejected", reason };
    }
  }

  // Release of one parked attendance by the operator: only non-active work; the factory's claim
  // and the human-assisted authorization are removed and each removal is confirmed by reread
  // (ADR 0001). Release neither concludes nor closes the issue. A partially confirmed removal
  // stays visible and the work stays parked (still tracked): no readmission sneaks in while the
  // cleanup is incomplete. The session and its context are preserved as `released`.
  async release(key: string, command: string): Promise<AssistOperatorResult> {
    const loaded = await this.deps.sessions.load();
    const current = loaded.sessions.find((candidate) => candidate.key === key);
    if (current === undefined) return { status: "rejected", reason: "atendimento assistido desconhecido" };
    if (current.state !== "pending") {
      return { status: "rejected", reason: `release não se aplica à sessão assistida em estado ${current.state}` };
    }
    await this.deps.sessions.save(appendSessionLog(current, `liberação solicitada pelo operador (comando ${command})`));
    const context: IssueWritesContext = { job: key, reason: "liberação assistida pelo operador", refs: { comando: command } };
    const claim = await this.writes.release(current.ref, context);
    if (claim.status === "not-confirmed") return { status: "rejected", reason: claim.reason };
    // The single label route of the port: the authorization label leaves through updateLabels,
    // each removal judged by reread (the same seam the approved conclusion consumes, #55).
    const authorization = await this.writes.updateLabels(current.ref, { remove: [HUMAN_ASSISTED_LABEL] }, context);
    if (authorization.status === "not-confirmed") return { status: "rejected", reason: authorization.reason };
    // Every removal confirmed (re-read): the release is neither a conclusion nor a close; the
    // session AREA stays on disk (the pi session, the clone, the records) and the tracking ends
    // by the record leaving the store, exactly like an approved conclusion. The removed
    // authorization is what keeps release from provoking an immediate re-admission.
    await this.deps.sessions.remove(key);
    this.emit(key, "atendimento-liberado", "atendimento assistido liberado pelo operador", {
      "claim removido": "sim", "human-assisted removido": "sim", "issue fechada": "não",
      "área preservada": "sim", "acompanhamento": "encerrado pelo operador",
    }, "info");
    // The work's tracking ended: every pendings of it are ended too (release/conclusion is
    // the state change that ends the matching pending — ticket #59).
    await this.deps.attention?.resolve(key);
    return { status: "applied" };
  }

  // The operator's answer to the interruption's continuity question, recorded verbatim in the
  // session registry (the command queue's `reply`). An already answered question never reopens
  // the decision; a pending session without one (a failure after the claim) records the reply
  // as an operator note. The interpretation (ticket #57): only an explicit affirmative
  // schedules the single-use resume; a refusal or a doubtful answer schedules nothing, keeping
  // the manual paths (never asked again, never silently authorized).
  async reply(key: string, message: string, command: string): Promise<AssistOperatorResult> {
    const loaded = await this.deps.sessions.load();
    const current = loaded.sessions.find((candidate) => candidate.key === key);
    if (current === undefined) return { status: "rejected", reason: "atendimento assistido desconhecido" };
    if (current.state !== "pending") {
      return { status: "rejected", reason: `reply não se aplica à sessão assistida em estado ${current.state}` };
    }
    if (message.trim() === "") return { status: "rejected", reason: "resposta vazia" };
    const now = this.deps.now ?? (() => new Date());
    const nowAt = now().toISOString();
    const shown = message.length > 200 ? `${message.slice(0, 200)}…` : message;
    let next = answerContinuity(
      appendSessionLog(current, `resposta do operador registrada (comando ${command}): ${shown}`),
      message, nowAt,
    );
    const verdict = interpretContinuityAnswer(message);
    const authorized = verdict === "authorized" && current.continuity !== undefined;
    if (authorized) {
      next = scheduleResume(next, { at: nowAt, command, answer: message });
      await this.deps.sessions.save(next);
      this.emit(key, "atendimento-resposta", "resposta do operador registrada na decisão de continuidade", {
        comando: command, resposta: shown,
        ...(next.continuity === undefined ? {} : { pergunta: next.continuity.question }),
        "retomada": "agendada (uso único)",
      }, "info");
      this.emit(key, "atendimento-retomada-agendada",
        "resposta do operador autoriza UMA retomada desta mesma sessão: agendada com prioridade sobre novos atendimentos;"
        + " uma nova interrupção exigirá uma nova decisão", {
          comando: command, resposta: shown,
          "uso único": "uma abertura", prioridade: "antes de novos atendimentos", "capacidade": "o N assistido segue sendo respeitado",
        }, "atenção", { highlight: true });
      // The answer also ends its decision pending (ticket #59): the session registry keeps the
      // answer, so a later restart never re-asks it — authorizing does not keep the question open.
      await this.deps.attention?.resolve(key, ["decisão"]);
      return { status: "applied" };
    }
    // The latest EXPLICIT decision wins: a negative answer cancels a scheduling not yet used;
    // a doubtful answer changes nothing (the operator has not decided) — manual paths remain.
    const cancelled = verdict === "declined" && current.scheduledResume !== undefined
      && current.scheduledResume.consumed === undefined;
    if (cancelled) {
      next = { ...next, scheduledResume: undefined };
      next = appendSessionLog(next, "retomada agendada cancelada pela nova resposta explícita do operador");
    }
    await this.deps.sessions.save(next);
    this.emit(key, "atendimento-resposta", "resposta do operador registrada na decisão de continuidade", {
      comando: command, resposta: shown,
      ...(next.continuity === undefined ? {} : { pergunta: next.continuity.question }),
      "retomada": cancelled ? "agendamento cancelado (recusa explícita do operador)"
        : verdict === "declined" ? "não agendada (recusa do operador)" : "não agendada (resposta ambígua)",
    }, "info");
    // The answered question ends its decision pending (ticket #59): the answer is kept in the
    // session registry, so a later restart never re-asks it.
    await this.deps.attention?.resolve(key, ["decisão"]);
    return { status: "applied" };
  }

  // Discovery and admission of the eligible attendances, one issue after another. Discovery
  // filters by the authorization label (human-assisted), never by the autonomous ready label;
  // each evaluation and each reservation are synchronous, so no poll cycle doubles an admission.
  private async admit(tracked: ReadonlySet<string>, report: AssistPollReport): Promise<void> {
    for (const project of this.deps.instance.projects) {
      if (!project.enabled) continue;
      const eligibility = this.deps.eligibility(project);
      let refs: IssueRef[] = [];
      try {
        refs = await this.deps.tracker.discoverCandidates({
          project: eligibility.scope.project,
          readyLabel: HUMAN_ASSISTED_LABEL,
        });
      } catch (error) {
        report.errors.push({ key: eligibility.scope.project, message: messageOf(error) });
        continue;
      }
      for (const ref of refs.sort((a, b) => byKey(refKey(a), refKey(b)))) {
        await this.guard(refKey(ref), report, () => this.admitOne(ref, project, tracked, report));
      }
    }
  }

  // The admission of one candidate, step by step with the session record as the persisted work:
  // revalidate, verify the environment, reserve, claim, snapshot, tab, exec.
  private async admitOne(ref: IssueRef, project: ProjectConfig, tracked: ReadonlySet<string>, report: AssistPollReport): Promise<void> {
    const key = refKey(ref);
    const loaded = await this.deps.sessions.load();
    if (tracked.has(key) || sessionTrackedKeys(loaded).has(key)) {
      report.skipped.push({ key, reason: "já acompanhado por um dos fluxos" });
      return;
    }
    // Revalidate the current conditions before the admission (spec #48 item 2).
    const snapshot = await this.deps.tracker.readIssue(ref);
    const verdict = evaluateEligibility({
      project: this.deps.eligibility(project).project, issue: snapshot, tracked,
    }, assistedRules);
    if (!verdict.eligible) {
      report.skipped.push({ key, reason: verdict.rejections.map((rejection) => rejection.reason).join("; ") });
      return;
    }
    // What the environment can prove must be proven BEFORE the claim (spec #48 item 3): no
    // reservation and no write on the tracker while the opening is impossible.
    const prepared = await this.prepare(project, key);
    if (typeof prepared === "string") {
      report.skipped.push({ key, reason: prepared });
      return;
    }
    await this.openAttendance(ref, snapshot, project, prepared, report);
  }

  // The environment checks of one attendance: Docker, Herdr, operator clone, assist model,
  // sessions limit and the runtime profile (host-resolved snapshot plan, ADR 0002). The return
  // is the reason the opening is impossible, or the prepared opening. Availability never
  // falls back to host execution, and no capacity is reserved before every check passes.
  private async prepare(project: ProjectConfig, key: string): Promise<PreparedOpening | string> {
    void key;
    const clone = this.deps.local.checkouts[project.repository];
    const model = this.deps.instance.assistModel;
    const limit = this.deps.instance.maxAssisted;
    try {
      await this.deps.ports.sandbox.preflight({ image: this.deps.local.image, account: project.githubAccount });
    } catch (error) {
      return `docker: ${messageOf(error)}`;
    }
    try {
      await this.deps.ports.herdr.available();
    } catch (error) {
      return `herdr: ${messageOf(error)}`;
    }
    if (clone === undefined) {
      return "clone assistido: clone local do projeto não configurado (checkouts do local.json)";
    }
    if (!(await this.deps.areaFs.exists(clone))) {
      return `clone assistido: configurado em ${clone}, mas não existe no host`;
    }
    if (typeof model !== "string" || model.trim() === "") {
      return "modelo de assistência: assistModel ausente no config (não herda o modelo de implementação)";
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      return "capacidade de sessões assistidas: maxAssisted ausente ou inválido no config; sem limite, nenhuma sessão é aberta";
    }
    const loaded = await this.deps.sessions.load();
    if (openCount(loaded) >= limit) {
      return `capacidade de sessões assistidas: N=${limit} já com ${openCount(loaded)} abertas` +
        " (sessão aguardando o humano continua contando)";
    }
    try {
      const profileDir = resolveRuntimeProfile(
        project, this.deps.local.profiles,
        resolveModelAuth(this.deps.instance, this.deps.config.credentials, this.deps.local.profiles).agentDir,
      );
      const profile = resolveRuntimeProfileDeclaration(project, profileDir, {
        runtimeProfiles: this.deps.config.runtimeProfiles,
        allowedRoots: this.deps.local.allowedRoots,
      });
      const blockers = await checkRequired(profile.source, profile.declaration);
      if (blockers.length > 0) return `perfil de runtime: ${blockers.join("; ")}`;
      const plan = await planSnapshot(profile.source, profile.declaration);
      if (plan.blockers.length > 0) return `perfil de runtime: ${plan.blockers.join("; ")}`;
      return {
        plan,
        agentUidGid: agentIdentities(),
        toolchain: profileToolchain(this.deps.toolchainsDir, project.runtimeProfile),
        requiredPackages: profile.declaration.required.packages,
        requiredTools: profile.declaration.required.tools,
      };
    } catch (error) {
      return `perfil de runtime: ${messageOf(error)}`;
    }
  }

  // Claim, persisted work, and only then the opening. Every failure after the claim lands in
  // pending: work preserved for intervention, no attendance is concluded, no issue is closed,
  // and nothing is replayed silently (the operator decides; the resume and release actions are
  // delivered by #56).
  private async openAttendance(
    ref: IssueRef, snapshot: IssueSnapshot, project: ProjectConfig, prepared: PreparedOpening, report: AssistPollReport,
  ): Promise<void> {
    const key = refKey(ref);
    const now = this.deps.now ?? (() => new Date());
    const states = humanStatesIn(snapshot.labels.known ? snapshot.labels.value : []);
    if (states.length !== 1) {
      report.skipped.push({ key, reason: `estado humano não único: ${states.join(", ")}` });
      return;
    }
    const area = assistAreaDir(this.deps.stateDir, key);
    const sessionsDir = `${area}/sessions`;
    const execStateDir = `${area}/state`;
    const profileDir = `${area}/profile`;
    const cloneDir = this.deps.local.checkouts[project.repository]!;
    const containerName = assistContainerName(key, now().toISOString());
    let session: AssistSession = {
      key,
      ref,
      repository: project.repository,
      state: "opening",
      promptKind: states[0]!,
      model: this.deps.instance.assistModel!,
      image: this.deps.local.image,
      cloneDir,
      containerName,
      sessionsDir,
      execStateDir,
      profileDir,
      startedAt: now().toISOString(),
      log: [`reserva: área ${area}; exec ${containerName}`],
    };
    // The work is persisted before the claim: a crash is a visible opening record, not a silent one.
    await this.deps.sessions.save(session);
    const context: IssueWritesContext = { job: key, reason: "admissão assistida" };
    const decision = await this.writes.start(ref, context);
    if (decision.status === "refused") {
      await this.deps.sessions.remove(key);
      report.skipped.push({ key, reason: `claim recusado pelo tracker: ${decision.reason}` });
      return;
    }
    if (decision.status === "retry") {
      // Nothing was written: the record is forgotten and the next poll tries again.
      await this.deps.sessions.remove(key);
      report.errors.push({ key, message: decision.reason });
      return;
    }
    if (decision.status === "intervention") {
      // The issue may hold a claim the factory did not prove it made: an operator decides. The
      // capacity is released (nothing was opened) but the record stays, visible, as pending.
      const kept = toPending(appendSessionLog(session, `início não confirmado: ${decision.reason}`), decision.reason);
      await this.deps.sessions.save(kept);
      report.pending.push({ key, reason: decision.reason });
      this.emit(key, "atendimento-intervenção", "admissão assistida pede intervenção", {
        motivo: decision.reason, "claim comprovado": "não", "issue fechada": "não",
      }, "atenção");
      return;
    }
    session = { ...session, claimedAt: now().toISOString() };
    session = appendSessionLog(session, "claim confirmado por releitura (mecanismo único do núcleo)");
    await this.deps.sessions.save(session);
    await this.deps.areaFs.ensureDirs([sessionsDir, execStateDir, prepared.toolchain.npm, prepared.toolchain.mise]);
    try {
      // The snapshot holds the operator's credentials (auth.json); it is written only after the
      // confirmed claim, with real files only (ADR 0002), and mounted read-only in the container.
      await this.deps.areaFs.ensureDirs([profileDir]);
      await writeSnapshot(prepared.plan, profileDir);
      session = appendSessionLog(session, `retrato do perfil escrito em ${profileDir}`);
      await this.deps.sessions.save(session);

      const herdr = this.deps.ports.herdr;
      const workspace = await herdr.currentWorkspace();
      const label = `msf-assist-${encodeRefPart(key).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 64);
      const opening = await herdr.createTab({ workspace, cwd: cloneDir, label });
      // The tab/pane identity is persisted before anything else changes: an opening is visible
      // even when the exec launch itself fails (never a claim without a visible record).
      session = { ...session, label, tabId: opening.tab.tabId, paneId: opening.tab.paneId };
      await this.deps.sessions.save(session);
      this.emit(key, "atendimento-admitido", "sessão assistida abrindo (aba própria, sem roubar foco)", {
        ab: label, aba: opening.tab.tabId, pane: opening.tab.paneId, clone: cloneDir, container: containerName,
      }, "atenção", { highlight: true });

      const command = assistExecCommand({
        name: containerName, image: this.deps.local.image, model: session.model,
        agentUidGid: prepared.agentUidGid, startedAt: session.startedAt,
        cloneHostDir: cloneDir, sessionsHostDir: sessionsDir, stateHostDir: execStateDir,
        snapshotHostDir: profileDir, runtimeHostDir: this.deps.runtimeImageDir,
        npmHostDir: prepared.toolchain.npm, miseHostDir: prepared.toolchain.mise,
        requiredPackages: prepared.requiredPackages, requiredTools: prepared.requiredTools,
        prompt: assistPrompt({ kind: session.promptKind, ref, title: snapshot.title }),
      });
      await herdr.paneRun(opening.tab.paneId, command);
      const opened = toOpen(appendSessionLog(session, `exec lançado na pane ${opening.tab.paneId} (container ${containerName})`));
      await this.deps.sessions.save(opened);
      report.opened.push(key);
      this.emit(key, "atendimento-aberto", "sessão assistida aberta (pi interativo no container, sem roubar foco)", {
        modelo: opened.model, container: opened.containerName ?? containerName, aba: opened.tabId ?? opening.tab.tabId,
        sessão: sessionsDir, espera: "aguardando o operador",
      }, "atenção");
      // The open session calls the operator's attention (ticket #59): a persisted pending with
      // the locating references, notified without stealing focus (best-effort channel).
      await this.announceAttention(opened.key, sessionOpenPending({
        key: opened.key, ref: opened.ref, repository: opened.repository,
        model: opened.model, cloneDir: opened.cloneDir,
        tabId: opened.tabId, paneId: opened.paneId, containerName: opened.containerName,
        label: opened.label, resumes: opened.resumes,
      }, this.hour()));
    } catch (error) {
      const reason = `falha na abertura assistida: ${messageOf(error)}`;
      const kept = toPending(appendSessionLog(session, reason), reason);
      await this.deps.sessions.save(kept);
      report.pending.push({ key, reason });
      this.emit(key, "atendimento-falha", "falha na abertura assistida; nada concluído, preservado para intervenção", {
        motivo: reason, "claim preservado": "sim", "issue fechada": "não",
      }, "erro", { highlight: true });
    }
  }

  // ── Operator attention (ticket #59): the state changes of the flow raise persistent
  // pendings with a best-effort desktop notification. The pendings live in the attention
  // store (state, not memory), and raising never touches the session record: a failing
  // attention cannot unset what the flow decided (ADR 0001 applies to it too).

  // The wall clock the flow's own timestamps use.
  private hour(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  // A state change takes over the open session's pending (the open announcement is about the
  // session waiting; the decision/intervention is what the operator must do now).
  private async announceAttention(key: string, pending: AttentionPending | "none"): Promise<void> {
    const attention = this.deps.attention;
    if (attention === undefined) return;
    try {
      await attention.resolve(key, ["abertura"]);
    } catch {
      // resolve never throws; keeping the branch honest is cheap.
    }
    if (pending !== "none") await attention.raise(pending);
  }

  // The session's pendings of a taken-up work end here: the resume is the state change that
  // makes the old decision/intervention stale, and the reopened session raises its own.
  private async resolveAttention(key: string, kinds: readonly PendingKind[]): Promise<void> {
    await this.deps.attention?.resolve(key, kinds);
  }

  private announceOnce(key: string, signature: string, action: () => void): void {
    const full = `${key}|${signature}`;
    if (this.announced.has(full)) return;
    this.announced.add(full);
    action();
  }

  // One operational event of one assisted attendance. Never throws: the observer is the only one
  // writing here, and observing never changes what the flow does.
  private emit(
    key: string, kind: string, text: string, fields: Record<string, FieldValue>, level: Level, extra: { highlight?: boolean } = {},
  ): void {
    this.obs.emit({
      kind, text, job: key, fields, ...(level === "info" ? {} : { level }), ...extra,
    });
  }

  private async guard(
    key: string, report: { errors: AssistError[] }, action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      report.errors.push({ key, message: messageOf(error) });
    }
  }
}

const toOpen = (session: AssistSession): AssistSession => ({ ...session, state: "open" });

const toProposed = (session: AssistSession): AssistSession =>
  ({ ...session, state: "proposed" satisfies AssistSessionState, reason: undefined });

const toPending = (session: AssistSession, reason: string): AssistSession =>
  ({ ...session, state: "pending", reason, endedAt: new Date().toISOString() });

// The result's status as the operator reads it, in the flow's own language.
const statusName = (status: AssistResult["status"]): string =>
  status === "concluded" ? "concluído" : status === "external_wait" ? "espera externa" : "interrompido";

const unreadableKeysOf = (names: readonly string[]): readonly string[] =>
  names.flatMap((name) => {
    try {
      return [decodeURIComponent(name.replace(/\.json$/, ""))];
    } catch {
      return [];
    }
  });
