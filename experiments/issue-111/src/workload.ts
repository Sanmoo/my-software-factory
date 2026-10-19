/**
 * The fixed workload. It is frozen before any alternative runs, so all three
 * see identical steps and identical progress boundaries; the comparison is of
 * the resume mechanism, not of the work.
 *
 * Progress is observable at step granularity, and the two external effects sit
 * at different points (middle and near the end) so a mechanism that reuses only
 * a prefix shows up differently from one that reuses nothing.
 */
export type StepKind = "analyze" | "effect";

export interface Step {
	readonly index: number;
	readonly kind: StepKind;
	readonly label: string;
	/** Present on `effect` steps: the identity of the simulated external mutation. */
	readonly effectId?: string;
}

export const WORKLOAD: readonly Step[] = [
	{ index: 1, kind: "analyze", label: "read issue and branch" },
	{ index: 2, kind: "analyze", label: "draft the change" },
	{ index: 3, kind: "effect", effectId: "push-branch", label: "push the work branch" },
	{ index: 4, kind: "analyze", label: "run the focused tests" },
	{ index: 5, kind: "analyze", label: "run the full suite" },
	{ index: 6, kind: "effect", effectId: "open-pr", label: "open the pull request" },
	{ index: 7, kind: "analyze", label: "read the CI result" },
	{ index: 8, kind: "analyze", label: "write the final note" },
];

export const WORKLOAD_STEPS = WORKLOAD.length;

export function stepAt(index: number): Step {
	const step = WORKLOAD.find((candidate) => candidate.index === index);
	if (!step) throw new Error(`no workload step ${index}`);
	return step;
}

/** Where the injected interruption lands. Fixed per scenario before execution. */
export type FaultPoint =
	/** Nothing is injected: the attempt runs to completion. */
	| "none"
	/** Killed before the step starts; every earlier result is recorded. */
	| "between-steps"
	/** Killed inside the step, after the external mutation, before its result. */
	| "during-effect"
	/** Killed after a torn external write: the evidence cannot decide. */
	| "during-effect-ambiguous";

export interface FaultSpec {
	readonly atStep: number;
	readonly point: FaultPoint;
}

export const NO_FAULT: FaultSpec = { atStep: 0, point: "none" };

/** How one step's work ended up in this attempt. */
export type Disposition =
	/** Already recorded by the mechanism: the work was not redone. */
	| "reused"
	/** Performed for the first time. */
	| "performed"
	/** Not recorded, but external evidence said it was already done: the mutation
	 * was NOT repeated. */
	| "reconciled"
	/** Not enough evidence to continue: the worker paused and asked for help. */
	| "help";

export interface StepRunResult {
	readonly step: number;
	readonly disposition: Disposition;
	readonly effectPerformed: boolean;
	readonly text: string;
}
