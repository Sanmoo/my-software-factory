/**
 * The concrete scenarios the report cites. Each one is a small world with its
 * own tracker, Worker registry and independent factory workspaces; nothing is
 * shared between the factories except the tracker model. Scenarios assert the
 * facts the report states — including the failures, which are findings, not
 * implementation targets.
 */

import { FactoryInstance } from "./factory.js";
import { PADLOCK_LABEL, formatClaim, ticketKey, type TicketIdentity } from "./identity.js";
import { claimSequence, conversationLock, currentMark, strictUnique, type ClaimProtocol } from "./protocols.js";
import { confirmStop, OperatorReleaseRefused, releaseClaim } from "./operator.js";
import { FIXTURE_TICKET, githubTicket } from "./explorer.js";
import { SimTracker, type CommentIdOrder, type ReadView, type SeedIssue } from "./tracker.js";
import { WorkerRegistry } from "./workers.js";

class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export interface ScenarioResult {
  readonly name: string;
  readonly expectation: string;
  readonly observations: Readonly<Record<string, unknown>>;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ScenarioError(message);
}

function equal<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new ScenarioError(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const FRESH: ReadView = { kind: "all" };

/** The three writes C5 performs for one claim (padlock, assignment, record),
 *  by applied position. */
function hideClaimWrites(start: number): ReadView {
  return { kind: "omit", indices: [start, start + 1, start + 2] };
}

interface World {
  readonly ticket: TicketIdentity;
  readonly tracker: SimTracker;
  readonly workers: WorkerRegistry;
  readonly a: FactoryInstance;
  readonly b: FactoryInstance;
}

function world(
  protocol: ClaimProtocol,
  options: {
    readonly ticket?: TicketIdentity;
    readonly idOrder?: CommentIdOrder;
    readonly seed?: SeedIssue;
  } = {},
): World {
  const ticket = options.ticket ?? FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, options.seed ?? {}, options.idOrder ?? "apply");
  return {
    ticket,
    tracker,
    workers: new WorkerRegistry(),
    a: newFactory("zeta", protocol),
    b: newFactory("alpha", protocol),
  };
}

/** The two fixture installations: distinct factory ids and Destinations, one
 *  shared Acting account (the v0.1 case) unless a scenario says otherwise. */
function newFactory(factoryId: "zeta" | "alpha", protocol: ClaimProtocol): FactoryInstance {
  const destination = factoryId === "zeta" ? "Sanmoo/destination-a" : "Sanmoo/destination-b";
  return new FactoryInstance(factoryId, "acting-account", destination, protocol);
}

function observeFree(factory: FactoryInstance, world: World): void {
  const observation = factory.observe(world.tracker, world.ticket, FRESH);
  equal(observation.decision, "free", "precondition: ticket observed free");
}

function claimAndRun(factory: FactoryInstance, world: World): void {
  observeFree(factory, world);
  const write = factory.write(world.tracker, world.ticket);
  equal(write.status, "applied", "claim write applied");
  equal(factory.verify(world.tracker, world.ticket, FRESH), "authorized", "claim authorized");
  const worker = factory.launch(world.workers, world.ticket);
  check(worker !== undefined, "a Worker starts after confirmed authority");
}

export function freeTicket(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  const write = w.a.write(w.tracker, w.ticket);
  equal(write.status, "applied", "write response");
  const decision = w.a.verify(w.tracker, w.ticket, FRESH);
  const worker = w.a.launch(w.workers, w.ticket);
  const snapshot = w.tracker.snapshot();
  return {
    name: "free-ticket-progress",
    expectation: "a free Ticket authorizes one Worker",
    observations: {
      decision,
      worker: worker?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
      attempts: w.a.attempts(w.ticket),
      claims: snapshot.comments.length,
      padlock: snapshot.labels.includes(PADLOCK_LABEL),
    },
  };
}

