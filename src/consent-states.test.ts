import assert from "node:assert/strict";
import { test } from "node:test";
import { consentAppliesTo } from "./loop.js";

/**
 * A retry authorization answers a pause; the round the factory planned
 * meanwhile never outranks it. The regression this locks: an interrupted
 * attempt on a work whose repair cycle had already fallen twice derives to
 * `repair-fall-blocked`, and a whitelist that forgot it stranded a valid
 * authorization forever (real incident on #128).
 */
const DERIVATION_STATES = [
  "done",
  "done-fallback",
  "rejected",
  "idle",
  "fall",
  "interrupted",
  "model-provider-failure",
  "stop-resume",
  "stop-unconfirmed",
  "continuity-paused",
  "feedback",
  "resumable",
  "repair",
  "repair-recovered",
  "repair-blocked",
  "repair-fall-blocked",
  "unknown",
] as const;

test("consent never reopens a terminal state or a work a worker may still carry", () => {
  for (const state of DERIVATION_STATES) {
    const terminal = ["done", "done-fallback", "rejected", "stop-unconfirmed"].includes(state);
    assert.equal(consentAppliesTo(state), !terminal, `${state}: consent must ${terminal ? "not " : ""}apply`);
  }
  assert.equal(consentAppliesTo("repair-fall-blocked"), true, "the state that stranded the authorization");
  assert.equal(consentAppliesTo("repair-blocked"), true);
});
