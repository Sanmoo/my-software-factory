/**
 * The recovery decision, as a pure function so the expected behaviour of every
 * alternative and guardrail is pinned by tests before any process runs.
 *
 * The harness's contract lives here:
 *  - infrastructure interruption does not end or consume an attempt;
 *  - a live worker is recognized, never duplicated;
 *  - with no trustworthy state, ask for help instead of pretending to recover;
 *  - the recovery budget is finite and separate from attempt identity.
 *
 * A is modelled as it exists: the factory relaunches a new attempt with
 * reconstructed context and has no worker-recognition path (state/status.ts
 * reads the container listing; the fall ruler frees on the first fall and
 * blocks on the second), so its expected outcomes here are deliberately worse.
 * That is the baseline being observed, not a defect introduced by the harness.
 */
import type { RecoveryDecision } from "./recovery.js";
import type { OwnerState, WorkerRecord } from "./ownership.js";

export type MechanismKind = "A" | "B" | "C";

export interface ControllerState {
	readonly mechanism: MechanismKind;
	readonly owner: OwnerState;
	readonly liveWorker: WorkerRecord | undefined;
	readonly workerRunning: boolean;
	/** The persisted state could not be opened or is invalid. */
	readonly stateUnusable: boolean;
	/** Somebody else already holds the work. */
	readonly anotherOwner: boolean;
	/** Consecutive attempts that produced no outcome, for A's own rule. */
	readonly attemptDrops: number;
	readonly budget: RecoveryDecision;
}

export type RecoveryAction =
	/** A worker is still conducting the execution: follow it, launch nothing. */
	| { readonly action: "attach-live-worker"; readonly workerPid: number }
	/** Same attempt, resumed from the last intact checkpoint. */
	| { readonly action: "rebuild-from-confirmed"; readonly waitMs: number }
	/** A's rule: a no-outcome drop releases a retry as a NEW attempt. */
	| { readonly action: "relaunch-new-attempt" }
	/** Stop and ask a human; never classify the interruption as attempt failure. */
	| { readonly action: "pause-help"; readonly reason: string };

export function decideRecovery(state: ControllerState): RecoveryAction {
	if (state.anotherOwner) {
		return { action: "pause-help", reason: "another owner or worker is conducting this execution" };
	}

	// A surviving worker wins over everything: recovering can mean recognizing it.
	if (state.liveWorker) {
		if (state.mechanism === "A") {
			// A has no worker-recognition path, so a controller restart launches a
			// second worker against work already in flight.
			return { action: "relaunch-new-attempt" };
		}
		return { action: "attach-live-worker", workerPid: state.liveWorker.pid };
	}

	if (state.mechanism === "A") {
		// The current factory rule: the first consecutive drop without outcome
		// releases a retry (a new attempt, branch preserved); the second blocks.
		if (state.attemptDrops >= 1) {
			return { action: "pause-help", reason: "second consecutive interrupted attempt without outcome" };
		}
		return { action: "relaunch-new-attempt" };
	}

	if (state.stateUnusable) {
		return { action: "pause-help", reason: "persisted state is missing or invalid" };
	}

	if (state.budget.decision === "pause-help") {
		return { action: "pause-help", reason: state.budget.reason };
	}

	return { action: "rebuild-from-confirmed", waitMs: state.budget.waitMs };
}
