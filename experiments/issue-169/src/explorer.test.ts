import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { exploreAll, VARIANTS, type VariantReport } from "./explorer.js";

const reports = new Map<string, VariantReport>(exploreAll().map((report) => [report.name, report]));

function report(name: string): VariantReport {
  const found = reports.get(name);
  assert.ok(found !== undefined, `missing variant ${name}`);
  return found;
}

function indexOf(trace: string[], event: string): number {
  return trace.indexOf(event);
}

describe("interleaving matrix: documented semantics", () => {
  test("two non-isolated jobs can both commit and both verify their own write: 2 authorized Workers", () => {
    const variant = report("documented-apply-not-isolated");
    assert.equal(variant.runs, 3432);
    assert.equal(variant.twoWinners, 200);
    assert.equal(variant.oneWinner, 3232);
    assert.equal(variant.noWinner, 0);
    const trace = variant.examples.twoWinners;
    assert.ok(trace !== undefined);
    assert.deepEqual(trace.winners.sort((a, b) => a.localeCompare(b)), ["factory-a", "factory-b"]);
    assert.deepEqual(trace.attempts, { "factory-a": 1, "factory-b": 1 });
    // The race: A verifies and launches before B's commit overwrites the value.
    assert.ok(indexOf(trace.events, "A:launch") < indexOf(trace.events, "B:commit"));
    assert.ok(indexOf(trace.events, "B:commit") < indexOf(trace.events, "B:verify"));
  });

  test("an enqueue-time eligibility snapshot defeats serialized writes", () => {
    const variant = report("documented-enqueue-serialized");
    assert.equal(variant.runs, 924);
    assert.equal(variant.twoWinners, 60);
  });

  test("the documented stale search does not remove the race", () => {
    const variant = report("documented-stale-search");
    assert.equal(variant.twoWinners, 200);
  });

  test("stale verification reads cannot reduce the two-winner count below zero", () => {
    const variant = report("documented-apply-prefix-reads");
    assert.equal(variant.twoWinners, 0);
    assert.ok(variant.noWinner > 0, "stale reads turn races into uncertainty, not into authority");
  });
});

describe("interleaving matrix: the CAS premise", () => {
  for (const name of ["cas-premise", "cas-premise-stale-search", "cas-premise-task-counts"]) {
    test(`${name}: no interleaving authorizes two Workers, and a free Ticket still progresses`, () => {
      const variant = report(name);
      assert.equal(variant.premise, "premise");
      assert.equal(variant.twoWinners, 0);
      assert.ok(variant.oneWinner > 0, "the premise must not reject every acquisition");
      assert.equal(variant.oneWinner + variant.twoWinners + variant.noWinner, variant.runs);
    });
  }

  test("cas-premise covers every linear extension: exactly one winner in all 924", () => {
    const variant = report("cas-premise");
    assert.equal(variant.runs, 924);
    assert.equal(variant.oneWinner, 924);
    assert.equal(variant.noWinner, 0);
  });

  test("with stale verification reads, safety survives and progress is lost to uncertainty", () => {
    const variant = report("cas-premise-prefix-reads");
    assert.equal(variant.runs, 924);
    assert.equal(variant.twoWinners, 0);
    assert.equal(variant.oneWinner, 0);
    assert.equal(variant.noWinner, 924);
  });
});

describe("matrix honesty", () => {
  test("every variant is labelled documented or premise and carries its note", () => {
    for (const variant of VARIANTS) {
      assert.ok(variant.name.length > 0);
      assert.ok(variant.note.length > 0);
      assert.ok(variant.premise === "documented" || variant.premise === "premise");
    }
  });

  test("no documented variant is silently relabelled as a premise", () => {
    assert.equal(report("documented-apply-not-isolated").premise, "documented");
    assert.equal(report("documented-enqueue-serialized").premise, "documented");
    assert.equal(report("cas-premise").premise, "premise");
  });

  test("the model's two-winner trace is not an artifact of a hidden queue: the requests are two separate jobs", () => {
    const trace = report("documented-apply-not-isolated").examples.twoWinners;
    assert.ok(trace !== undefined);
    const scheduled = trace.requests.filter((line) => line.includes("PUT bulk issue property") && line.includes("scheduled"));
    assert.equal(scheduled.length, 2);
    assert.ok(trace.requests.some((line) => line.startsWith("factory-a GET issue property -> present")));
    assert.ok(trace.requests.some((line) => line.startsWith("factory-b GET issue property -> present")));
  });
});
