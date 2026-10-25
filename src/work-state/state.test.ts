import assert from "node:assert/strict";
import { test } from "node:test";

import { STATE_DECLARATIONS, consentAppliesTo, type StateDeclaration, type WorkStateReading } from "./state.js";

/**
 * The declarations that replace the loop's three hand-maintained tables
 * (ticket #200, AC2). The compile-time half of this test is the `satisfies` on
 * STATE_DECLARATIONS: a state added to the union without its three properties —
 * or declared here without existing in the union — does not compile. What the
 * test below pins is the content: the vocabulary and the values carried over
 * from `state/derive.ts` + `src/loop.ts`, state by state.
 */

/** The one vocabulary: 18 state strings over 19 members (`fall` has two). */
const STATES = [
  "done",
  "done-fallback",
  "rejected",
  "feedback",
  "repair",
  "repair-recovered",
  "repair-blocked",
  "repair-fall-blocked",
  "resumable",
  "parked",
  "fall",
  "interrupted",
  "stop-resume",
  "stop-unconfirmed",
  "model-provider-failure",
  "continuity-paused",
  "unreadable",
  "not-planned",
] as const satisfies readonly WorkStateReading["state"][];

test("every state of the union declares its three properties, and nothing else does", () => {
  assert.deepEqual(Object.keys(STATE_DECLARATIONS).sort(), [...STATES].sort());
  assert.equal(STATES.length, 18, "the two names that lied became three honest ones");

  for (const state of STATES) {
    const declaration: StateDeclaration = STATE_DECLARATIONS[state];
    assert.equal(typeof declaration.terminalForConsent, "boolean", `${state}: terminal-for-consent`);
    assert.equal(typeof declaration.holdsWhileLivenessUnknown, "boolean", `${state}: waits for liveness`);
    assert.ok(
      declaration.announces === null || typeof declaration.announces === "string",
      `${state}: announces an operational class, or that it leaves`,
    );
  }
});

test("the vocabulary says what the facts are: `idle` is parked and `unknown` split in two", () => {
  for (const gone of ["idle", "unknown"]) {
    assert.equal(gone in STATE_DECLARATIONS, false, `\`${gone}\` must not survive: it named two different facts`);
  }
  assert.equal("parked" in STATE_DECLARATIONS, true);
  assert.equal("unreadable" in STATE_DECLARATIONS, true, "the ticket could not be read");
  assert.equal("not-planned" in STATE_DECLARATIONS, true, "the ticket was read and is closed as not-planned");
});

test("consent never reopens a terminal state or a work a worker may still carry", () => {
  const terminal = STATES.filter((state) => STATE_DECLARATIONS[state].terminalForConsent);

  assert.deepEqual(terminal.sort(), ["done", "done-fallback", "rejected", "stop-unconfirmed"]);
  for (const state of STATES) {
    assert.equal(consentAppliesTo(state), !terminal.includes(state), `${state}: consent must ${terminal.includes(state) ? "not " : ""}apply`);
  }
  assert.equal(consentAppliesTo("repair-fall-blocked"), true, "the state that stranded an authorization (issue #128)");
});

test("the class a state contributes: the two dones leave, two speak their own class, the rest are reserved", () => {
  const announced = Object.fromEntries(STATES.map((state) => [state, STATE_DECLARATIONS[state].announces]));

  assert.deepEqual(announced, {
    done: null,
    "done-fallback": null,
    rejected: "reserved",
    feedback: "feedback",
    repair: "reserved",
    "repair-recovered": "reserved",
    "repair-blocked": "reserved",
    "repair-fall-blocked": "reserved",
    resumable: "resumable",
    parked: "reserved",
    fall: "reserved",
    interrupted: "reserved",
    "stop-resume": "reserved",
    "stop-unconfirmed": "reserved",
    "model-provider-failure": "reserved",
    "continuity-paused": "reserved",
    unreadable: "reserved",
    "not-planned": "reserved",
  });
});

test("the states that presume a worker stopped wait while liveness cannot be read", () => {
  const holds = STATES.filter((state) => STATE_DECLARATIONS[state].holdsWhileLivenessUnknown);

  assert.deepEqual(holds.sort(), [
    "continuity-paused",
    "done",
    "done-fallback",
    "fall",
    "interrupted",
    "model-provider-failure",
    "rejected",
    "repair-blocked",
    "repair-fall-blocked",
  ]);
});
