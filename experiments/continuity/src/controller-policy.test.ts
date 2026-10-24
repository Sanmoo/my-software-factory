import assert from "node:assert/strict";
import test from "node:test";
import { decideRecovery, type ControllerState, type MechanismKind } from "./controller-policy.js";
import type { OwnerRecord, WorkerRecord } from "./ownership.js";

const owner: OwnerRecord = {
	ownerId: "owner-1",
	controllerPid: 111,
	attemptId: "attempt-1",
	startedAt: 0,
	heartbeatAt: 0,
};
const staleOwner = { state: "stale", owner } as const;
const liveOwner = { state: "live", owner } as const;
const worker: WorkerRecord = { pid: 222, attemptId: "attempt-1", startedAt: 0, heartbeatAt: 0 };
const free = { state: "free" } as const;

const recoverable = { decision: "recover", index: 0, waitMs: 1000, consumed: 0 } as const;
const exhausted = { decision: "pause-help", reason: "recovery budget exhausted", consumed: 3 } as const;

const state = (overrides: Partial<ControllerState> & { mechanism: MechanismKind }): ControllerState => ({
	owner: staleOwner,
	liveWorker: undefined,
	workerRunning: false,
	stateUnusable: false,
	anotherOwner: false,
	attemptDrops: 0,
	budget: recoverable,
	...overrides,
});

test("a surviving worker is attached to, never duplicated", () => {
	assert.deepEqual(decideRecovery(state({ mechanism: "B", owner: liveOwner, liveWorker: worker })), {
		action: "attach-live-worker",
		workerPid: 222,
	});
	assert.deepEqual(decideRecovery(state({ mechanism: "C", owner: liveOwner, liveWorker: worker })), {
		action: "attach-live-worker",
		workerPid: 222,
	});
	assert.deepEqual(decideRecovery(state({ mechanism: "C", liveWorker: worker })), {
		action: "attach-live-worker",
		workerPid: 222,
	});
});

test("A, as it exists, launches a second worker against work already in flight", () => {
	assert.deepEqual(decideRecovery(state({ mechanism: "A", liveWorker: worker })), { action: "relaunch-new-attempt" });
});

test("B and C resume the same attempt from the last confirmed checkpoint", () => {
	for (const mechanism of ["B", "C"] as const) {
		assert.deepEqual(decideRecovery(state({ mechanism })), { action: "rebuild-from-confirmed", waitMs: 1000 });
	}
});

test("A consumes an attempt for an infrastructure interruption, then blocks", () => {
	assert.deepEqual(decideRecovery(state({ mechanism: "A", attemptDrops: 0 })), { action: "relaunch-new-attempt" });
	assert.deepEqual(decideRecovery(state({ mechanism: "A", attemptDrops: 1 })), {
		action: "pause-help",
		reason: "second consecutive interrupted attempt without outcome",
	});
});

test("B and C never consume an attempt for an interruption", () => {
	for (const mechanism of ["B", "C"] as const) {
		const action = decideRecovery(state({ mechanism, attemptDrops: 5 }));
		assert.equal(action.action, "rebuild-from-confirmed");
	}
});

test("invalid state asks for help instead of being read as failure", () => {
	for (const mechanism of ["B", "C"] as const) {
		assert.deepEqual(decideRecovery(state({ mechanism, stateUnusable: true })), {
			action: "pause-help",
			reason: "persisted state is missing or invalid",
		});
	}
});

test("an exhausted budget pauses and asks for help", () => {
	for (const mechanism of ["A", "B", "C"] as const) {
		const action = decideRecovery(state({ mechanism, attemptDrops: 0, budget: exhausted }));
		assert.equal(action.action, mechanism === "A" ? "relaunch-new-attempt" : "pause-help");
	}
	assert.equal(decideRecovery(state({ mechanism: "B", budget: exhausted })).action, "pause-help");
});

test("a second owner stops everything, whatever the mechanism", () => {
	for (const mechanism of ["A", "B", "C"] as const) {
		const action = decideRecovery(state({ mechanism, anotherOwner: true }));
		assert.equal(action.action, "pause-help");
		assert.match(action.action === "pause-help" ? action.reason : "", /another owner/);
	}
});

test("a free work dir resumes from confirmed progress without another owner", () => {
	assert.deepEqual(decideRecovery(state({ mechanism: "C", owner: free })), {
		action: "rebuild-from-confirmed",
		waitMs: 1000,
	});
});
