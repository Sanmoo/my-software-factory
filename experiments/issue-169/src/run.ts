import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exploreAll } from "./explorer.js";
import { runScenarios } from "./scenarios.js";
import { ACCESSED, OPENAPI_VERSION, SOURCES } from "./sources.js";

/**
 * Reproducible entry point: `npm run run` prints the model × outcome matrix and
 * the scenario table, and writes the same evidence to runs/evidence.json.
 * Everything is deterministic (no network, no clock, no Docker).
 */

const OUT_DIR = join(process.cwd(), "runs");

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function main(): void {
  const variants = exploreAll();
  const scenarios = runScenarios();

  const evidence = {
    issue: 169,
    accessed: ACCESSED,
    openapiVersion: OPENAPI_VERSION,
    note: "Documentation + harness evidence. No real Jira site was mutated and no concurrent experiment against Jira Cloud was run.",
    variants,
    scenarios,
    sources: SOURCES,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  console.log("Interleaving matrix (conditional bulk-property candidate, two factories):\n");
  console.log(
    `${pad("variant", 36)}${pad("premise", 11)}${pad("runs", 7)}${pad("1 winner", 10)}${pad("2 winners", 11)}0 winners`,
  );
  for (const variant of variants) {
    console.log(
      `${pad(variant.name, 36)}${pad(variant.premise, 11)}${pad(String(variant.runs), 7)}${pad(String(variant.oneWinner), 10)}${pad(String(variant.twoWinners), 11)}${variant.noWinner}`,
    );
  }

  console.log("\nScenarios:\n");
  console.log(`${pad("scenario", 46)}${pad("workers", 9)}${pad("attempts", 10)}claim`);
  for (const scenario of scenarios) {
    const attempts = Object.entries(scenario.attemptsByFactory)
      .map(([factory, count]) => `${factory}:${count}`)
      .join(",");
    const claim = Object.values(scenario.claims).join(",");
    console.log(`${pad(scenario.scenario, 46)}${pad(String(scenario.workerCount), 9)}${pad(attempts, 10)}${claim}`);
  }

  console.log(`\nEvidence written to ${join(OUT_DIR, "evidence.json")}`);
}

main();
