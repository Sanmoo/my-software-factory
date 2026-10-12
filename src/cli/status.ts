import { projectEligibility } from "../config/project-eligibility.js";
import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import { evaluateEligibility } from "../core/eligibility.js";
import type { Job } from "../core/job.js";
import { refForCommand } from "../core/job-ref.js";
import { trackedKeys } from "../core/job-store.js";
import { jobCommands, type CliHints } from "../core/observability.js";
import { createRedactor } from "../core/redaction.js";
import { messageOf } from "../core/values.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { readFailures, type RecordedFailure } from "../state/history.js";
import type { GitHubBoundary } from "../tracker/github.js";
import { refKey, type IssueRef, type TrackerPort } from "../tracker/port.js";
import { composeTrackers, registerSecrets } from "./compose.js";
import type { CliRun } from "./instance.js";
import { stateLabel, summaryOf } from "./jobs-view.js";

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

// GitHub references are repository-qualified; Jira issue ids already carry their key.
function displayRef(ref: IssueRef, project: ProjectConfig): string {
  return project.adapter === "github" ? `${ref.project}#${ref.id}` : ref.id;
}

interface LocalState {
  jobs: Job[];
  unreadable: string[];
  // Admission state as the instance will have it after its queued commands (R09).
  paused: boolean;
  pausePending: boolean;
  pendingCommands: number;
  // Observability that is failing right now: the operator lost some visibility, not the agent.
  observability: RecordedFailure[];
  observabilityUnreadable?: string;
}

async function readLocalState(stateDir: string): Promise<LocalState & { tracked: ReadonlySet<string> }> {
  const loaded = await createFileJobStore(stateDir).load();
  const queued = await createFileCommandQueue(stateDir).pending();
  const applied = await createFileInstanceControl(stateDir).isPaused();
  // The last queued pause or unpause decides the state once the queue is applied.
  const last = queued.commands.filter((command) => command.type === "pause" || command.type === "unpause").at(-1);
  const state: LocalState = {
    jobs: loaded.jobs,
    unreadable: loaded.unreadable,
    paused: last ? last.type === "pause" : applied,
    pausePending: last !== undefined && (last.type === "pause") !== applied,
    pendingCommands: queued.commands.length + queued.unreadable.length,
    observability: [],
  };
  try {
    state.observability = await readFailures(stateDir);
  } catch (error) {
    state.observabilityUnreadable = messageOf(error);
  }
  return { ...state, tracked: trackedKeys(loaded) };
}

const TRACKED_STATES: ReadonlySet<Job["state"]> = new Set(["running", "waiting-for-pr", "interrupted", "intervention-required"]);
// Only these can be taken up again by the operator with a command that is safe to paste.
const RESUMABLE: ReadonlySet<Job["state"]> = new Set(["interrupted", "intervention-required"]);

function renderJobs(state: LocalState, instance: InstanceConfig, cli: CliHints): string[] {
  const keys = state.jobs.map((job) => job.key);
  const nameOf = (job: Job): string => refForCommand(job.key, keys);
  const lines: string[] = [`Vagas: ${state.jobs.filter((job) => job.state === "running").length}/${instance.maxConcurrent}`];

  const helps = state.jobs.filter((job) => job.state === "waiting-for-help");
  lines.push("", `Pedidos de ajuda (${helps.length}):`);
  for (const job of helps) {
    const commands = jobCommands(cli, job.key, keys);
    lines.push(`  ${nameOf(job)} — ${job.question ?? ""}`, `    ${commands.reply}`, `    ${commands.logs}`);
  }

  const followed = state.jobs.filter((job) => TRACKED_STATES.has(job.state));
  lines.push("", `Trabalhos acompanhados (${followed.length}):`);
  for (const job of followed) {
    const summary = summaryOf(job);
    lines.push(`  ${nameOf(job)} ${stateLabel(job.state)}${summary ? ` — ${summary}` : ""}`);
    if (!RESUMABLE.has(job.state)) continue;
    const commands = jobCommands(cli, job.key, keys);
    lines.push(`    ${commands.resume}`, `    ${commands.logs}`);
  }

  const count = (state_: Job["state"]): number => state.jobs.filter((job) => job.state === state_).length;
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
    local = await readLocalState(options.stateDir);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `estado da instância ilegível: ${redactor.apply(messageOf(error))}\n` };
  }

  // Only the trackers are built: the status needs no checkout and no sandbox.
  const composed = options.tracker === undefined
    ? composeTrackers({ instance, env: options.env, ...(options.github === undefined ? {} : { github: options.github }) })
    : { tracker: options.tracker, unavailable: () => undefined };

  let failed = false;
  const reports: ProjectReport[] = [];
  for (const project of instance.projects) {
    const scope = projectEligibility(instance, project).scope.project;
    const reason = project.enabled ? composed.unavailable(project) : undefined;
    if (reason !== undefined) {
      failed = true;
      reports.push({ project, scope, unavailable: redactor.apply(reason) });
      continue;
    }
    try {
      reports.push(await reportProject(composed.tracker, instance, project, local.tracked));
    } catch (error) {
      failed = true;
      reports.push({ project, scope, unavailable: redactor.apply(messageOf(error)) });
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
