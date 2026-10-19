/**
 * The recovery budget: a finite, persisted allowance of automatic recoveries,
 * counted per attempt and kept strictly apart from attempt identity. Running out
 * pauses and asks for help; it never restarts indefinitely and never turns an
 * infrastructure interruption into a failed attempt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RecoveryPolicy {
	/** Automatic recoveries allowed for one attempt. */
	readonly maxRecoveries: number;
	/** Wait before each recovery, by index; the last value repeats. */
	readonly waitsMs: readonly number[];
}

/** Fixed before the tests ran, and recorded in the report. */
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
	maxRecoveries: 3,
	waitsMs: [1_000, 4_000, 16_000],
};

export interface RecoveryEvent {
	readonly index: number;
	readonly reason: string;
	readonly waitMs: number;
	readonly at: number;
}

export interface RecoveryState {
	readonly consumed: number;
	readonly events: readonly RecoveryEvent[];
}

export type RecoveryDecision =
	| { readonly decision: "recover"; readonly index: number; readonly waitMs: number; readonly consumed: number }
	| { readonly decision: "pause-help"; readonly reason: string; readonly consumed: number };

export class RecoveryLedger {
	constructor(
		private readonly path: string,
		private readonly policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
		private readonly now: () => number = Date.now,
	) {}

	state(): RecoveryState {
		if (!existsSync(this.path)) return { consumed: 0, events: [] };
		return JSON.parse(readFileSync(this.path, "utf8")) as RecoveryState;
	}

	/** What the next recovery would cost, without consuming it. */
	peek(reason: string): RecoveryDecision {
		const { consumed } = this.state();
		if (consumed >= this.policy.maxRecoveries) {
			return { decision: "pause-help", reason: this.exhaustedReason(reason), consumed };
		}
		const waitMs = this.policy.waitsMs[Math.min(consumed, this.policy.waitsMs.length - 1)] ?? 0;
		return { decision: "recover", index: consumed, waitMs, consumed };
	}

	/** Consume one recovery and persist it, so a new process continues the count. */
	consume(reason: string): RecoveryDecision {
		const decision = this.peek(reason);
		if (decision.decision === "pause-help") {
			this.write({ consumed: decision.consumed, events: this.state().events });
			return decision;
		}
		const event: RecoveryEvent = { index: decision.index, reason, waitMs: decision.waitMs, at: this.now() };
		const state = { consumed: decision.consumed + 1, events: [...this.state().events, event] };
		this.write(state);
		return { decision: "recover", index: event.index, waitMs: event.waitMs, consumed: state.consumed };
	}

	/** An infrastructure interruption is not an attempt failure; the budget is the
	 * only thing that runs out. */
	private exhaustedReason(reason: string): string {
		return `recovery budget exhausted after ${this.policy.maxRecoveries} recoveries (${reason})`;
	}

	private write(state: RecoveryState): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(state, null, 1)}\n`);
	}
}
