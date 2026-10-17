// Configuration model for instances and projects. Credentials are references
// by name only; no field here holds a secret value.

export const MODEL_ROLES = ["implementer", "reviewer-standards", "reviewer-spec", "default"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type CredentialKind = "env" | "pi-auth";

export interface CredentialRef {
  kind: CredentialKind;
  ref: string;
}

export interface JiraSettings {
  projectKey: string;
  routingLabel: string;
  doingTransition: string;
  doneTransition: string;
  blockingLinkTypes: string[];
  credential: string;
  operator: string;
  // Optional ranking of the Jira priority names of this project: lower number = more urgent.
  // Absent, the adapter's default table applies.
  priorityRanks?: Record<string, number>;
}

export interface ProjectLabels {
  ready: string;
  claimed: string;
}

interface ProjectCommon {
  name: string;
  enabled: boolean;
  repository: string;
  targetBranch: string;
  prIntegration: "github.com";
  runtimeProfile: string;
  githubAccount: string;
  labels: ProjectLabels;
  models: Record<ModelRole, string>;
}

export type ProjectConfig =
  | (ProjectCommon & { adapter: "github" })
  | (ProjectCommon & { adapter: "jira"; jira: JiraSettings });

export interface InstanceConfig {
  name: string;
  maxConcurrent: number;
  // Human-assisted sessions limit (spec #48): the second independent N, next to maxConcurrent.
  // Optional until now: absent, the assisted diagnosis reports it as not configured and the
  // opening of sessions is blocked; no default limit is invented.
  maxAssisted?: number;
  // The explicit model of the human-assisted attendance, provider/model. Configured per
  // instance and never inherited from the implementation models: absent, the diagnosis
  // reports it as not configured.
  assistModel?: string;
  pollIntervalSeconds: number;
  maxIterations: number;
  modelAuth: string;
  projects: ProjectConfig[];
}

// What a runtime profile must carry for a job to run (ADR 0002). Names, not paths: where they come
// from is the machine's business (local settings). Without a required item the job is not admitted.
export interface RuntimeProfileConfig {
  required: {
    files: string[]; // files at the root of the profile, e.g. settings.json
    packages: string[]; // Pi package sources the profile's settings.json must list, e.g. npm:pi-subagents
    skills: string[]; // skills/<name>/SKILL.md
    agents: string[]; // agents/<name>.md
    tools: string[]; // tool names the operator declares in mise and the container must find on PATH, e.g. rtk
  };
  // Package sources dropped from the container's copy of settings.json (never from the host's).
  excludePackages: string[];
}

export interface MsfConfig {
  credentials: Record<string, CredentialRef>;
  // Declaration of each runtime profile a project may name; a project naming one without it is an error.
  runtimeProfiles: Record<string, RuntimeProfileConfig>;
  instances: InstanceConfig[];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: MsfConfig }
  | { ok: false; issues: ConfigIssue[] };
