import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COOPERATIVE_STOP_MS, installStopSignals } from "./stop-signals.js";

/**
 * The operator's stop signals (issue #146): the first Ctrl-C or SIGTERM closes
 * admissions and requests the cooperative stop; the second of either escalates.
 * The guarantee must be identical for both signals — a process manager stops
 * the factory exactly as Ctrl-C does — and the handlers must be detachable so
 * the run's window is the lock's window.
 */

describe("the stop signals — first request, second escalation, both signals", () => {
  function withSignals(run: (installed: ReturnType<typeof installStopSignals>) => Promise<void>) {
    return async (): Promise<void> => {
      const installed = installStopSignals();
      try {
        await run(installed);
      } finally {
        installed.dispose();
      }
    };
  }

  test(
    "SIGINT requests the stop once and escalates on the second",
    withSignals(async (installed) => {
      assert.equal(installed.requested.aborted, false);
      process.emit("SIGINT");
      assert.equal(installed.requested.aborted, true);
      assert.equal(installed.escalated.aborted, false, "the first signal never escalates");
      process.emit("SIGINT");
      assert.equal(installed.escalated.aborted, true, "the second signal escalates");
    }),
  );

  test(
    "SIGTERM carries the same contract — and escalates a stop first requested by SIGINT",
    withSignals(async (installed) => {
      process.emit("SIGTERM");
      assert.equal(installed.requested.aborted, true);
      assert.equal(installed.escalated.aborted, false);
      process.emit("SIGTERM");
      assert.equal(installed.escalated.aborted, true);

      const other = installStopSignals();
      try {
        process.emit("SIGINT");
        process.emit("SIGTERM");
        assert.equal(other.escalated.aborted, true, "a mixed pair still escalates");
      } finally {
        other.dispose();
      }
    }),
  );

  test(
    "dispose detaches the handlers: a later signal does nothing",
    withSignals(async (installed) => {
      installed.dispose();
      process.emit("SIGINT");
      assert.equal(installed.requested.aborted, false);
    }),
  );

  test("the cooperative window is ten seconds, one budget for the whole run", () => {
    assert.equal(COOPERATIVE_STOP_MS, 10_000);
  });
});
