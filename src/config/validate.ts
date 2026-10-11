import {
  MODEL_ROLES,
  type ConfigIssue,
  type ConfigResult,
  type CredentialRef,
  type InstanceConfig,
  type JiraSettings,
  type ModelRole,
  type MsfConfig,
  type ProjectConfig,
} from "./types.js";

type Obj = Record<string, unknown>;

const PROJECT_KEYS = ["name", "enabled", "adapter", "repository", "targetBranch", "prIntegration",
  "runtimeProfile", "githubAccount", "labels", "models", "jira"];
const JIRA_KEYS = ["projectKey", "routingLabel", "doingTransition", "doneTransition",
  "blockingLinkTypes", "credential", "operator"];
const INSTANCE_KEYS = ["name", "maxConcurrent", "pollIntervalSeconds", "maxIterations", "modelAuth", "projects"];
const CREDENTIAL_KEYS = ["kind", "ref"];
const CREDENTIAL_KINDS = ["env", "pi-auth"];
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]+$/;
const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const LABEL_PATTERN = /^\S+$/;
const MODEL_PATTERN = /^[^/\s]+\/\S+$/;
const DEFAULT_LABELS = { ready: "ready-for-agent", claimed: "agent-claimed" };

class Issues {
  readonly list: ConfigIssue[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function checkKeys(obj: Obj, allowed: readonly string[], path: string, issues: Issues): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) issues.add(join(path, key), "campo desconhecido");
  }
}

function text(obj: Obj, key: string, path: string, issues: Issues, pattern?: RegExp, hint?: string): string | undefined {
  const value = obj[key];
  const at = join(path, key);
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(at, "texto obrigatório ausente ou vazio");
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    issues.add(at, hint ?? "formato inválido");
    return undefined;
  }
  return value;
}

function positiveInteger(obj: Obj, key: string, path: string, issues: Issues): number | undefined {
  const value = obj[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  issues.add(join(path, key), "deve ser inteiro positivo");
  return undefined;
}

function boolean(obj: Obj, key: string, path: string, issues: Issues): boolean | undefined {
  const value = obj[key];
  if (typeof value === "boolean") return value;
  issues.add(join(path, key), "deve ser true ou false");
  return undefined;
}

function parseCredentials(raw: unknown, issues: Issues): Record<string, CredentialRef> | undefined {
  if (!isObject(raw)) {
    issues.add("credentials", "deve ser objeto de referências nomeadas");
    return undefined;
  }
  const result: Record<string, CredentialRef> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const at = join("credentials", name);
    if (!isObject(entry)) {
      issues.add(at, "referência de credencial deve ser objeto");
      continue;
    }
    checkKeys(entry, CREDENTIAL_KEYS, at, issues);
    const kind = text(entry, "kind", at, issues);
    const ref = text(entry, "ref", at, issues);
    if (kind === undefined || ref === undefined) continue;
    if (!CREDENTIAL_KINDS.includes(kind)) {
      issues.add(join(at, "kind"), `tipo desconhecido (${CREDENTIAL_KINDS.join(" | ")})`);
      continue;
    }
    result[name] = { kind: kind as CredentialRef["kind"], ref };
  }
  return result;
}

function requireCredential(
  name: string | undefined,
  kind: CredentialRef["kind"],
  at: string,
  credentials: Record<string, CredentialRef>,
  issues: Issues,
): void {
  if (name === undefined) return;
  const declared = credentials[name];
  if (!declared) {
    issues.add(at, `referência de credencial '${name}' não declarada em credentials`);
  } else if (declared.kind !== kind) {
    issues.add(at, `credencial '${name}' é do tipo ${declared.kind}; esperado ${kind}`);
  }
}

function parseModels(raw: unknown, path: string, issues: Issues): Record<ModelRole, string> | undefined {
  if (!isObject(raw)) {
    issues.add(path, "models deve ser objeto com um modelo por papel");
    return undefined;
  }
  checkKeys(raw, MODEL_ROLES, path, issues);
  const models = {} as Record<ModelRole, string>;
  let complete = true;
  for (const role of MODEL_ROLES) {
    if (!(role in raw)) {
      issues.add(join(path, role), `papel '${role}' ausente`);
      complete = false;
      continue;
    }
    const value = text(raw, role, path, issues, MODEL_PATTERN, "modelo deve ser explícito no formato provider/model");
    if (value === undefined) complete = false;
    else models[role] = value;
  }
  return complete ? models : undefined;
}

