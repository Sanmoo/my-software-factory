import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";

const fixture = async (): Promise<InstanceConfig[]> => {
  const path = fileURLToPath(new URL("./fixtures/instances.json", import.meta.url));
  const result = parseConfig(JSON.parse(await readFile(path, "utf8")));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config.instances;
};

test("a Jira project is eligible only in the open sprint and assigned to the operator, on top of the core rules", async () => {
  const [work] = await fixture();
  const setup = projectEligibility(work!, work!.projects.find((project) => project.name === "revolving-monolith-backend")!);
  const names = setup.rules.map((rule) => rule.name);
  assert.ok(names.includes("sprint-atual"));
  assert.ok(names.includes("assignee-operador"));
  assert.ok(names.includes("not-claimed"));
});

test("a GitHub project gets the core rules only, with no Jira rule", async () => {
  const [work] = await fixture();
  const setup = projectEligibility(work!, work!.projects.find((project) => project.name === "dora-metrics")!);
  const names = setup.rules.map((rule) => rule.name);
  assert.ok(!names.includes("sprint-atual"));
  assert.ok(!names.includes("assignee-operador"));
  assert.deepEqual(names, ["enabled", "ready", "routing", "not-claimed", "no-blockers", "not-terminal", "not-tracked"]);
});

test("the scope is the repository of a GitHub project and the project key of a Jira project", async () => {
  const [work] = await fixture();
  const github = projectEligibility(work!, work!.projects.find((project) => project.name === "dora-metrics")!);
  const jira = projectEligibility(work!, work!.projects.find((project) => project.name === "revolving-monolith-backend")!);
  assert.deepEqual(github.scope, { project: "samuel-santos_bjd/dora-metrics", readyLabel: "ready-for-agent" });
  assert.deepEqual(jira.scope, { project: "VAN", readyLabel: "ready-for-agent" });
});

test("a Jira project routes by the labels of its project key in the instance; a GitHub project routes by repository", async () => {
  const [work] = await fixture();
  const github = projectEligibility(work!, work!.projects.find((project) => project.name === "dora-metrics")!);
  const jira = projectEligibility(work!, work!.projects.find((project) => project.name === "revolving-monolith-backend")!);
  assert.deepEqual(github.project.routing, { kind: "repository" });
  assert.deepEqual(jira.project.routing, {
    kind: "label",
    routingLabel: "monolith",
    knownLabels: ["monolith", "dealer-services", "mfe", "fdm", "common-infra", "lambda-auth", "playbooks"],
  });
});
