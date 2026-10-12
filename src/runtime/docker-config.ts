import { MODEL_ROLES, type CredentialRef, type InstanceConfig, type ModelRole, type ProjectConfig, type RuntimeProfileConfig } from "../config/types.js";
import { refKey, type IssueRef } from "../tracker/port.js";
import type { ProfileSource } from "./profile-snapshot.js";

// Configuration the Docker runner needs before any container starts. Every problem is a
// visible RunnerConfigError: nothing falls back to another model, auth or profile (CA18).
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

export type RunModels = Readonly<Record<ModelRole, string>>;

const MODEL_PATTERN = /^[^/\s]+\/\S+$/;

export function requireRunModels(project: ProjectConfig): RunModels {
  const models = {} as Record<ModelRole, string>;
  for (const role of MODEL_ROLES) {
    const value: unknown = project.models?.[role];
    if (typeof value !== "string" || value.trim() === "") {
      throw new RunnerConfigError(`modelo ausente para o papel ${role} no projeto ${project.name}; sem fallback`);
    }
    if (!MODEL_PATTERN.test(value)) {
      throw new RunnerConfigError(`modelo do papel ${role} no projeto ${project.name} deve ser provider/model`);
    }
    models[role] = value;
  }
  return models;
}

// The instance's model auth is a pi-auth reference; the runner maps the reference name to
// a host Pi agent directory it was given. A reference without a directory is an error.
export function resolveModelAuth(
  instance: InstanceConfig,
  credentials: Readonly<Record<string, CredentialRef>>,
  profiles: Readonly<Record<string, string>>,
): { ref: string; agentDir: string } {
  const credential = credentials[instance.modelAuth];
  if (!credential) throw new RunnerConfigError(`referência ${instance.modelAuth} não existe na configuração`);
  if (credential.kind !== "pi-auth") {
    throw new RunnerConfigError(`auth do modelo ${instance.modelAuth} deve ser pi-auth`);
  }
  const agentDir = profiles[credential.ref];
  if (!agentDir) {
    throw new RunnerConfigError(`perfil Pi ${credential.ref} não configurado no runner; sem fallback`);
  }
  return { ref: credential.ref, agentDir };
}

// The container uses the project's runtime profile, which must be the instance's model auth
// directory: a container never runs with another account's credentials.
export function resolveRuntimeProfile(
  project: ProjectConfig,
  profiles: Readonly<Record<string, string>>,
  authDir: string,
): string {
  const dir = profiles[project.runtimeProfile];
  if (!dir) throw new RunnerConfigError(`perfil ${project.runtimeProfile} não configurado no runner`);
  if (dir !== authDir) {
    throw new RunnerConfigError(`perfil ${project.runtimeProfile} não é o diretório de autenticação da instância; sem fallback`);
  }
  return dir;
}

// The runtime profile of a project is declared in two places (ADR 0002): what it must carry in config.json,
// where it lives and where its links may lead in local.json. Missing either is a configuration error.
export interface RuntimeProfileDeclarations {
  runtimeProfiles: Readonly<Record<string, RuntimeProfileConfig>>;
  allowedRoots: Readonly<Record<string, readonly string[]>>;
}

export interface RuntimeProfile {
  source: ProfileSource;
  declaration: RuntimeProfileConfig;
}

export function resolveRuntimeProfileDeclaration(
  project: ProjectConfig,
  dir: string,
  declarations: RuntimeProfileDeclarations,
): RuntimeProfile {
  const declaration = declarations.runtimeProfiles[project.runtimeProfile];
  if (!declaration) {
    throw new RunnerConfigError(`perfil de runtime ${project.runtimeProfile} (projeto ${project.name}) sem declaração em runtimeProfiles do config.json; sem fallback`);
  }
  const allowedRoots = declarations.allowedRoots[project.runtimeProfile];
  if (!allowedRoots) {
    throw new RunnerConfigError(`perfil de runtime ${project.runtimeProfile} (projeto ${project.name}) sem raízes permitidas em allowedRoots do local.json; sem fallback`);
  }
  return { source: { dir, allowedRoots }, declaration };
}

// The skill the triage of PR feedback invokes (issue #21). It comes from the operator's Pi profile, which
// the operator links it into on purpose; the factory only checks that it is there, never installs it.
export const TRIAGE_SKILL = "gh-address-comments";

export const skillPathOf = (skill: string): string => `skills/${skill}/SKILL.md`;

// Routing by tracker scope: a GitHub ref names the repository, a Jira ref names the project key.
// A Jira key shared by several projects is ambiguous without the repository of the job, so it is
// refused when the repository is not given.
export function findProject(projects: readonly ProjectConfig[], ref: IssueRef, repository?: string): ProjectConfig {
  const matches = projects.filter((project) => {
    if (!project.enabled) return false;
    if (repository !== undefined && project.repository !== repository) return false;
    if (ref.tracker === "github") return project.adapter === "github" && project.repository === ref.project;
    return ref.tracker === "jira" && project.adapter === "jira" && project.jira.projectKey === ref.project;
  });
  if (matches.length === 0) throw new RunnerConfigError(`projeto não configurado para ${refKey(ref)}`);
  if (matches.length > 1) throw new RunnerConfigError(`projeto ambíguo para ${refKey(ref)}: ${matches.length} projetos`);
  return matches[0]!;
}
