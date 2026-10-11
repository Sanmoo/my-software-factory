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
  pollIntervalSeconds: number;
  maxIterations: number;
  modelAuth: string;
  projects: ProjectConfig[];
}

export interface MsfConfig {
  credentials: Record<string, CredentialRef>;
  instances: InstanceConfig[];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: MsfConfig }
  | { ok: false; issues: ConfigIssue[] };
