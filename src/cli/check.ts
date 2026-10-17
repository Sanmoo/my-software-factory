import { git } from "../runtime/docker-area.js";
import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import type { AdmissionDeps } from "../core/admission.js";
import { messageOf } from "../core/values.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";
import { profileToolchain } from "../runtime/docker-invocation.js";
import { readToolchainState } from "../runtime/toolchain-state.js";
import { resolveModelAuth, resolveRuntimeProfile, resolveRuntimeProfileDeclaration, skillPathOf, TRIAGE_SKILL } from "../runtime/docker-config.js";
import { checkRequired, resolves } from "../runtime/profile-snapshot.js";
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
  // Root of the persistent per-profile toolchains, under the factory `--home` (ADR 0004).
  toolchainsDir: string;
  env?: NodeJS.ProcessEnv;
}


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
  return [
    await attempt(`${project.name}: checkout ${checkout}`, async () => {
      await git(checkout, "rev-parse", "--verify", `refs/heads/${branch}`);
      const remote = (await git(checkout, "remote", "get-url", "origin")).trim();
      if (!remote.includes(project.repository)) throw new Error(`origin (${remote}) não aponta para ${project.repository}`);
      await git(checkout, "rev-parse", "--verify", `refs/remotes/origin/${branch}`).catch(() => {
        throw new Error(`origin/${branch} desconhecida neste checkout; rode git fetch`);
      });
      // Commits not on origin would ride along in the job's PR: the area is cloned from this branch.
      const ahead = await git(checkout, "rev-list", "--count", `origin/${branch}..${branch}`).catch(() => "0");
      if (Number(ahead) > 0) throw new Error(`${branch} local tem ${ahead.trim()} commit(s) que não estão em origin/${branch}; eles iriam no PR do trabalho`);
      const behind = await git(checkout, "rev-list", "--count", `${branch}..origin/${branch}`).catch(() => "0");
      return Number(behind) > 0
        ? `ATENÇÃO: ${branch} local está ${behind.trim()} commit(s) atrás de origin/${branch}; atualize antes do piloto`
        : `branch ${branch} presente`;
    }),
  ];
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
  // The runtime profile is resolved on the host the way an admission would (ADR 0002): what it must carry
  // has to resolve inside the allowed roots. The check reports it and never links or repairs anything.
  const checkedProfiles = new Set<string>();
  for (const project of projects) {
    if (checkedProfiles.has(project.runtimeProfile)) continue;
    checkedProfiles.add(project.runtimeProfile);
    lines.push(await attempt(`perfil de runtime ${project.runtimeProfile}: obrigatórios resolvem no host`, async () => {
      const dir = resolveRuntimeProfile(project, local.profiles, resolveModelAuth(instance, config.credentials, local.profiles).agentDir);
      const profile = resolveRuntimeProfileDeclaration(project, dir, { runtimeProfiles: config.runtimeProfiles, allowedRoots: local.allowedRoots });
      const blockers = await checkRequired(profile.source, profile.declaration);
      if (blockers.length > 0) throw new Error(blockers.join("; "));
      const { required } = profile.declaration;
      return `${required.files.length} arquivo(s), ${required.skills.length} skill(s), ${required.agents.length} agent(s), ${required.packages.length} pacote(s)`;
    }));
  }
  // The triage of PR feedback needs its skill (issue #21), resolved the way the snapshot resolves it.
  for (const name of checkedProfiles) {
    const project = projects.find((candidate) => candidate.runtimeProfile === name)!;
    lines.push(await attempt(`perfil de runtime ${name} tem a skill ${TRIAGE_SKILL}`, async () => {
      const dir = resolveRuntimeProfile(project, local.profiles, resolveModelAuth(instance, config.credentials, local.profiles).agentDir);
      const { source } = resolveRuntimeProfileDeclaration(project, dir, { runtimeProfiles: config.runtimeProfiles, allowedRoots: local.allowedRoots });
      if (!(await resolves(source, skillPathOf(TRIAGE_SKILL)))) {
        throw new Error(`${skillPathOf(TRIAGE_SKILL)} não existe no perfil ${dir} ou o link sai das raízes permitidas; a triagem de comentários do PR não teria a skill (linke-a no perfil)`);
      }
      return skillPathOf(TRIAGE_SKILL);
    }));
  }
  // The state of the persistent toolchain of each profile (ADR 0004): read-only, never repaired. An
  // empty tree is the first invocation's business and is reported as such, not as a failure.
  for (const name of checkedProfiles) {
    lines.push(await attempt(`perfil de runtime ${name}: toolchain persistente`, async () => {
      const toolchain = profileToolchain(options.toolchainsDir, name);
      const state = await readToolchainState(toolchain);
      const packages = state.stamp === undefined
        ? "pacotes do Pi: ainda não convergidos (a primeira execução instala)"
        : `pacotes do Pi: selo ${state.stamp.slice(0, 12)}`;
      const tools = state.tools.length === 0
        ? "ferramentas do mise: nenhuma instalada ainda"
        : `ferramentas do mise: ${state.tools.join(", ")}`;
      const declaration = local.mise[name] === undefined
        ? "declaração de mise: não configurada em local.json"
        : `declaração de mise: ${local.mise[name]}`;
      return `${toolchain.base} (${packages}; ${tools}; ${declaration})`;
    }));
  }
  // The image the container runs in: without these the convergence could not run or the Pi probes
  // would download on every start. Read-only, one probe per tool.
  lines.push(await attempt("imagem do runner tem mise, ripgrep e fd", async () => {
    const missing: string[] = [];
    for (const tool of ["mise", "rg", "fd"]) {
      if (!(await sandbox.imageHas(local.image, tool))) missing.push(tool);
    }
    if (missing.length > 0) {
      throw new Error(`${missing.join(", ")} não existe(m) na imagem ${local.image}; reconstrua a imagem (src/runtime/docker-image)`);
    }
    return "mise, ripgrep e fd presentes";
  }));
  lines.push(await attempt("imagem do runner tem python3", async () => {
    if (!(await sandbox.imageHas(local.image, "python3"))) {
      throw new Error(`python3 não existe na imagem ${local.image}; a skill ${TRIAGE_SKILL} o exige (reconstrua a imagem)`);
    }
    return "python3 presente";
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
    if (!accounts.has(project.githubAccount)) {
      accounts.add(project.githubAccount);
      lines.push(await attempt(`Docker, imagem e token da conta ${project.githubAccount}`, async () => {
        await sandbox.preflight({ image: local.image, account: project.githubAccount });
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