export function simultaneousAcquisition(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  observeFree(w.b, w);
  equal(w.a.write(w.tracker, w.ticket).status, "applied", "A write");
  equal(w.b.write(w.tracker, w.ticket).status, "applied", "B write");
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);
  const workerB = w.b.launch(w.workers, w.ticket);
  return {
    name: "simultaneous-acquisition",
    expectation: "both observed the Ticket free; at most one is authorized",
    observations: {
      decisionA,
      decisionB,
      workerA: workerA?.id ?? null,
      workerB: workerB?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
      attemptsA: w.a.attempts(w.ticket),
      attemptsB: w.b.attempts(w.ticket),
    },
  };
}

export function currentMarkDoubleAuthorization(): ScenarioResult {
  const w = world(currentMark);
  observeFree(w.a, w);
  observeFree(w.b, w);
  w.a.write(w.tracker, w.ticket);
  w.b.write(w.tracker, w.ticket);
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);
  const workerB = w.b.launch(w.workers, w.ticket);
  return {
    name: "current-mark-double-authorization",
    expectation: "the current shared mark authorizes BOTH factories (the finding)",
    observations: {
      decisionA,
      decisionB,
      workerA: workerA?.id ?? null,
      workerB: workerB?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
      maxLive: w.workers.maxLivePerTicket(),
    },
  };
}

export function conversationLockDoubleAuthorization(): ScenarioResult {
  const w = world(conversationLock);
  observeFree(w.a, w);
  observeFree(w.b, w);
  w.a.write(w.tracker, w.ticket);
  w.b.write(w.tracker, w.ticket);
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  w.a.launch(w.workers, w.ticket);
  w.b.launch(w.workers, w.ticket);
  return {
    name: "conversation-lock-double-authorization",
    expectation: "the conversation lock has no owner, so it cannot identify a winner",
    observations: {
      decisionA,
      decisionB,
      live: w.workers.liveFor(w.ticket).length,
      locked: w.tracker.snapshot().locked,
    },
  };
}

export function destinationsDoNotBypass(): ScenarioResult {
  const w = world(claimSequence);
  check(
    w.a.destination !== w.b.destination,
    "the two factories carry different Destinations",
  );
  observeFree(w.a, w);
  w.a.write(w.tracker, w.ticket);
  equal(w.a.verify(w.tracker, w.ticket, FRESH), "authorized", "A authorized");
  w.a.launch(w.workers, w.ticket);

  // B has a different Destination and has never observed this Ticket before:
  // its first observation must still respect A's Claim on the Ticket identity.
  const before = w.tracker.appliedCount;
  const observation = w.b.observe(w.tracker, w.ticket, FRESH);
  const workerB = w.b.launch(w.workers, w.ticket);
  return {
    name: "destinations-do-not-bypass",
    expectation: "a different Destination does not change Ticket identity or authority",
    observations: {
      identityA: ticketKey(w.ticket),
      identityB: ticketKey(w.ticket),
      destinationsDiffer: w.a.destination !== w.b.destination,
      observationB: observation.decision,
      bWrote: w.tracker.appliedCount - before,
      workerB: workerB?.id ?? null,
      attemptsB: w.b.attempts(w.ticket),
      live: w.workers.liveFor(w.ticket).length,
    },
  };
}

export function subIssuesParallel(): ScenarioResult {
  const parent = githubTicket("Sanmoo/fixture", 200);
  const sibling = githubTicket("Sanmoo/fixture", 201);
  const tracker = new SimTracker(parent);
  const siblingTracker = new SimTracker(sibling);
  const workers = new WorkerRegistry();
  const a = newFactory("zeta", claimSequence);
  const b = newFactory("alpha", claimSequence);

  for (const [factory, ticket, ticketTracker] of [
    [a, parent, tracker],
    [b, sibling, siblingTracker],
  ] as const) {
    equal(factory.observe(ticketTracker, ticket, FRESH).decision, "free", "sub-issue free");
    equal(factory.write(ticketTracker, ticket).status, "applied", "sub-issue claim write");
    equal(factory.verify(ticketTracker, ticket, FRESH), "authorized", "sub-issue claim authorized");
    check(factory.launch(workers, ticket) !== undefined, "sub-issue worker starts");
  }

  return {
    name: "distinct-sub-issues-parallel",
    expectation: "distinct Ticket identities execute in parallel",
    observations: {
      parentKey: ticketKey(parent),
      siblingKey: ticketKey(sibling),
      different: ticketKey(parent) !== ticketKey(sibling),
      liveParent: workers.liveFor(parent).length,
      liveSibling: workers.liveFor(sibling).length,
      maxLivePerTicket: workers.maxLivePerTicket(),
    },
  };
}

