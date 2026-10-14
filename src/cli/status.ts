import { projectEligibility } from "../config/project-eligibility.js";
import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { ContinuityDecision, ScheduledResume } from "../core/assist-session.js";
import { evaluateEligibility } from "../core/eligibility.js";
import { holdsSlot, type Job } from "../core/job.js";
import { refForCommand } from "../core/job-ref.js";
import { unreadableKeys } from "../core/job-store.js";
import { jobCommands, type CliHints } from "../core/observability.js";
import { createRedactor } from "../core/redaction.js";
import { messageOf } from "../core/values.js";
import { buildOperatorView } from "../core/operator-view.js";
import { renderPendingNotification, type AttentionPending } from "../core/attention.js";
import type { RecordedFailure } from "../state/history.js";
import type { GitHubBoundary } from "../tracker/github.js";
import { refKey, type IssueRef, type TrackerPort } from "../tracker/port.js";
import { composeTrackers, registerSecrets } from "./compose.js";
import type { CliRun } from "./instance.js";
import { displayRef, stateLabel, summaryOf } from "./jobs-view.js";

// `./msf [--home DIR] <instância> status`: what the instance has recorded and what its trackers show
// now. It reads the real trackers of every enabled project, evaluates eligibility with the rules and
// the tracked issues the admission uses, and writes nothing. It describes the recorded state; it does
// not claim that the orchestrator is running.

export interface StatusOptions {
  instance: InstanceConfig;
  stateDir: string;
  // Absolute base directory, only when it is not the default: it is what the printed commands carry.
  home?: string;
  env: NodeJS.ProcessEnv;
  // Boundaries are injectable for tests; the defaults are the real ones.
  github?: GitHubBoundary;
  // Replaces the trackers of every project (tests inject one). Default: the instance's real trackers.
  tracker?: TrackerPort;
}

interface Row {
  ref: IssueRef;
  title: string;
  reasons: string[];
}

type ProjectReport =
  | { project: ProjectConfig; scope: string; disabled: true }
  | { project: ProjectConfig; scope: string; unavailable: string }
  | { project: ProjectConfig; scope: string; eligible: Row[]; rejected: Row[] };

async function reportProject(
  tracker: TrackerPort,
  instance: InstanceConfig,
  project: ProjectConfig,
  tracked: ReadonlySet<string>,
): Promise<ProjectReport> {
  const setup = projectEligibility(instance, project);
  const scope = setup.scope.project;
  if (!project.enabled) return { project, scope, disabled: true };
  const eligible: Row[] = [];
  const rejected: Row[] = [];
  for (const ref of await tracker.discoverCandidates(setup.scope)) {
    // An issue the instance already has a job for is not a candidate, in any state.
    if (tracked.has(refKey(ref))) continue;
    const issue = await tracker.readIssue(ref);
    const verdict = evaluateEligibility({ project: setup.project, issue, tracked }, setup.rules);
    if (verdict.eligible) eligible.push({ ref, title: issue.title, reasons: [] });
    else rejected.push({ ref, title: issue.title, reasons: verdict.rejections.map((r) => r.reason) });
  }
  return { project, scope, eligible, rejected };
}

interface LocalState {
  jobs: Job[];
  unreadable: string[];
  // Admission state as the instance will have it after its queued commands.
  paused: boolean;
  pausePending: boolean;
  pendingCommands: number;
  // Observability that is failing right now: the operator lost some visibility, not the agent.
  observability: RecordedFailure[];
  observabilityUnreadable?: string;
  // The assisted sessions' registry, the local mirror of the interruptions (ticket #56). A
  // session is never a job; it is shown countable here and listed with its awaited decision.
  assisted: AssistedRow[];
  assistedUnreadable?: string;
  // The persisted operator pendings (ticket #59): what still needs a human, with the provenance
  // of its desktop-notification attempt. This is the consultation that does not depend on the log.
  pendings: AttentionPending[];
  pendingsUnreadable?: string;
}

interface AssistedRow {
  key: string;
  state: string;
  reason?: string;
  continuity?: ContinuityDecision;
  scheduledResume?: ScheduledResume;
}

