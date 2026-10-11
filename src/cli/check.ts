import { access } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../runtime/docker-area.js";
import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import type { AdmissionDeps } from "../core/admission.js";
import { messageOf } from "../core/values.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";
import { resolveModelAuth, resolveRuntimeProfile } from "../runtime/docker-config.js";
import { jiraConnectionFromEnv, jiraRequest } from "../tracker/jira.js";
import type { LocalSettings } from "./local-settings.js";

// Read-only readiness check of one instance, run before the pilot: every external piece an
// admission would touch is exercised once, with no claim, comment or other write. A failed
// line names what to fix; a check never repairs anything.

export interface CheckLine {
  ok: boolean;
  what: string;
  detail: string;
}

export interface CheckOptions {
  config: MsfConfig;
  instance: InstanceConfig;
  local: LocalSettings;
  deps: AdmissionDeps;
  sandbox: SandboxBoundary;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_REVIEW_INPUTS = { specPath: "docs/spec.md", standardsPath: "CODING_STANDARDS.md" };

async function attempt(what: string, run: () => Promise<string>): Promise<CheckLine> {
  try {
    return { ok: true, what, detail: await run() };
  } catch (error) {
    return { ok: false, what, detail: messageOf(error) };
  }
}

async function checkoutLines(project: ProjectConfig, local: LocalSettings): Promise<CheckLine[]> {
  const checkout = local.checkouts[project.repository]!;
  const branch = project.targetBranch;
  const inputs = local.reviewInputs ?? DEFAULT_REVIEW_INPUTS;
  const lines = [
    await attempt(`${project.name}: checkout ${checkout}`, async () => {
      await git(checkout, "rev-parse", "--verify", `refs/heads/${branch}`);
      const remote = (await git(checkout, "remote", "get-url", "origin")).trim();
      if (!remote.includes(project.repository)) throw new Error(`origin (${remote}) não aponta para ${project.repository}`);
      // Commits not on origin would ride along in the job's PR: the area is cloned from this branch.
      const ahead = await git(checkout, "rev-list", "--count", `origin/${branch}..${branch}`).catch(() => "0");
      if (Number(ahead) > 0) throw new Error(`${branch} local tem ${ahead.trim()} commit(s) que não estão em origin/${branch}; eles iriam no PR do trabalho`);
      const behind = await git(checkout, "rev-list", "--count", `${branch}..origin/${branch}`).catch(() => "0");
      return Number(behind) > 0
        ? `ATENÇÃO: ${branch} local está ${behind.trim()} commit(s) atrás de origin/${branch}; atualize antes do piloto`
        : `branch ${branch} presente`;
    }),
  ];
  for (const file of [inputs.specPath, inputs.standardsPath]) {
    lines.push(await attempt(`${project.name}: ${file} em ${branch}`, async () => {
      await git(checkout, "cat-file", "-e", `refs/heads/${branch}:${file}`);
      return "presente (insumo de review dos reviewers)";
    }));
  }
  return lines;
}

export async function checkInstance(options: CheckOptions): Promise<CheckLine[]> {
  const { config, instance, local, deps, sandbox } = options;
  const lines: CheckLine[] = [];
  const projects = instance.projects.filter((project) => project.enabled);
  const jiraProjects = projects.filter((project): project is Extract<ProjectConfig, { adapter: "jira" }> => project.adapter === "jira");

  lines.push(await attempt("autenticação do modelo (perfil Pi da instância)", async () => {
    const auth = resolveModelAuth(instance, config.credentials, local.profiles);
    for (const project of projects) resolveRuntimeProfile(project, local.profiles, auth.agentDir);
    return auth.agentDir;
  }));
  lines.push(await attempt("perfil Pi tem a skill implement", async () => {
    const dir = resolveModelAuth(instance, config.credentials, local.profiles).agentDir;
    await access(join(dir, "skills", "implement", "SKILL.md")).catch(() => {
      throw new Error(`${join(dir, "skills", "implement", "SKILL.md")} não existe; o container não teria /implement`);
    });
    return "skills/implement/SKILL.md";
  }));

  if (jiraProjects.length > 0) {
    lines.push(await attempt("Jira: conta autenticada é o operador configurado", async () => {
      const me = await jiraRequest<{ accountId?: string }>(jiraConnectionFromEnv(options.env), "GET", "/rest/api/3/myself");
      const wrong = jiraProjects.filter((project) => project.jira.operator !== me?.accountId);
      if (wrong.length > 0) {
        throw new Error(`jira.operator difere do accountId autenticado (${me?.accountId}) em: ${wrong.map((p) => p.name).join(", ")}`);
      }
      return `accountId ${me?.accountId}`;
    }));
  }

  const accounts = new Set<string>();
  for (const project of projects) {
    const auth = resolveModelAuth(instance, config.credentials, local.profiles);
    if (!accounts.has(project.githubAccount)) {
      accounts.add(project.githubAccount);
      lines.push(await attempt(`Docker, imagem, perfil e token da conta ${project.githubAccount}`, async () => {
        await sandbox.preflight({ image: local.image, profileDir: auth.agentDir, account: project.githubAccount });
        return `imagem ${local.image}`;
      }));
    }
    lines.push(await attempt(`${project.name}: tracker (descoberta somente leitura)`, async () => {
      const refs = await deps.tracker.discoverCandidates(deps.eligibility(project).scope);
      return `${refs.length} issue(s) com ${project.labels.ready} no escopo`;
    }));
    lines.push(...await checkoutLines(project, local));
  }
  return lines;
}
