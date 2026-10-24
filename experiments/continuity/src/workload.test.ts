import assert from "node:assert/strict";
import test from "node:test";
import { WORKLOAD, WORKLOAD_STEPS, stepAt } from "./workload.js";

test("the workload is fixed at eight steps with two external effects", () => {
	assert.equal(WORKLOAD_STEPS, 8);
	assert.deepEqual(
		WORKLOAD.map((step) => step.index),
		[1, 2, 3, 4, 5, 6, 7, 8],
	);
	assert.deepEqual(
		WORKLOAD.filter((step) => step.kind === "effect").map((step) => step.effectId),
		["push-branch", "open-pr"],
	);
});

test("effects have identities and analyze steps do not", () => {
	assert.equal(stepAt(3).effectId, "push-branch");
	assert.equal(stepAt(6).effectId, "open-pr");
	assert.equal(stepAt(1).effectId, undefined);
	assert.throws(() => stepAt(9));
});
