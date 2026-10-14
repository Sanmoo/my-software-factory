import { projectEligibility } from "../config/project-eligibility.js";
import { join } from "node:path";
import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import type { AdmissionDeps } from "../core/admission.js";
import { createGithubPrPort } from "../pr/github.js";
import { noopObserver, type Observer } from "../core/observability.js";
import { messageOf } from "../core/values.js";
import { createDockerRunner, type SandboxBoundary } from "../runtime/docker-runner.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { createFileAssistAreaFs } from "../state/file-assist-area-fs.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { AssistedAttendance } from "../core/assist-flow.js";
import { AttentionKeeper } from "../core/attention.js";
import { createFileAttentionStore } from "../state/file-attention-store.js";
import { runtimeImageDirOf } from "../runtime/assist-exec.js";
import { createDesktopNotifier } from "../runtime/desktop-notify.js";
import { dockerExecProbe, dockerExecStop } from "../runtime/assist-exec-probe.js";
import { herdrBoundary } from "../runtime/herdr.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { createGhCliBoundary, GitHubTracker, type GitHubBoundary } from "../tracker/github.js";
import { JIRA_ENV_VARS, JiraConfigError, JiraTracker, jiraConnectionFromEnv, type JiraConnection, type JiraTrackerSettings } from "../tracker/jira.js";
import type { TrackerPort } from "../tracker/port.js";
import { routeTrackers, type TrackerRoute } from "../tracker/routing.js";
import type { LocalSettings } from "./local-settings.js";

// Composition root of one instance: builds the real adapters from the configuration and the
// local settings. It is the only place that knows which concrete tracker, PR and runtime
// implementations an instance runs with. Nothing here talks to the network when it builds.

export interface ComposeOptions {
  config: MsfConfig;
  instance: InstanceConfig;
  local: LocalSettings;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  // Boundaries are injectable for tests; the defaults are the real ones.
  github?: GitHubBoundary;
  sandbox?: SandboxBoundary;
  // Where operational events go: the main log and the local history (issue #15).
  observer?: Observer;
}

const enabled = (instance: InstanceConfig): ProjectConfig[] => instance.projects.filter((project) => project.enabled);

function jiraSettingsOf(project: Extract<ProjectConfig, { adapter: "jira" }>): JiraTrackerSettings {
  return {
    claimedLabel: project.labels.claimed,
    doingTransition: project.jira.doingTransition,
    doneTransition: project.jira.doneTransition,
    blockingLinkTypes: project.jira.blockingLinkTypes,
    ...(project.jira.priorityRanks ? { priorityRanks: project.jira.priorityRanks } : {}),
  };
}

// The Jira credentials come from the environment only. When they are missing the message is enough
// to fix it: the instance, the Jira projects and the variables to export.
function jiraConnectionOf(instance: InstanceConfig, projects: ProjectConfig[], env: NodeJS.ProcessEnv): JiraConnection {
  try {
    return jiraConnectionFromEnv(env);
  } catch (error) {
    if (!(error instanceof JiraConfigError)) throw error;
    const jira = projects.flatMap((project) => (project.adapter === "jira" ? [`${project.name} (${project.jira.projectKey})`] : []));
    throw new Error(
      `a instância ${instance.name} usa Jira (projetos: ${jira.join(", ")}) e ${error.message}; `
      + `exporte ${JIRA_ENV_VARS.join(", ")} no ambiente antes de iniciar a instância`,
    );
  }
}

// One Jira adapter serves a project key. Projects that share a key (routing labels of VAN) must
// agree on the workflow settings: the adapter is per key, and a silent winner would be a guess.
function jiraRoutes(instance: InstanceConfig, projects: ProjectConfig[], env: NodeJS.ProcessEnv): TrackerRoute[] {
  const byKey = new Map<string, { settings: JiraTrackerSettings; project: string }>();
  for (const project of projects) {
    if (project.adapter !== "jira") continue;
    const settings = jiraSettingsOf(project);
    const known = byKey.get(project.jira.projectKey);
    if (known && JSON.stringify(known.settings) !== JSON.stringify(settings)) {
      throw new Error(
        `projetos ${known.project} e ${project.name} compartilham a chave Jira ${project.jira.projectKey} com transições/labels diferentes`,
      );
    }
    if (!known) byKey.set(project.jira.projectKey, { settings, project: project.name });
  }
  if (byKey.size === 0) return [];
  const connection = jiraConnectionOf(instance, projects, env);
  return [...byKey.entries()].map(([key, { settings }]) => ({
    tracker: "jira" as const,
    project: key,
    port: new JiraTracker(connection, settings),
  }));
}

