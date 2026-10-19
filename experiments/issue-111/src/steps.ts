/**
 * The shared step executor. It is deliberately the same code for A, B and C: the
 * only thing that differs between alternatives is the resume mechanism, so any
 * difference in reused work is attributable to that mechanism.
 *
 * Two layers live here and are reported separately:
 *   - the mechanism layer: a step whose result the mechanism already recorded is
 *     not run at all (`reused`);
 *   - the guardrail layer (`guardrails: true`): before repeating an external
 *     mutation, consult the outside world. Present evidence means skip;
 *     ambiguous evidence means pause and ask for help, never a blind repeat.
 */
import type { ExternalWorld } from "./effects.js";
import type { Journal } from "./journal.js";
import { FaultSpec, Step, StepRunResult } from "./workload.js";

export interface StepRunHooks {
	readonly attemptId: string;
	readonly guardrails: boolean;
	readonly journal: Journal;
	readonly world: ExternalWorld;
	readonly fault: FaultSpec;
	/** Hard stop of this process, mid-step, at the injected point. */
	readonly kill: () => never;
	/** Steps the mechanism already records as confirmed for this attempt. */
	readonly confirmed: ReadonlySet<number>;
	/** Artificial latency, so a worker is not finished before a restart arrives. */
	readonly stepDelayMs: number;
	/** Stop the worker and ask for help: never continue past an unresolved ambiguity. */
	readonly pause: (reason: string) => never;
	/** Logical round: a human feedback round is not the same execution as the first. */
	readonly round: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export async function runStep(step: Step, hooks: StepRunHooks): Promise<StepRunResult> {
	if (hooks.confirmed.has(step.index)) {
		hooks.journal.append({ role: "worker", event: "step-reused", attemptId: hooks.attemptId, round: hooks.round, step: step.index });
		return { step: step.index, disposition: "reused", effectPerformed: false, text: `step ${step.index} reused` };
	}

	if (step.kind === "analyze") {
		if (hooks.fault.atStep === step.index && hooks.fault.point === "between-steps") {
			hooks.journal.append({ role: "worker", event: "kill-between-steps", attemptId: hooks.attemptId, round: hooks.round, step: step.index });
			hooks.kill();
		}
		await sleep(hooks.stepDelayMs);
		hooks.journal.append({ role: "worker", event: "step-performed", attemptId: hooks.attemptId, round: hooks.round, step: step.index, kind: step.kind });
		return { step: step.index, disposition: "performed", effectPerformed: false, text: `step ${step.index} done` };
	}

	const effectId = step.effectId;
	if (!effectId) throw new Error(`effect step ${step.index} has no effect id`);
	const injected = hooks.fault.atStep === step.index;
	const injectedHere = injected && hooks.fault.point !== "between-steps" && hooks.fault.point !== "none";

	// Reconciliation comes first: never repeat a mutation the outside world can
	// still confirm. This runs before any mutation, injected or not.
	if (hooks.guardrails) {
		const evidence = hooks.world.evidence(effectId);
		if (evidence === "present") {
			hooks.journal.append({ role: "worker", event: "effect-reconciled", attemptId: hooks.attemptId, round: hooks.round, step: step.index, effectId });
			if (injectedHere) {
				// The effect is already outside; the interruption claim is satisfied
				// without repeating it.
				hooks.journal.append({ role: "worker", event: "kill-after-reconcile", attemptId: hooks.attemptId, round: hooks.round, step: step.index });
				hooks.kill();
			}
			return {
				step: step.index,
				disposition: "reconciled",
				effectPerformed: false,
				text: `step ${step.index} already performed outside`,
			};
		}
		if (evidence === "ambiguous") {
			hooks.journal.append({
				role: "worker",
				event: "help-requested",
				attemptId: hooks.attemptId,
				round: hooks.round,
				step: step.index,
				reason: "ambiguous-effect",
			});
			// The run stops here: continuing would be continuing blindly.
			hooks.pause("ambiguous-effect");
		}
	}

	if (injectedHere && hooks.fault.point === "during-effect-ambiguous") {
		hooks.world.performAmbiguous(effectId, step.index, hooks.attemptId);
		hooks.journal.append({ role: "worker", event: "kill-during-effect-ambiguous", attemptId: hooks.attemptId, round: hooks.round, step: step.index });
		hooks.kill();
	}

	hooks.world.perform(effectId, step.index, hooks.attemptId);
	hooks.journal.append({ role: "worker", event: "effect-performed", attemptId: hooks.attemptId, round: hooks.round, step: step.index, effectId });
	await sleep(hooks.stepDelayMs);

	if (injectedHere) {
		// The mutation landed outside; the local record of it never will.
		hooks.journal.append({ role: "worker", event: "kill-during-effect", attemptId: hooks.attemptId, round: hooks.round, step: step.index });
		hooks.kill();
	}

	return { step: step.index, disposition: "performed", effectPerformed: true, text: `step ${step.index} done` };
}
