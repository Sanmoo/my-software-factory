/**
 * The experiment driver. It plays the machine that runs the factory: it starts a
 * controller process, observes it die or finish, and starts the next one. That
 * is what makes "the factory was restarted" a real event instead of a flag.
 *
 * Fixed before execution: workload, fault points, guardrails, recovery policy
 * (3 recoveries, 1s/4s/16s) and the repeats per configuration.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExternalWorld } from "./effects.js";
import { Journal } from "./journal.js";
import type { RunConfig } from "./mechanism.js";
import { computeMetrics, type RunMetrics } from "./metrics.js";
import type { RecoveryState } from "./recovery.js";
import { NO_FAULT, type FaultSpec } from "./workload.js";

const here = dirname(fileURLToPath(import.meta.url));
const controllerPath = join(here, "controller.js");

export interface ScenarioSpec {
	readonly id: string;
	readonly name: string;
	readonly fault: FaultSpec;
	readonly corruptState: "none" | "session" | "storage" | "storage-torn";
	readonly feedback?: string;
	readonly killControllerAfterMilestone: boolean;
	readonly holdOwner: boolean;
	/** What the contract expects, recorded before any run. */
	readonly expected: string;
	/** Labels this scenario only makes sense for. */
	readonly variantsOnly?: readonly string[];
}

const feedbackText = "Humano: use pnpm, e não inclua o diretório experiments/ no PR.";

export const SCENARIOS: readonly ScenarioSpec[] = [
	{
		id: "s1",
		name: "fábrica interrompida; worker vivo",
		fault: NO_FAULT,
		corruptState: "none",
		killControllerAfterMilestone: true,
		holdOwner: false,
		expected: "reconhecer o worker vivo; não lançar outro; não consumir tentativa",
	},
	{
		id: "s2",
		name: "worker interrompido entre passos",
		fault: { atStep: 5, point: "between-steps" },
		corruptState: "none",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "mesma tentativa; passos confirmados reaproveitados; nenhum efeito duplicado",
	},
	{
		id: "s3",
		name: "efeito realizado; resultado não registrado",
		fault: { atStep: 6, point: "during-effect" },
		corruptState: "none",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "consultar evidência externa antes de repetir; nenhuma duplicação",
	},
	{
		id: "s3b",
		name: "evidência externa ambígua",
		fault: { atStep: 3, point: "during-effect-ambiguous" },
		corruptState: "none",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "pausar e pedir ajuda; não continuar às cegas",
	},
	{
		id: "g1",
		name: "interrupções sucessivas até o limite",
		fault: { atStep: 5, point: "between-steps" },
		corruptState: "none",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "esgotar o orçamento e pedir ajuda com limite finito",
	},
	{
		id: "g2",
		name: "estado ausente ou inválido",
		fault: { atStep: 5, point: "between-steps" },
		corruptState: "storage",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "pedir ajuda; não classificar como falha da tentativa",
	},
	{
		id: "g2b",
		name: "última escrita parcial (tail truncado)",
		fault: { atStep: 5, point: "between-steps" },
		corruptState: "storage-torn",
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "registrar o que ficou sem prova: uma cauda parcial pode ser descartada em silêncio",
		variantsOnly: ["C-jsonl+guard"],
	},
	{
		id: "g3",
		name: "tentativa de segundo dono",
		fault: NO_FAULT,
		corruptState: "none",
		killControllerAfterMilestone: false,
		holdOwner: true,
		expected: "recusar o segundo dono; nenhum efeito externo",
	},
	{
		id: "g4",
		name: "feedback humano novo antes de continuar",
		fault: { atStep: 5, point: "between-steps" },
		corruptState: "none",
		feedback: feedbackText,
		killControllerAfterMilestone: false,
		holdOwner: false,
		expected: "iniciar nova rodada com contexto atualizado; não continuar cegamente",
	},
];

export interface MechanismVariant {
	readonly alternative: "A" | "B" | "C";
	readonly storage: "sqlite" | "jsonl";
	readonly replaySafe: boolean;
	/** The shared reconciliation layer, on or off, so its gain is separable. */
	readonly guardrails: boolean;
	readonly label: string;
}

export const VARIANTS: readonly MechanismVariant[] = [
	{ alternative: "A", storage: "sqlite", replaySafe: false, guardrails: true, label: "A+guard" },
	{ alternative: "A", storage: "sqlite", replaySafe: false, guardrails: false, label: "A-noguard" },
	{ alternative: "B", storage: "sqlite", replaySafe: false, guardrails: true, label: "B+guard" },
	{ alternative: "B", storage: "sqlite", replaySafe: false, guardrails: false, label: "B-noguard" },
	{ alternative: "C", storage: "sqlite", replaySafe: false, guardrails: true, label: "C-sqlite+guard" },
	{ alternative: "C", storage: "sqlite", replaySafe: false, guardrails: false, label: "C-sqlite-noguard" },
	{ alternative: "C", storage: "jsonl", replaySafe: false, guardrails: true, label: "C-jsonl+guard" },
	{ alternative: "C", storage: "sqlite", replaySafe: true, guardrails: true, label: "C-safe+guard" },
];

