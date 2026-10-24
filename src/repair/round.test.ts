import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalWorkFacts } from "../git/port.js";
import type { Known, PrRepairFacts } from "../tracker/port.js";
import { githubRepository, githubTicket, workIdentity } from "../tracker/identity.js";
import {
  EMPTY_REPAIR_CYCLE,
  type RepairAttempt,
  type RepairCycle,
} from "../pool/repair.js";
import {
  confirmRepairRound,
  openRepairRound,
  readRepairPremise,
  repairOpening,
  repairSignature,
  returnUnstartedRound,
  settleRepairRound,
} from "./round.js";

/**
 * One Repair round tested at its own seam (issue #186, stories 11-13): the
 * module is fed the trigger, the cycle and the OBSERVATIONS (remote head, local
 * work, premise), so opening and settling are deterministic and the distinction
 * between an obsolete premise and a concurrent change is decided without a
 * factory, a worker or a git host.
 */

const WORK = workIdentity(githubTicket("Sanmoo/repair-seam", 9), githubRepository("Sanmoo/repair-seam"));

const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OBSERVED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRODUCED = "cccccccccccccccccccccccccccccccccccccccc";
const COLLABORATOR = "dddddddddddddddddddddddddddddddddddddddd";

function prFacts(overrides: Partial<PrRepairFacts> = {}): PrRepairFacts {
  return {
    number: 9,
    headBranch: "agent-issue-9",
    baseBranch: "main",
    headSha: OBSERVED,
    baseSha: BASE,
    mergeState: "conflicting",
    requiredChecks: null,
    ...overrides,
  } as PrRepairFacts;
}

function known(facts: PrRepairFacts): Known<PrRepairFacts> {
  return { known: true, value: facts };
}

const LOCAL: LocalWorkFacts = {
  headSha: PRODUCED,
  commits: 2,
  uncommitted: false,
  operationInProgress: null,
};

function attempt(overrides: Partial<RepairAttempt> = {}): RepairAttempt {
  return {
    evidence: "signature",
    attempt: 3,
    observedHeadSha: OBSERVED,
    remoteHeadSha: null,
    publication: "unknown",
    localWork: null,
    ...overrides,
  };
}

function cycle(overrides: Partial<RepairCycle> = {}): RepairCycle {
  return { ...EMPTY_REPAIR_CYCLE, ...overrides };
}

test("a confirmed trigger opens a round pinned to the head its evidence was read on", () => {
  const reading = readRepairPremise(known(prFacts()));
  assert.equal(reading.premise, "persisting");
  const verdict = openRepairRound({
    work: WORK,
    trigger: reading.premise === "persisting" ? reading.trigger : null,
    facts: known(prFacts()),
    cycle: cycle(),
  });

  assert.equal(verdict.kind, "open");
  if (verdict.kind !== "open") return;
  assert.equal(verdict.round.pinnedHeadSha, OBSERVED);
  assert.equal(verdict.round.baseBranch, "main");
  assert.equal(verdict.round.resuming, null);
});

test("the same evidence is never a new round, and an exhausted budget blocks", () => {
  const trigger = readRepairPremise(known(prFacts()));
  assert.equal(trigger.premise, "persisting");
  if (trigger.premise !== "persisting") return;
  const signature = openRepairRound({ work: WORK, trigger: trigger.trigger, facts: known(prFacts()), cycle: cycle() });
  assert.equal(signature.kind, "open");
  if (signature.kind !== "open") return;
  const consumed = repairSignature(WORK, trigger.trigger);

  const wait = openRepairRound({
    work: WORK,
    trigger: trigger.trigger,
    facts: known(prFacts()),
    cycle: cycle({ usedRounds: 1, lastEvidence: consumed }),
  });
  assert.deepEqual(wait, { kind: "wait", because: "evidence-consumed" });

  const blocked = openRepairRound({
    work: WORK,
    trigger: trigger.trigger,
    facts: known(prFacts()),
    cycle: cycle({ usedRounds: 2, lastEvidence: consumed }),
  });
  assert.equal(blocked.kind, "block");
});

