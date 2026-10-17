import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialRef, InstanceConfig, ProjectConfig, RuntimeProfileConfig } from "../config/types.js";
import {
  findProject,
  requireRunModels,
  resolveModelAuth,
  resolveRuntimeProfile,
  resolveRuntimeProfileDeclaration,
  skillPathOf,
  TRIAGE_SKILL,
  type RuntimeProfile,
} from "./docker-config.js";
import { checkRequired, describePlan, planSnapshot, resolves, writeSnapshot } from "./profile-snapshot.js";
import {
  createJobRepo,
  jobLayout,
  type JobLayout,
} from "./docker-area.js";
import { jobBranch } from "../core/job.js";
import { profileToolchain, sandcastleRequest, type SandcastleRequest } from "./docker-invocation.js";
import { interpretOutput } from "./docker-output.js";
import { continuationItems, continuationPrompt, implementPrompt } from "./docker-prompt.js";
import { planCommands, type ContinuationPlan } from "../core/feedback.js";
import type { PiEvent } from "./pi-events.js";
import type { Runner, RunnerContext, RunnerOutput } from "./runner.js";
import { messageOf } from "../core/values.js";
import { noopObserver, shellQuote, type Observer } from "../core/observability.js";
import type { IssueRef, TrackerPort } from "../tracker/port.js";
import { AgentActivity } from "./agent-activity.js";

// Docker runner. Each job gets its own git area and Pi
// session on the host; the agent runs only inside the sandbox boundary. Any failure before or
// during the run is an interruption with its reason. Nothing here runs on the host instead.

// The sandbox boundary: Docker and Sandcastle in production, a fake in tests.
// The silence the runtime tolerates before it gives up, and how often it warns meanwhile. The
// Sandcastle boundary applies both; the activity reports them as the effective values.
export const IDLE_TIMEOUT_SECONDS = 600;
export const IDLE_WARNING_SECONDS = 60;

export interface SandboxRun {
  image: string;
  cwd: string; // job repository, the bind-mounted work area
  sessionsDir: string; // host directory for the Pi session, outside the container
  // The runtime profile as real files, written by the runner for this invocation and mounted read-only. It
  // is all the container sees of the operator's profile: no profile directory, no link roots (ADR 0002).
  snapshotDir: string;
  // Packages and tools the container must find converged before the agent gets its prompt; otherwise it
  // stops with the reason (ADR 0004).
  requiredPackages: readonly string[];
  requiredTools: readonly string[];
  // The profile's persistent toolchain (ADR 0004), created here as the invoking user and bind-mounted by
  // the boundary: the Pi package tree converged from the operator's lock (per profile) and the mise data
  // directory (one for every profile of the `--home`).
  npmDir: string;
  miseDir: string;
  model: string; // implementer model: the main agent of the invocation
  token: string; // GitHub token for the container environment only
  request: SandcastleRequest;
  // Where the boundary sends what the agent prints, line by line, as it arrives. The runner turns it
  // into the detailed log and the operational events; the boundary only feeds it and drives its clock.
  activity: AgentActivity;
  // Seconds of silence after which the runtime stops the agent.
  idleTimeoutSeconds: number;
  idleWarningSeconds: number;
  // The dependency's own log (setup, warnings): written during the run, deleted after it. The detailed log is the activity's.
  runtimeLogPath: string;
  // Hides the known credentials of this run in any text the boundary writes itself.
  redact: (text: string) => string;
}

export interface SandboxOutcome {
  sessionId?: string;
  completed: boolean; // the completion signal was matched
  iterations: number; // Sandcastle iterations used; each one is a fresh Pi session
  events: PiEvent[];
}

export interface SandboxBoundary {
  // Docker reachable, image present, token available. Throws otherwise. The profile is the runner's business.
  preflight(input: { image: string; account: string }): Promise<{ token: string }>;
  // Whether the image has a command on its PATH (issue #21: the triage skill runs python3).
  imageHas(image: string, command: string): Promise<boolean>;
  run(input: SandboxRun): Promise<SandboxOutcome>;
}

