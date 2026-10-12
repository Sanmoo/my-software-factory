import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseConfig } from "../src/config/validate.js";
import { loadConfigFile } from "../src/config/load.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("loads two instances (work and personal) with their projects", async () => {
  const result = await loadConfigFile(fixture("instances.json"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const names = result.config.instances.map((instance) => instance.name);
  assert.deepEqual(names, ["trabalho", "pessoal"]);
  const [work, personal] = result.config.instances;
  assert.deepEqual(work.projects.map((project) => project.name), [
    "dora-metrics", "revolving-monolith-backend", "revolving-dealer-services", "revolving-mfe",
    "revolving-fdm", "revolving-common-infra", "revolving-lambda-auth", "revolving-playbooks",
    "consorcio-monolith-backend", "consorcio-mfe", "consorcio-playbooks",
  ]);
  assert.deepEqual(personal.projects.map((project) => project.name),
    ["my-tasks", "my-software-factory", "my-finances", "lorebase-frontend", "lorebase-backend"]);
  assert.equal(work.maxConcurrent, 1);
  assert.equal(personal.maxConcurrent, 2);
  assert.equal(personal.pollIntervalSeconds, 600);
});

// The configured targets of spec section 7, written out from the spec (not derived from the fixture).
const SECTION_7: Array<[string, string, string]> = [
  ["pessoal", "github", "Sanmoo/my-tasks"],
  ["pessoal", "github", "Sanmoo/my-software-factory"],
  ["pessoal", "github", "Sanmoo/my-finances"],
  ["pessoal", "github", "Sanmoo/lorebase-frontend"],
  ["pessoal", "github", "Sanmoo/lorebase-backend"],
  ["trabalho", "github", "samuel-santos_bjd/dora-metrics"],
  ["trabalho", "VAN/monolith", "bancojohndeere/revolving-credit-monolith-backend"],
  ["trabalho", "VAN/dealer-services", "bancojohndeere/revolving-credit-dealer-services"],
  ["trabalho", "VAN/mfe", "bancojohndeere/revolving-credit-mfe"],
  ["trabalho", "VAN/fdm", "bancojohndeere/revolving-credit-fiscal-document-management"],
  ["trabalho", "VAN/common-infra", "bancojohndeere/revolving-credit-products-common-infra"],
  ["trabalho", "VAN/lambda-auth", "bancojohndeere/revolving-credit-multi-issuer-lambda-authorizer"],
  ["trabalho", "VAN/playbooks", "bancojohndeere/revolving-credit-playbooks"],
  ["trabalho", "CON/monolith", "bancojohndeere/consorcio-monolith-backend"],
  ["trabalho", "CON/mfe", "bancojohndeere/consorcio-mfe"],
  ["trabalho", "CON/playbooks", "bancojohndeere/consorcio-playbooks"],
];

test("the fixture carries all 16 targets of spec section 7: 5 personal and 11 work, Jira and GitHub", async () => {
  const result = await loadConfigFile(fixture("instances.json"));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  if (!result.ok) return;
  const targets = result.config.instances.flatMap((instance) => instance.projects.map((project) => {
    if (project.adapter === "github") return [instance.name, "github", project.repository];
    return [instance.name, `${project.jira.projectKey}/${project.jira.routingLabel}`, project.repository];
  }));
  assert.equal(targets.length, 16);
  assert.deepEqual(targets.filter(([instance]) => instance === "pessoal").length, 5);
  assert.deepEqual(targets.filter(([instance]) => instance === "trabalho").length, 11);
  const sorted = (rows: string[][]) => rows.map((row) => row.join(" ")).sort();
  assert.deepEqual(sorted(targets), sorted(SECTION_7));
});

// oxlint-disable-next-line typescript/no-explicit-any -- error-case tests deliberately mutate arbitrary JSON fixture shapes
type Raw = Record<string, any>;
const readRaw = async (): Promise<Raw> => JSON.parse(await readFile(fixture("instances.json"), "utf8"));
const parse = async (mutate: (raw: Raw) => void) => {
  const raw = await readRaw();
  mutate(raw);
  return parseConfig(raw);
};
const messages = (result: Awaited<ReturnType<typeof parseConfig>>) =>
  result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);

