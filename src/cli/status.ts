import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfigFile } from "../config/load.js";
import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import { coreRules, evaluateEligibility, type EligibilityRule, type Routing } from "../core/eligibility.js";
import { jiraEligibilityRules } from "../tracker/jira-rules.js";
import { loadMemoryTracker, type MemoryTracker } from "../tracker/memory.js";
import type { IssueRef } from "../tracker/port.js";

// `status` for one instance: lists the eligible issues and every rejection with its
// reasons. Only the memory adapter exists until the GitHub and Jira adapters land,
// so the tracker data comes from a fixture file.

export interface StatusRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Options {
  configPath: string;
  instanceName: string;
  fixturePath: string;
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

const USAGE = "uso: npm run status -- --config FILE --instance NAME --fixture FILE";
const FLAGS = ["--config", "--instance", "--fixture"];

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
  return { configPath, instanceName, fixturePath };
}

// Routing labels are the ones configured for the same Jira project key in this instance.
function routingFor(instance: InstanceConfig, project: ProjectConfig): Routing {
  if (project.adapter === "github") return { kind: "repository" };
  const knownLabels = instance.projects.flatMap((other) =>
    other.adapter === "jira" && other.jira.projectKey === project.jira.projectKey ? [other.jira.routingLabel] : []);
  return { kind: "label", routingLabel: project.jira.routingLabel, knownLabels };
}

function rulesFor(project: ProjectConfig): readonly EligibilityRule[] {
  return project.adapter === "jira" ? [...coreRules, ...jiraEligibilityRules(project.jira.operator)] : coreRules;
}

async function reportProject(
  tracker: MemoryTracker,
  instance: InstanceConfig,
  project: ProjectConfig,
): Promise<ProjectReport> {
  const scope = project.adapter === "github" ? project.repository : project.jira.projectKey;
  const report: ProjectReport = { project, scope, candidates: [], rejected: [] };
  if (!project.enabled) return report;
  const refs = await tracker.discoverCandidates({ project: scope, readyLabel: project.labels.ready });
  for (const ref of refs) {
    const issue = await tracker.readIssue(ref);
    const verdict = evaluateEligibility({
      project: { enabled: project.enabled, readyLabel: project.labels.ready, routing: routingFor(instance, project) },
      issue,
      // Nothing is tracked yet: no admission exists in this slice.
      tracked: new Set<string>(),
    }, rulesFor(project));
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

function render(instance: InstanceConfig, fixturePath: string, reports: ProjectReport[]): string {
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
  return lines.join("\n") + "\n";
}

export async function runStatus(argv: readonly string[]): Promise<StatusRun> {
  const options = parseArgs(argv);
  if (typeof options === "string") return { exitCode: 2, stdout: "", stderr: `${options}\n` };

  const loaded = await loadConfigFile(options.configPath);
  if (!loaded.ok) {
    const details = loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    return { exitCode: 1, stdout: "", stderr: `configuração inválida:\n${details}\n` };
  }

  const instance = loaded.config.instances.find((candidate) => candidate.name === options.instanceName);
  if (!instance) {
    const available = loaded.config.instances.map((candidate) => candidate.name).join(", ");
    return {
      exitCode: 2,
      stdout: "",
      stderr: `instância '${options.instanceName}' não encontrada; disponíveis: ${available}\n`,
    };
  }

  let tracker: MemoryTracker;
  try {
    tracker = loadMemoryTracker(JSON.parse(await readFile(options.fixturePath, "utf8")));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "fixture inválido: JSON" : (error as Error).message;
    return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
  }

  const reports: ProjectReport[] = [];
  for (const project of instance.projects) reports.push(await reportProject(tracker, instance, project));
  return { exitCode: 0, stdout: render(instance, options.fixturePath, reports), stderr: "" };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runStatus(process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}