function parseJira(raw: unknown, path: string, credentials: Record<string, CredentialRef>, issues: Issues): JiraSettings | undefined {
  if (!isObject(raw)) {
    issues.add(path, "jira deve ser objeto");
    return undefined;
  }
  checkKeys(raw, JIRA_KEYS, path, issues);
  const projectKey = text(raw, "projectKey", path, issues, JIRA_KEY_PATTERN, "chave Jira inválida");
  const routingLabel = text(raw, "routingLabel", path, issues, LABEL_PATTERN, "label de roteamento não pode conter espaços");
  const doingTransition = text(raw, "doingTransition", path, issues);
  const doneTransition = text(raw, "doneTransition", path, issues);
  const credential = text(raw, "credential", path, issues);
  const operator = text(raw, "operator", path, issues);
  let blockingLinkTypes: string[] | undefined;
  const links = raw.blockingLinkTypes;
  if (Array.isArray(links) && links.length > 0 && links.every((link) => typeof link === "string" && link.trim() !== "")) {
    blockingLinkTypes = links as string[];
  } else {
    issues.add(join(path, "blockingLinkTypes"), "lista de tipos de link de bloqueio obrigatória");
  }
  requireCredential(credential, "env", join(path, "credential"), credentials, issues);
  if (projectKey === undefined || routingLabel === undefined || doingTransition === undefined
    || doneTransition === undefined || blockingLinkTypes === undefined || credential === undefined
    || operator === undefined) {
    return undefined;
  }
  return { projectKey, routingLabel, doingTransition, doneTransition, blockingLinkTypes, credential, operator };
}

function parseLabels(raw: unknown, path: string, issues: Issues): { ready: string; claimed: string } | undefined {
  if (raw === undefined) return { ...DEFAULT_LABELS };
  if (!isObject(raw)) {
    issues.add(path, "labels deve ser objeto");
    return undefined;
  }
  checkKeys(raw, ["ready", "claimed"], path, issues);
  const ready = raw.ready === undefined ? DEFAULT_LABELS.ready : text(raw, "ready", path, issues, LABEL_PATTERN, "label não pode conter espaços");
  const claimed = raw.claimed === undefined ? DEFAULT_LABELS.claimed : text(raw, "claimed", path, issues, LABEL_PATTERN, "label não pode conter espaços");
  return ready === undefined || claimed === undefined ? undefined : { ready, claimed };
}

function parseProject(raw: unknown, path: string, credentials: Record<string, CredentialRef>, issues: Issues): ProjectConfig | undefined {
  if (!isObject(raw)) {
    issues.add(path, "projeto deve ser objeto");
    return undefined;
  }
  checkKeys(raw, PROJECT_KEYS, path, issues);
  const name = text(raw, "name", path, issues);
  const enabled = boolean(raw, "enabled", path, issues);
  const adapter = raw.adapter;
  if (adapter !== "github" && adapter !== "jira") {
    issues.add(join(path, "adapter"), "adapter deve ser github ou jira");
  }
  const repository = text(raw, "repository", path, issues, REPOSITORY_PATTERN, "repositório deve ser owner/repo");
  const targetBranch = text(raw, "targetBranch", path, issues);
  if (raw.prIntegration !== "github.com") {
    issues.add(join(path, "prIntegration"), "integração de PR deve ser github.com");
  }
  const runtimeProfile = text(raw, "runtimeProfile", path, issues);
  const githubAccount = text(raw, "githubAccount", path, issues, ACCOUNT_PATTERN, "conta GitHub inválida");
  const labels = parseLabels(raw.labels, join(path, "labels"), issues);
  const models = parseModels(raw.models, join(path, "models"), issues);

  let jira: JiraSettings | undefined;
  if (adapter === "jira") {
    if (raw.jira === undefined) issues.add(join(path, "jira"), "adapter jira exige bloco jira");
    else jira = parseJira(raw.jira, join(path, "jira"), credentials, issues);
  } else if (raw.jira !== undefined) {
    issues.add(join(path, "jira"), "bloco jira só é válido com adapter jira");
  }

  if (name === undefined || enabled === undefined || repository === undefined || targetBranch === undefined
    || runtimeProfile === undefined || githubAccount === undefined || labels === undefined || models === undefined) {
    return undefined;
  }
  const base = {
    name, enabled, repository, targetBranch, prIntegration: "github.com" as const, runtimeProfile,
    githubAccount, labels, models,
  };
  if (adapter === "github") return { ...base, adapter };
  if (adapter === "jira" && jira !== undefined) return { ...base, adapter, jira };
  return undefined;
}

