/**
 * The public entry of the experiment: `npm run run` (or `node dist/run.js`).
 * It prints the protocol × read-model matrix and every concrete scenario, and
 * writes the same evidence as JSON under the experiment's ignored `runs/` dir.
 * The JSON carries one example trace per outcome per cell, not every explored
 * trace. Nothing here talks to GitHub or to the factory: this is a
 * deterministic model, and its premises are the report's subject.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exploreAll, progress, READ_PROFILES, safe, verdict, type ExploreResult } from "./explorer.js";
import { PROTOCOLS } from "./protocols.js";
import { SCENARIOS, type ScenarioResult } from "./scenarios.js";

type Cells = ReadonlyMap<string, ExploreResult>;

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function cellsOf(results: readonly ExploreResult[]): Cells {
  return new Map(results.map((entry) => [`${entry.protocol}/${entry.profile}`, entry]));
}

function renderMatrix(cells: Cells): string[] {
  const out: string[] = [];
  out.push("## Matriz: protocolo × modelo de leitura");
  out.push("");
  out.push(`Perfis: ${READ_PROFILES.map((profile) => profile.name).join(", ")}`);
  out.push("");
  const header = ["protocolo", ...READ_PROFILES.map((profile) => profile.name)];
  out.push(`| ${header.join(" | ")} |`);
  out.push(`|${header.map(() => "---").join("|")}|`);
  for (const protocol of PROTOCOLS) {
    const row = READ_PROFILES.map((profile) => {
      const result = cells.get(`${protocol.name}/${profile.name}`);
      if (result === undefined) throw new Error(`missing matrix cell: ${protocol.name}/${profile.name}`);
      return verdict(result);
    });
    out.push(`| ${protocol.name} | ${row.join(" | ")} |`);
  }
  out.push("");
  for (const protocol of PROTOCOLS) {
    const risky = READ_PROFILES.filter((profile) => {
      const result = cells.get(`${protocol.name}/${profile.name}`);
      return result !== undefined && safe(result) && progress(result);
    }).map((profile) => profile.name);
    out.push(
      `${protocol.name}: exclusividade+progresso apenas em [${
        risky.join(", ") || "nenhum"
      }]`,
    );
  }
  return out;
}

function renderScenarios(results: readonly ScenarioResult[]): string[] {
  const out: string[] = [];
  out.push("");
  out.push("## Cenários");
  for (const result of results) {
    out.push("");
    out.push(`### ${result.name}`);
    out.push(result.expectation);
    out.push("```json");
    out.push(JSON.stringify(result.observations, null, 2));
    out.push("```");
  }
  return out;
}

function main(): void {
  const results = exploreAll(PROTOCOLS);
  const cells = cellsOf(results);
  const scenarios = SCENARIOS.map((scenario) => scenario.run());
  const evidence = {
    producedBy: "experiments/issue-168",
    profiles: READ_PROFILES.map((profile) => ({
      name: profile.name,
      summary: profile.summary,
      idOrder: profile.idOrder,
    })),
    protocols: PROTOCOLS.map((protocol) => ({
      name: protocol.name,
      summary: protocol.summary,
    })),
    matrix: results,
    scenarios,
  };

  line("# Experimento #168 — Claim exclusivo entre fábricas pelo GitHub Issues");
  line("");
  line("Modelo determinístico: duas instâncias independentes, tracker como único meio.");
  line("Este harness NÃO fala com o GitHub real; ver RELATORIO.md para as premissas.");
  line("");
  for (const text of renderMatrix(cells)) line(text);
  for (const text of renderScenarios(scenarios)) line(text);

  const runs = resolve(process.cwd(), "runs");
  mkdirSync(runs, { recursive: true });
  const path = resolve(runs, "evidence.json");
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  line("");
  line(`Evidência escrita em ${path}`);
}

main();