export interface DockerRunnerOptions {
  instance: InstanceConfig;
  credentials: Readonly<Record<string, CredentialRef>>;
  profiles: Readonly<Record<string, string>>;
  // What each runtime profile must carry (config.yaml) and where its links may lead (local.yaml).
  runtimeProfiles: Readonly<Record<string, RuntimeProfileConfig>>;
  allowedRoots: Readonly<Record<string, readonly string[]>>;
  stateDir: string;
  // Root of the persistent toolchains (ADR 0004), under the factory `--home`: the per-profile Pi package
  // trees and the mise data dir shared by every profile. The runner creates them before the container
  // starts, so a bind never lands root-owned.
  toolchainsDir: string;
  image: string;
  // Local clone each project's job area is cloned from (the operator's checkout).
  repositorySource: (project: ProjectConfig) => string;
  // Remote the job area pushes to, when it differs from the checkout it was cloned from.
  remoteUrl?: (project: ProjectConfig) => string | undefined;
  boundary: SandboxBoundary;
  // Where operational events go. Absent: the run is not observed beyond its own logs.
  observer?: Observer;
  // The clock of the activity, injectable so silence can be controlled in tests.
  now?: () => number;
  // Reads the issue of a job in the tracker: the evidence by which a write the agent made on its
  // own issue can be confirmed. Absent: such writes are reported as not confirmable.
  tracker?: Pick<TrackerPort, "readIssue" | "readComments">;
}

// Configuration problems are visible when the runner is built, before any job starts.
export function createDockerRunner(options: DockerRunnerOptions): Runner {
  for (const project of options.instance.projects) {
    if (!project.enabled) continue;
    requireRunModels(project);
    const auth = resolveModelAuth(options.instance, options.credentials, options.profiles);
    resolveRuntimeProfileDeclaration(project, resolveRuntimeProfile(project, options.profiles, auth.agentDir), options);
  }
  return new DockerRunner(options);
}

interface JobRecord {
  jobId: string;
  targetBranch: string;
  branch: string;
  baseSha: string;
  sessionId?: string;
}

// Operator replies delivered with a continuation; the admission hands them over as the typed
// plan in `continuation`. A continuation with no plan is a plain resume with no items to deliver.
const continuationPlan = (context: RunnerContext): ContinuationPlan =>
  context.continuation?.plan ?? { step: "continue", items: [] };

const redact = (text: string, secret: string | undefined): string =>
  secret ? text.split(secret).join("[redacted]") : text;

const interrupted = (reason: string): RunnerOutput => ({
  kind: "finished",
  results: [{ status: "interrupted", reason }],
});

const exists = (path: string) => access(path).then(() => true, () => false);

class DockerRunner implements Runner {
  constructor(private readonly options: DockerRunnerOptions) {}

