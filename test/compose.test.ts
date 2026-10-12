import assert from "node:assert/strict";
import test from "node:test";
import { composeInstance } from "../src/cli/compose.js";
import { parseLocalSettings } from "../src/cli/local-settings.js";
import { parseConfig } from "../src/config/validate.js";
import type { GitHubBoundary } from "../src/tracker/github.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";

const MODEL = "github-copilot/gpt-6-luna";
const models = { implementer: MODEL, "reviewer-standards": MODEL, "reviewer-spec": MODEL, default: MODEL };
const common = { enabled: true, targetBranch: "main", prIntegration: "github.com", runtimeProfile: "work",
  githubAccount: "acme-bot", labels: { ready: "ready-for-agent", claimed: "agent-claimed" }, models };
const jira = (routingLabel: string, doneTransition = "Done") => ({
  ...common, name: `van-${routingLabel}`, adapter: "jira", repository: `acme/${routingLabel}`,
  jira: { projectKey: "VAN", routingLabel, doingTransition: "Doing", doneTransition, blockingLinkTypes: ["Blocks"],
    credential: "JIRA", operator: "op-1" },
});
const rawConfig = (projects: unknown[]) => ({
  credentials: { MODEL: { kind: "pi-auth", ref: "work" }, JIRA: { kind: "env", ref: "JIRA_API_TOKEN" } },
  instances: [{ name: "work", maxConcurrent: 1, pollIntervalSeconds: 60, maxIterations: 5, modelAuth: "MODEL", projects }],
});

const github: GitHubBoundary = { accountToken: async () => "t", api: async () => ({ status: 200, body: [] }) };
const sandbox: SandboxBoundary = { preflight: async () => ({ token: "t" }), imageHas: async () => true, run: async () => { throw new Error("unused"); } };
const env = { JIRA_URL: "https://x.atlassian.net", JIRA_USERNAME: "u", JIRA_API_TOKEN: "t" };

function build(projects: unknown[], over: { env?: NodeJS.ProcessEnv; checkouts?: Record<string, string> } = {}) {
  const parsed = parseConfig(rawConfig(projects));
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  const instance = parsed.config.instances[0]!;
  const checkouts = over.checkouts ?? Object.fromEntries(instance.projects.map((p) => [p.repository, `/src/${p.repository}`]));
  const local = parseLocalSettings({ profiles: { work: "/home/op/.pi/agent" }, checkouts });
  assert.ok(typeof local !== "string", String(local));
  return () => composeInstance({ config: parsed.config, instance, local, stateDir: "/tmp/msf-compose-test", env: over.env ?? env, github, sandbox });
}

const ghProject = { ...common, name: "dora", adapter: "github", repository: "acme/dora" };

test("one instance mixes a GitHub repository and several Jira projects of the same key", () => {
  const deps = build([ghProject, jira("monolith"), jira("mfe")])();
  assert.equal(deps.instance.name, "work");
  assert.equal(typeof deps.tracker.discoverCandidates, "function");
});

test("projects sharing a Jira key must agree on the workflow", () => {
  assert.throws(build([jira("monolith"), jira("mfe", "Itens concluídos")]), /compartilham a chave Jira VAN/);
});

test("a project without a local checkout is refused before anything runs", () => {
  assert.throws(build([ghProject], { checkouts: {} }), /checkout local de acme\/dora não configurado/);
});

test("Jira projects need the Jira environment; GitHub-only instances do not", () => {
  assert.throws(build([jira("monolith")], { env: {} }), /JIRA_URL/);
  assert.doesNotThrow(build([ghProject], { env: {} }));
});

test("local settings must use absolute paths and say what is wrong", () => {
  assert.match(String(parseLocalSettings({ profiles: { a: "rel" }, checkouts: {} })), /profiles\.a .* absoluto/);
  assert.match(String(parseLocalSettings({ profiles: {} })), /checkouts deve ser um objeto/);
});
