import { access } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import { projectEligibility } from "../config/project-eligibility.js";
import { assistedRules, HUMAN_ASSISTED_LABEL, humanStatesIn } from "../core/assist-eligibility.js";
import { evaluateEligibility } from "../core/eligibility.js";
import { holdsSlot } from "../core/job.js";
import { trackedKeys } from "../core/job-store.js";
import { createRedactor } from "../core/redaction.js";
import { messageOf } from "../core/values.js";
import { resolveModelAuth, resolveRuntimeProfile, resolveRuntimeProfileDeclaration } from "../runtime/docker-config.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";
import { checkRequired } from "../runtime/profile-snapshot.js";
import type { ContinuityDecision, ScheduledResume } from "../core/assist-session.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileJobStore } from "../state/file-job-store.js";
import type { IssueRef, IssueSnapshot, TrackerPort } from "../tracker/port.js";
import { composeTrackers, registerSecrets } from "./compose.js";
import type { CliRun } from "./instance.js";
import type { LocalSettings } from "./local-settings.js";
import { displayRef } from "./jobs-view.js";

// `./msf <instância> assist`: local diagnostic of the human-assisted attendance (spec #48).
// It reads the enabled trackers, evaluates which issues would be eligible for assisted work
// and why the others are not, and presents the two independent capacity limits and the assist
// parameters. It is a diagnosis only: nothing is written to the tracker, no capacity is
// reserved, and no session, pane or container is opened. What the environment cannot prove
// without starting execution is reported as unknown, never as ok.

// A prerequisite the command can judge. `desconhecido` means it could not be proven:
// unknown is never absence of impediment (the same rule the eligibility rules follow).
export type AssistFinding =
  | { status: "ok"; detail: string }
  | { status: "impedimento"; reason: string }
  | { status: "desconhecido"; reason: string };

// Environment prerequisites, verified without starting anything. Tests inject both.
export interface AssistEnvironmentPort {
  // Docker reachable, image present, operator token available: what a session needs before it starts.
  docker(input: { image: string; account: string }): Promise<AssistFinding>;
  // Herdr available for tabs/panes; no tab is opened, it is only checked.
  herdr(): Promise<AssistFinding>;
}

export interface AssistOptions {
  config: MsfConfig;
  instance: InstanceConfig;
  local: LocalSettings;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  sandbox: SandboxBoundary;
  // Replaces the trackers of every project (tests inject one). Default: the instance's real trackers.
  tracker?: TrackerPort;
  // Replaces the Herdr check (tests inject one). Default: unknown; the integration is not implemented.
  herdr?: AssistEnvironmentPort["herdr"];
}

interface AssistRow {
  ref: IssueRef;
  title: string;
  // The human states the labels carry (empty when the labels are unknown: that is its own rejection).
  states: readonly string[];
  assignees: string | undefined;
  reasons: string[];
}

type AssistProjectBody = {
  eligible: AssistRow[];
  rejected: AssistRow[];
  clone: AssistFinding;
  profile: AssistFinding;
};

type AssistProjectReport =
  | { project: ProjectConfig; disabled: true }
  | { project: ProjectConfig; unavailable: string }
  | ({ project: ProjectConfig } & AssistProjectBody);

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// The opening and failures of the human-assisted attendance are visible in the local commands:
// this diagnosis shows the sessions already recorded (opened by the run loop of the same
// instance) with their state and identity, reading the same store the run loop keeps. A pending
// interruption also shows its persisted decision (ticket #56): the continuity question asked
// once and, when the operator already answered it, the verbatim answer.
interface SessionRow {
  key: string; state: string; model: string;
  containerName?: string; tabId?: string; reason?: string; decision?: string;
}

const decisionOf = (session: { continuity?: ContinuityDecision }): string | undefined =>
  session.continuity === undefined ? undefined
    : session.continuity.answeredAt !== undefined
      ? `respondida (${session.continuity.answer === undefined || session.continuity.answer === "" ? "sem texto" : session.continuity.answer})`
      : "pergunta de continuidade pendente";

