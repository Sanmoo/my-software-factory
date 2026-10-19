import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ExternalWorld } from "./effects.js";
import type { JournalEntry } from "./journal.js";
import { computeMetrics } from "./metrics.js";

const entry = (at: number, event: string, fields: Record<string, unknown> = {}): JournalEntry => ({
	at,
	role: "worker",
	event,
	...fields,
});

const world = () => new ExternalWorld(join(mkdtempSync(join(tmpdir(), "msf111-met-")), "external.jsonl"));

test("a clean single attempt reuses nothing and repeats nothing", () => {
	const external = world();
	for (let step = 1; step <= 8; step += 1) {
		if (step === 3 || step === 6) external.perform(step === 3 ? "push-branch" : "open-pr", step, "attempt-1");
	}
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s2",
		mechanism: "B",
		label: "B+guard",
		guardrails: true,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(1, "attempt-opened", { attemptId: "attempt-1", confirmed: [], interrupted: [] }),
			entry(2, "step-performed", { attemptId: "attempt-1", step: 1 }),
			entry(3, "effect-performed", { attemptId: "attempt-1", step: 3 }),
			entry(4, "worker-exit", { code: 0 }),
			entry(5, "attempt-completed", { attemptId: "attempt-1" }),
		],
		world: external,
		recovery: { consumed: 0, events: [] },
		exitCodes: [0],
	});
	assert.equal(metrics.stepsReused, 0);
	assert.equal(metrics.stepsRepeated, 0);
	assert.deepEqual(metrics.duplicatedEffects, []);
	assert.equal(metrics.outcome, "completed");
	assert.equal(metrics.simultaneousWorkers, 1);
});

test("a second attempt without confirmed progress repeats the work and duplicates effects", () => {
	const external = world();
	external.perform("push-branch", 3, "attempt-1");
	external.perform("push-branch", 3, "attempt-2");
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s1",
		mechanism: "A",
		label: "A-noguard",
		guardrails: false,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(1, "attempt-opened", { attemptId: "attempt-1", confirmed: [], interrupted: [] }),
			entry(2, "step-performed", { attemptId: "attempt-1", step: 1 }),
			entry(3, "effect-performed", { attemptId: "attempt-1", step: 3 }),
			entry(4, "worker-spawned", { attemptId: "attempt-2", pid: 2 }),
			entry(5, "attempt-opened", { attemptId: "attempt-2", confirmed: [], interrupted: [] }),
			entry(6, "step-performed", { attemptId: "attempt-2", step: 1 }),
			entry(7, "effect-performed", { attemptId: "attempt-2", step: 3 }),
			entry(8, "worker-exit", { code: 0 }),
			entry(9, "attempt-completed", { attemptId: "attempt-2" }),
		],
		world: external,
		recovery: { consumed: 0, events: [] },
		exitCodes: [0],
	});
	assert.deepEqual(metrics.attempts, ["attempt-1", "attempt-2"]);
	assert.equal(metrics.attemptsConsumedByInterruption, 1, "the interruption cost an attempt");
	assert.equal(metrics.stepsReused, 0);
	assert.equal(metrics.stepsRepeated, 2);
	assert.deepEqual(metrics.duplicatedEffects, ["push-branch"]);
});

test("resuming the same attempt reuses confirmed steps and repeats none", () => {
	const external = world();
	external.perform("push-branch", 3, "attempt-1");
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s2",
		mechanism: "C",
		label: "C-sqlite+guard",
		guardrails: true,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(1, "attempt-opened", { attemptId: "attempt-1", round: 1, confirmed: [], interrupted: [] }),
			entry(2, "effect-performed", { attemptId: "attempt-1", step: 3 }),
			entry(3, "worker-spawned", { attemptId: "attempt-1", pid: 2 }),
			entry(4, "attempt-opened", { attemptId: "attempt-1", round: 1, confirmed: [1, 2], interrupted: [3] }),
			entry(5, "effect-reconciled", { attemptId: "attempt-1", step: 3 }),
			entry(6, "step-performed", { attemptId: "attempt-1", step: 4 }),
			entry(7, "worker-exit", { code: 0 }),
			entry(8, "attempt-completed", { attemptId: "attempt-1" }),
		],
		world: external,
		recovery: { consumed: 1, events: [{ index: 0, reason: "x", waitMs: 1000, at: 1 }] },
		exitCodes: [0],
	});
	assert.deepEqual(metrics.attempts, ["attempt-1"]);
	assert.equal(metrics.attemptsConsumedByInterruption, 0);
	assert.equal(metrics.stepsReused, 2);
	assert.equal(metrics.stepsRepeated, 0);
	assert.equal(metrics.taskReplays, 0);
	assert.deepEqual(metrics.duplicatedEffects, []);
	assert.equal(metrics.recoveriesConsumed, 1);
	assert.equal(metrics.interruptedFacts, 1);
});