function parseInstance(raw: unknown, path: string, credentials: Record<string, CredentialRef>, issues: Issues): InstanceConfig | undefined {
  if (!isObject(raw)) {
    issues.add(path, "instância deve ser objeto");
    return undefined;
  }
  checkKeys(raw, INSTANCE_KEYS, path, issues);
  const name = text(raw, "name", path, issues);
  const maxConcurrent = positiveInteger(raw, "maxConcurrent", path, issues);
  const pollIntervalSeconds = positiveInteger(raw, "pollIntervalSeconds", path, issues);
  const maxIterations = positiveInteger(raw, "maxIterations", path, issues);
  const modelAuth = text(raw, "modelAuth", path, issues);
  requireCredential(modelAuth, "pi-auth", join(path, "modelAuth"), credentials, issues);
  if (!Array.isArray(raw.projects)) {
    issues.add(join(path, "projects"), "lista de projetos obrigatória");
    return undefined;
  }
  const projects = raw.projects.map((project, index) => {
    // Name the project in error paths when it is readable, so the operator can find it.
    const label = isObject(project) && typeof project.name === "string" ? project.name : String(index);
    return parseProject(project, `${join(path, "projects")}.${label}`, credentials, issues);
  });
  const validProjects = projects.filter((p): p is ProjectConfig => p !== undefined);
  if (name === undefined || maxConcurrent === undefined || pollIntervalSeconds === undefined
    || maxIterations === undefined || modelAuth === undefined || validProjects.length !== projects.length) {
    return undefined;
  }
  return { name, maxConcurrent, pollIntervalSeconds, maxIterations, modelAuth, projects: validProjects };
}

// Cross-instance rules: an instance name is unique, a project name is unique,
// a GitHub repository or Jira project key belongs to exactly one instance, and
// a Jira project key + routing label pair is unique across the whole config.
function checkOwnership(instances: InstanceConfig[], issues: Issues): void {
  const instanceNames = new Map<string, string>();
  const projectNames = new Map<string, string>();
  const scopeOwner = new Map<string, string>();
  const jiraRoutes = new Map<string, string>();
  instances.forEach((instance, index) => {
    const at = `instances[${index}]`;
    if (instanceNames.has(instance.name)) {
      issues.add(join(at, "name"), `nome de instância duplicado: ${instance.name}`);
    }
    instanceNames.set(instance.name, instance.name);
    for (const project of instance.projects) {
      const where = `${instance.name}/${project.name}`;
      const previousProject = projectNames.get(project.name);
      if (previousProject !== undefined) {
        issues.add(at, `projeto '${project.name}' aparece em ${previousProject} e ${instance.name}`);
      }
      projectNames.set(project.name, instance.name);
      const scope = project.adapter === "github" ? project.repository : project.jira.projectKey;
      const owner = scopeOwner.get(scope);
      if (owner !== undefined && owner !== instance.name) {
        issues.add(at, `escopo ${scope} está em duas instâncias (${owner} e ${instance.name})`);
      }
      scopeOwner.set(scope, instance.name);
      if (project.adapter === "jira") {
        const route = `${project.jira.projectKey}:${project.jira.routingLabel}`;
        if (jiraRoutes.has(route)) {
          issues.add(at, `roteamento ${route} configurado mais de uma vez (${jiraRoutes.get(route)} e ${where})`);
        }
        jiraRoutes.set(route, where);
      }
    }
  });
}

export function parseConfig(raw: unknown): ConfigResult {
  const issues = new Issues();
  if (!isObject(raw)) {
    issues.add("", "configuração deve ser um objeto JSON");
    return { ok: false, issues: issues.list };
  }
  checkKeys(raw, ["credentials", "instances"], "", issues);
  const credentials = parseCredentials(raw.credentials, issues) ?? {};
  if (!Array.isArray(raw.instances)) {
    issues.add("instances", "lista de instâncias obrigatória");
    return { ok: false, issues: issues.list };
  }
  const parsed = raw.instances.map((instance, index) =>
    parseInstance(instance, `instances[${index}]`, credentials, issues));
  const instances = parsed.filter((i): i is InstanceConfig => i !== undefined);
  checkOwnership(instances, issues);
  if (issues.list.length > 0 || instances.length !== parsed.length) {
    return { ok: false, issues: issues.list };
  }
  const config: MsfConfig = { credentials, instances };
  return { ok: true, config };
}
