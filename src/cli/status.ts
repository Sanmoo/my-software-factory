import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import { evaluateEligibility } from "../core/eligibility.js";
import type { Job } from "../core/job.js";
import { projectEligibility } from "../core/project-eligibility.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../tracker/memory.js";
import type { IssueRef } from "../tracker/port.js";
import { loadInstance, type CliRun } from "./instance.js";
import { stateLabel, summaryOf } from "./jobs-view.js";

// `status` for one instance: lists the eligible issues and every rejection with its
// reasons. Only the memory adapter exists until the GitHub and Jira adapters land,
// so the tracker data comes from a fixture file. With --state-dir it also lists the
// jobs of the instance and treats their issues as already tracked.

export type StatusRun = CliRun;

interface Options {
  configPath: string;
  instanceName: string;
  fixturePath: string;
  stateDir?: string;
}

interface Row {
  ref: IssueRef;
  title: string;
  reasons: string[];
}

interface ProjectReport {
  project: ProjectConfig;
  scope: string;
  candidates: Row[];
  rejected: Row[];
}

interface JobsReport {
  jobs: Job[];
  unreadable: string[];
  // Admission state as the instance will have it after its queued commands (R09).
  paused: boolean;
  pausePending: boolean;
  pendingCommands: number;
}

const USAGE = "uso: npm run status -- --config FILE --instance NAME --fixture FILE [--state-dir DIR]";
const FLAGS = ["--config", "--instance", "--fixture", "--state-dir"];

function parseArgs(argv: readonly string[]): Options | string {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag)) return `argumento desconhecido: ${flag}\n${USAGE}`;
    if (value === undefined || value.startsWith("--")) return `${flag} exige um valor\n${USAGE}`;
    values.set(flag, value);
  }
  const configPath = values.get("--config");
  const instanceName = values.get("--instance");
  const fixturePath = values.get("--fixture");
  if (configPath === undefined || instanceName === undefined) return USAGE;
  if (fixturePath === undefined) {
    return `--fixture é obrigatório: sem adapter real de tracker, o status lê um fixture em memória\n${USAGE}`;
  }
  return { configPath, instanceName, fixturePath, stateDir: values.get("--state-dir") };
}

async function reportProject(
  tracker: MemoryTracker,
  instance: InstanceConfig,
  project: ProjectConfig,
  tracked: ReadonlySet<string>,
): Promise<ProjectReport> {
  const setup = projectEligibility(instance, project);
  const report: ProjectReport = { project, scope: setup.scope.project, candidates: [], rejected: [] };
  if (!project.enabled) return report;
  const refs = await tracker.discoverCandidates(setup.scope);
  for (const ref of refs) {
    const issue = await tracker.readIssue(ref);
    const verdict = evaluateEligibility({ project: setup.project, issue, tracked }, setup.rules);
    if (verdict.eligible) {
      report.candidates.push({ ref, title: issue.title, reasons: [] });
    } else {
      report.rejected.push({ ref, title: issue.title, reasons: verdict.rejections.map((r) => r.reason) });
    }
  }
  return report;
}

// GitHub references are repository-qualified; Jira issue ids already carry their key.
function displayRef(ref: IssueRef, project: ProjectConfig): string {
  return project.adapter === "github" ? `${ref.project}#${ref.id}` : ref.id;
}

function renderJobs(jobs: JobsReport): string[] {
  const lines = [
    "",
    `Admissões: ${jobs.paused ? "pausadas" : "ativas"}${jobs.pausePending ? " (comando aguarda o próximo ciclo)" : ""}`,
    `Comandos pendentes: ${jobs.pendingCommands}`,
    `Trabalhos (${jobs.jobs.length}):`,
  ];
  for (const job of jobs.jobs) {
    const summary = summaryOf(job);
    lines.push(`  ${job.key} ${stateLabel(job.state)}${summary ? ` — ${summary}` : ""}`);
  }
  if (jobs.unreadable.length > 0) lines.push(`Arquivos ilegíveis (${jobs.unreadable.length}): ${jobs.unreadable.join(", ")}`);
  return lines;
}

function render(instance: InstanceConfig, fixturePath: string, reports: ProjectReport[], jobs?: JobsReport): string {
  const lines = [
    `Instância ${instance.name} (N=${instance.maxConcurrent}, polling ${instance.pollIntervalSeconds}s, máx. iterações ${instance.maxIterations})`,
    `Tracker: memória (fixture ${fixturePath})`,
  ];
  for (const { project, scope, candidates, rejected } of reports) {
    const target = project.adapter === "jira" ? `${scope} / ${project.jira.routingLabel}` : scope;
    lines.push("", `[${project.name}] ${project.adapter} ${target}`);
    if (!project.enabled) {
      lines.push("  projeto desabilitado: não consultado");
      continue;
    }
    lines.push(`  candidatas (${candidates.length}):`);
    for (const row of candidates) lines.push(`    ${displayRef(row.ref, project)} ${row.title}`);
    lines.push(`  rejeitadas (${rejected.length}):`);
    for (const row of rejected) {
      lines.push(`    ${displayRef(row.ref, project)} ${row.title} — ${row.reasons.join("; ")}`);
    }
  }
  if (jobs) lines.push(...renderJobs(jobs));
  return lines.join("\n") + "\n";
}

export async function runStatus(argv: readonly string[]): Promise<StatusRun> {
  const options = parseArgs(argv);
  if (typeof options === "string") return { exitCode: 2, stdout: "", stderr: `${options}\n` };

  const loaded = await loadInstance(options.configPath, options.instanceName);
  if (!loaded.ok) return loaded.run;
  const { instance } = loaded;

  let tracker: MemoryTracker;
  try {
    tracker = loadMemoryTracker(JSON.parse(await readFile(options.fixturePath, "utf8")));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "fixture inválido: JSON" : (error as Error).message;
    return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
  }

  let jobs: JobsReport | undefined;
  if (options.stateDir !== undefined) {
    const loadedJobs = await createFileJobStore(options.stateDir).load();
    const queued = await createFileCommandQueue(options.stateDir).pending();
    const applied = await createFileInstanceControl(options.stateDir).isPaused();
    // The last queued pause or unpause decides the state once the queue is applied.
    const switches = queued.commands.filter((command) => command.type === "pause" || command.type === "unpause");
    const last = switches.at(-1);
    jobs = {
      jobs: loadedJobs.jobs,
      unreadable: loadedJobs.unreadable,
      paused: last ? last.type === "pause" : applied,
      pausePending: last !== undefined && (last.type === "pause") !== applied,
      pendingCommands: queued.commands.length + queued.unreadable.length,
    };
  }
  const tracked = new Set((jobs?.jobs ?? []).map((job) => job.key));

  const reports: ProjectReport[] = [];
  for (const project of instance.projects) reports.push(await reportProject(tracker, instance, project, tracked));
  return { exitCode: 0, stdout: render(instance, options.fixturePath, reports, jobs), stderr: "" };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runStatus(process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}