export function existingClaimNoTakeover(): ScenarioResult {
  const first = world(claimSequence);
  observeFree(first.a, first);
  equal(first.a.write(first.tracker, first.ticket).status, "applied", "A claim write");
  // A disappears: the tracker fact remains, the local workspace does not. B has
  // no reservation for this ticket at all.
  const b = newFactory("alpha", claimSequence);
  const before = first.tracker.appliedCount;
  const observation = b.observe(first.tracker, first.ticket, FRESH);
  const worker = b.launch(first.workers, first.ticket);
  return {
    name: "existing-claim-no-takeover",
    expectation: "an existing Claim with no local Reservation is not a takeover opportunity",
    observations: {
      observation: observation.decision,
      bWrote: first.tracker.appliedCount - before,
      worker: worker?.id ?? null,
      attempts: b.attempts(first.ticket),
      claims: first.tracker.snapshot().comments.length,
    },
  };
}

export function lostResponse(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  const write = w.a.write(w.tracker, w.ticket, { lostAfter: 3 });
  const workerBeforeVerify = w.a.launch(w.workers, w.ticket);
  const attemptsBeforeVerify = w.a.attempts(w.ticket);

  const before = w.tracker.appliedCount;
  const observationB = w.b.observe(w.tracker, w.ticket, FRESH);
  const workerB = w.b.launch(w.workers, w.ticket);
  const bWrote = w.tracker.appliedCount - before;

  const decision = w.a.verify(w.tracker, w.ticket, FRESH);
  const workerAfterVerify = w.a.launch(w.workers, w.ticket);

  return {
    name: "lost-response",
    expectation: "a lost response does not authorize, clean or spend an Attempt",
    observations: {
      writeStatus: write.status,
      writeApplied: write.applied,
      workerBeforeVerify: workerBeforeVerify?.id ?? null,
      attemptsBeforeVerify,
      observationB: observationB.decision,
      bWrote,
      workerB: workerB?.id ?? null,
      attemptsB: w.b.attempts(w.ticket),
      decision: decision,
      workerAfterVerify: workerAfterVerify?.id ?? null,
      attemptsA: w.a.attempts(w.ticket),
      live: w.workers.liveFor(w.ticket).length,
    },
  };
}

export function failedBeforeWrite(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  const write = w.a.write(w.tracker, w.ticket, { failBefore: true });
  const decision = w.a.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);

  observeFree(w.b, w);
  equal(w.b.write(w.tracker, w.ticket).status, "applied", "B claims the untouched Ticket");
  equal(w.b.verify(w.tracker, w.ticket, FRESH), "authorized", "B authorized");
  const workerB = w.b.launch(w.workers, w.ticket);

  return {
    name: "failed-before-write",
    expectation: "nothing was applied, so the Ticket stays free for another factory",
    observations: {
      writeStatus: write.status,
      applied: write.applied,
      decisionA: decision,
      workerA: workerA?.id ?? null,
      attemptsA: w.a.attempts(w.ticket),
      workerB: workerB?.id ?? null,
      attemptsB: w.b.attempts(w.ticket),
      live: w.workers.liveFor(w.ticket).length,
    },
  };
}

