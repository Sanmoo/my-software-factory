import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialRef, InstanceConfig, ProjectConfig } from "../src/config/types.js";
import {
  findProject,
  requireRunModels,
  resolveModelAuth,
  resolveRuntimeProfile,
  RunnerConfigError,
} from "../src/runtime/docker-config.js";

const models = {
  implementer: "github-copilot/gpt-6-luna",
  "reviewer-standards": "github-copilot/gpt-6-luna",
  "reviewer-spec": "github-copilot/gpt-6-luna",
  default: "github-copilot/gpt-6-luna",
};

const github = (overrides: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: "app",
  enabled: true,
  adapter: "github",
  repository: "acme/app",
  targetBranch: "main",
  prIntegration: "github.com",
  runtimeProfile: "personal",
  githubAccount: "acme-bot",
  labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
  models: { ...models },
  ...overrides,
} as ProjectConfig);

const jira = (projectKey: string, routingLabel: string): ProjectConfig => ({
  name: `jira-${routingLabel}`,
  enabled: true,
  adapter: "jira",
  repository: `acme/${routingLabel}`,
  targetBranch: "main",
  prIntegration: "github.com",
  runtimeProfile: "personal",
  githubAccount: "acme-bot",
  labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
  models: { ...models },
  jira: {
    projectKey, routingLabel, doingTransition: "Doing", doneTransition: "Done",
    blockingLinkTypes: [], credential: "JIRA", operator: "operator",
  },
});

const instance = (projects: ProjectConfig[]): InstanceConfig => ({
  name: "personal", maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 5,
  modelAuth: "MODEL_AUTH", projects,
});

const credentials: Record<string, CredentialRef> = {
  MODEL_AUTH: { kind: "pi-auth", ref: "PI_AUTH" },
  JIRA: { kind: "env", ref: "JIRA_TOKEN" },
};

test("every model role must be configured explicitly, and a missing one is named", () => {
  assert.deepEqual(requireRunModels(github()), models);
  const { "reviewer-spec": _omitted, ...withoutSpec } = models;
  assert.throws(
    () => requireRunModels(github({ models: withoutSpec } as Partial<ProjectConfig>)),
    (error: unknown) => error instanceof RunnerConfigError && /reviewer-spec/.test(error.message),
  );
});

test("a blank model is an error, never replaced by another model", () => {
  assert.throws(
    () => requireRunModels(github({ models: { ...models, default: "  " } } as Partial<ProjectConfig>)),
    /default/,
  );
});

test("the model auth is a configured pi-auth reference with a profile on this host, otherwise a visible error", () => {
  assert.deepEqual(
    resolveModelAuth(instance([github()]), credentials, { PI_AUTH: "/home/op/.pi/agent" }),
    { ref: "PI_AUTH", agentDir: "/home/op/.pi/agent" },
  );
  assert.throws(
    () => resolveModelAuth(instance([github()]), credentials, {}),
    /PI_AUTH.*sem fallback/,
  );
  assert.throws(
    () => resolveModelAuth({ ...instance([github()]), modelAuth: "NOPE" }, credentials, { PI_AUTH: "/x" }),
    /referência NOPE não existe/,
  );
  assert.throws(
    () => resolveModelAuth({ ...instance([github()]), modelAuth: "JIRA" }, credentials, { PI_AUTH: "/x" }),
    /deve ser pi-auth/,
  );
});

test("the container profile must be the same directory as the instance's model auth", () => {
  const profiles = { PI_AUTH: "/home/op/.pi/agent", personal: "/home/op/.pi/agent", work: "/home/op/.pi/work" };
  assert.equal(resolveRuntimeProfile(github(), profiles, "/home/op/.pi/agent"), "/home/op/.pi/agent");
  assert.throws(
    () => resolveRuntimeProfile(github({ runtimeProfile: "work" }), profiles, "/home/op/.pi/agent"),
    /perfil work .* autenticação da instância/,
  );
  assert.throws(
    () => resolveRuntimeProfile(github({ runtimeProfile: "missing" }), profiles, "/home/op/.pi/agent"),
    /perfil missing não configurado/,
  );
});

test("a ref resolves to exactly one configured project: repository for GitHub, project key for Jira", () => {
  const projects = [github(), jira("VAN", "monolith"), jira("VAN", "mfe"), jira("CON", "mfe")];
  assert.equal(findProject(projects, { tracker: "github", project: "acme/app", id: "1" }).name, "app");
  assert.throws(() => findProject(projects, { tracker: "jira", project: "VAN", id: "9" }), /ambíguo/);
  assert.equal(findProject(projects, { tracker: "jira", project: "CON", id: "9" }).name, "jira-mfe");
  assert.throws(() => findProject(projects, { tracker: "github", project: "acme/other", id: "1" }), /não configurado/);
});

test("the repository of the job picks the project when several Jira projects share a key", () => {
  const projects = [jira("VAN", "monolith"), jira("VAN", "mfe")];
  const ref = { tracker: "jira" as const, project: "VAN", id: "9" };
  assert.equal(findProject(projects, ref, "acme/mfe").name, "jira-mfe");
  assert.throws(() => findProject(projects, ref, "acme/unknown"), /não configurado/);
  assert.throws(() => findProject(projects, { ...ref, project: "CON" }, "acme/mfe"), /não configurado/);
});
