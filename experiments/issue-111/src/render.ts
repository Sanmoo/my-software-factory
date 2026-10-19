/**
 * Re-render the report from an existing results.json, so the prose can be
 * revised without re-running anything. The numbers always come from the runs.
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { RunMetrics } from "./metrics.js";
import { SCENARIOS } from "./orchestrator.js";
import { renderReport } from "./report.js";

const arg = (name: string, fallback: string) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};

const results = JSON.parse(readFileSync(arg("results", "runs/results.json"), "utf8")) as {
	versions: Record<string, string>;
	factoryCommit: string;
	bundles: RunMetrics[];
};

writeFileSync(
	arg("out", "runs/report.md"),
	renderReport(results.bundles, {
		factoryCommit: results.factoryCommit,
		versions: results.versions,
		repeats: new Set(results.bundles.map((bundle) => bundle.repeat)).size,
		scenarios: SCENARIOS,
	}),
);
