import assert from "node:assert/strict";
import { test } from "node:test";

import { mapBounded } from "./concurrency.js";

/** A gate an operation waits on, so the test decides when it completes. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let every worker that can start do so before the test observes them. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the results keep the input order even when the work finishes in reverse", async () => {
  const gates = new Map<number, ReturnType<typeof gate>>();
  const running = mapBounded([1, 2, 3], 3, async (item) => {
    const itemGate = gate();
    gates.set(item, itemGate);
    await itemGate.wait;
    return item * 10;
  });

  await settle();
  for (const item of [3, 2, 1]) gates.get(item)!.open();

  assert.deepEqual(await running, [10, 20, 30]);
});

test("at most `limit` operations are in flight at once", async () => {
  const gates = new Map<number, ReturnType<typeof gate>>();
  let inFlight = 0;
  let peak = 0;
  const running = mapBounded([1, 2, 3, 4, 5], 2, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const itemGate = gate();
    gates.set(item, itemGate);
    await itemGate.wait;
    inFlight -= 1;
    return item;
  });

  await settle();
  assert.equal(peak, 2, "only the limit started; the rest wait for a slot");
  for (const item of [1, 2, 3, 4, 5]) {
    gates.get(item)!.open();
    await settle();
  }

  assert.deepEqual(await running, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2, "the bound holds for the whole run");
});

test("an empty input resolves without running anything", async () => {
  let calls = 0;
  const results = await mapBounded([], 4, async () => {
    calls += 1;
    return 0;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("a limit that cannot bound anything is refused", async () => {
  await assert.rejects(mapBounded([1], 0, async (item) => item), RangeError);
});