// Credentials the process holds, hidden from every log and history before they are written.
const SECRET_ENV_VARS = ["JIRA_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
export function registerSecrets(register: (secret: string | undefined) => void, env: NodeJS.ProcessEnv): void {
  for (const name of SECRET_ENV_VARS) register(env[name]);
}

function githubRoutes(projects: ProjectConfig[], github: GitHubBoundary): TrackerRoute[] {
  return projects.flatMap((project) => project.adapter === "github"
    ? [{
      tracker: "github" as const,
      project: project.repository,
      port: new GitHubTracker({ account: project.githubAccount, claimedLabel: project.labels.claimed, boundary: github }),
    }]
    : []);
}

// The trackers of an instance and nothing else: no checkout, no sandbox. It is what `status` needs;
// `composeInstance` builds on it. Jira trouble (missing credentials, projects that disagree) does not
// take the GitHub projects down: it is reported as the reason the Jira projects are unavailable.
export interface ComposedTrackers {
  tracker: TrackerPort;
  // Why the tracker of a project cannot be reached, when it is known before any call.
  unavailable(project: ProjectConfig): string | undefined;
}

export function composeTrackers(options: { instance: InstanceConfig; env?: NodeJS.ProcessEnv; github?: GitHubBoundary }): ComposedTrackers {
  const env = options.env ?? process.env;
  const projects = enabled(options.instance);
  const routes = githubRoutes(projects, options.github ?? createGhCliBoundary());
  try {
    return { tracker: routeTrackers([...routes, ...jiraRoutes(options.instance, projects, env)]), unavailable: () => undefined };
  } catch (error) {
    const reason = messageOf(error);
    return {
      tracker: routeTrackers(routes),
      unavailable: (project) => (project.adapter === "jira" ? reason : undefined),
    };
  }
}

export function composeInstance(options: ComposeOptions): AdmissionDeps & { assist: AssistedAttendance } {
  const { config, instance, local } = options;
  const observer = options.observer ?? noopObserver;
  registerSecrets((secret) => observer.registerSecret(secret), options.env ?? process.env);
  const projects = enabled(instance);

  for (const project of projects) {
    if (!local.checkouts[project.repository]) {
      throw new Error(`checkout local de ${project.repository} não configurado (projeto ${project.name})`);
    }
  }

  // The run needs every tracker: a Jira trouble stops the composition, as before.
  const composed = composeTrackers({ instance, ...(options.env === undefined ? {} : { env: options.env }), ...(options.github === undefined ? {} : { github: options.github }) });
  const trouble = projects.flatMap((project) => composed.unavailable(project) ?? []);
  if (trouble.length > 0) throw new Error(trouble[0]);
  const tracker = composed.tracker;

  const runner = createDockerRunner({
    instance,
    credentials: config.credentials,
    profiles: local.profiles,
    runtimeProfiles: config.runtimeProfiles,
    allowedRoots: local.allowedRoots,
    stateDir: options.stateDir,
    image: local.image,
    repositorySource: (project) => local.checkouts[project.repository]!,
    remoteUrl: (project) => `https://github.com/${project.repository}.git`,
    boundary: options.sandbox ?? sandcastleBoundary(),
    observer,
    // The tracker reader the runner hands to the agent write watch: the evidence by which a write
    // the agent makes on its own issue can be confirmed.
    tracker,
  });

  // The operator attention (ticket #59): persistent pendings in `pendencias/` plus the
  // best-effort desktop channel from the local settings. When the channel is disabled (or its
  // command is absent for the platform) the keeper records the absent channel on each pending —
  // it never presumes the Herdr notification reaches the desktop.
  const notify = local.notifications?.enabled === false
    ? undefined
    : createDesktopNotifier({ platform: process.platform, ...(local.notifications?.command === undefined ? {} : { command: local.notifications.command }) });
  const attention = new AttentionKeeper({
    store: createFileAttentionStore(join(options.stateDir, "pendencias")),
    ...(notify === undefined ? {} : { notify }),
    observer,
  });

  // A second flow of the same loop: the human-assisted attendance, with its own capacity (spec
  // #48, #54). It shares the tracker and the observer, and counts its own sessions.
  const attendances = new AssistedAttendance({
    instance, config, local, tracker,
    jobs: createFileJobStore(options.stateDir),
    sessions: createFileAssistSessionStore(join(options.stateDir, "assist-sessions")),
    // The fs authority of the assisted session areas (spec #48): exit-record channel, pi session
    // texts, area directories and attempt identities, all real host files under the state dir.
    areaFs: createFileAssistAreaFs(),
    commands: createFileCommandQueue(options.stateDir),
    control: createFileInstanceControl(options.stateDir),
    eligibility: (project) => projectEligibility(instance, project),
    observer,
    ports: {
      sandbox: options.sandbox ?? sandcastleBoundary(),
      herdr: herdrBoundary(),
      // The real-execution probe of the post-restart reconciliation (ticket #58): docker inspect
      // by the recorded container name, daemon reachability judged in the same look.
      exec: dockerExecProbe(),
      // The identity reclaim of the exec (ticket #56): a gone tab makes the supervision
      // request the stop itself (docker rm -f by the recorded name) and verify it before
      // anything is freed (#52: closing the tab does not stop the exec).
      stopExec: dockerExecStop(),
    },
    runtimeImageDir: runtimeImageDirOf(),
    stateDir: options.stateDir,
    attention,
  });

  const accountOf = new Map(projects.map((project) => [project.repository, project.githubAccount]));
  return {
    // The assisted flow rides the same polling cycle; run.ts drains both loops. It also
    // answers the operator commands that name an assisted session (ticket #56), so the command
    // queue keeps a single drain in the admission.
    assist: attendances,
    assistOperator: attendances,
    instance,
    attention,
    tracker,
    runner,
    store: createFileJobStore(options.stateDir),
    commands: createFileCommandQueue(options.stateDir),
    control: createFileInstanceControl(options.stateDir),
    prs: createGithubPrPort({
      accountOf: (repository) => {
        const account = accountOf.get(repository);
        if (!account) throw new Error(`repositório ${repository} não é de nenhum projeto da instância`);
        return account;
      },
    }),
    eligibility: (project) => projectEligibility(instance, project),
    observer,
  };
}
