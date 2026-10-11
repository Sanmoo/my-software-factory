import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialRef, InstanceConfig, ProjectConfig } from "../config/types.js";
import {
  findProject,
  requireRunModels,
  resolveModelAuth,
  resolveRuntimeProfile,
} from "./docker-config.js";
import {
  createJobRepo,
  diffSha256Of,
  fileSha256At,
  headOf,
  jobLayout,
  type JobLayout,
} from "./docker-area.js";
import { jobBranch } from "../core/job.js";
import { sandcastleRequest, type SandcastleRequest } from "./docker-invocation.js";
import { interpretOutput } from "./docker-output.js";
import { continuationPrompt, implementPrompt, type ReviewMaterial } from "./docker-prompt.js";
import type { PiEvent } from "./pi-events.js";
import type { Runner, RunnerContext, RunnerOutput } from "./runner.js";

// Docker runner (R06, R07, R08, CA08, CA09, CA18). Each job gets its own git area and Pi
// session on the host; the agent runs only inside the sandbox boundary. Any failure before or
// during the run is an interruption with its reason. Nothing here runs on the host instead.

// The sandbox boundary: Docker and Sandcastle in production, a fake in tests.
export interface SandboxRun {
  image: string;
  cwd: string; // job repository, the bind-mounted work area
  sessionsDir: string; // host directory for the Pi session, outside the container
  profileDir: string; // host Pi agent directory, mounted read-only at the same path
  model: string; // implementer model: the main agent of the invocation
  token: string; // GitHub token for the container environment only
  request: SandcastleRequest;
}

export interface SandboxOutcome {
  sessionId?: string;
  completed: boolean; // the completion signal was matched
  iterations: number; // Sandcastle iterations used; each one is a fresh Pi session
  events: PiEvent[];
}

export interface SandboxBoundary {
  // Docker reachable, image present, profile complete, token available. Throws otherwise.
  preflight(input: { image: string; profileDir: string; account: string }): Promise<{ token: string }>;
  run(input: SandboxRun): Promise<SandboxOutcome>;
}

export interface ReviewInputs {
  specPath: string;
  standardsPath: string;
}

export interface DockerRunnerOptions {
  instance: InstanceConfig;
  credentials: Readonly<Record<string, CredentialRef>>;
  profiles: Readonly<Record<string, string>>;
  stateDir: string;
  image: string;
  // Local clone each project's job area is cloned from (the operator's checkout).
  repositorySource: (project: ProjectConfig) => string;
  boundary: SandboxBoundary;
  reviewInputs?: ReviewInputs;
}

