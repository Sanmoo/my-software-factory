import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryLedger } from "./recovery.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "msf-continuity-rec-")), "recovery.json");
const policy = { maxRecoveries: 3, waitsMs: [1, 4, 16] };

test("recoveries wait by the fixed schedule and stop at the budget", () => {
	const ledger = new RecoveryLedger(fresh(), policy, () => 1000);
	assert.deepEqual(
		[1, 2, 3].map(() => {
			const decision = ledger.consume("worker-interrupted");
			return decision.decision === "recover" ? decision.waitMs : decision.decision;
		}),
		[1, 4, 16],
	);

	const exhausted = ledger.consume("worker-interrupted");
	assert.equal(exhausted.decision, "pause-help");
	assert.match(exhausted.decision === "pause-help" ? exhausted.reason : "", /budget exhausted after 3 recoveries/);
	assert.equal(ledger.state().consumed, 3, "an exhausted budget is not consumed further");
});

test("the count survives a new process, so recovery cannot loop forever", () => {
	const path = fresh();
	new RecoveryLedger(path, policy, () => 1000).consume("first");

	const next = new RecoveryLedger(path, policy, () => 2000);
	assert.equal(next.state().consumed, 1);
	const peeked = next.peek("second");
	assert.equal(peeked.decision, "recover");
	assert.equal(peeked.decision === "recover" ? peeked.waitMs : -1, 4);
});

test("peek reports the cost without spending it", () => {
	const ledger = new RecoveryLedger(fresh(), policy, () => 1000);
	ledger.peek("x");
	ledger.peek("x");
	assert.equal(ledger.state().consumed, 0);
});