export function partialClaim(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  const write = w.a.write(w.tracker, w.ticket, { lostAfter: 1 });
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);
  const observationB = w.b.observe(w.tracker, w.ticket, FRESH);
  const workerB = w.b.launch(w.workers, w.ticket);
  const beforeResweep = w.tracker.appliedCount;
  const resweepA = w.a.observe(w.tracker, w.ticket, FRESH);
  const resweepWrote = w.tracker.appliedCount - beforeResweep;
  const snapshot = w.tracker.snapshot();

  return {
    name: "partial-claim",
    expectation: "a partial Claim (padlock, no readable record) is never authority",
    observations: {
      writeStatus: write.status,
      writeApplied: write.applied,
      decisionA,
      workerA: workerA?.id ?? null,
      observationB: observationB.decision,
      workerB: workerB?.id ?? null,
      attemptsA: w.a.attempts(w.ticket),
      attemptsB: w.b.attempts(w.ticket),
      padlock: snapshot.labels.includes(PADLOCK_LABEL),
      claims: snapshot.comments.length,
      resweepA: resweepA.decision,
      resweepWrote,
    },
  };
}

/** The uncertain acquisition is not replaced by a new observation: the
 *  factory re-verifies ITS pending claim, never writes a second one. */
export function uncertainResweep(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  const write = w.a.write(w.tracker, w.ticket, { lostAfter: 3 });
  const before = w.tracker.appliedCount;
  const again = w.a.observe(w.tracker, w.ticket, FRESH);
  const wroteBetween = w.tracker.appliedCount - before;
  const decision = w.a.verify(w.tracker, w.ticket, FRESH);
  const worker = w.a.launch(w.workers, w.ticket);
  return {
    name: "uncertain-resweep",
    expectation: "an uncertain acquisition re-verifies its own claim; it never writes a second one",
    observations: {
      writeStatus: write.status,
      observeAgain: again.decision,
      wroteBetween,
      decision,
      worker: worker?.id ?? null,
      attempts: w.a.attempts(w.ticket),
      claims: w.tracker.snapshot().comments.length,
    },
  };
}

/** A Claim left by the same installation but no longer backed by a local
 *  Reservation is not this acquisition's authority. */
export function sameInstallationWithoutReservation(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  equal(w.a.write(w.tracker, w.ticket).status, "applied", "A claim write");
  const before = w.tracker.appliedCount;
  const again = newFactory("zeta", claimSequence);
  const observation = again.observe(w.tracker, w.ticket, FRESH);
  const worker = again.launch(w.workers, w.ticket);
  return {
    name: "same-installation-without-reservation",
    expectation: "an unbacked Claim is not a takeover, even when the factory id matches",
    observations: {
      observation: observation.decision,
      wrote: w.tracker.appliedCount - before,
      worker: worker?.id ?? null,
      attempts: again.attempts(w.ticket),
      claims: w.tracker.snapshot().comments.length,
    },
  };
}

/** A stale observation can show a free Ticket while a Claim exists; under P2
 *  the verification read still binds both writers to the same winner. */
export function staleObservation(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  w.a.write(w.tracker, w.ticket); // A's claim is applied here...
  const observationB = w.b.observe(w.tracker, w.ticket, hideClaimWrites(0));
  w.b.write(w.tracker, w.ticket);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  const workerB = w.b.launch(w.workers, w.ticket);
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);
  return {
    name: "stale-observation",
    expectation: "a stale observation does not create authority; the verification read decides",
    observations: {
      observationB: observationB.decision,
      decisionB,
      workerB: workerB?.id ?? null,
      decisionA,
      workerA: workerA?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
    },
  };
}

export function unreadableClaim(): ScenarioResult {
  const ticket = FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, {
    labels: [PADLOCK_LABEL],
    comments: [
      {
        id: 6,
        author: "acting-account",
        body: formatClaim({
          factoryId: "zeta",
          nonce: "zeta:inc-1:1",
          ticket,
        }),
      },
      {
        id: 7,
        author: "unknown-factory",
        body: "<!-- msf:claim -->\nfactory: unknown-factory\n",
      },
    ],
  });
  const workers = new WorkerRegistry();
  const b = newFactory("alpha", claimSequence);
  const observation = b.observe(tracker, ticket, FRESH);
  const worker = b.launch(workers, ticket);
  return {
    name: "unreadable-claim",
    expectation: "an incomplete claim marker is uncertain, never 'no claim'",
    observations: {
      observation: observation.decision,
      worker: worker?.id ?? null,
      attempts: b.attempts(ticket),
      claims: tracker.snapshot().comments.length,
    },
  };
}

