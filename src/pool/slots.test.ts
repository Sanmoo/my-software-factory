import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { Slots } from "./slots.js";

describe("slots — the y worker slots in process, pool in memory", () => {
  test("starts empty with the configured capacity (the y)", () => {
    const slots = new Slots(2);
    assert.equal(slots.capacity, 2);
    assert.equal(slots.inFlight, 0);
    assert.equal(slots.free, 2);
    assert.ok(!slots.full);
  });

  test("acquire up to y, then the slots are full", () => {
    const slots = new Slots(2);
    assert.ok(slots.tryAcquire("Sanmoo/a#1"));
    assert.ok(slots.tryAcquire("Sanmoo/a#2"));
    assert.ok(slots.full);
    assert.ok(!slots.tryAcquire("Sanmoo/a#3"));
    assert.equal(slots.inFlight, 2);
  });

  test("release frees the slot for immediate replenishment", () => {
    const slots = new Slots(1);
    slots.tryAcquire("Sanmoo/a#1");
    slots.release("Sanmoo/a#1");
    assert.equal(slots.inFlight, 0);
    assert.ok(slots.tryAcquire("Sanmoo/b#9"));
  });

  test("the same work cannot hold two slots", () => {
    const slots = new Slots(3);
    assert.ok(slots.tryAcquire("Sanmoo/a#1"));
    assert.ok(!slots.tryAcquire("Sanmoo/a#1"));
  });

  test("releasing an unknown work is a no-op, not an error", () => {
    const slots = new Slots(1);
    slots.release("Sanmoo/a#404");
    assert.equal(slots.inFlight, 0);
  });

  test("zero capacity means no slot ever (idle factory)", () => {
    const slots = new Slots(0);
    assert.ok(slots.full);
    assert.ok(!slots.tryAcquire("Sanmoo/a#1"));
  });
});