test("a pending publication holds the round: no worker and no budget return", () => {
  const verdict = openRepairRound({
    work: WORK,
    trigger: null,
    facts: known(prFacts({ mergeState: "mergeable", requiredChecks: [] })),
    cycle: cycle({ usedRounds: 1, attempt: attempt({ publication: "pending" }) }),
  });
  assert.deepEqual(verdict, { kind: "wait", because: "pending-reconciliation" });
});

test("a clean PR with a repair cycle recovers the budget", () => {
  const verdict = openRepairRound({
    work: WORK,
    trigger: null,
    facts: known(prFacts({ mergeState: "mergeable", requiredChecks: [{ name: "ci", status: "completed", conclusion: "success" }] })),
    cycle: cycle({ usedRounds: 1 }),
  });
  assert.deepEqual(verdict, { kind: "recovered" });
});

test("an obsolete premise returns the round unspent", () => {
  const reading = readRepairPremise(known(prFacts({ mergeState: "mergeable", requiredChecks: [] })));
  const verdict = confirmRepairRound({
    round: repairOpening(
      { reasons: ["conflicts"], facts: prFacts(), failingChecks: [] },
      null,
    ),
    reading,
    remote: { known: true, headSha: OBSERVED },
  });
  assert.deepEqual(verdict, { kind: "return", because: "premise-obsolete" });
});

test("a moved remote holds a fresh round and settles a resumption as the concurrent change it is", () => {
  const resuming = attempt({ publication: "not-published" });
  const round = repairOpening({ reasons: ["conflicts"], facts: prFacts(), failingChecks: [] }, resuming);
  const reading = readRepairPremise(known(prFacts()));

  const fresh = confirmRepairRound({
    round: repairOpening({ reasons: ["conflicts"], facts: prFacts(), failingChecks: [] }, null),
    reading,
    remote: { known: true, headSha: COLLABORATOR },
  });
  assert.deepEqual(fresh, { kind: "hold", because: "remote-moved", remoteHeadSha: COLLABORATOR });

  const held = confirmRepairRound({ round, reading, remote: { known: true, headSha: COLLABORATOR } });
  assert.deepEqual(held, {
    kind: "hold",
    because: "remote-moved",
    remoteHeadSha: COLLABORATOR,
    concurrent: { attempt: resuming },
  });
});

test("a fresh round follows the facts to the current head; a resumption keeps its own", () => {
  const moved = prFacts({ headSha: PRODUCED });
  const reading = readRepairPremise(known(moved));
  assert.equal(reading.premise, "persisting");
  if (reading.premise !== "persisting") return;

  const fresh = confirmRepairRound({
    round: repairOpening({ reasons: ["conflicts"], facts: prFacts(), failingChecks: [] }, null),
    reading,
    remote: { known: true, headSha: PRODUCED },
  });
  assert.equal(fresh.kind, "launch");
  if (fresh.kind === "launch") assert.equal(fresh.round.pinnedHeadSha, PRODUCED);

  const resuming = attempt({ publication: "not-published" });
  const held = confirmRepairRound({
    round: repairOpening({ reasons: ["conflicts"], facts: prFacts(), failingChecks: [] }, resuming),
    reading,
    remote: { known: true, headSha: PRODUCED },
  });
  assert.equal(held.kind, "hold");
});

test("the remote carrying the produced commit is a publication, charged once", () => {
  const decision = settleRepairRound(cycle({ usedRounds: 1, attempt: attempt() }), {
    remote: { known: true, headSha: PRODUCED },
    localWork: LOCAL,
    premise: "persisting",
  });
  assert.equal(decision.kind, "published");
  if (decision.kind !== "published") return;
  assert.equal(decision.cycle.usedRounds, 1, "a published round stays charged");
  assert.equal(decision.cycle.consecutiveFalls, 0);
  assert.equal(decision.attempt.publication, "published");
});

