/**
 * CLI: run the fixed matrix and write the evidence.
 *
 *   node dist/run.js --repeats 3 [--scenarios s1,s2] [--variants A,B] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ExternalWorld } from "./effects.js";
import { Journal } from "./journal.js";
import type { RunConfig } from "./mechanism.js";
import { computeMetrics, type RunMetrics } from "./metrics.js";
import type { RecoveryState } from "./recovery.js";
import { SCENARIOS, VARIANTS, runOnce, type MechanismVariant, type ScenarioSpec } from "./orchestrator.js";
import { GUARDRAIL_SCENARIOS } from "./orchestrator.js";
import { renderReport } from "./report.js";
import { cliArgument } from "./util.js";

const repeats = Number(cliArgument("repeats", "3"));
const root = resolve(cliArgument("root", join(process.cwd(), "runs")));
const only = cliArgument("scenarios", "")
	.split(",")
	.filter(Boolean);
const onlyVariants = cliArgument("variants", "")
	.split(",")
	.filter(Boolean);

const scenarios: ScenarioSpec[] = SCENARIOS.filter((scenario) => only.length === 0 || only.includes(scenario.id));
// Guardrail scenarios only need the guardrails-on variants: they test ownership,
// budget, invalid state and rounds, not reconciliation.
const variantsFor = (scenario: ScenarioSpec): MechanismVariant[] =>
	VARIANTS.filter(
		(variant) =>
			(onlyVariants.length === 0 || onlyVariants.includes(variant.label)) &&
			(!GUARDRAIL_SCENARIOS.has(scenario.id) || variant.guardrails) &&
			(scenario.variantsOnly === undefined || scenario.variantsOnly.includes(variant.label)),
	);

const versions = (): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const name of [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-durable",
		"@earendil-works/pi-ai",
		"@earendil-works/chord",
	]) {
		try {
			const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "node_modules", name, "package.json"), "utf8")) as {
				version: string;
			};
			out[name] = manifest.version;
		} catch {
			out[name] = "unknown";
		}
	}
	return out;
};

const factoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8" }).trim();

mkdirSync(root, { recursive: true });
const bundles: RunMetrics[] = [];
const startedAt = Date.now();

/** Rebuild the metrics from the journals already on disk, without running anything. */
async function recompute(): Promise<RunMetrics[]> {
	const runsDir = join(root, "runs");
	const rebuilt: RunMetrics[] = [];
	for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(runsDir, entry.name);
		const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as RunConfig & { label?: string };
		const journal = new Journal(config.journalPath);
		const recoveryPath = join(config.workDir, "recovery.json");
		rebuilt.push(
			computeMetrics({
				runId: config.runId,
				scenario: config.scenario,
				mechanism: config.alternative,
				label: config.label ?? config.runId,
				guardrails: config.guardrails,
				storage: config.storage,
				replaySafe: config.replaySafe,
				repeat: Number(config.runId.split("rep")[1] ?? "1"),
				journal: journal.read(),
				world: new ExternalWorld(config.worldPath),
				recovery: existsSync(recoveryPath)
					? (JSON.parse(readFileSync(recoveryPath, "utf8")) as RecoveryState)
					: { consumed: 0, events: [] },
				exitCodes: [],
			}),
		);
	}
	return rebuilt.sort((left, right) => left.runId.localeCompare(right.runId));
}

const recomputing = cliArgument("recompute", "") === "true";
if (recomputing) bundles.push(...(await recompute()));

for (const scenario of recomputing ? [] : scenarios) {
	for (const variant of variantsFor(scenario)) {
		for (let repeat = 1; repeat <= repeats; repeat += 1) {
			const bundle = await runOnce(root, scenario, variant, repeat);
			bundles.push(bundle.metrics);
			process.stdout.write(
				`${bundle.metrics.runId.padEnd(30)} outcome=${bundle.metrics.outcome.padEnd(9)} attempts=${bundle.metrics.attempts.length} reused=${bundle.metrics.stepsReused} repeated=${bundle.metrics.stepsRepeated} dup=${bundle.metrics.duplicatedEffects.length} help=${bundle.metrics.helpRequests} workers=${bundle.metrics.simultaneousWorkers} ms=${bundle.metrics.durationMs}\n`,
			);
		}
	}
}

const resultsPath = join(root, "results.json");
writeFileSync(resultsPath, `${JSON.stringify({ versions: versions(), factoryCommit, bundles }, null, 1)}\n`);
const reportPath = join(root, "report.md");
writeFileSync(
	reportPath,
	renderReport(bundles, { factoryCommit, versions: versions(), repeats, scenarios }),
);

process.stdout.write(`\n${bundles.length} execuções em ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
process.stdout.write(`resultados: ${resultsPath}\nrelatório: ${reportPath}\n`);