export function staleReadTwoWinners(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  observeFree(w.b, w);
  w.a.write(w.tracker, w.ticket); // history 0 padlock, 1 assignment, 2 record
  w.b.write(w.tracker, w.ticket); // history 3 padlock, 4 assignment, 5 record
  const decisionA = w.a.verify(w.tracker, w.ticket, hideClaimWrites(3));
  const decisionB = w.b.verify(w.tracker, w.ticket, hideClaimWrites(0));
  w.a.launch(w.workers, w.ticket);
  w.b.launch(w.workers, w.ticket);
  return {
    name: "stale-read-two-winners",
    expectation: "a read may omit an already-applied claim; nothing in the docs excludes it",
    observations: {
      decisionA,
      decisionB,
      live: w.workers.liveFor(w.ticket).length,
      liveIds: w.workers.liveFor(w.ticket).map((worker) => worker.id),
    },
  };
}

export function unorderedIdsTwoWinners(): ScenarioResult {
  const w = world(claimSequence, { idOrder: "reverse" });
  observeFree(w.a, w);
  observeFree(w.b, w);
  w.a.write(w.tracker, w.ticket);
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  w.a.launch(w.workers, w.ticket);
  w.b.write(w.tracker, w.ticket);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  w.b.launch(w.workers, w.ticket);
  return {
    name: "unordered-ids-two-winners",
    expectation: "later-applied ids can be smaller; fresh reads alone do not save the race",
    observations: {
      decisionA,
      decisionB,
      live: w.workers.liveFor(w.ticket).length,
      commentIds: w.tracker.snapshot().comments.map((comment) => comment.id),
    },
  };
}

export function strictDeadlock(): ScenarioResult {
  const w = world(strictUnique);
  observeFree(w.a, w);
  observeFree(w.b, w);
  w.a.write(w.tracker, w.ticket);
  w.b.write(w.tracker, w.ticket);
  const decisionA = w.a.verify(w.tracker, w.ticket, FRESH);
  const decisionB = w.b.verify(w.tracker, w.ticket, FRESH);
  const workerA = w.a.launch(w.workers, w.ticket);
  const workerB = w.b.launch(w.workers, w.ticket);
  return {
    name: "strict-unique-deadlock",
    expectation: "safe but no progress: two claims make both factories yield, forever",
    observations: {
      decisionA,
      decisionB,
      workerA: workerA?.id ?? null,
      workerB: workerB?.id ?? null,
      attemptsA: w.a.attempts(w.ticket),
      attemptsB: w.b.attempts(w.ticket),
      live: w.workers.liveFor(w.ticket).length,
      claims: w.tracker.snapshot().comments.length,
    },
  };
}

export function abandonmentDoesNotTransfer(): ScenarioResult {
  const w = world(claimSequence);
  claimAndRun(w.a, w);
  const firstWorker = w.workers.liveFor(w.ticket)[0];
  check(firstWorker !== undefined, "fixture worker alive");

  // A dies; its Worker survives. B sweeps repeatedly. Nothing in the tracker
  // depends on the clock: there is no lease, expiry or remote health check to
  // consult, so elapsed time cannot change the answer.
  const observations: string[] = [];
  for (let sweep = 0; sweep < 3; sweep += 1) {
    observations.push(w.b.observe(w.tracker, w.ticket, FRESH).decision);
  }
  const workerB = w.b.launch(w.workers, w.ticket);

  w.a.markInterrupted(w.ticket);
  w.workers.interrupt(firstWorker);
  const afterDeath = w.b.observe(w.tracker, w.ticket, FRESH);
  const workerAfterDeath = w.b.launch(w.workers, w.ticket);

  return {
    name: "abandonment-does-not-transfer",
    expectation: "death, silence and elapsed time do not transfer the Ticket",
    observations: {
      sweeps: observations.join(","),
      workerB: workerB?.id ?? null,
      attemptsB: w.b.attempts(w.ticket),
      afterDeath: afterDeath.decision,
      workerAfterDeath: workerAfterDeath?.id ?? null,
      liveAfter: w.workers.liveFor(w.ticket).length,
      firstWorkerEnded: firstWorker.ended,
    },
  };
}

