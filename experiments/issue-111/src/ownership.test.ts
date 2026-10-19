import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Ownership, OwnershipConflict, isProcessAlive } from "./ownership.js";

const fresh = () => mkdtempSync(join(tmpdir(), "msf111-own-"));

test("a free work dir can be acquired, and a second owner is refused", () => {
	const dir = fresh();
	const ownership = new Ownership(dir, () => 1000, () => true);
	assert.equal(ownership.inspectOwner().state, "free");
	assert.equal(ownership.acquire("owner-1", "attempt-1").result, "acquired");

	// A second process must not open the state or launch a substitute.
	const second = ownership.acquire("owner-2", "attempt-1");
	assert.equal(second.result, "held");
	assert.equal(second.result === "held" ? second.owner.ownerId : undefined, "owner-1");
});

test("a record whose controller died is stale and can be taken over, keeping the attempt", () => {
	const dir = fresh();
	const deadController: number[] = [];
	const alive = (pid: number) => deadController.includes(pid);
	const first = new Ownership(dir, () => 1000, alive);
	first.acquire("owner-1", "attempt-7");
	const state = first.inspectOwner();
	assert.equal(state.state, "stale");

	const second = new Ownership(dir, () => 2000, alive);
	const taken = second.takeover("owner-2");
	assert.equal(taken.ownerId, "owner-2");
	assert.equal(taken.attemptId, "attempt-7", "an interruption does not start a new attempt");
	assert.equal(taken.startedAt, 1000, "the attempt's start survives the takeover");
});

test("a live owner cannot be taken over", () => {
	const dir = fresh();
	const ownership = new Ownership(dir, () => 1000, () => true);
	ownership.acquire("owner-1", "attempt-1");
	assert.throws(() => ownership.takeover("owner-2"), OwnershipConflict);
});

test("a surviving worker is recognized, and blocks opening the state as a new owner", () => {
	const dir = fresh();
	const ownership = new Ownership(dir, () => 1000, () => true);
	ownership.acquire("owner-1", "attempt-1");
	ownership.recordWorker("attempt-1", 4242);

	assert.equal(ownership.liveWorker()?.pid, 4242);
	assert.throws(() => ownership.guardBeforeOpen("owner-2"), OwnershipConflict);
	// The owner itself may keep working.
	ownership.guardBeforeOpen("owner-1");
});

test("a worker whose process is gone is not a live worker", () => {
	const dir = fresh();
	const alive = (pid: number) => pid === process.pid;
	const ownership = new Ownership(dir, () => 1000, alive);
	ownership.acquire("owner-1", "attempt-1");
	ownership.recordWorker("attempt-1", 999_999);
	assert.equal(ownership.liveWorker(), undefined);
	ownership.clearWorker();
	assert.equal(ownership.worker(), undefined);
});

test("heartbeats move the ownership record forward", () => {
	const dir = fresh();
	const ownership = new Ownership(dir, () => 1000, () => true);
	ownership.acquire("owner-1", "attempt-1");
	ownership.heartbeat(5000);
	assert.equal(ownership.owner()?.heartbeatAt, 5000);
});

test("liveness is asked of the OS, not inferred from the file", () => {
	assert.equal(isProcessAlive(process.pid), true);
	assert.equal(isProcessAlive(0), false);
	assert.equal(isProcessAlive(-1), false);
	assert.equal(isProcessAlive(2 ** 30), false);
});