  async run(context: RunnerContext): Promise<RunnerOutput> {
    const layout = jobLayout(this.options.stateDir, context.jobId);
    const observer = this.options.observer ?? noopObserver;
    let secret: string | undefined;
    let activity: AgentActivity | undefined;
    try {
      const project = findProject(this.options.instance.projects, context.ref, context.repository);
      const models = requireRunModels(project);
      const auth = resolveModelAuth(this.options.instance, this.options.credentials, this.options.profiles);
      const profile = this.profileOf(project, auth.agentDir);
      // The profile's persistent toolchain: created here, as the invoking user, because Docker creates a
      // missing bind target as root and the container would then not be able to write (ADR 0004).
      const toolchain = profileToolchain(this.options.toolchainsDir, project.runtimeProfile);
      // Resolved on the host before anything is created: a required item missing stops here, with no container.
      const plan = await planSnapshot(profile.source, profile.declaration);
      if (plan.blockers.length > 0) throw new Error(`perfil de runtime bloqueado: ${plan.blockers.join("; ")}`);
      const preflight = await this.options.boundary.preflight({ image: this.options.image, account: project.githubAccount });
      secret = preflight.token;
      observer.registerSecret(preflight.token);

      const saved = context.kind === "new" ? undefined : await this.readRecord(layout);
      const repoRef = context.kind === "new"
        ? await this.startJob(context, project, layout)
        : await this.resumeJob(context, saved, layout);
      const prompt = context.kind === "new"
        ? implementPrompt({ ref: context.ref, repository: project.repository, targetBranch: repoRef.targetBranch, branch: repoRef.branch, baseSha: repoRef.baseSha, models, ...(context.issue ? { issue: context.issue } : {}) })
        : continuationPrompt({ kind: context.kind, plan: continuationPlan(context), ref: context.ref, repository: project.repository, targetBranch: repoRef.targetBranch, branch: repoRef.branch, baseSha: repoRef.baseSha, models });

      const request = sandcastleRequest({
        kind: context.kind, prompt, configuredLimit: context.maxIterations, sessionId: repoRef.sessionId,
      });
      await this.audit(layout, `invocação ${context.kind}; limite efetivo=${request.maxIterations}; implementer=${models.implementer}`);
      await mkdir(layout.sessionsDir, { recursive: true });
      // Recreated on every invocation, outside the repository the agent works in.
      await writeSnapshot(plan, layout.snapshotDir);

      // One invocation, one detailed log: the operator follows it with `tail -f` while it runs.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logs = join(layout.areaDir, "logs");
      const detailPath = join(logs, `${stamp}.log`);
      const runtimeLogPath = join(logs, `${stamp}.runtime.log`);
      const artifactsDir = join(logs, `${stamp}.artifacts`);
      const tracker = this.options.tracker;
      activity = new AgentActivity({
        observer, job: context.jobId, ...(context.invocation === undefined ? {} : { invocation: context.invocation }),
        detailPath, artifactsDir, ...(this.options.now === undefined ? {} : { now: this.options.now }),
        idle: { timeoutSeconds: IDLE_TIMEOUT_SECONDS, warnEverySeconds: IDLE_WARNING_SECONDS },
        issueWrites: { ref: context.ref, repository: project.repository, githubAccount: project.githubAccount, ...(tracker === undefined ? {} : { tracker }) },
      });
      activity.note("perfil de runtime", describePlan(plan));
      observer.setDetailLog(context.jobId, detailPath);
      observer.emit({
        kind: "logs-da-invocação", text: "logs da invocação", job: context.jobId,
        ...(context.invocation === undefined ? {} : { invocation: context.invocation }),
        lines: [`tail -f ${shellQuote(detailPath)}`],
        fields: { detalhado: detailPath, artefatos: artifactsDir, "limite-de-silêncio": `${IDLE_TIMEOUT_SECONDS}s` },
      });
      // The toolchain directories exist before the container starts, owned by the invoking user: Docker
      // creates a missing bind target as root, and the convergence inside could not write to it (ADR 0004).
      // The mise data dir is the shared one, so this is idempotent for every profile.
      await mkdir(toolchain.npm, { recursive: true });
      await mkdir(toolchain.mise, { recursive: true });
      const outcome = await this.options.boundary.run({
        image: this.options.image, cwd: layout.repoDir, sessionsDir: layout.sessionsDir,
        snapshotDir: layout.snapshotDir, requiredPackages: profile.declaration.required.packages,
        requiredTools: profile.declaration.required.tools, npmDir: toolchain.npm, miseDir: toolchain.mise,
        model: models.implementer, token: preflight.token, request,
        activity, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS, idleWarningSeconds: IDLE_WARNING_SECONDS, runtimeLogPath,
        redact: (text) => observer.redact(text),
      });
      await activity.close();
      this.reportReplyDelivery(observer, context, activity);

      const sessionId = outcome.sessionId ?? repoRef.sessionId;
      await this.writeRecord(layout, { ...repoRef, sessionId });
      await this.audit(layout, `iterações do Sandcastle=${outcome.iterations} de ${request.maxIterations}; completou=${outcome.completed}`);
      // The session and area of this invocation are reported so the admission can resume them.
      const reportWorkspace = (output: RunnerOutput): RunnerOutput =>
        sessionId === undefined ? output : { ...output, workspace: { session: sessionId, area: layout.repoDir } };
      const interpretation = interpretOutput({
        events: outcome.events,
        completed: outcome.completed,
        models,
      });
      for (const line of interpretation.audit) await this.audit(layout, line);
      return reportWorkspace(interpretation.output);
    } catch (error) {
      const reason = observer.redact(redact(messageOf(error), secret));
      // A real timeout is a transition of its own; the warnings before it were only warnings.
      if (/Agent idle for \d+ seconds/.test(reason)) activity?.timedOut(reason);
      if (activity) {
        await activity.close();
        // A run that failed has not shown that the reply reached the agent, unless the stream did.
        this.reportReplyDelivery(observer, context, activity);
      }
      await this.audit(layout, `interrompido: ${reason}`);
      return interrupted(reason);
    } finally {
      // The snapshot holds the operator's credentials (auth.json): it lives only as long as the invocation.
      await rm(layout.snapshotDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // The runtime profile of a project: where it lives, what it must carry, where its links may lead.
  private profileOf(project: ProjectConfig, authDir: string): RuntimeProfile {
    return resolveRuntimeProfileDeclaration(project, resolveRuntimeProfile(project, this.options.profiles, authDir), this.options);
  }

  private profileForJob(job: { ref: IssueRef; repository: string }): RuntimeProfile {
    const project = findProject(this.options.instance.projects, job.ref, job.repository);
    const auth = resolveModelAuth(this.options.instance, this.options.credentials, this.options.profiles);
    return this.profileOf(project, auth.agentDir);
  }

  // Asked by the admission before the claim and before a continuation (ADR 0002): the required items of the
  // runtime profile resolve on the host, or the reason they do not.
  async runtimeBlocker(job: { ref: IssueRef; repository: string }): Promise<string | undefined> {
    try {
      const profile = this.profileForJob(job);
      const blockers = await checkRequired(profile.source, profile.declaration);
      return blockers.length === 0 ? undefined : blockers.join("; ");
    } catch (error) {
      return `perfil de runtime não resolvido: ${messageOf(error)}`;
    }
  }

  // The triage runs the skill of the operator's profile; without it the agent would not have it (issue #21).
  // It resolves the skill the way the snapshot does, so a skill the container would not get is unavailable.
  async triageUnavailable(job: { ref: IssueRef; repository: string }): Promise<string | undefined> {
    try {
      const profile = this.profileForJob(job);
      const path = skillPathOf(TRIAGE_SKILL);
      return (await resolves(profile.source, path))
        ? undefined
        : `skill ${TRIAGE_SKILL} ausente do perfil de runtime (${profile.source.dir}/${path}, links só dentro das raízes permitidas); o operador a linka no perfil`;
    } catch (error) {
      return `perfil Pi não resolvido: ${messageOf(error)}`;
    }
  }

  // An item is delivered only when the stream shows it reaching the agent: the user message of the
  // invocation carries the rendered items of the plan. Delivery is confirmed by counting the items
  // found in the stream against the items the prompt rendered (issue #21).
  private reportReplyDelivery(observer: Observer, context: RunnerContext, activity: AgentActivity): void {
    const plan = continuationPlan(context);
    const items = continuationItems(plan);
    if (items.length === 0) return;
    const messages = activity.userMessages();
    const delivered = items.filter((item) => messages.some((message) => message.includes(item))).length;
    const commands = planCommands(plan);
    const base = {
      job: context.jobId, ...(context.invocation === undefined ? {} : { invocation: context.invocation }),
    };
    const fields = { comando: commands.length === 0 ? undefined : commands.join(","), respostas: items.length };
    if (delivered === items.length) {
      observer.emit({ kind: "resposta-entregue", text: "resposta entregue ao agente", level: "progresso", ...base, fields: { ...fields, evidência: "mensagem do usuário no stream do runtime" } });
    } else {
      observer.emit({
        kind: "entrega-não-confirmada", text: "entrega da resposta ao agente não confirmada", level: "atenção", ...base,
        fields: { ...fields, confirmadas: delivered, motivo: "sem evidência no stream do runtime; a resposta foi incluída na retomada" },
      });
    }
  }

  // New job: a clone of the target branch at base, on the job branch. Its base is recorded.
  private async startJob(
    context: RunnerContext,
    project: ProjectConfig,
    layout: JobLayout,
  ): Promise<JobRecord & { targetBranch: string; branch: string; baseSha: string }> {
    const branch = jobBranch(context.ref);
    const remoteUrl = this.options.remoteUrl?.(project);
    const baseSha = await createJobRepo({
      source: this.options.repositorySource(project),
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
      repoDir: layout.repoDir,
      targetBranch: project.targetBranch,
      branch,
    });
    const saved = { jobId: context.jobId, targetBranch: project.targetBranch, branch, baseSha };
    await this.writeRecord(layout, saved);
    return saved;
  }

  // Continuation: the recorded session and the job's own area must both still exist. Nothing is
  // rebuilt and no new conversation is started.
  private async resumeJob(
    context: RunnerContext,
    saved: JobRecord | undefined,
    layout: JobLayout,
  ): Promise<JobRecord & { targetBranch: string; branch: string; baseSha: string }> {
    if (!saved) throw new Error("retomada sem registro do trabalho: nada a continuar; não iniciar nova conversa");
    if (!(await exists(layout.repoDir))) {
      throw new Error(`área do trabalho ausente: ${layout.repoDir}; retomada não reconstrói o trabalho`);
    }
    // The admission's record of the job is the authority for what to continue; it must agree with the runner's.
    const workspace = context.continuation?.workspace;
    if (workspace === undefined) return { ...saved, jobId: context.jobId };
    if (workspace.area !== layout.repoDir) {
      throw new Error(`área registrada no trabalho (${workspace.area}) difere da área do runner; não retomar`);
    }
    if (saved.sessionId !== undefined && saved.sessionId !== workspace.session) {
      throw new Error("sessão registrada no trabalho difere da sessão do runner; não retomar");
    }
    return { ...saved, jobId: context.jobId, sessionId: workspace.session };
  }

  private async readRecord(layout: JobLayout): Promise<JobRecord | undefined> {
    let text: string;
    try {
      text = await readFile(layout.recordPath, "utf8");
    } catch {
      return undefined;
    }
    return JSON.parse(text) as JobRecord;
  }

  private async writeRecord(layout: JobLayout, record: JobRecord): Promise<void> {
    await mkdir(dirname(layout.recordPath), { recursive: true });
    await writeFile(layout.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private async audit(layout: JobLayout, line: string): Promise<void> {
    await mkdir(dirname(layout.auditPath), { recursive: true });
    await appendFile(layout.auditPath, `${JSON.stringify({ at: new Date().toISOString(), line })}\n`);
  }
}