test("a step repeated inside the same attempt is still a repeat", () => {
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s2b",
		mechanism: "C",
		label: "C-safe+guard",
		guardrails: true,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(1, "attempt-opened", { attemptId: "attempt-1", round: 1, confirmed: [], interrupted: [] }),
			entry(2, "tool-task", { step: 4, callId: "call-a", round: 1 }),
			entry(3, "step-performed", { attemptId: "attempt-1", round: 1, step: 4 }),
			entry(4, "tool-task", { step: 4, callId: "call-a", round: 1 }),
			entry(5, "step-performed", { attemptId: "attempt-1", round: 1, step: 4 }),
			entry(6, "worker-exit", { code: 0 }),
			entry(7, "attempt-completed", { attemptId: "attempt-1" }),
		],
		world: world(),
		recovery: { consumed: 0, events: [] },
		exitCodes: [0],
	});
	assert.equal(metrics.stepsRepeated, 1, "the second execution of step 4 is a repeat");
	assert.equal(metrics.taskReplays, 1, "the same call id running twice is a replay");
});

test("recovery time is the wall time from the interruption to the next attempt", () => {
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s2",
		mechanism: "B",
		label: "B+guard",
		guardrails: true,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(10, "attempt-opened", { attemptId: "attempt-1", round: 1, confirmed: [], interrupted: [] }),
			entry(100, "kill-between-steps", { step: 5 }),
			entry(1_000, "recover-from-confirmed", { waitMs: 1000 }),
			entry(1_500, "attempt-opened", { attemptId: "attempt-1", round: 1, confirmed: [1, 2, 3, 4], interrupted: [] }),
		],
		world: world(),
		recovery: { consumed: 1, events: [] },
		exitCodes: [0],
	});
	assert.equal(metrics.recoveryWaitMs, 1000);
	assert.equal(metrics.recoveryTimeMs, 1_400);
	assert.equal(metrics.stepsReused, 4);
});

test("a recorded interruption and an inferred one are counted apart", () => {
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s3",
		mechanism: "C",
		label: "C-sqlite+guard",
		guardrails: true,
		repeat: 1,
		journal: [
			entry(0, "attempt-settled", { attemptId: "attempt-1", round: 1, interrupted: [6], interruptedFactKind: "recorded" }),
			entry(1, "attempt-settled", { attemptId: "attempt-1", round: 1, interrupted: [6], interruptedFactKind: "inferred" }),
		],
		world: world(),
		recovery: { consumed: 0, events: [] },
		exitCodes: [0],
	});
	assert.equal(metrics.interruptedFactsRecorded, 1);
	assert.equal(metrics.interruptedFactsInferred, 1);
});

test("two overlapping workers and a help request are both visible", () => {
	const metrics = computeMetrics({
		runId: "r",
		scenario: "s1",
		mechanism: "A",
		label: "A-noguard",
		guardrails: false,
		repeat: 1,
		journal: [
			entry(0, "worker-spawned", { attemptId: "attempt-1", pid: 1 }),
			entry(1, "worker-spawned", { attemptId: "attempt-2", pid: 2 }),
			entry(2, "worker-exit", { code: 0 }),
			entry(3, "help-requested", { reason: "ambiguous-effect" }),
		],
		world: world(),
		recovery: { consumed: 0, events: [] },
		exitCodes: [30],
	});
	assert.equal(metrics.simultaneousWorkers, 2);
	assert.equal(metrics.helpRequests, 1);
	assert.equal(metrics.outcome, "help");
});