export function manualRelease(): ScenarioResult {
  const w = world(claimSequence);
  claimAndRun(w.a, w);
  const worker = w.workers.liveFor(w.ticket)[0];
  check(worker !== undefined, "fixture worker alive");

  let refusedWhileAlive = false;
  try {
    confirmStop(w.workers, w.ticket);
  } catch (error) {
    refusedWhileAlive = error instanceof OperatorReleaseRefused;
  }
  const claimWhileAlive = w.tracker.snapshot().comments.length;

  w.workers.interrupt(worker);
  w.a.markInterrupted(w.ticket);
  const confirmation = confirmStop(w.workers, w.ticket);
  releaseClaim(w.tracker, w.workers, w.ticket, confirmation, "acting-account");
  const releasedComments = w.tracker.snapshot().comments.length;
  const releasedPadlock = w.tracker.snapshot().labels.includes(PADLOCK_LABEL);
  const releasedAssignee = w.tracker.snapshot().assignees.includes("acting-account");

  observeFree(w.b, w);
  w.b.write(w.tracker, w.ticket);
  equal(w.b.verify(w.tracker, w.ticket, FRESH), "authorized", "B authorized after release");
  const workerB = w.b.launch(w.workers, w.ticket);

  return {
    name: "manual-release-precondition",
    expectation: "release needs confirmed Worker end; the tracker edit is not a remote stop",
    observations: {
      refusedWhileAlive,
      claimWhileAlive,
      released: releasedComments,
      padlockAfter: releasedPadlock,
      assigneeAfter: releasedAssignee,
      workerB: workerB?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
      firstWorkerEnded: worker.ended,
    },
  };
}

export function localRecovery(): ScenarioResult {
  const w = world(claimSequence);
  observeFree(w.a, w);
  w.a.write(w.tracker, w.ticket);
  equal(w.a.verify(w.tracker, w.ticket, FRESH), "authorized", "A authorized");
  const first = w.a.launch(w.workers, w.ticket);
  check(first !== undefined, "first attempt launched");
  equal(w.a.attempts(w.ticket), 1, "first attempt counted");

  w.workers.interrupt(first);
  w.a.markInterrupted(w.ticket);
  const restored = FactoryInstance.restore(w.a.persist(), claimSequence);
  const decision = restored.verify(w.tracker, w.ticket, FRESH);
  const recovered = restored.launch(w.workers, w.ticket, { recovering: true });

  const observationB = w.b.observe(w.tracker, w.ticket, FRESH);
  const workerB = w.b.launch(w.workers, w.ticket);

  return {
    name: "local-recovery",
    expectation: "the original factory recovers its own interrupted attempt; another still may not",
    observations: {
      decision,
      recovered: recovered?.id ?? null,
      attempts: restored.attempts(w.ticket),
      observationB: observationB.decision,
      workerB: workerB?.id ?? null,
      live: w.workers.liveFor(w.ticket).length,
    },
  };
}

export function legacyClaim(): ScenarioResult {
  const ticket = FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, {
    labels: [PADLOCK_LABEL],
    assignees: ["acting-account"],
  });
  const workers = new WorkerRegistry();
  const b = newFactory("alpha", claimSequence);
  const before = tracker.appliedCount;
  const observation = b.observe(tracker, ticket, FRESH);
  const worker = b.launch(workers, ticket);
  const bWrote = tracker.appliedCount - before;

  const confirmation = confirmStop(workers, ticket);
  releaseClaim(tracker, workers, ticket, confirmation, "acting-account");
  const releasedPadlock = tracker.snapshot().labels.includes(PADLOCK_LABEL);
  const afterRelease = b.observe(tracker, ticket, FRESH);
  equal(b.write(tracker, ticket).status, "applied", "B claims after the operator release");
  equal(b.verify(tracker, ticket, FRESH), "authorized", "B authorized after the operator release");
  const workerB = b.launch(workers, ticket);

  return {
    name: "legacy-claim",
    expectation: "a prior Claim convention is respected, never overwritten by the new protocol",
    observations: {
      observation: observation.decision,
      worker: worker?.id ?? null,
      bWrote,
      releasedPadlock,
      afterRelease: afterRelease.decision,
      workerB: workerB?.id ?? null,
    },
  };
}

