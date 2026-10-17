import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseConfig } from "../src/config/validate.js";
import { parseYamlDocument } from "../src/config/yaml.js";

// The pilot template (issue #10): every configured target across the two instances.
async function yamlOfText(text: string): Promise<unknown> {
  const parsed = parseYamlDocument(text);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed.ok ? parsed.value : undefined;
}

async function yamlOf(path: string): Promise<unknown> {
  const parsed = parseYamlDocument(await readFile(path, "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed.ok ? parsed.value : undefined;
}

async function template() {
  const text = (await readFile("docs/pilot/config.template.yaml", "utf8"))
    .replaceAll("__JIRA_OPERATOR_ACCOUNT_ID__", "operator-account-id")
    .replaceAll("__CON_DONE_TRANSITION__", "Itens concluídos");
  const parsed = parseConfig((await yamlOfText(text)));
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  return parsed.config;
}

test("the template loads and holds every configured target in the right instance", async () => {
  const config = await template();
  const byName = new Map(config.instances.map((instance) => [instance.name, instance]));
  const personal = byName.get("pessoal")!;
  const work = byName.get("trabalho")!;
  assert.deepEqual(personal.projects.map((p) => p.repository).sort(), [
    "Sanmoo/lorebase-backend", "Sanmoo/lorebase-frontend", "Sanmoo/my-finances", "Sanmoo/my-software-factory", "Sanmoo/my-tasks",
  ]);
  assert.ok(personal.projects.every((p) => p.adapter === "github" && p.githubAccount === "Sanmoo"));
  assert.equal(work.projects.length, 11);
  assert.deepEqual(
    work.projects.filter((p) => p.adapter === "jira").map((p) => p.adapter === "jira" ? `${p.jira.projectKey}/${p.jira.routingLabel}` : "").sort(),
    ["CON/mfe", "CON/monolith", "CON/playbooks", "VAN/common-infra", "VAN/dealer-services", "VAN/fdm", "VAN/lambda-auth",
      "VAN/mfe", "VAN/monolith", "VAN/playbooks"],
  );
  assert.ok(work.projects.every((p) => p.githubAccount === "samuel-santos_bjd" && p.enabled));
});

test("the work and personal model auths are separate references", async () => {
  const config = await template();
  assert.deepEqual(config.instances.map((i) => i.modelAuth).sort(), ["PI_AUTH_PESSOAL", "PI_AUTH_TRABALHO"]);
  assert.notEqual(config.credentials.PI_AUTH_PESSOAL!.ref, config.credentials.PI_AUTH_TRABALHO!.ref);
});

test("the template carries placeholders only where the operator must supply a value", async () => {
  const text = await readFile("docs/pilot/config.template.yaml", "utf8");
  assert.deepEqual([...new Set(text.match(/__[A-Z_]+__/g))].sort(), ["__CON_DONE_TRANSITION__", "__JIRA_OPERATOR_ACCOUNT_ID__"]);
});

test("the template declares the initial runtime profile for every profile a project names, the same for both", async () => {
  const config = await template();
  const initial = {
    required: {
      files: ["settings.json", "auth.json"], packages: ["npm:pi-subagents"],
      skills: ["implement", "tdd", "code-review", "gh-address-comments"],
      agents: ["implementer", "code-reviewer", "spec-reviewer"],
      tools: ["rtk"],
    },
    excludePackages: ["npm:pi-lens"],
  };
  const named = new Set(config.instances.flatMap((instance) => instance.projects.map((project) => project.runtimeProfile)));
  assert.deepEqual([...named].sort(), ["pessoal", "trabalho"]);
  for (const name of named) assert.deepEqual(config.runtimeProfiles[name], initial, name);
});

test("the documented example declares the runtime profile its projects name", async () => {
  const parsed = parseConfig(await yamlOf("docs/config.example.yaml"));
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  const named = new Set(parsed.config.instances.flatMap((instance) => instance.projects.map((project) => project.runtimeProfile)));
  for (const name of named) assert.ok(parsed.config.runtimeProfiles[name], `${name} is declared`);
});