test("a project configured in two instances is a visible error", async () => {
  const result = await parse((raw) => {
    raw.instances[1].projects.push({ ...raw.instances[0].projects[0], name: "dora-copy" });
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /samuel-santos_bjd\/dora-metrics.*trabalho.*pessoal|pessoal.*trabalho/);
});

test("an agentic role without a model is a visible error", async () => {
  const result = await parse((raw) => {
    delete raw.instances[0].projects[0].models["reviewer-spec"];
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /dora-metrics.*models.*reviewer-spec/);
});

test("a project without the default model is a visible error", async () => {
  const result = await parse((raw) => {
    delete raw.instances[0].projects[0].models.default;
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /models\.default.*ausente|default.*ausente/);
});

test("a model reference without explicit provider/model is a visible error", async () => {
  const result = await parse((raw) => {
    raw.instances[0].projects[0].models.implementer = "gpt-6-luna";
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /implementer.*provider\/model/);
});

test("an undeclared credential reference is a visible error", async () => {
  const result = await parse((raw) => {
    raw.instances[0].projects[1].jira.credential = "jira-missing";
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /jira-missing.*não declarada/);
});

test("a credential reference of the wrong kind is a visible error", async () => {
  const result = await parse((raw) => {
    raw.instances[0].modelAuth = "jira-van";
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /modelAuth.*jira-van.*pi-auth/);
});

test("credential entries cannot carry values", async () => {
  const result = await parse((raw) => {
    raw.credentials["copilot-trabalho"].token = "ghp_example";
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /token.*campo desconhecido/);
});

test("a Jira project without routing label or operator is a visible error", async () => {
  const result = await parse((raw) => {
    delete raw.instances[0].projects[1].jira.routingLabel;
    delete raw.instances[0].projects[1].jira.operator;
  });
  assert.equal(result.ok, false);
  const text = messages(result).join("\n");
  assert.match(text, /routingLabel/);
  assert.match(text, /operator/);
});

test("a GitHub project cannot carry Jira settings", async () => {
  const result = await parse((raw) => {
    raw.instances[0].projects[0].jira = raw.instances[0].projects[1].jira;
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /bloco jira só é válido com adapter jira/);
});

test("non-positive or non-integer instance limits are visible errors", async () => {
  const result = await parse((raw) => {
    raw.instances[0].maxConcurrent = 0;
    raw.instances[1].pollIntervalSeconds = 1.5;
    raw.instances[1].maxIterations = "5";
  });
  assert.equal(result.ok, false);
  const text = messages(result).join("\n");
  assert.match(text, /maxConcurrent/);
  assert.match(text, /pollIntervalSeconds/);
  assert.match(text, /maxIterations/);
});

test("the documented example configuration validates and carries no credential values", async () => {
  const path = fileURLToPath(new URL("../docs/config.example.json", import.meta.url));
  const result = await loadConfigFile(path);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /ghp_|github_pat_|token"\s*:/i);
});

test("projects without label overrides use the default ready and claimed labels", async () => {
  const result = await loadConfigFile(fixture("instances.json"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const project of result.config.instances.flatMap((instance) => instance.projects)) {
    assert.deepEqual(project.labels, { ready: "ready-for-agent", claimed: "agent-claimed" });
  }
});

test("a Jira project may carry a priority rank map: names are non-empty and ranks positive integers", async () => {
  const valid = await parse((raw) => {
    raw.instances[0].projects[1].jira.priorityRanks = { Blocker: 1, Highest: 2 };
  });
  assert.equal(valid.ok, true, messages(valid).join("\n"));
  if (valid.ok) {
    const jira = valid.config.instances[0]!.projects[1]!;
    assert.ok(jira.adapter === "jira" && jira.jira.priorityRanks?.Blocker === 1);
  }

  const invalid = await parse((raw) => {
    raw.instances[0].projects[1].jira.priorityRanks = { Blocker: 0, Highest: 1.5, "": 2 };
  });
  assert.equal(invalid.ok, false);
  const text = messages(invalid).join("\n");
  assert.match(text, /priorityRanks\.Blocker.*inteiro positivo/);
  assert.match(text, /priorityRanks\.Highest.*inteiro positivo/);
  assert.match(text, /priorityRanks.*nome de prioridade vazio/);
});

test("a GitHub project cannot carry a priority rank map", async () => {
  const result = await parse((raw) => {
    raw.instances[0].projects[0].priorityRanks = { Blocker: 1 };
  });
  assert.equal(result.ok, false);
  assert.match(messages(result).join("\n"), /priorityRanks.*campo desconhecido/);
});

test("the documented example names the Jira operator as an accountId placeholder, not an e-mail", async () => {
  const path = fileURLToPath(new URL("../docs/config.example.json", import.meta.url));
  const raw = JSON.parse(await readFile(path, "utf8"));
  const operators = raw.instances.flatMap((instance: { projects: Array<{ jira?: { operator: string } }> }) =>
    instance.projects.flatMap((project) => (project.jira ? [project.jira.operator] : [])));
  assert.ok(operators.length > 0, "the example has a Jira project");
  for (const operator of operators) {
    assert.match(operator, /ACCOUNT_ID/, "placeholder names the Jira accountId");
    assert.doesNotMatch(operator, /@/, "not an e-mail");
  }
});

test("the Jira project of the fixture uses the done transition confirmed by the conformance report (007)", async () => {
  const result = await loadConfigFile(fixture("instances.json"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const van = result.config.instances.flatMap((instance) => instance.projects)
    .filter((project) => project.adapter === "jira" && project.jira.projectKey === "VAN");
  assert.ok(van.length > 0);
  for (const project of van) {
    assert.ok(project.adapter === "jira" && project.jira.doneTransition === "Itens concluídos");
  }
});