/** The operator's release refuses a marker it cannot read: no cleanup by guess. */
export function releaseRefusesMalformed(): ScenarioResult {
  const ticket = FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, {
    labels: [PADLOCK_LABEL],
    comments: [
      {
        id: 6,
        author: "acting-account",
        body: formatClaim({
          factoryId: "zeta",
          nonce: "zeta:inc-1:1",
          ticket,
        }),
      },
      {
        id: 7,
        author: "unknown-factory",
        body: "<!-- msf:claim -->\nfactory: unknown-factory\n",
      },
    ],
  });
  const workers = new WorkerRegistry();
  const confirmation = confirmStop(workers, ticket);
  let refused = false;
  try {
    releaseClaim(tracker, workers, ticket, confirmation, "acting-account");
  } catch (error) {
    refused = error instanceof OperatorReleaseRefused;
  }
  const snapshot = tracker.snapshot();
  return {
    name: "release-refuses-malformed",
    expectation: "a malformed claim marker is refused, never deleted by guess",
    observations: {
      refused,
      claims: snapshot.comments.length,
      padlock: snapshot.labels.includes(PADLOCK_LABEL),
    },
  };
}

export function claimForAnotherTicket(): ScenarioResult {
  const ticket = FIXTURE_TICKET;
  const tracker = new SimTracker(ticket, {
    comments: [
      {
        id: 11,
        author: "some-factory",
        body: formatClaim({
          factoryId: "some-factory",
          nonce: "some-factory:1",
          ticket: githubTicket("Sanmoo/fixture", 999),
        }),
      },
    ],
  });
  const workers = new WorkerRegistry();
  const b = newFactory("alpha", claimSequence);
  const observation = b.observe(tracker, ticket, FRESH);
  return {
    name: "claim-for-another-ticket",
    expectation: "a marker that does not describe this Ticket is uncertain, never ignored",
    observations: {
      observation: observation.decision,
      worker: b.launch(workers, ticket)?.id ?? null,
    },
  };
}

export type Scenario = () => ScenarioResult;

export const SCENARIOS: readonly { readonly name: string; readonly run: Scenario }[] = [
  { name: "free-ticket-progress", run: freeTicket },
  { name: "simultaneous-acquisition", run: simultaneousAcquisition },
  { name: "current-mark-double-authorization", run: currentMarkDoubleAuthorization },
  { name: "conversation-lock-double-authorization", run: conversationLockDoubleAuthorization },
  { name: "destinations-do-not-bypass", run: destinationsDoNotBypass },
  { name: "distinct-sub-issues-parallel", run: subIssuesParallel },
  { name: "existing-claim-no-takeover", run: existingClaimNoTakeover },
  { name: "lost-response", run: lostResponse },
  { name: "failed-before-write", run: failedBeforeWrite },
  { name: "partial-claim", run: partialClaim },
  { name: "uncertain-resweep", run: uncertainResweep },
  { name: "same-installation-without-reservation", run: sameInstallationWithoutReservation },
  { name: "stale-observation", run: staleObservation },
  { name: "unreadable-claim", run: unreadableClaim },
  { name: "stale-read-two-winners", run: staleReadTwoWinners },
  { name: "unordered-ids-two-winners", run: unorderedIdsTwoWinners },
  { name: "strict-unique-deadlock", run: strictDeadlock },
  { name: "abandonment-does-not-transfer", run: abandonmentDoesNotTransfer },
  { name: "manual-release-precondition", run: manualRelease },
  { name: "local-recovery", run: localRecovery },
  { name: "legacy-claim", run: legacyClaim },
  { name: "release-refuses-malformed", run: releaseRefusesMalformed },
  { name: "claim-for-another-ticket", run: claimForAnotherTicket },
];
