/**
 * Metrics, computed from the journal and the simulated outside world. Nothing
 * here is a self-report by a mechanism: reused/repeated work is measured from
 * the events each mechanism's own machinery produced, and duplication is
 * measured from the external world's record of what it was asked to do.
 */
import type { ExternalWorld } from "./effects.js";
import type { JournalEntry } from "./journal.js";
import type { RecoveryState } from "./recovery.js";
import { WORKLOAD_STEPS } from "./workload.js";

export interface RunInput {
	readonly runId: string;
	readonly scenario: string;
	readonly alternative: string;
	readonly guardrails: boolean;
	readonly storage?: string;
	readonly replaySafe?: boolean;
	readonly repeat: number;
	readonly journal: readonly JournalEntry[];
	readonly world: ExternalWorld;
	readonly recovery: RecoveryState;
	readonly exitCodes: readonly number[];
}

export interface RunMetrics {
	readonly runId: string;
	readonly scenario: string;
	readonly alternative: string;
	readonly guardrails: boolean;
	readonly storage?: string;
	readonly replaySafe?: boolean;
	readonly repeat: number;
	/** Attempt identities the work passed through, in order. */
	readonly attempts: string[];
	/** Rounds the work passed through (a feedback round is a separate round). */
	readonly rounds: string[];
	/** True when an infrastructure interruption consumed an attempt (A only). */
	readonly attemptsConsumedByInterruption: number;
	readonly recoveriesConsumed: number;
	/** Steps the mechanism itself confirmed at the start of a recovery attempt. */
	readonly stepsReused: number;
	/** Steps that had to be worked on again after being worked on before. */
	readonly stepsRepeated: number;
	/** Steps whose mutation was skipped because the outside world already had it. */
	readonly effectsReconciled: number;
	readonly externalMutations: number;
	readonly duplicatedEffects: string[];
	readonly helpRequests: number;
	/** Most workers alive at the same time: 2 means a duplicate worker ran. */
	readonly simultaneousWorkers: number;
	/** A step was left unconfirmed after an interruption. */
	readonly interruptedFacts: number;
	/** The mechanism recorded that interruption itself (durable does). */
	readonly interruptedRecordedFacts: number;
	/** A new round really carried the human's feedback in its context. */
	readonly feedbackInContext: boolean;
	/** Live durable tasks seen when the state was reopened (durable only). */
	readonly liveTaskFacts: number;
	readonly completed: boolean;
	readonly durationMs: number;
	readonly recoveryWaitMs: number;
	readonly exitCodes: readonly number[];
	readonly outcome: "completed" | "help" | "failed";
}

export function computeMetrics(input: RunInput): RunMetrics {
	const spawned = input.journal.filter((entry) => entry.event === "worker-spawned");
	const attempts = [...new Set(spawned.map((entry) => String(entry.attemptId)))];

	const performedByRound = new Map<string, Set<number>>();
	const rounds: string[] = [];
	for (const entry of input.journal) {
		if (entry.event !== "step-performed" && entry.event !== "effect-performed") continue;
		const round = `${String(entry.attemptId ?? "unknown")}#${String(entry.round ?? 1)}`;
		if (!rounds.includes(round)) rounds.push(round);
		const steps = performedByRound.get(round) ?? new Set<number>();
		if (typeof entry.step === "number") steps.add(entry.step);
		performedByRound.set(round, steps);
	}

	let stepsRepeated = 0;
	const seen = new Set<number>();
	for (const round of rounds) {
		const steps = performedByRound.get(round) ?? new Set<number>();
		for (const step of steps) {
			if (seen.has(step)) stepsRepeated += 1;
			seen.add(step);
		}
	}

	const recoveryOpens = input.journal.filter(
		(entry) => entry.event === "attempt-opened" && Number(entry.round) === 1,
	);
	const stepsReused = recoveryOpens
		.slice(1)
		.reduce((best, entry) => Math.max(best, Array.isArray(entry.confirmed) ? entry.confirmed.length : 0), 0);

	const completed = input.journal.some((entry) => entry.event === "attempt-completed");
	const help = input.journal.some((entry) => entry.event === "help-requested");
	const lastExit = input.exitCodes.at(-1);

	const timestamps = input.journal.map((entry) => entry.at);
	const durationMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

	return {
		runId: input.runId,
		scenario: input.scenario,
		alternative: input.alternative,
		guardrails: input.guardrails,
		...(input.storage === undefined ? {} : { storage: input.storage }),
		...(input.replaySafe === undefined ? {} : { replaySafe: input.replaySafe }),
		repeat: input.repeat,
		attempts,
		rounds,
		attemptsConsumedByInterruption: Math.max(0, attempts.length - 1),
		recoveriesConsumed: input.recovery.consumed,
		stepsReused,
		stepsRepeated,
		effectsReconciled: input.journal.filter((entry) => entry.event === "effect-reconciled").length,
		externalMutations: input.world.records().length,
		duplicatedEffects: input.world.duplicatedEffects(),
		helpRequests: input.journal.filter((entry) => entry.event === "help-requested").length,
		simultaneousWorkers: maxConcurrentWorkers(input.journal),
		interruptedFacts: input.journal.filter(
			(entry) =>
				(entry.event === "attempt-opened" || entry.event === "attempt-settled") &&
				Array.isArray(entry.interrupted) &&
				entry.interrupted.length > 0,
		).length,
		liveTaskFacts: input.journal.reduce((peak, entry) => {
			if (entry.event !== "attempt-opened") return peak;
			const facts = entry.facts as { liveTasks?: number } | undefined;
			return Math.max(peak, facts?.liveTasks ?? 0);
		}, 0),
		feedbackInContext: input.journal.some(
			(entry) => entry.event === "feedback-in-context" && entry.present === true,
		),
		interruptedRecordedFacts: input.journal.filter(
			(entry) =>
				entry.event === "attempt-settled" &&
				entry.interruptedRecorded === true &&
				Array.isArray(entry.interrupted) &&
				entry.interrupted.length > 0,
		).length,
		completed,
		durationMs,
		recoveryWaitMs: input.journal
			.filter((entry) => entry.event === "recover-from-confirmed")
			.reduce((total, entry) => total + (typeof entry.waitMs === "number" ? entry.waitMs : 0), 0),
		exitCodes: input.exitCodes,
		outcome: completed ? "completed" : help ? "help" : lastExit === 0 ? "completed" : "failed",
	};
}

/** Peak overlap of workers that asked to be launched, by their own events. */
function maxConcurrentWorkers(journal: readonly JournalEntry[]): number {
	const events = journal
		.filter((entry) => entry.event === "worker-spawned" || entry.event === "worker-exit" || entry.event === "attached-worker-exited")
		.map((entry) => ({
			at: entry.at,
			delta: entry.event === "worker-spawned" ? 1 : -1,
		}))
		.sort((left, right) => left.at - right.at || right.delta - left.delta);
	let alive = 0;
	let peak = 0;
	for (const event of events) {
		alive += event.delta;
		peak = Math.max(peak, alive);
	}
	// A worker that was killed never exits by its own hand: the controller's
	// observation of its death counts instead.
	const killed = journal.filter((entry) => entry.event === "kill-self" || entry.event === "kill-during-effect").length;
	return killed > 0 ? Math.max(peak, 1) : peak;
}

export { WORKLOAD_STEPS };