// One reading of the recorded state, through the operator's reading model (issue #65): the CLIs
// stopped composing their own view out of raw stores. `readLocalState` keeps its shape (the
// presentation stays here) but every local value — raw jobs in every state, assisted registry,
// pendings, queue, pause, unreadable lists — now comes from ONE buildOperatorView call. The
// trackers are composed separately in runStatus: they are not part of the local reading.
async function readLocalState(stateDir: string, instance: InstanceConfig): Promise<LocalState & { tracked: ReadonlySet<string> }> {
  const view = await buildOperatorView({ stateDir, instance });
  const assistedUnreadable = view.storeReads.sessions.degraded
    ?? (view.storeReads.sessions.unreadable.length > 0 ? view.storeReads.sessions.unreadable.join(", ") : undefined);
  const pendingsUnreadable = view.storeReads.attention.degraded
    ?? (view.storeReads.attention.unreadable.length > 0 ? view.storeReads.attention.unreadable.join(", ") : undefined);
  const state: LocalState = {
    jobs: view.jobs,
    unreadable: view.storeReads.jobs.unreadable,
    paused: view.footer.pause.paused,
    pausePending: view.footer.pause.pending,
    pendingCommands: view.footer.pendingCommands,
    observability: view.observability.failures,
    ...(view.observability.failuresUnreadable === undefined ? {} : { observabilityUnreadable: view.observability.failuresUnreadable }),
    assisted: view.sessions.map((session) => ({
      key: session.key, state: session.state, reason: session.reason, continuity: session.continuity,
      scheduledResume: session.scheduledResume,
    })),
    ...(assistedUnreadable === undefined ? {} : { assistedUnreadable }),
    pendings: view.pendings,
    ...(pendingsUnreadable === undefined ? {} : { pendingsUnreadable }),
  };
  // The same tracked set eligibility has always judged against: readable job keys plus the
  // keys decodable from the unreadable file names (an unreadable file still names its issue).
  return { ...state, tracked: new Set([...view.jobs.map((job) => job.key), ...unreadableKeys(view.storeReads.jobs.unreadable)]) };
}

const TRACKED_STATES: ReadonlySet<Job["state"]> = new Set(["running", "waiting-for-pr", "interrupted", "intervention-required"]);
// Only these can be taken up again by the operator with a command that is safe to paste.
const RESUMABLE: ReadonlySet<Job["state"]> = new Set(["interrupted", "intervention-required"]);

// The persisted pendings (ticket #59), where they stay consultable whatever the notification
// channel did. Each pending names its subject (same key space the flows use), what and when,
// the provenance of the delivery attempt (never a presumed delivery) and the paste-ready local
// actions for its key.
function renderPendings(state: LocalState, cli: CliHints): string[] {
  const lines: string[] = [`Pendências (${state.pendings.length}):`];
  const keys = [
    ...state.jobs.map((job) => job.key),
    ...state.assisted.map((assisted) => assisted.key),
  ];
  for (const pending of state.pendings) {
    // The paste-ready actions come from the handover structure itself: nothing is re-parsed
    // out of the sentence strings the main log prints.
    const commands = jobCommands(cli, pending.key, keys);
    const [base, ref] = [commands.base, commands.ref];
    lines.push(
      `  ${pending.kind} ${pending.key} — ${pending.what}${pending.reason === undefined ? "" : `: ${pending.reason}`}`,
      ...(pending.question === undefined ? [] : [
        pending.answer !== undefined
          ? `    pergunta respondida: ${pending.question} → ${pending.answer}`
          : `    pergunta: ${pending.question}`,
      ]),
      ...(pending.work === undefined ? [] : [`    trabalho: ${pending.work.repository}#${pending.work.ref.id}`]),
      ...(pending.context === undefined ? [] : [`    ${Object.entries(pending.context).map(([name, value]) => `${name}=${value}`).join(", ")}`]),
      `    ${renderPendingNotification(pending)}`,
      ...pending.actions
        .filter((action) => action !== "logs" || commands.detail !== undefined)
        .map((action) => action === "reply" ? `    ${commands.reply}`
          : action === "resume" ? `    ${commands.resume}`
          : action === "logs" ? `    ${commands.logs}`
          : `    ${base} ${action} ${ref}`),
    );
  }
  if (state.pendingsUnreadable !== undefined) {
    lines.push(`  arquivos ilegíveis de pendências: ${state.pendingsUnreadable}`);
  }
  return lines;
}

