import { projectEligibility } from "../config/project-eligibility.js";
import type { InstanceConfig, MsfConfig, ProjectConfig } from "../config/types.js";
import type { AdmissionDeps } from "../core/admission.js";
import { createGithubPrPort } from "../pr/github.js";
import { noopObserver, type Observer } from "../core/observability.js";
import { createDockerRunner, type SandboxBoundary } from "../runtime/docker-runner.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { createGhCliBoundary, GitHubTracker, type GitHubBoundary } from "../tracker/github.js";
import { JiraTracker, jiraConnectionFromEnv, type JiraTrackerSettings } from "../tracker/jira.js";
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

// One Jira adapter serves a project key. Projects that share a key (routing labels of VAN) must
// agree on the workflow settings: the adapter is per key, and a silent winner would be a guess.
function jiraRoutes(projects: ProjectConfig[], env: NodeJS.ProcessEnv): TrackerRoute[] {
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
  const connection = jiraConnectionFromEnv(env);
  return [...byKey.entries()].map(([key, { settings }]) => ({
    tracker: "jira" as const,
    project: key,
    port: new JiraTracker(connection, settings),
  }));
}

export function composeInstance(options: ComposeOptions): AdmissionDeps {
  const { config, instance, local } = options;
  const observer = options.observer ?? noopObserver;
  // Credentials the process holds are hidden from every log and history before they are written.
  for (const name of ["JIRA_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) observer.registerSecret((options.env ?? process.env)[name]);
  const projects = enabled(instance);
  const github = options.github ?? createGhCliBoundary();

  for (const project of projects) {
    if (!local.checkouts[project.repository]) {
      throw new Error(`checkout local de ${project.repository} não configurado (projeto ${project.name})`);
    }
  }

  const githubRoutes: TrackerRoute[] = projects.flatMap((project) => project.adapter === "github"
    ? [{
      tracker: "github" as const,
      project: project.repository,
      port: new GitHubTracker({ account: project.githubAccount, claimedLabel: project.labels.claimed, boundary: github }),
    }]
    : []);
  const tracker = routeTrackers([...githubRoutes, ...jiraRoutes(projects, options.env ?? process.env)]);

  const runner = createDockerRunner({
    instance,
    credentials: config.credentials,
    profiles: local.profiles,
    stateDir: options.stateDir,
    image: local.image,
    repositorySource: (project) => local.checkouts[project.repository]!,
    remoteUrl: (project) => `https://github.com/${project.repository}.git`,
    boundary: options.sandbox ?? sandcastleBoundary(),
    observer,
    // What the tracker shows about an issue, to confirm (or not) the writes the agent makes itself.
    issueEvidence: (ref) => async () => {
      const [snapshot, comments] = await Promise.all([tracker.readIssue(ref), tracker.readComments(ref)]);
      return {
        ...(snapshot.labels.known ? { labels: snapshot.labels.value } : {}),
        ...(snapshot.statusCategory.known ? { done: snapshot.statusCategory.value === "done" } : {}),
        commentIds: comments.map((comment) => comment.id),
      };
    },
  });

  const accountOf = new Map(projects.map((project) => [project.repository, project.githubAccount]));
  return {
    instance,
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