// Configuration problems are visible when the runner is built, before any job starts.
export function createDockerRunner(options: DockerRunnerOptions): Runner {
  for (const project of options.instance.projects) {
    if (!project.enabled) continue;
    requireRunModels(project);
    const auth = resolveModelAuth(options.instance, options.credentials, options.profiles);
    resolveRuntimeProfile(project, options.profiles, auth.agentDir);
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Operator replies delivered with a continuation (R09); the admission hands them over in `continuation`.
const operatorInput = (context: RunnerContext): string => (context.continuation?.replies ?? []).join("\n");

const redact = (text: string, secret: string | undefined): string =>
  secret ? text.split(secret).join("[redacted]") : text;

const interrupted = (reason: string): RunnerOutput => ({
  kind: "finished",
  results: [{ status: "interrupted", reason }],
});

const exists = (path: string) => access(path).then(() => true, () => false);

class DockerRunner implements Runner {
  private readonly reviewInputs: ReviewInputs;

  constructor(private readonly options: DockerRunnerOptions) {
    this.reviewInputs = options.reviewInputs ?? { specPath: "docs/spec.md", standardsPath: "CODING_STANDARDS.md" };
  }

  async run(context: RunnerContext): Promise<RunnerOutput> {
    const layout = jobLayout(this.options.stateDir, context.jobId);
    let secret: string | undefined;
    try {
      const project = findProject(this.options.instance.projects, context.ref);
      const models = requireRunModels(project);
      const auth = resolveModelAuth(this.options.instance, this.options.credentials, this.options.profiles);
      const profileDir = resolveRuntimeProfile(project, this.options.profiles, auth.agentDir);
      const preflight = await this.options.boundary.preflight({
        image: this.options.image, profileDir, account: project.githubAccount,
      });
      secret = preflight.token;

      const saved = context.kind === "new" ? undefined : await this.readRecord(layout);
      const repoRef = context.kind === "new"
        ? await this.startJob(context, project, layout)
        : await this.resumeJob(context, saved, layout);
      const review = await this.reviewMaterial(layout.repoDir, repoRef.baseSha);
      const prompt = context.kind === "new"
        ? implementPrompt({ ref: context.ref, repository: project.repository, targetBranch: repoRef.targetBranch, branch: repoRef.branch, baseSha: repoRef.baseSha, models, review, ...(context.issue ? { issue: context.issue } : {}) })
        : continuationPrompt({ kind: context.kind, note: operatorInput(context), ref: context.ref, repository: project.repository, targetBranch: repoRef.targetBranch, branch: repoRef.branch, baseSha: repoRef.baseSha, models, review });

      const request = sandcastleRequest({
        kind: context.kind, prompt, configuredLimit: context.maxIterations, sessionId: repoRef.sessionId,
      });
      await this.audit(layout, `invocação ${context.kind}; limite efetivo=${request.maxIterations}; implementer=${models.implementer}`);
      await mkdir(layout.sessionsDir, { recursive: true });
      const outcome = await this.options.boundary.run({
        image: this.options.image, cwd: layout.repoDir, sessionsDir: layout.sessionsDir, profileDir,
        model: models.implementer, token: preflight.token, request,
      });

      const sessionId = outcome.sessionId ?? repoRef.sessionId;
      await this.writeRecord(layout, { ...repoRef, sessionId });
      await this.audit(layout, `iterações do Sandcastle=${outcome.iterations} de ${request.maxIterations}; completou=${outcome.completed}`);
      // The session and area of this invocation are reported so the admission can resume them (P03).
      const reportWorkspace = (output: RunnerOutput): RunnerOutput =>
        sessionId === undefined ? output : { ...output, workspace: { session: sessionId, area: layout.repoDir } };
      const headSha = await headOf(layout.repoDir);
      const interpretation = interpretOutput({
        events: outcome.events,
        completed: outcome.completed,
        models,
        baseSha: repoRef.baseSha,
        headSha,
        diffSha256: await diffSha256Of(layout.repoDir, repoRef.baseSha, headSha),
        specSha256: review.specSha256,
        standardsSha256: review.standardsSha256,
      });
      for (const line of interpretation.audit) await this.audit(layout, line);
      return reportWorkspace(interpretation.output);
    } catch (error) {
      const reason = redact(messageOf(error), secret);
      await this.audit(layout, `interrompido: ${reason}`);
      return interrupted(reason);
    }
  }

  // New job: a clone of the target branch at base, on the job branch. Its base is recorded.
  private async startJob(
    context: RunnerContext,
    project: ProjectConfig,
    layout: JobLayout,
  ): Promise<JobRecord & { targetBranch: string; branch: string; baseSha: string }> {
    const branch = jobBranch(context.ref);
    const baseSha = await createJobRepo({
      source: this.options.repositorySource(project),
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

  private async reviewMaterial(repoDir: string, baseSha: string): Promise<ReviewMaterial> {
    const { specPath, standardsPath } = this.reviewInputs;
    return {
      specPath,
      specSha256: await fileSha256At(repoDir, baseSha, specPath),
      standardsPath,
      standardsSha256: await fileSha256At(repoDir, baseSha, standardsPath),
    };
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