/** Guardrail scenarios are about ownership, budget and rounds, not reconciliation. */
export const GUARDRAIL_SCENARIOS = new Set(["g1", "g2", "g2b", "g3", "g4"]);

interface PhaseResult {
	readonly code: number | null;
	readonly signal: string | null;
}

function runPhase(configPath: string, mode: string, timeoutMs = 90_000): Promise<PhaseResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [controllerPath, configPath, mode], { stdio: ["ignore", "ignore", "ignore"] });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`controller ${mode} timed out`));
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export interface RunBundle {
	readonly metrics: RunMetrics;
	readonly dir: string;
	readonly exitCodes: number[];
}

export async function runOnce(
	root: string,
	scenario: ScenarioSpec,
	variant: MechanismVariant,
	repeat: number,
): Promise<RunBundle> {
	const runId = `${scenario.id}-${variant.label}-rep${repeat}`;
	const dir = join(root, "runs", runId);
	rmSync(dir, { recursive: true, force: true });
	const workDir = join(dir, "work");
	const sessionsDir = join(dir, "sessions");
	const agentDir = join(dir, "agent");
	for (const path of [workDir, sessionsDir, agentDir]) mkdirSync(path, { recursive: true });

	const config: RunConfig = {
		runId,
		scenario: scenario.id,
		alternative: variant.alternative,
		guardrails: variant.guardrails,
		replaySafe: variant.replaySafe,
		storage: variant.storage,
		fault: scenario.fault,
		round: 1,
		...(scenario.feedback === undefined ? {} : { feedback: scenario.feedback }),
		workDir,
		sessionsDir,
		agentDir,
		journalPath: join(dir, "journal.jsonl"),
		worldPath: join(dir, "external.jsonl"),
		ownerId: runId,
		attemptId: "attempt-1",
		reconstructedContext:
			"Contexto reconstruído: issue #111, conversa do PR e diff do branch de trabalho.",
		corruptState:
			scenario.corruptState === "session" && variant.alternative === "C"
				? "storage"
				: scenario.corruptState === "storage-torn" && variant.alternative !== "C"
					? "session"
					: scenario.corruptState,
		killControllerAfterMilestone: scenario.killControllerAfterMilestone,
		repeatFault: scenario.id === "g1",
		stepDelayMs: scenario.killControllerAfterMilestone ? 600 : 150,
	};
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 1)}\n`);

	const exitCodes: number[] = [];
	let hold: ReturnType<typeof spawn> | undefined;

	if (scenario.holdOwner) {
		hold = spawn(process.execPath, [controllerPath, configPath, "hold"], { stdio: ["ignore", "ignore", "ignore"] });
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (journalHas(dir, "hold")) break;
			await sleep(25);
		}
	}

	const first = await runPhase(configPath, "launch");
	if (first.code !== null) exitCodes.push(first.code);

	// A controller that was hard-stopped leaves the machine to restart it.
	const recoveries = scenario.killControllerAfterMilestone ? 4 : 1;
	for (let phase = 0; phase < recoveries; phase += 1) {
		if (journalHas(dir, "attempt-completed") && !scenario.feedback) break;
		if (journalHas(dir, "help-requested")) break;
		const result = await runPhase(configPath, "recover");
		if (result.code !== null) exitCodes.push(result.code);
		if (result.code === 0 || result.code === 30) break;
	}

	if (hold) hold.kill("SIGKILL");

	const journal = new Journal(join(dir, "journal.jsonl"));
	const recoveryPath = join(workDir, "recovery.json");
	const recovery: RecoveryState = existsSync(recoveryPath)
		? (JSON.parse(readFileSync(recoveryPath, "utf8")) as RecoveryState)
		: { consumed: 0, events: [] };

	const metrics = computeMetrics({
		runId,
		scenario: scenario.id,
		alternative: variant.label,
		guardrails: config.guardrails,
		storage: variant.storage,
		replaySafe: variant.replaySafe,
		repeat,
		journal: journal.read(),
		world: new ExternalWorld(config.worldPath),
		recovery,
		exitCodes,
	});
	return { metrics, dir, exitCodes };
}

function journalHas(dir: string, event: string): boolean {
	const path = join(dir, "journal.jsonl");
	if (!existsSync(path)) return false;
	return readFileSync(path, "utf8").includes(`"event":"${event}"`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
