import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  asyncTaskOrderDoesNotDecide,
  candidateAssignment,
  candidateBlindSingleProperty,
  candidateBulkList,
  candidateLabelEdit,
  candidateWorkflowTransition,
  claimWithoutWorkerIsNotAbandoned,
  contestedSimultaneousCas,
  contestedSimultaneousDocumented,
  deathAndTimeDoNotAuthorizeTakeover,
  distinctTicketsRunInParallel,
  existingClaimIsRespected,
  failedJobWritesNothing,
  failedReadDoesNotAuthorize,
  freeTicketProgresses,
  legacyClaimIsRespected,
  localRecoveryKeepsTheAttempt,
  lostResponseDoesNotLaunch,
  malformedClaimIsUncertainty,
  manualReleaseNeedsConfirmedEnd,
  noLocalReservationProvesNoAbandonment,
  nonParticipantBreaksThePremise,
  partialClaimHoldsWithoutAttempt,
  sameTicketDifferentDestinations,
  staleSearchObservationStillLosesTheCas,
  staleVerificationOnlyAddsUncertainty,
  subIssuesRunInParallel,
  twoSitesSamePresentationKey,
  type SceneFacts,
} from "./scenarios.js";

function assertNoForeignClaimRemoved(facts: SceneFacts, expected: string): void {
  assert.deepEqual(new Set(Object.values(facts.claims)), new Set([expected]));
}

describe("progress: a free Ticket and distinct Tickets", () => {
  test("a free Ticket with no contention starts exactly one Worker and consumes one Attempt", () => {
    const facts = freeTicketProgresses();
    assert.equal(facts.workerCount, 1);
    assert.equal(facts.attemptsByFactory["A"], 1);
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "A");
  });

  test("two distinct Tickets acquire and run in parallel", () => {
    const facts = distinctTicketsRunInParallel();
    assert.equal(facts.workerCount, 2);
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 1 });
  });

  test("a parent and its sub-issue are distinct Tickets and run in parallel", () => {
    const facts = subIssuesRunInParallel();
    assert.equal(facts.workerCount, 2);
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 1 });
    assert.match(facts.details["parent"] ?? "", /10000/);
    assert.match(facts.details["child"] ?? "", /10002/);
  });

  test("the same presentation key and provider id on two sites stay distinct: both run", () => {
    const facts = twoSitesSamePresentationKey();
    assert.equal(facts.workerCount, 2);
    assert.deepEqual(facts.claims, {
      "jira:alpha.atlassian.net:10001": "A",
      "jira:beta.atlassian.net:10001": "B",
    });
    assert.equal(facts.details["presentation"], "OPS-1 on both sites");
  });
});

describe("contention", () => {
  test("under P-CAS, simultaneous acquisition authorizes exactly one Worker and spends one Attempt", () => {
    const facts = contestedSimultaneousCas();
    assert.equal(facts.workerCount, 1);
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 0 });
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "A");
    assert.match(facts.outcomes["B"] ?? "", /^unavailable/);
  });

  test("documented semantics admit an interleaving with two authorized Workers (the gap)", () => {
    const facts = contestedSimultaneousDocumented();
    assert.equal(facts.workerCount, 2);
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 1 });
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "B");
  });

  test("the claim is per Ticket: a different Destination neither bypasses it nor blinds the other factory", () => {
    const cas = sameTicketDifferentDestinations("cas");
    assert.equal(cas.workerCount, 1);
    assert.deepEqual(cas.attemptsByFactory, { A: 1, B: 0 });
    assert.equal(cas.details["A destination"], "github:github.com:Sanmoo/repo-a");
    assert.equal(cas.details["B destination"], "github:github.com:Sanmoo/repo-b");

    const documented = sameTicketDifferentDestinations("documented");
    assert.equal(documented.workerCount, 2, "the failure is the same regardless of Destination");
  });

  test("the async task order does not decide the winner; the conditional check does", () => {
    const facts = asyncTaskOrderDoesNotDecide();
    assert.equal(facts.workerCount, 1);
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "B");
    assert.deepEqual(facts.attemptsByFactory, { A: 0, B: 1 });
    assert.equal(facts.details["submission order"], "A then B");
    assert.equal(facts.details["application order"], "B then A");
  });
});

describe("claims that already exist", () => {
  test("an existing valid claim blocks acquisition without any write, removal or Attempt", () => {
    const facts = existingClaimIsRespected();
    assert.equal(facts.workerCount, 1);
    assert.equal(facts.attemptsByFactory["B"], 0);
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "A");
  });

  test("the absence of a local Reservation is not evidence of abandonment", () => {
    const facts = noLocalReservationProvesNoAbandonment();
    assert.equal(facts.details["B reservation"], "absent");
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.attemptsByFactory["B"], 0);
    assertNoForeignClaimRemoved(facts, "A");
  });

  test("a claim with no Worker yet is Reserved-without-Attempt, not an abandoned Ticket", () => {
    const facts = claimWithoutWorkerIsNotAbandoned();
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.details["A launch after recovery"], "yes");
    assert.equal(facts.attemptsByFactory["A"], 1);
    assert.equal(facts.workerCount, 1);
  });

  test("an unreadable property is uncertainty: no write, no removal, no Attempt", () => {
    const facts = malformedClaimIsUncertainty();
    assert.equal(facts.details["B observation"], "uncertain");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.details["property preserved"], "yes");
    assert.equal(facts.workerCount, 0);
  });

  test("the legacy Claim (label + assignment without the property) is respected and never cleared", () => {
    const facts = legacyClaimIsRespected();
    assert.equal(facts.details["B observation"], "legacy-claim");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.workerCount, 0);
    assert.equal(facts.attemptsByFactory["B"], 0);
  });
});

