import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderWaits } from "./waits.js";

/**
 * The waits vocabulary shared by the recovery and model-provider decisions:
 * both render the configured backoff with the same rule, so one
 * ledger's decision never has to import the other's module.
 */
describe("the waits in the operator's words", () => {
  test("whole seconds keep their seconds and sub-second waits keep their milliseconds", () => {
    assert.equal(renderWaits([1_000, 4_000, 16_000]), "1s/4s/16s");
    assert.equal(renderWaits([250, 1_500]), "250ms/1500ms", "a configured 250 ms is never reported as \"0s\"");
  });

  test("the rendered schedule follows the configured order", () => {
    assert.equal(renderWaits([15_000, 30_000, 60_000, 120_000]), "15s/30s/60s/120s");
  });
});
