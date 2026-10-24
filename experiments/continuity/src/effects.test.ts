import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ExternalWorld, writeExternalWorld } from "./effects.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "msf111-eff-")), "external.jsonl");

test("nothing recorded means the effect can be performed", () => {
	const world = new ExternalWorld(fresh());
	assert.equal(world.evidence("open-pr"), "absent");
});

test("a recorded mutation is present evidence, and duplicates are visible", () => {
	const path = fresh();
	const world = new ExternalWorld(path);
	world.perform("open-pr", 6, "attempt-1");
	assert.equal(world.evidence("open-pr"), "present");
	assert.deepEqual(world.duplicatedEffects(), []);

	world.perform("open-pr", 6, "attempt-1");
	assert.deepEqual(world.duplicatedEffects(), ["open-pr"]);
});

test("a torn write is ambiguous evidence, never absent", () => {
	const path = fresh();
	const world = new ExternalWorld(path);
	world.performAmbiguous("push-branch", 3, "attempt-1");
	assert.equal(world.evidence("push-branch"), "ambiguous");
});

test("a torn line next to an intact one still reads as present", () => {
	const path = fresh();
	const world = new ExternalWorld(path);
	world.perform("push-branch", 3, "attempt-1");
	world.performAmbiguous("push-branch", 3, "attempt-1");
	assert.equal(world.evidence("push-branch"), "present");
});

test("an unreadable line for another effect does not decide this one", () => {
	const path = fresh();
	const world = new ExternalWorld(path);
	writeExternalWorld(path, ['{"effectId":"other","mutationId":"x"}', '{"effectId":"push-br']);
	assert.equal(world.evidence("open-pr"), "absent");
});

test("every asked-for mutation is kept, so a repeat is countable", () => {
	const world = new ExternalWorld(fresh());
	world.perform("open-pr", 6, "attempt-1");
	world.perform("open-pr", 6, "attempt-1");
	world.perform("open-pr", 6, "attempt-2");
	assert.equal(world.mutations("open-pr").length, 3);
});
