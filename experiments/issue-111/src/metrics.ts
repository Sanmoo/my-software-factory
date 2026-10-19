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
	/** The mechanism under test: A, B or C. */
	readonly mechanism: string;
	/** The exact configuration label, for citing a run. */
	readonly label: string;
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
	readonly mechanism: string;
	readonly label: string;
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
	/** Confirmed steps carried across interruptions, summed over recovery attempts. */
	readonly stepsReused: number;
	/** Step executions that repeat a step already executed earlier in the run. */
	readonly stepsRepeated: number;
	/** Tool calls the mechanism itself re-ran with the same call id (safe replay). */
	readonly taskReplays: number;
	/** Steps whose mutation was skipped because the outside world already had it. */
	readonly effectsReconciled: number;
	readonly externalMutations: number;
	readonly duplicatedEffects: string[];
	readonly helpRequests: number;
	/** Most workers alive at the same time: 2 means a duplicate worker ran. */
	readonly simultaneousWorkers: number;
	/** The policy wanted a substitute while a worker was alive (refused by the gate). */
	readonly policyWouldDuplicate: number;
	/** The controller attached to a worker that outlived its controller. */
	readonly attachedLiveWorker: number;
	/** A step was left unconfirmed after an interruption. */
	readonly interruptedFacts: number;
	/** The mechanism recorded the interruption as an error result (durable does). */
	readonly interruptedFactsRecorded: number;
	/** The interruption was only inferred from a call left without a result (Pi). */
	readonly interruptedFactsInferred: number;
	/** A new round really carried the human's feedback in its context. */
	readonly feedbackInContext: boolean;
	/** Live durable tasks seen when the state was reopened (durable only). */
	readonly liveTaskFacts: number;
	readonly completed: boolean;
	readonly durationMs: number;
	/** Configured backoff spent before recoveries. */
	readonly recoveryWaitMs: number;
	/** Wall time from an interruption to the next attempt opening, summed. */
	readonly recoveryTimeMs: number;
	readonly exitCodes: readonly number[];
	readonly outcome: "completed" | "help" | "failed";
}

export function computeMetrics(input: RunInput): RunMetrics {
	const spawned = input.journal.filter((entry) => entry.event === "worker-spawned");
	const attempts = [...new Set(spawned.map((entry) => String(entry.attemptId)))];

	// Chronological, not per-attempt: a step executed twice inside one attempt
	// (a replay-safe tool re-running an interrupted call) is a repeat too.
	const rounds: string[] = [];
	let stepsRepeated = 0;
	const seen = new Set<number>();
	for (const entry of input.journal) {
		if (entry.event !== "step-performed" && entry.event !== "effect-performed") continue;
		const round = `${String(entry.attemptId ?? "unknown")}#${String(entry.round ?? 1)}`;
		if (!rounds.includes(round)) rounds.push(round);
		if (typeof entry.step !== "number") continue;
		if (seen.has(entry.step)) stepsRepeated += 1;
		seen.add(entry.step);
	}

	let taskReplays = 0;
	const seenCalls = new Set<string>();
	for (const entry of input.journal) {
		if (entry.event !== "tool-task") continue;
		const callId = String(entry.callId ?? "");
		if (callId.length > 0 && seenCalls.has(callId)) taskReplays += 1;
		if (callId.length > 0) seenCalls.add(callId);
	}

	// Every recovery attempt that opened reports what it carried over; summing
	// counts the reuse each interruption actually preserved.
	const recoveryOpens = input.journal.filter(
		(entry) => entry.event === "attempt-opened" && Number(entry.round) === 1,
	);
	const stepsReused = recoveryOpens
		.slice(1)
		.reduce((total, entry) => total + (Array.isArray(entry.confirmed) ? entry.confirmed.length : 0), 0);

	const completed = input.journal.some((entry) => entry.event === "attempt-completed");
	const help = input.journal.some((entry) => entry.event === "help-requested");
	const lastExit = input.exitCodes.at(-1);

	const timestamps = input.journal.map((entry) => entry.at);
	const durationMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

	return {
		runId: input.runId,
		scenario: input.scenario,
		mechanism: input.mechanism,
		label: input.label,
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
		taskReplays,
		effectsReconciled: input.journal.filter((entry) => entry.event === "effect-reconciled").length,
		externalMutations: input.world.records().length,
		duplicatedEffects: input.world.duplicatedEffects(),
		helpRequests: input.journal.filter((entry) => entry.event === "help-requested").length,
		simultaneousWorkers: maxConcurrentWorkers(input.journal),
		policyWouldDuplicate: input.journal.filter((entry) => entry.event === "policy-would-duplicate").length,
		attachedLiveWorker: input.journal.filter((entry) => entry.event === "attach-live-worker").length,
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
		interruptedFactsRecorded: input.journal.filter(
			(entry) =>
				entry.event === "attempt-settled" &&
				entry.interruptedFactKind === "recorded" &&
				Array.isArray(entry.interrupted) &&
				entry.interrupted.length > 0,
		).length,
		interruptedFactsInferred: input.journal.filter(
			(entry) =>
				entry.event === "attempt-settled" &&
				entry.interruptedFactKind === "inferred" &&
				Array.isArray(entry.interrupted) &&
				entry.interrupted.length > 0,
		).length,
		completed,
		durationMs,
		recoveryWaitMs: input.journal
			.filter((entry) => entry.event === "recover-from-confirmed")
			.reduce((total, entry) => total + (typeof entry.waitMs === "number" ? entry.waitMs : 0), 0),
		recoveryTimeMs: recoveryTime(input.journal),
		exitCodes: input.exitCodes,
		outcome: completed ? "completed" : help ? "help" : lastExit === 0 ? "completed" : "failed",
	};
}

/** Wall time from each interruption to the next attempt opening, summed. */
function recoveryTime(journal: readonly JournalEntry[]): number {
	const interruptionEvents = new Set([
		"kill-self",
		"kill-between-steps",
		"kill-during-effect",
		"kill-during-effect-ambiguous",
		"kill-during-tool",
		"worker-exit",
		"attached-worker-exited",
	]);
	let lastInterruption: number | undefined;
	let seenFirstOpen = false;
	let total = 0;
	for (const entry of journal) {
		if (interruptionEvents.has(entry.event)) lastInterruption = entry.at;
		if (entry.event !== "attempt-opened") continue;
		if (seenFirstOpen && lastInterruption !== undefined) total += Math.max(0, entry.at - lastInterruption);
		seenFirstOpen = true;
		lastInterruption = undefined;
	}
	return total;
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