function renderJobs(state: LocalState, instance: InstanceConfig, cli: CliHints): string[] {
  const keys = state.jobs.map((job) => job.key);
  const nameOf = (job: Job): string => refForCommand(job.key, keys);
  const lines: string[] = [`Vagas: ${state.jobs.filter((job) => holdsSlot(job.state)).length}/${instance.maxConcurrent}`];

  const helps = state.jobs.filter((job) => job.state === "waiting-for-help");
  lines.push("", `Pedidos de ajuda (${helps.length}):`);
  for (const job of helps) {
    const commands = jobCommands(cli, job.key, keys);
    lines.push(`  ${nameOf(job)} — ${job.question ?? ""}`, `    ${commands.reply}`, `    ${commands.logs}`);
  }

  // The persisted pendings (ticket #59), right after the help requests they generalize.
  lines.push("", ...renderPendings(state, cli));

  const followed = state.jobs.filter((job) => TRACKED_STATES.has(job.state));
  lines.push("", `Trabalhos acompanhados (${followed.length}):`);
  for (const job of followed) {
    const summary = summaryOf(job);
    lines.push(`  ${nameOf(job)} ${stateLabel(job.state)}${summary ? ` — ${summary}` : ""}`);
    if (!RESUMABLE.has(job.state)) continue;
    const commands = jobCommands(cli, job.key, keys);
    lines.push(`    ${commands.resume}`, `    ${commands.logs}`);
  }

  const pendings = state.assisted.filter((row) => row.state === "pending");
  lines.push("", `Atendimento assistido pendente (${pendings.length}):`);
  for (const row of pendings) {
    const commands = jobCommands(cli, row.key, [...keys, ...state.assisted.map((assisted) => assisted.key)]);
    const decision = row.continuity === undefined ? "intervenção pedida"
      : row.continuity.answeredAt === undefined ? row.continuity.question
      : `pergunta respondida (${row.continuity.answer ?? "sem texto"})`;
    // The single-use resume the answer may have scheduled (ticket #57): the operator sees its
    // demand and its consumption before any automatic opening happens.
    const scheduled = row.scheduledResume === undefined ? ""
      : row.scheduledResume.consumed === undefined
        ? " (retomada agendada: uso único)"
        : ` (retomada agendada consumida pela tentativa ${row.scheduledResume.consumed.attempt})`;
    lines.push(`  ${row.key} — ${decision}${scheduled}${row.reason === undefined ? "" : ` (${row.reason})`}`, `    ${commands.resume}`, `    ${commands.reply}`);
  }
  if (state.assistedUnreadable !== undefined) lines.push(`  arquivos ilegíveis de sessão assistida: ${state.assistedUnreadable}`);
  const opens = state.assisted.filter((row) => row.state === "opening" || row.state === "open").length;
  lines.push("", `Sessões assistidas: abertas agora: ${opens}, pendentes: ${pendings.length}`);

  const count = (wanted: Job["state"]): number => state.jobs.filter((job) => job.state === wanted).length;
  lines.push("", `Encerrados: concluídos: ${count("done")}, liberados: ${count("released")}`);
  lines.push(
    "",
    `Admissões: ${state.paused ? "pausadas" : "ativas"}${state.pausePending ? " (comando aguarda o próximo ciclo)" : ""}`,
    `Comandos pendentes: ${state.pendingCommands}`,
  );
  return lines;
}

function renderTail(state: LocalState): string[] {
  const lines: string[] = [];
  for (const failure of state.observability) {
    lines.push(`Observabilidade: falha em ${failure.sink} desde ${failure.at}: ${failure.message} (a execução dos trabalhos não depende disso)`);
  }
  if (state.observabilityUnreadable !== undefined) lines.push(`Observabilidade: estado das falhas ilegível (${state.observabilityUnreadable})`);
  if (state.unreadable.length > 0) lines.push(`Arquivos ilegíveis (${state.unreadable.length}): ${state.unreadable.join(", ")}`);
  return lines;
}

function renderProject(report: ProjectReport): string[] {
  const { project, scope } = report;
  const target = project.adapter === "jira" ? `${scope} / ${project.jira.routingLabel}` : scope;
  const lines = ["", `[${project.name}] ${project.adapter} ${target}`];
  if ("disabled" in report) return [...lines, "  projeto desabilitado: não consultado"];
  if ("unavailable" in report) return [...lines, `  tracker indisponível: ${report.unavailable}`];
  lines.push(`  elegíveis (${report.eligible.length}):`);
  for (const row of report.eligible) lines.push(`    ${displayRef(row.ref, project)} ${row.title}`);
  lines.push(`  rejeitadas (${report.rejected.length}):`);
  for (const row of report.rejected) lines.push(`    ${displayRef(row.ref, project)} ${row.title} — ${row.reasons.join("; ")}`);
  return lines;
}

export async function runStatus(options: StatusOptions): Promise<CliRun> {
  const { instance } = options;
  const redactor = createRedactor();
  registerSecrets((secret) => redactor.add(secret), options.env);

  let local: Awaited<ReturnType<typeof readLocalState>>;
  try {
    local = await readLocalState(options.stateDir, instance);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `estado da instância ilegível: ${redactor.apply(messageOf(error))}\n` };
  }

  // Only the trackers are built: the status needs no checkout and no sandbox.
  const composed = options.tracker === undefined
    ? composeTrackers({ instance, env: options.env, ...(options.github === undefined ? {} : { github: options.github }) })
    : { tracker: options.tracker, unavailable: () => undefined };

  let failed = false;
  const reports: ProjectReport[] = [];
  const unavailable = (project: ProjectConfig, reason: string): void => {
    failed = true;
    reports.push({ project, scope: projectEligibility(instance, project).scope.project, unavailable: redactor.apply(reason) });
  };
  for (const project of instance.projects) {
    const reason = project.enabled ? composed.unavailable(project) : undefined;
    if (reason !== undefined) {
      unavailable(project, reason);
      continue;
    }
    try {
      reports.push(await reportProject(composed.tracker, instance, project, local.tracked));
    } catch (error) {
      unavailable(project, messageOf(error));
    }
  }

  const cli: CliHints = { instance: instance.name, ...(options.home === undefined ? {} : { home: options.home }) };
  const lines = [
    `Instância ${instance.name} (N=${instance.maxConcurrent}, polling ${instance.pollIntervalSeconds}s, máx. iterações ${instance.maxIterations})`,
    ...renderJobs(local, instance, cli),
    ...reports.flatMap(renderProject),
    ...renderTail(local),
  ];
  return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
