import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ExternalWorld } from "./effects.js";
import { Journal } from "./journal.js";
import { runStep, type StepRunHooks } from "./steps.js";
import { FaultSpec, stepAt } from "./workload.js";

const scratch = () => mkdtempSync(join(tmpdir(), "msf111-step-"));

class Killed extends Error {}

class Paused extends Error {}

function hooks(
	scratchDir: string,
	options: { guardrails?: boolean; fault?: FaultSpec; confirmed?: number[] } = {},
): { hooks: StepRunHooks; world: ExternalWorld; journal: Journal; kills: number[]; pauses: string[] } {
	const world = new ExternalWorld(join(scratchDir, "external.jsonl"));
	const journal = new Journal(join(scratchDir, "journal.jsonl"));
	const kills: number[] = [];
	const pauses: string[] = [];
	return {
		world,
		journal,
		kills,
		pauses,
		hooks: {
			attemptId: "attempt-1",
			guardrails: options.guardrails ?? false,
			journal,
			world,
			fault: options.fault ?? { atStep: 0, point: "none" },
			confirmed: new Set(options.confirmed ?? []),
			stepDelayMs: 0,
			round: 1,
			pause: (reason: string) => {
				pauses.push(reason);
				throw new Paused(reason);
			},
			kill: () => {
				kills.push(1);
				throw new Killed("killed");
			},
		},
	};
}

test("a step the mechanism already records is reused, not re-executed", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir, { confirmed: [3] });
	const result = await runStep(stepAt(3), h);
	assert.equal(result.disposition, "reused");
	assert.equal(world.evidence("push-branch"), "absent", "no mutation is performed for a reused step");
});

test("without guardrails, a step whose effect is already outside is performed again", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir);
	world.perform("open-pr", 6, "attempt-1");
	const result = await runStep(stepAt(6), h);
	assert.equal(result.disposition, "performed");
	assert.equal(world.mutations("open-pr").length, 2, "the duplicate is what the mechanism-only path produces");
});

test("with guardrails, evidence of a completed effect prevents the repeat", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir, { guardrails: true });
	world.perform("open-pr", 6, "attempt-1");
	const result = await runStep(stepAt(6), h);
	assert.equal(result.disposition, "reconciled");
	assert.equal(result.effectPerformed, false);
	assert.equal(world.mutations("open-pr").length, 1);
});

test("ambiguous evidence stops the run and asks for help instead of continuing blindly", async () => {
	const dir = scratch();
	const { hooks: h, world, journal, pauses } = hooks(dir, { guardrails: true });
	world.performAmbiguous("push-branch", 3, "attempt-1");
	await assert.rejects(() => runStep(stepAt(3), h), Paused);
	assert.deepEqual(pauses, ["ambiguous-effect"]);
	assert.equal(journal.last("help-requested")?.reason, "ambiguous-effect");
	assert.equal(world.mutations("push-branch").length, 0, "an ambiguous effect is never performed again");
});

test("the during-effect fault kills after the mutation and before the result", async () => {
	const dir = scratch();
	const { hooks: h, world, journal } = hooks(dir, { fault: { atStep: 6, point: "during-effect" } });
	await assert.rejects(() => runStep(stepAt(6), h), Killed);
	assert.equal(world.evidence("open-pr"), "present");
	assert.equal(journal.last("effect-performed")?.step, 6);
	assert.equal(journal.last("kill-during-effect")?.step, 6);
});

test("the during-tool fault also lands on a step with no external effect", async () => {
	const dir = scratch();
	const { hooks: h, world, journal } = hooks(dir, { fault: { atStep: 4, point: "during-tool" } });
	await assert.rejects(() => runStep(stepAt(4), h), Killed);
	assert.equal(journal.last("kill-during-tool")?.step, 4);
	assert.equal(world.records().length, 0, "no effect is involved");
});

test("the ambiguous fault leaves torn evidence behind", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir, { fault: { atStep: 3, point: "during-effect-ambiguous" } });
	await assert.rejects(() => runStep(stepAt(3), h), Killed);
	assert.equal(world.evidence("push-branch"), "ambiguous");
});

test("the between-steps fault kills before the step starts, leaving no effect", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir, { fault: { atStep: 4, point: "between-steps" } });
	await assert.rejects(() => runStep(stepAt(4), h), Killed);
	assert.equal(world.records().length, 0);
});

test("guardrails do not invent evidence: a genuinely absent effect is performed", async () => {
	const dir = scratch();
	const { hooks: h, world } = hooks(dir, { guardrails: true });
	const result = await runStep(stepAt(3), h);
	assert.equal(result.disposition, "performed");
	assert.equal(result.effectPerformed, true);
	assert.equal(world.mutations("push-branch").length, 1);
});

test("every step the workload declares is runnable", async () => {
	const dir = scratch();
	for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const { hooks: h } = hooks(dir, { guardrails: true });
		const result = await runStep(stepAt(step), h);
		assert.equal(result.disposition, "performed");
	}
});