describe("uncertain acquisition", () => {
  test("a lost response causes no launch, no removal and no Attempt; verification then authorizes", () => {
    const facts = lostResponseDoesNotLaunch();
    assert.match(facts.details["outcome after the lost response"] ?? "", /^uncertain/);
    assert.equal(facts.details["attempts before verification"], "0");
    assert.equal(facts.details["A submissions"], "1", "no blind retry after the lost response");
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["launched after verification"], "yes");
    assert.equal(facts.workerCount, 1);
    assert.equal(facts.attemptsByFactory["A"], 1);
  });

  test("a failed verification read does not authorize; a later successful read does", () => {
    const facts = failedReadDoesNotAuthorize();
    assert.match(facts.details["outcome after the failed read"] ?? "", /^uncertain/);
    assert.equal(facts.details["attempts after the failed read"], "0");
    assert.equal(facts.details["launch after the failed read"], "no");
    assert.equal(facts.details["launch after the successful read"], "yes");
    assert.equal(facts.attemptsByFactory["A"], 1);
  });

  test("a FAILED job wrote nothing, spends no Attempt, and a retry may acquire", () => {
    const facts = failedJobWritesNothing();
    assert.match(facts.details["outcome after the failed job"] ?? "", /^not-acquired/);
    assert.equal(facts.details["launch after the failed job"], "no");
    assert.equal(facts.details["attempts after the failed job"], "0");
    assert.equal(facts.details["launch after the retry"], "yes");
    assert.equal(facts.workerCount, 1);
    assert.equal(facts.attemptsByFactory["A"], 1);
  });

  test("a stale search observation loses the conditional write and does not launch", () => {
    const facts = staleSearchObservationStillLosesTheCas();
    assert.equal(facts.details["B observation"], "free");
    assert.equal(facts.details["B launch"], "no");
    assert.equal(facts.details["B attempts"], "0");
    assert.equal(facts.details["A launch"], "yes");
    assert.equal(facts.workerCount, 1);
  });

  test("a stale verification read can only add uncertainty, never authority", () => {
    const facts = staleVerificationOnlyAddsUncertainty();
    assert.match(facts.outcomes["A"] ?? "", /^uncertain/);
    assert.equal(facts.details["launch"], "no");
    assert.equal(facts.details["attempts"], "0");
    assert.equal(facts.details["claim stored"], "yes");
  });
});

describe("death, silence, time and manual release", () => {
  test("a dead Worker and 30 days of silence authorize no takeover and expire no claim", () => {
    const facts = deathAndTimeDoNotAuthorizeTakeover();
    assert.equal(facts.details["alive Workers"], "0");
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["B submitted"], "no");
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "A");
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 0 });
  });

  test("local Recovery relaunches the same Attempt and spends no extra recovery as a new Attempt", () => {
    const facts = localRecoveryKeepsTheAttempt();
    assert.equal(facts.details["recovered worker attempt"], "1");
    assert.equal(facts.details["A attempts"], "1");
    assert.equal(facts.details["worker starts"], "2", "two starts, still one Attempt");
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.workerCount, 1);
  });

  test("a partial Claim holds the Ticket without launching or spending an Attempt", () => {
    const facts = partialClaimHoldsWithoutAttempt();
    assert.equal(facts.details["launch while presentation is partial"], "no");
    assert.equal(facts.details["attempts while presentation is partial"], "0");
    assert.equal(facts.details["B observation"], "claimed");
    assert.equal(facts.details["launch after presentation"], "yes");
    assert.equal(facts.attemptsByFactory["A"], 1);
  });

  test("manual release is refused while a Worker lives and without confirmed end; only then does B acquire", () => {
    const facts = manualReleaseNeedsConfirmedEnd();
    assert.match(facts.details["release while a Worker is alive"] ?? "", /^refused/);
    assert.match(facts.details["release without confirmation"] ?? "", /^refused/);
    assert.match(facts.details["release after confirmation"] ?? "", /^released/);
    assert.equal(facts.claims["jira:alpha.atlassian.net:10001"], "B");
    assert.deepEqual(facts.attemptsByFactory, { A: 1, B: 1 });
    assert.equal(facts.workerCount, 1);
  });

  test("a non-participant is outside the guarantee and can run a second Worker", () => {
    const facts = nonParticipantBreaksThePremise();
    assert.equal(facts.workerCount, 2);
    assert.match(facts.note, /OUTSIDE the guarantee/);
  });
});

describe("candidates that are not conditional writes", () => {
  for (const build of [
    candidateBlindSingleProperty,
    candidateBulkList,
    candidateAssignment,
    candidateLabelEdit,
    candidateWorkflowTransition,
  ]) {
    const facts = build();
    test(`${facts.scenario}: two factories each read their own mark and both run`, () => {
      assert.equal(facts.workerCount, 2);
    });
  }
});
