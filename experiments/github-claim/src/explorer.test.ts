import assert from "node:assert/strict";
import test from "node:test";
import { exploreAll, READ_PROFILES, progress, safe, type ExploreResult } from "./explorer.js";
import { claimSequence, conversationLock, currentMark, minLabel, PROTOCOLS, strictUnique } from "./protocols.js";

const results = exploreAll(PROTOCOLS);

function result(protocol: { name: string }, profileName: string): ExploreResult {
  const found = results.find(
    (entry) => entry.protocol === protocol.name && entry.profile === profileName,
  );
  assert.ok(found, `missing result for ${protocol.name}/${profileName}`);
  return found;
}

test("every read/id model in the matrix is explored", () => {
  assert.equal(results.length, PROTOCOLS.length * READ_PROFILES.length);
  for (const entry of results) assert.ok(entry.traces > 0);
});

test("the current padlock+assignment mark authorizes both factories even with fresh reads", () => {
  for (const profile of READ_PROFILES) {
    assert.equal(safe(result(currentMark, profile.name)), false, profile.name);
  }
  const linearizable = result(currentMark, "linearizable");
  assert.equal(linearizable.twoOrMore, linearizable.traces);
});

test("the conversation lock authorizes both factories even with fresh reads", () => {
  const linearizable = result(conversationLock, "linearizable");
  assert.equal(safe(linearizable), false);
  assert.equal(linearizable.twoOrMore, linearizable.traces);
});

test("a client-chosen min label is superseded by a later smaller key", () => {
  assert.equal(safe(result(minLabel, "linearizable")), false);
  assert.ok(result(minLabel, "linearizable").twoOrMore > 0);
});

test("the strict 'no other claim' rule is safe under consistent reads but can deadlock", () => {
  assert.equal(safe(result(strictUnique, "linearizable")), true);
  assert.equal(safe(result(strictUnique, "prefix+ordered")), true);
  assert.equal(progress(result(strictUnique, "linearizable")), true);
  assert.ok(result(strictUnique, "linearizable").zeroWorkers > 0);
});

test("hiding two already-applied writes also breaks the strict rule", () => {
  assert.equal(safe(result(strictUnique, "holey+ordered")), false);
  assert.equal(safe(result(strictUnique, "holey+unordered")), false);
});

test("the claim sequence is safe and always finds a winner under fresh ordered reads", () => {
  const linearizable = result(claimSequence, "linearizable");
  assert.equal(safe(linearizable), true);
  assert.equal(linearizable.oneWorker, linearizable.traces);
  assert.equal(linearizable.zeroWorkers, 0);
});

test("the claim sequence is safe under prefix visibility with provider-ordered ids", () => {
  const prefix = result(claimSequence, "prefix+ordered");
  assert.equal(safe(prefix), true);
  assert.equal(progress(prefix), true);
});

test("the claim sequence is unsafe without the provider-assigned id order", () => {
  const unordered = result(claimSequence, "fresh+unordered");
  assert.equal(safe(unordered), false);
  assert.ok(unordered.twoOrMore > 0);
});

test("the claim sequence is unsafe when a read can omit an applied claim", () => {
  const holey = result(claimSequence, "holey+ordered");
  assert.equal(safe(holey), false);
  assert.ok(holey.twoOrMore > 0);
  assert.equal(safe(result(claimSequence, "holey+unordered")), false);
});
