import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseConfig } from "../src/config/validate.js";

// The pilot template (issue #10, CA01, CA16): every target of spec §7 across the two instances.
async function template() {
  const text = (await readFile("docs/pilot/config.template.json", "utf8"))
    .replaceAll("__JIRA_OPERATOR_ACCOUNT_ID__", "operator-account-id")
    .replaceAll("__CON_DONE_TRANSITION__", "Itens concluídos");
  const parsed = parseConfig(JSON.parse(text));
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  return parsed.config;
}

test("the template loads and holds every target of spec §7 in the right instance", async () => {
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
  const text = await readFile("docs/pilot/config.template.json", "utf8");
  assert.deepEqual([...new Set(text.match(/__[A-Z_]+__/g))].sort(), ["__CON_DONE_TRANSITION__", "__JIRA_OPERATOR_ACCOUNT_ID__"]);
});