// The single-use resume authorization (ticket #57) is part of the operator's decision: whether
// it awaits its one opening (its consumption will be shown by the attempt identity recorded).
const resumeOf = (resume: ScheduledResume | undefined): string | undefined =>
  resume === undefined ? undefined
    : resume.consumed === undefined
      ? "retomada agendada (uso único)"
      : `retomada agendada consumida pela tentativa ${resume.consumed.attempt} (em ${resume.consumed.at})`;

const withDecision = (session: { continuity?: ContinuityDecision; scheduledResume?: ScheduledResume }): Pick<SessionRow, "decision"> | {} => {
  const decision = decisionOf(session);
  const resume = resumeOf(session.scheduledResume);
  if (decision === undefined && resume === undefined) return {};
  return { decision: [decision, resume].filter(Boolean).join(", ") };
};

async function sessionRows(stateDir: string): Promise<{ rows: SessionRow[]; problems: string[] }> {
  const store = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  try {
    const loaded = await store.load();
    const rows: SessionRow[] = loaded.sessions
      .map((session) => ({
        key: session.key,
        state: session.state,
        model: session.model,
        ...(session.containerName === undefined ? {} : { containerName: session.containerName }),
        ...(session.tabId === undefined ? {} : { tabId: session.tabId }),
        ...(session.reason === undefined ? {} : { reason: session.reason }),
        ...withDecision(session),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { rows, problems: loaded.unreadable.map((name) => `arquivo de sessão assistida ilegível: ${name}`) };
  } catch (error) {
    return { rows: [], problems: [`histórico de sessões ilegível: ${messageOf(error)}`] };
  }
}

// Herdr cannot be proven from the host in this slice: the tab/pane integration is only proven by
// the technical validation (spec #48, issue #52). Unknown, never ok.
const herdrUnknown = (): Promise<AssistFinding> => Promise.resolve({
  status: "desconhecido",
  reason: "não verificável sem iniciar execução: a integração Herdr não está implementada nesta fatia (prova técnica na issue #52)",
});

const dockerCheck = (sandbox: SandboxBoundary): AssistEnvironmentPort["docker"] => async ({ image, account }) => {
  try {
    await sandbox.preflight({ image, account });
    return { status: "ok", detail: `docker alcançado; imagem ${image} e token da conta ${account}` };
  } catch (error) {
    return { status: "impedimento", reason: messageOf(error) };
  }
};

const describeFinding = (what: string, finding: AssistFinding): string =>
  finding.status === "ok" ? `${what}: ok — ${finding.detail}`
    : finding.status === "impedimento" ? `${what}: impedimento — ${finding.reason}`
    : `${what}: desconhecido — ${finding.reason}`;

// The operator's local clone the attendance runs in. It is operator-managed: the factory does not
// create a worktree for it and never imposes a hard write prohibition as eligibility condition
// (spec #48, approved direction for #53).
async function cloneFinding(local: LocalSettings, project: ProjectConfig): Promise<AssistFinding> {
  const clone = local.checkouts[project.repository];
  if (clone === undefined) {
    return { status: "impedimento", reason: `clone local de ${project.repository} não configurado (checkouts do local.yaml)` };
  }
  return (await exists(clone))
    ? { status: "ok", detail: `${clone} (gerenciado pelo operador; sem worktree da factory)` }
    : { status: "impedimento", reason: `clone local de ${project.repository} configurado em ${clone}, mas não existe no host` };
}

// ADR 0002: the profile resolves on the host before anything starts. A required item that does
// not resolve is a proven blocker; a configuration that cannot be read is a proven problem too.
async function profileFinding(config: MsfConfig, instance: InstanceConfig, local: LocalSettings, project: ProjectConfig): Promise<AssistFinding> {
  try {
    const dir = resolveRuntimeProfile(project, local.profiles, resolveModelAuth(instance, config.credentials, local.profiles).agentDir);
    const profile = resolveRuntimeProfileDeclaration(project, dir, { runtimeProfiles: config.runtimeProfiles, allowedRoots: local.allowedRoots });
    const blockers = await checkRequired(profile.source, profile.declaration);
    return blockers.length === 0
      ? { status: "ok", detail: "obrigatórios resolvem no host" }
      : { status: "impedimento", reason: blockers.join("; ") };
  } catch (error) {
    return { status: "impedimento", reason: messageOf(error) };
  }
}

function assigneesOf(issue: IssueSnapshot): string | undefined {
  if (!issue.assignees.known) return `desconhecido (${issue.assignees.reason})`;
  const assignees = issue.assignees.value;
  return assignees.length === 0 ? undefined : assignees.join(", ");
}

function rowOf(issue: IssueSnapshot, rejections: string[] = []): AssistRow {
  const states = issue.labels.known ? humanStatesIn(issue.labels.value) : [];
  return { ref: issue.ref, title: issue.title, states, assignees: assigneesOf(issue), reasons: rejections };
}

// The eligible line says the human state the issue is attended in and, when there is one, its
// human assignee — shown, never taken as the factory's claim. The rejected line says every
// reason the admission would refuse it.
const describeRow = (row: AssistRow, project: ProjectConfig): string => {
  const detail = row.reasons.length > 0
    ? row.reasons.join("; ")
    : [
      ...row.states,
      ...(row.assignees === undefined ? [] : [`assignees: ${row.assignees} (atribuição não é claim)`]),
    ].join("; ");
  return `${displayRef(row.ref, project)} ${row.title}${detail === "" ? "" : ` — ${detail}`}`;
};

async function projectReport(options: {
  tracker: TrackerPort;
  instance: InstanceConfig;
  config: MsfConfig;
  local: LocalSettings;
  project: ProjectConfig;
  tracked: ReadonlySet<string>;
}): Promise<AssistProjectBody> {
  const { project, tracker, instance, config, local, tracked } = options;
  const setup = projectEligibility(instance, project);
  // Assisted candidates are discovered by the authorization label, not by the autonomous ready
  // label: discovery is the tracker's filter; the rules below are the contract.
  const scope = { project: setup.scope.project, readyLabel: HUMAN_ASSISTED_LABEL };
  const eligible: AssistRow[] = [];
  const rejected: AssistRow[] = [];
  for (const ref of await tracker.discoverCandidates(scope)) {
    const issue = await tracker.readIssue(ref);
    // A tracked issue stays in the report: the concurrent tracking is its own rejection, visible.
    const verdict = evaluateEligibility({ project: setup.project, issue, tracked }, assistedRules);
    if (verdict.eligible) eligible.push(rowOf(issue));
    else rejected.push(rowOf(issue, verdict.rejections.map((rejection) => rejection.reason)));
  }
  return {
    eligible, rejected,
    clone: await cloneFinding(local, project),
    profile: await profileFinding(config, instance, local, project),
  };
}

interface InstanceState {
  tracked: ReadonlySet<string>;
  slots: number;
}

async function readInstanceState(stateDir: string): Promise<InstanceState> {
  const loaded = await createFileJobStore(stateDir).load();
  return { tracked: trackedKeys(loaded), slots: loaded.jobs.filter((job) => holdsSlot(job.state)).length };
}

const sessionLines = (rows: SessionRow[]): string[] => rows.length === 0
  ? ["  nenhuma sessão registrada neste estado da instância"]
  : rows.map((row) =>
    `  ${row.key} — ${row.state}, modelo ${row.model}`
    + (row.containerName === undefined ? "" : `, container ${row.containerName}`)
    + (row.tabId === undefined ? "" : `, aba ${row.tabId}`)
    + (row.reason === undefined ? "" : `, motivo: ${row.reason}`)
    + (row.decision === undefined ? "" : `, decisão: ${row.decision}`));

function describeCapacity(limit: number | undefined, what: string, detail: string, whyNotConfigured: string): string {
  return limit === undefined ? `${what}: não configurado (${whyNotConfigured})` : `${what}: N=${limit} (${detail})`;
}

export async function runAssist(options: AssistOptions): Promise<CliRun> {
  const { instance } = options;
  const redactor = createRedactor();
  registerSecrets((secret) => redactor.add(secret), options.env);

  let state: InstanceState;
  try {
    state = await readInstanceState(options.stateDir);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `estado da instância ilegível: ${redactor.apply(messageOf(error))}\n` };
  }
  const assistSessions = await sessionRows(options.stateDir);
  const assistOpened = assistSessions.rows.filter((row) => row.state === "opening" || row.state === "open").length;

  const composed = options.tracker === undefined
    ? composeTrackers({ instance, env: options.env })
    : { tracker: options.tracker, unavailable: () => undefined };
  const herdr = options.herdr ?? herdrUnknown;
  const docker = dockerCheck(options.sandbox);

  // The environment checks run for what the instance names, once each: no session or container
  // is started; only what a session would need is proven (or is reported unknown).
  const herdrFinding = await herdr();
  const accounts = new Set(instance.projects.filter((project) => project.enabled).map((project) => project.githubAccount));
  const dockerFindings = await Promise.all([...accounts].map(async (account) => ({ account, finding: await docker({ image: options.local.image, account }) })));
  const profileFindings = new Map<string, AssistFinding>();
  for (const name of new Set(instance.projects.filter((project) => project.enabled).map((project) => project.runtimeProfile))) {
    const project = instance.projects.find((candidate) => candidate.enabled && candidate.runtimeProfile === name)!;
    profileFindings.set(name, await profileFinding(options.config, instance, options.local, project));
  }

  let failed = false;
  const reports: AssistProjectReport[] = [];
  for (const project of instance.projects) {
    if (!project.enabled) {
      reports.push({ project, disabled: true });
      continue;
    }
    const reason = options.tracker === undefined ? composed.unavailable(project) : undefined;
    if (reason !== undefined) {
      failed = true;
      reports.push({ project, unavailable: redactor.apply(reason) });
      continue;
    }
    try {
      const report = await projectReport({ tracker: composed.tracker, instance, config: options.config, local: options.local, project, tracked: state.tracked });
      reports.push({ project, ...report, profile: profileFindings.get(project.runtimeProfile)! });
    } catch (error) {
      failed = true;
      reports.push({ project, unavailable: redactor.apply(messageOf(error)) });
    }
  }

  const lines = [
    `Atendimento assistido — instância ${instance.name}`,
    "Diagnóstico local: nenhuma escrita no tracker; nenhuma sessão, pane ou container é aberto.",
    "",
    "Capacidade (dois limites independentes):",
    `  ${describeCapacity(instance.maxConcurrent, "implementação autônoma", `vagas em uso agora: ${state.slots}`, "maxConcurrent ausente no config.yaml")}`,
    `  ${describeCapacity(instance.maxAssisted, "sessões assistidas", `abertas agora: ${assistOpened}${assistSessions.problems.length > 0 ? `; ${assistSessions.problems.join(", ")}` : ""}`, "maxAssisted ausente no config.yaml")}`,
    "",
    "Sessões assistidas registradas:",
    ...sessionLines(assistSessions.rows),
    "",
    "Parâmetros de assistência:",
    instance.assistModel === undefined
      ? "  modelo de assistência: não configurado (assistModel ausente no config.yaml; não herda o modelo de implementação)"
      : `  modelo de assistência: ${instance.assistModel}`,
    `  ${describeFinding("Herdr", herdrFinding)}`,
    ...dockerFindings.map(({ finding }) => `  ${describeFinding("Docker", finding)}`),
    "  o clone assistido é gerenciado pelo operador: a factory não cria worktree nem impõe proibição de escrita",
    "",
  ];
  for (const report of reports) {
    const { project } = report;
    const scope = project.adapter === "github" ? project.repository : project.jira.projectKey;
    lines.push(`[${project.name}] ${project.adapter} ${scope}`);
    if ("disabled" in report) lines.push("  projeto desabilitado: não consultado");
    else if ("unavailable" in report) lines.push(`  tracker indisponível: ${report.unavailable}`);
    else {
      lines.push(
        `  elegíveis para atendimento assistido (${report.eligible.length}):`,
        ...report.eligible.map((row) => `    ${describeRow(row, project)}`),
        `  impedidas (${report.rejected.length}):`,
        ...report.rejected.map((row) => `    ${describeRow(row, project)}`),
        `  ${describeFinding("clone assistido", report.clone)}`,
        `  ${describeFinding(`perfil de runtime ${project.runtimeProfile}`, report.profile)}`,
      );
    }
    lines.push("");
  }
  return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
