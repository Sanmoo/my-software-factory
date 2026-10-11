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
  assert.deepEqual(work.projects.map((project) => project.name),
    ["dora-metrics", "revolving-monolith-backend", "revolving-dealer-services"]);
  assert.deepEqual(personal.projects.map((project) => project.name), ["my-tasks"]);
  assert.equal(work.maxConcurrent, 1);
  assert.equal(personal.maxConcurrent, 2);
  assert.equal(personal.pollIntervalSeconds, 600);
});

type Raw = Record<string, any>; // mutable JSON fixture copy for error-case tests
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