test("a round that published nothing returns its charge and counts one fall", () => {
  const decision = settleRepairRound(cycle({ usedRounds: 2, attempt: attempt() }), {
    remote: { known: true, headSha: OBSERVED },
    localWork: LOCAL,
    premise: "persisting",
  });
  assert.equal(decision.kind, "not-published");
  if (decision.kind !== "not-published") return;
  assert.equal(decision.cycle.usedRounds, 1);
  assert.equal(decision.cycle.consecutiveFalls, 1);
});

test("an obsolete premise returns the round with NO fall — there is nothing left to fix", () => {
  const decision = settleRepairRound(cycle({ usedRounds: 2, attempt: attempt() }), {
    remote: { known: true, headSha: COLLABORATOR },
    localWork: LOCAL,
    premise: "obsolete",
  });
  assert.equal(decision.kind, "premise-obsolete");
  if (decision.kind !== "premise-obsolete") return;
  assert.equal(decision.cycle.usedRounds, 1);
  assert.equal(decision.cycle.consecutiveFalls, 0, "the work is never blamed for a fault that no longer exists");
});

test("a remote the attempt did not produce while the impediment stands is a concurrent change", () => {
  const decision = settleRepairRound(cycle({ usedRounds: 1, attempt: attempt() }), {
    remote: { known: true, headSha: COLLABORATOR },
    localWork: LOCAL,
    premise: "persisting",
  });
  assert.equal(decision.kind, "concurrent-change");
  if (decision.kind !== "concurrent-change") return;
  assert.equal(decision.attempt.publication, "concurrent-change");
  assert.equal(decision.cycle.usedRounds, 1, "the round stays charged");
});

test("an unreadable remote, local work or premise is pending — never a verdict", () => {
  const base = cycle({ usedRounds: 1, attempt: attempt() });
  for (const observations of [
    { remote: { known: false } as const, localWork: LOCAL, premise: "persisting" as const },
    { remote: { known: true, headSha: OBSERVED } as const, localWork: null, premise: "persisting" as const },
    { remote: { known: true, headSha: COLLABORATOR } as const, localWork: LOCAL, premise: "unknown" as const },
  ]) {
    const decision = settleRepairRound(base, observations);
    assert.equal(decision.kind, "pending");
    if (decision.kind !== "pending") continue;
    assert.equal(decision.cycle.usedRounds, 1, "nothing is returned while the fact is unknown");
    assert.equal(decision.cycle.consecutiveFalls, 0);
  }
});

test("a settled attempt is never settled again", () => {
  const decision = settleRepairRound(cycle({ attempt: attempt({ publication: "published" }) }), {
    remote: { known: true, headSha: COLLABORATOR },
    localWork: LOCAL,
    premise: "obsolete",
  });
  assert.deepEqual(decision, { kind: "none" });
});

test("a round that never reached the runtime returns its charge; one that started does not", () => {
  const unstarted = returnUnstartedRound(cycle({ usedRounds: 1, lastEvidence: "sig", attempt: attempt() }), {
    hasEventLog: false,
    journalIntact: true,
    journalHasSession: false,
    hasOwnOutcome: false,
  });
  assert.deepEqual(unstarted, cycle({ usedRounds: 0, lastEvidence: null, attempt: null }));

  for (const evidence of [
    { hasEventLog: true, journalIntact: true, journalHasSession: false, hasOwnOutcome: false },
    { hasEventLog: false, journalIntact: false, journalHasSession: false, hasOwnOutcome: false },
    { hasEventLog: false, journalIntact: true, journalHasSession: true, hasOwnOutcome: false },
    { hasEventLog: false, journalIntact: true, journalHasSession: false, hasOwnOutcome: true },
  ]) {
    assert.equal(returnUnstartedRound(cycle({ usedRounds: 1, attempt: attempt() }), evidence), null);
  }
});
