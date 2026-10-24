import { Factory, type AcquisitionOutcome, type Observation } from "./factory.js";
import {
  claimRecord,
  CLAIMED_LABEL,
  CLAIM_PROPERTY_KEY,
  githubDestination,
  jiraTicket,
  parseClaim,
  ticketIdentityKey,
  type ClaimRecord,
  type Destination,
  type JiraTicket,
} from "./identity.js";
import { CAS_PREMISE_MODEL, DOCUMENTED_MODEL, JiraCloud, type JiraModel, type JsonValue } from "./jira.js";
import { releaseManually } from "./operator.js";
import { WorkerRuntime } from "./workers.js";

/**
 * The acceptance-criteria scenarios. Each one owns a fresh tracker and two or
 * more independent factories; the only shared state is the tracker. The facts
 * returned are what the tests assert and what the evidence file records.
 */

const SHARED_ACCOUNT = "shared-acting-account";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SceneFacts {
  scenario: string;
  note: string;
  workers: Array<{ factory: string; ticket: string; attempt: number }>;
  workerCount: number;
  launches: number;
  attemptsByFactory: Record<string, number>;
  claims: Record<string, string | null>;
  writes: number;
  requests: string[];
  outcomes: Record<string, string>;
  details: Record<string, string>;
}

function outcomeText(outcome: AcquisitionOutcome | null | undefined): string {
  if (outcome === null || outcome === undefined) return "none";
  return outcome.kind === "authorized" ? "authorized" : `${outcome.kind}: ${outcome.reason}`;
}

function observationText(observation: Observation | undefined): string {
  return observation === undefined ? "none" : observation.kind;
}

export class Lab {
  readonly tracker: JiraCloud;
  readonly runtime = new WorkerRuntime();
  readonly factoryMap = new Map<string, Factory>();
  readonly ticketMap = new Map<string, JiraTicket>();

  constructor(readonly model: JiraModel = CAS_PREMISE_MODEL) {
    this.tracker = new JiraCloud(model);
  }

  seed(
    ticket: JiraTicket,
    issue?: { properties?: Record<string, JsonValue>; assignee?: string | null; labels?: string[]; status?: string },
  ): JiraTicket {
    this.ticketMap.set(ticketIdentityKey(ticket), ticket);
    this.tracker.seedIssue({
      site: ticket.site,
      stableId: ticket.stableId,
      key: ticket.key,
      ...(issue ?? {}),
    });
    return ticket;
  }

  factory(id: string, ticket: JiraTicket, options?: { destination?: Destination; accountId?: string }): Factory {
    const factory = new Factory(
      {
        id,
        accountId: options?.accountId ?? SHARED_ACCOUNT,
        destination:
          options?.destination ?? githubDestination({ site: "github.com", repo: `Sanmoo/dest-${id}` }),
        claimedLabel: CLAIMED_LABEL,
      },
      ticket,
      this.tracker,
      this.runtime,
    );
    this.factoryMap.set(id, factory);
    this.ticketMap.set(ticketIdentityKey(ticket), ticket);
    return factory;
  }

  f(id: string): Factory {
    const factory = this.factoryMap.get(id);
    if (factory === undefined) throw new Error(`unknown factory ${id}`);
    return factory;
  }

  claims(): Record<string, string | null> {
    const claims: Record<string, string | null> = {};
    for (const [key, ticket] of this.ticketMap) {
      const stored = this.tracker.storedProperty(ticket.site, Number(ticket.stableId), CLAIM_PROPERTY_KEY);
      if (stored.kind === "absent") {
        claims[key] = null;
        continue;
      }
      const parsed = parseClaim(stored.value, key);
      claims[key] = parsed.kind === "valid" ? parsed.record.factory : "<malformed>";
    }
    return claims;
  }

  facts(input: {
    scenario: string;
    note: string;
    outcomes?: Record<string, string>;
    details?: Record<string, string>;
  }): SceneFacts {
    const workers = this.runtime
      .all()
      .filter((worker) => worker.alive)
      .map((worker) => ({ factory: worker.factory, ticket: worker.ticket, attempt: worker.attempt }));
    const attemptsByFactory: Record<string, number> = {};
    for (const [id, factory] of this.factoryMap) attemptsByFactory[id] = factory.attempts();
    return {
      scenario: input.scenario,
      note: input.note,
      workers,
      workerCount: workers.length,
      launches: this.runtime.all().length,
      attemptsByFactory,
      claims: this.claims(),
      writes: this.tracker.appliedWrites(),
      requests: this.tracker.requestLog().map((entry) => `${entry.factory} ${entry.op} -> ${entry.outcome}`),
      outcomes: input.outcomes ?? {},
      details: input.details ?? {},
    };
  }
}

function defaultTicket(site = "alpha.atlassian.net"): JiraTicket {
  return jiraTicket({ site, stableId: "10001", key: "OPS-1" });
}

/** One full CAS acquisition followed by presentation and launch. */
function acquireCas(lab: Lab, id: string): void {
  const factory = lab.f(id);
  factory.observe();
  const pending = factory.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  factory.completeClaim();
  factory.verifyClaim();
  factory.presentClaim();
  factory.launch();
}

function contendCas(lab: Lab, applyOrder: "ab" | "ba" = "ab"): void {
  const a = lab.f("A");
  const b = lab.f("B");
  a.observe();
  b.observe();
  const pendingA = a.submitClaim();
  const pendingB = b.submitClaim();
  const pending = applyOrder === "ab" ? [pendingA, pendingB] : [pendingB, pendingA];
  for (const entry of pending) {
    if (entry?.taskId != null) lab.tracker.applyJob(entry.taskId);
  }
  a.completeClaim();
  b.completeClaim();
  a.verifyClaim();
  b.verifyClaim();
  a.presentClaim();
  a.launch();
  b.presentClaim();
  b.launch();
}

/** The documented model witnessed: both commit and each verifies its own write. */
function contendDocumented(lab: Lab): void {
  const a = lab.f("A");
  const b = lab.f("B");
  a.observe();
  b.observe();
  const pendingA = a.submitClaim();
  const pendingB = b.submitClaim();
  if (pendingA?.taskId != null) lab.tracker.beginJob(pendingA.taskId);
  if (pendingB?.taskId != null) lab.tracker.beginJob(pendingB.taskId);
  if (pendingA?.taskId != null) lab.tracker.commitJob(pendingA.taskId);
  a.completeClaim();
  a.verifyClaim();
  a.presentClaim();
  a.launch();
  if (pendingB?.taskId != null) lab.tracker.commitJob(pendingB.taskId);
  b.completeClaim();
  b.verifyClaim();
  b.presentClaim();
  b.launch();
}

/** A blind-mark race: each factory writes its mark, reads it back, and runs. */
function raceBlindMarks(
  lab: Lab,
  write: (factory: Factory) => void,
  showsOwnMark: (factory: Factory) => boolean,
): void {
  for (const id of ["A", "B"] as const) {
    const factory = lab.f(id);
    factory.observe();
    write(factory);
    if (showsOwnMark(factory)) startDirect(lab, id);
  }
}

/** A blind/async write followed by read-back and launch, for C1 and C3. */
function candidateWriteThenLaunch(lab: Lab, write: (factory: Factory) => void): void {
  for (const id of ["A", "B"] as const) {
    const factory = lab.f(id);
    factory.observe();
    write(factory);
    factory.verifyClaim();
    factory.presentClaim();
    factory.launch();
  }
}

function startDirect(lab: Lab, id: string): void {
  lab.runtime.start({
    factory: id,
    ticket: ticketIdentityKey(lab.f(id).ticket),
    attempt: 1,
    at: lab.tracker.now(),
  });
}

function claimFor(factory: Factory, nonce: string): ClaimRecord {
  return claimRecord({
    factory: factory.id,
    nonce,
    ticket: factory.ticket,
    account: factory.accountId,
    destination: factory.destination,
    createdAt: "2026-10-24T12:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// Progress and contention
// ---------------------------------------------------------------------------

export function freeTicketProgresses(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  acquireCas(lab, "A");
  return lab.facts({
    scenario: "free-ticket-progresses",
    note: "a free Ticket, no contention: one Worker starts and one Attempt is consumed",
    outcomes: { A: outcomeText(lab.f("A").outcome()) },
  });
}

export function contestedSimultaneousCas(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  contendCas(lab);
  return lab.facts({
    scenario: "contested-simultaneous-cas",
    note: "P-CAS holds: both observed free and submitted, exactly one Worker is authorized",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
  });
}

export function contestedSimultaneousDocumented(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(DOCUMENTED_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  contendDocumented(lab);
  return lab.facts({
    scenario: "contested-simultaneous-documented",
    note: "documented semantics admit this interleaving: both jobs commit and each factory verifies its own write",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
  });
}

export function sameTicketDifferentDestinations(premise: "cas" | "documented"): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(
    premise === "cas"
      ? CAS_PREMISE_MODEL
      : DOCUMENTED_MODEL,
  );
  lab.seed(ticket);
  lab.factory("A", ticket, { destination: githubDestination({ site: "github.com", repo: "Sanmoo/repo-a" }) });
  lab.factory("B", ticket, { destination: githubDestination({ site: "github.com", repo: "Sanmoo/repo-b" }) });
  if (premise === "cas") contendCas(lab);
  else contendDocumented(lab);
  return lab.facts({
    scenario: `same-ticket-different-destinations-${premise}`,
    note: "the claim is per Ticket; a factory configured with another Destination neither bypasses it nor is blinded by it",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "ticket identity": ticketIdentityKey(ticket),
      "A destination": "github:github.com:Sanmoo/repo-a",
      "B destination": "github:github.com:Sanmoo/repo-b",
    },
  });
}

export function twoSitesSamePresentationKey(): SceneFacts {
  const alpha = jiraTicket({ site: "alpha.atlassian.net", stableId: "10001", key: "OPS-1" });
  const beta = jiraTicket({ site: "beta.atlassian.net", stableId: "10001", key: "OPS-1" });
  const lab = new Lab();
  lab.seed(alpha);
  lab.seed(beta);
  lab.factory("A", alpha);
  lab.factory("B", beta);
  acquireCas(lab, "A");
  acquireCas(lab, "B");
  return lab.facts({
    scenario: "two-sites-same-key-and-id",
    note: "same presentation key and even the same provider id on two sites: distinct Tickets, both may run",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "alpha identity": ticketIdentityKey(alpha),
      "beta identity": ticketIdentityKey(beta),
      "presentation": "OPS-1 on both sites",
    },
  });
}

export function subIssuesRunInParallel(): SceneFacts {
  const parent = jiraTicket({ site: "alpha.atlassian.net", stableId: "10000", key: "OPS-1" });
  const child = jiraTicket({ site: "alpha.atlassian.net", stableId: "10002", key: "OPS-2" });
  const lab = new Lab();
  lab.seed(parent);
  lab.seed(child);
  lab.factory("A", parent);
  lab.factory("B", child);
  acquireCas(lab, "A");
  acquireCas(lab, "B");
  return lab.facts({
    scenario: "sub-issues-run-in-parallel",
    note: "a parent Claim does not cover its sub-issue: they are distinct Tickets",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: { parent: ticketIdentityKey(parent), child: ticketIdentityKey(child) },
  });
}

export function distinctTicketsRunInParallel(): SceneFacts {
  const first = jiraTicket({ site: "alpha.atlassian.net", stableId: "10001", key: "OPS-1" });
  const second = jiraTicket({ site: "alpha.atlassian.net", stableId: "10002", key: "OPS-2" });
  const lab = new Lab();
  lab.seed(first);
  lab.seed(second);
  lab.factory("A", first);
  lab.factory("B", second);
  acquireCas(lab, "A");
  acquireCas(lab, "B");
  return lab.facts({
    scenario: "distinct-tickets-run-in-parallel",
    note: "two distinct Tickets acquire concurrently without serializing each other",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
  });
}

// ---------------------------------------------------------------------------
// Claims that already exist, uncertain acquisitions, abandonment
// ---------------------------------------------------------------------------

export function existingClaimIsRespected(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  const b = lab.f("B");
  const observation = b.observe();
  const attempted = b.submitClaim();
  return lab.facts({
    scenario: "existing-claim-is-respected",
    note: "B observes A's valid claim and writes nothing: no read, no removal, no Attempt",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(b.outcome()) },
    details: {
      "B observation": observationText(observation),
      "B submitted": attempted === null ? "no" : "yes",
      "claim factory": String(lab.claims()[ticketIdentityKey(ticket)]),
    },
  });
}

export function lostResponseDoesNotLaunch(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  const a = lab.f("A");
  a.observe();
  a.submitClaim({ loseResponseAfterScheduling: true });
  a.completeClaim();
  const firstOutcome = a.outcome();
  const attemptsBefore = a.attempts();
  const taskIds = lab.tracker.scheduledTaskIds();
  const taskId = taskIds[0];
  if (taskId !== undefined) lab.tracker.applyJob(taskId);
  const bObservation = lab.f("B").observe();
  const afterVerification = a.verifyClaim();

  // A must not have launched before verification, and must not have removed a
  // claim it could not see: it only verifies.
  const launchedAfterVerification = a.launch();
  const submittedRequests = lab.tracker
    .requestLog()
    .filter((entry) => entry.factory === "A" && entry.op.includes("bulk issue property") && entry.outcome === "scheduled");
  return lab.facts({
    scenario: "lost-response-does-not-launch",
    note: "the write was applied and the response was lost: no launch, no removal and no Attempt until the claim is verified",
    outcomes: { A: outcomeText(afterVerification), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "outcome after the lost response": outcomeText(firstOutcome),
      "attempts before verification": String(attemptsBefore),
      "A submissions": String(submittedRequests.length),
      "launched after verification": launchedAfterVerification === null ? "no" : "yes",
      "B observation": observationText(bObservation),
    },
  });
}

export function failedReadDoesNotAuthorize(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  a.completeClaim();
  lab.tracker.failNextRead("503 Service Unavailable");
  const failedVerification = a.verifyClaim();
  const attemptsAfterFailure = a.attempts();
  const launchAfterFailure = a.launch();
  const recoveredVerification = a.verifyClaim();
  const launchAfterRecovery = a.launch();
  return lab.facts({
    scenario: "failed-read-does-not-authorize",
    note: "a failed verification read leaves the acquisition uncertain: no launch and no Attempt; a later read authorizes",
    outcomes: { A: outcomeText(recoveredVerification) },
    details: {
      "outcome after the failed read": outcomeText(failedVerification),
      "attempts after the failed read": String(attemptsAfterFailure),
      "launch after the failed read": launchAfterFailure === null ? "no" : "yes",
      "launch after the successful read": launchAfterRecovery === null ? "no" : "yes",
    },
  });
}

export function failedJobWritesNothing(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.failJob(pending.taskId, "the transaction failed");
  a.completeClaim();
  const failedOutcome = a.verifyClaim();
  const launchAfterFailure = a.launch();
  const attemptsAfterFailure = a.attempts();

  // A failed task is documented to have updated nothing, so a new acquisition
  // is allowed; the first one consumed no Attempt.
  a.observe();
  const retry = a.submitClaim();
  if (retry?.taskId != null) lab.tracker.applyJob(retry.taskId);
  a.completeClaim();
  a.verifyClaim();
  a.presentClaim();
  const launched = a.launch();
  return lab.facts({
    scenario: "failure-before-write",
    note: "a FAILED job is the documented all-or-nothing failure: nothing was written, no Attempt was spent, a retry may acquire",
    outcomes: { A: outcomeText(a.outcome()) },
    details: {
      "outcome after the failed job": outcomeText(failedOutcome),
      "launch after the failed job": launchAfterFailure === null ? "no" : "yes",
      "attempts after the failed job": String(attemptsAfterFailure),
      "launch after the retry": launched === null ? "no" : "yes",
    },
  });
}

export function failureBeforeScheduling(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  const a = lab.f("A");
  a.observe();
  a.submitClaim({ failBeforeScheduling: true });
  const firstOutcome = a.outcome();
  const attemptsAfterFailure = a.attempts();
  const launchAfterFailure = a.launch();

  a.observe();
  const retry = a.submitClaim();
  if (retry?.taskId != null) lab.tracker.applyJob(retry.taskId);
  a.completeClaim();
  a.verifyClaim();
  a.presentClaim();
  const launched = a.launch();
  return lab.facts({
    scenario: "failure-before-scheduling",
    note: "the request never reached Jira: no job, no claim, no Attempt; a clean retry acquires",
    outcomes: { A: outcomeText(a.outcome()) },
    details: {
      "outcome after the failed request": outcomeText(firstOutcome),
      "launch after the failed request": launchAfterFailure === null ? "no" : "yes",
      "attempts after the failed request": String(attemptsAfterFailure),
      "launch after the retry": launched === null ? "no" : "yes",
    },
  });
}

export function currentValueTransfer(premise: "cas" | "documented"): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(
    premise === "cas"
      ? CAS_PREMISE_MODEL
      : DOCUMENTED_MODEL,
  );
  lab.seed(ticket);
  const holder = lab.factory("A", ticket);
  const first = lab.factory("B", ticket);
  const second = lab.factory("C", ticket);
  const observed = claimFor(holder, "a-1");
  lab.tracker.setPropertyBlind({
    site: ticket.site,
    issueId: Number(ticket.stableId),
    propertyKey: CLAIM_PROPERTY_KEY,
    value: observed,
    factory: holder.id,
  });
  const firstJob = lab.tracker.submitConditional({
    site: ticket.site,
    issueId: Number(ticket.stableId),
    propertyKey: CLAIM_PROPERTY_KEY,
    value: claimFor(first, "b-1"),
    factory: first.id,
    filter: "current-value",
    currentValue: observed,
  });
  const secondJob = lab.tracker.submitConditional({
    site: ticket.site,
    issueId: Number(ticket.stableId),
    propertyKey: CLAIM_PROPERTY_KEY,
    value: claimFor(second, "c-1"),
    factory: second.id,
    filter: "current-value",
    currentValue: observed,
  });
  if (premise === "cas") {
    lab.tracker.applyJob(firstJob.taskId);
    lab.tracker.applyJob(secondJob.taskId);
  } else {
    lab.tracker.beginJob(firstJob.taskId);
    lab.tracker.beginJob(secondJob.taskId);
    lab.tracker.commitJob(firstJob.taskId);
    lab.tracker.commitJob(secondJob.taskId);
  }
  return lab.facts({
    scenario: `current-value-transfer-${premise}`,
    note: "currentValue is the same undocumented evaluation; two transfers conditioned on the same observed value can both commit",
    details: {
      "observed value": observed.factory,
      "final claim": String(lab.claims()[ticketIdentityKey(ticket)]),
      "transfer jobs committed": String(
        lab.tracker.requestLog().filter((entry) => entry.op === "bulk job" && entry.outcome === "applied").length,
      ),
    },
  });
}

export function noLocalReservationProvesNoAbandonment(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  const b = lab.f("B");
  const observation = b.observe();
  const attempted = b.submitClaim();
  return lab.facts({
    scenario: "no-local-reservation-proves-no-abandonment",
    note: "B's workspace has no Reservation for the Ticket; the foreign claim still blocks it",
    outcomes: { B: outcomeText(b.outcome()) },
    details: {
      "B observation": observationText(observation),
      "B reservation": b.reservation() === undefined ? "absent" : "present",
      "B submitted": attempted === null ? "no" : "yes",
    },
  });
}

export function deathAndTimeDoNotAuthorizeTakeover(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  lab.f("A").interrupt();
  lab.tracker.advance(30 * DAY_MS);
  const b = lab.f("B");
  const observation = b.observe();
  const attempted = b.submitClaim();
  return lab.facts({
    scenario: "death-and-time-do-not-authorize-takeover",
    note: "the Worker died and 30 days passed: no takeover, no expiry, no removal; the claim stays with A",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(b.outcome()) },
    details: {
      "alive Workers": String(lab.runtime.aliveCount()),
      "B observation": observationText(observation),
      "B submitted": attempted === null ? "no" : "yes",
      "claim factory": String(lab.claims()[ticketIdentityKey(ticket)]),
    },
  });
}

export function contactLossDoesNotAuthorizeTakeover(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  // A's factory becomes unreachable. The protocol has no channel to another
  // factory: B reads the tracker, not A's health, and A's Worker is still alive
  // (the experiment's witness; B cannot and does not inspect it).
  const holderWorkers = lab.runtime.aliveCount();
  lab.tracker.advance(6 * 60 * 60 * 1000);
  const b = lab.f("B");
  const observation = b.observe();
  const attempted = b.submitClaim();
  return lab.facts({
    scenario: "contact-loss-does-not-authorize-takeover",
    note: "the holder is unreachable; its Worker is alive and the Claim remains — no remote supervision, no takeover",
    outcomes: { B: outcomeText(b.outcome()) },
    details: {
      "holder Workers alive (experiment witness)": String(holderWorkers),
      "B observation": observationText(observation),
      "B submitted": attempted === null ? "no" : "yes",
      "B attempts": String(b.attempts()),
      "elapsed hours": "6",
    },
  });
}

export function localRecoveryKeepsTheAttempt(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  const a = lab.f("A");
  a.interrupt();
  const recovered = a.recover();
  const b = lab.f("B");
  const observation = b.observe();
  return lab.facts({
    scenario: "local-recovery-keeps-the-attempt",
    note: "A's local Recovery relaunches the SAME Attempt; B still sees the same claim and stays out",
    outcomes: { A: outcomeText(a.outcome()), B: outcomeText(b.outcome()) },
    details: {
      "recovered worker attempt": recovered === null ? "none" : String(recovered.attempt),
      "A attempts": String(a.attempts()),
      "worker starts": String(lab.runtime.all().length),
      "B observation": observationText(observation),
    },
  });
}

export function claimWithoutWorkerIsNotAbandoned(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  a.completeClaim();
  const bObservation = lab.f("B").observe();
  const bAttempted = lab.f("B").submitClaim();
  lab.tracker.advance(7 * DAY_MS);
  a.verifyClaim();
  a.presentClaim();
  const launched = a.launch();
  return lab.facts({
    scenario: "claim-without-worker-is-not-abandoned",
    note: "a claim with no Worker yet is a Reserved-without-Attempt, never an abandoned Ticket",
    outcomes: { A: outcomeText(a.outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "B observation": observationText(bObservation),
      "B submitted": bAttempted === null ? "no" : "yes",
      "A launch after recovery": launched === null ? "no" : "yes",
      "A attempts": String(a.attempts()),
    },
  });
}

// ---------------------------------------------------------------------------
// Partial / legacy / manual release
// ---------------------------------------------------------------------------

export function partialClaimHoldsWithoutAttempt(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  a.completeClaim();
  a.verifyClaim();
  a.setPresentationFailure({ assignee: true });
  const heldLaunch = a.launch();
  const attemptsWhileHeld = a.attempts();
  const bObservation = lab.f("B").observe();
  a.setPresentationFailure(null);
  const completedLaunch = a.launch();
  return lab.facts({
    scenario: "partial-claim-holds-without-attempt",
    note: "the authority write landed but its presentation failed: no Worker and no Attempt until the presentation completes",
    outcomes: { A: outcomeText(a.outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "launch while presentation is partial": heldLaunch === null ? "no" : "yes",
      "attempts while presentation is partial": String(attemptsWhileHeld),
      "B observation": observationText(bObservation),
      "launch after presentation": completedLaunch === null ? "no" : "yes",
    },
  });
}

export function malformedClaimIsUncertainty(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  const malformed: JsonValue = { protocol: "someone-else/v9", factory: "x" };
  lab.seed(ticket, { properties: { [CLAIM_PROPERTY_KEY]: malformed } });
  const b = lab.factory("B", ticket);
  const observation = b.observe();
  const attempted = b.submitClaim();
  const stored = lab.tracker.storedProperty(ticket.site, Number(ticket.stableId), CLAIM_PROPERTY_KEY);
  return lab.facts({
    scenario: "malformed-claim-is-uncertainty",
    note: "an unreadable property is uncertainty, never free: no write, no removal, no Attempt",
    outcomes: { B: outcomeText(b.outcome()) },
    details: {
      "B observation": observationText(observation),
      "B submitted": attempted === null ? "no" : "yes",
      "property preserved": stored.kind === "present" ? "yes" : "no",
    },
  });
}

export function legacyClaimIsRespected(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket, { labels: [CLAIMED_LABEL], assignee: SHARED_ACCOUNT });
  const b = lab.factory("B", ticket);
  const observation = b.observe();
  const attempted = b.submitClaim();
  return lab.facts({
    scenario: "legacy-claim-is-respected",
    note: "the old Claim (label + assignment to the acting account) blocks acquisition and is never cleared or promoted",
    outcomes: { B: outcomeText(b.outcome()) },
    details: {
      "B observation": observationText(observation),
      "B submitted": attempted === null ? "no" : "yes",
      "property": "absent",
    },
  });
}

export function manualReleaseNeedsConfirmedEnd(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  acquireCas(lab, "A");
  const a = lab.f("A");

  const whileAlive = releaseManually({
    tracker: lab.tracker,
    runtime: lab.runtime,
    ticket,
    confirmedWorkerEnd: true,
    actor: "operator",
  });
  const aliveWorker = lab.runtime.aliveFor(ticketIdentityKey(ticket))[0];
  if (aliveWorker !== undefined) lab.runtime.end(aliveWorker.id);
  const withoutConfirmation = releaseManually({
    tracker: lab.tracker,
    runtime: lab.runtime,
    ticket,
    confirmedWorkerEnd: false,
    actor: "operator",
  });
  const afterConfirmation = releaseManually({
    tracker: lab.tracker,
    runtime: lab.runtime,
    ticket,
    confirmedWorkerEnd: true,
    actor: "operator",
  });
  acquireCas(lab, "B");
  return lab.facts({
    scenario: "manual-release-needs-confirmed-end",
    note: "a tracker edit is not a remote interruption: release is refused while a Worker lives and without confirmation",
    outcomes: { A: outcomeText(a.outcome()), B: outcomeText(lab.f("B").outcome()) },
    details: {
      "release while a Worker is alive": `${whileAlive.released ? "released" : "refused"} (${whileAlive.reason})`,
      "release without confirmation": `${withoutConfirmation.released ? "released" : "refused"} (${withoutConfirmation.reason})`,
      "release after confirmation": `${afterConfirmation.released ? "released" : "refused"} (${afterConfirmation.reason})`,
      "claim factory": String(lab.claims()[ticketIdentityKey(ticket)]),
    },
  });
}

export function nonParticipantBreaksThePremise(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  acquireCas(lab, "A");
  const intruder = claimFor(lab.f("A"), "intruder-nonce");
  lab.tracker.setPropertyBlind({
    site: ticket.site,
    issueId: Number(ticket.stableId),
    propertyKey: CLAIM_PROPERTY_KEY,
    value: { ...intruder, factory: "intruder" },
    factory: "intruder",
  });
  lab.runtime.start({
    factory: "intruder",
    ticket: ticketIdentityKey(ticket),
    attempt: 1,
    at: lab.tracker.now(),
  });
  return lab.facts({
    scenario: "non-participant-breaks-the-premise",
    note: "OUTSIDE the guarantee: a factory that ignores the protocol overwrites the claim and runs a second Worker",
    details: { participants: "intruder does not read, verify or respect the claim" },
  });
}

// ---------------------------------------------------------------------------
// Reads the API admits: stale search, stale verification, task order
// ---------------------------------------------------------------------------

export function staleSearchObservationStillLosesTheCas(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab({ ...CAS_PREMISE_MODEL, searchStale: true });
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  a.completeClaim();
  const b = lab.f("B");
  const bObservation = b.observe();
  const bPending = b.submitClaim();
  if (bPending?.taskId != null) lab.tracker.applyJob(bPending.taskId);
  b.completeClaim();
  const bOutcome = b.verifyClaim();
  const bLaunch = b.launch();
  a.verifyClaim();
  a.presentClaim();
  const aLaunch = a.launch();
  return lab.facts({
    scenario: "stale-search-observation-still-loses-the-cas",
    note: "the search said free while A's claim existed; the conditional write updated nothing and B did not launch",
    outcomes: { B: outcomeText(bOutcome), A: outcomeText(a.outcome()) },
    details: {
      "B observation": observationText(bObservation),
      "B launch": bLaunch === null ? "no" : "yes",
      "A launch": aLaunch === null ? "no" : "yes",
      "B attempts": String(b.attempts()),
    },
  });
}

export function staleVerificationOnlyAddsUncertainty(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab({ ...CAS_PREMISE_MODEL, readModel: "prefix" });
  lab.seed(ticket);
  lab.factory("A", ticket);
  const a = lab.f("A");
  a.observe();
  const pending = a.submitClaim();
  if (pending?.taskId != null) lab.tracker.applyJob(pending.taskId);
  a.completeClaim();
  const staleOutcome = a.verifyClaim();
  const launch = a.launch();
  const stored = lab.tracker.storedProperty(ticket.site, Number(ticket.stableId), CLAIM_PROPERTY_KEY);
  return lab.facts({
    scenario: "stale-verification-only-adds-uncertainty",
    note: "a stale verification read cannot authorize: the factory stays uncertain, spends no Attempt and keeps the claim",
    outcomes: { A: outcomeText(staleOutcome) },
    details: {
      "launch": launch === null ? "no" : "yes",
      "attempts": String(a.attempts()),
      "claim stored": stored.kind === "present" ? "yes" : "no",
    },
  });
}

export function asyncTaskOrderDoesNotDecide(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  contendCas(lab, "ba");
  const a = lab.f("A");
  const b = lab.f("B");
  return lab.facts({
    scenario: "async-task-order-does-not-decide",
    note: "A submitted first but B's job ran first: under P-CAS the job that found the property absent wins, not the submission order",
    outcomes: { A: outcomeText(a.outcome()), B: outcomeText(b.outcome()) },
    details: {
      "submission order": "A then B",
      "application order": "B then A",
      "winner": String(lab.claims()[ticketIdentityKey(ticket)]),
    },
  });
}

// ---------------------------------------------------------------------------
// Candidates that are not conditional writes
// ---------------------------------------------------------------------------

export function candidateBlindSingleProperty(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  candidateWriteThenLaunch(lab, (factory) => {
    lab.tracker.setPropertyBlind({
      site: ticket.site,
      issueId: Number(ticket.stableId),
      propertyKey: CLAIM_PROPERTY_KEY,
      value: claimFor(factory, `${factory.id}-1`),
      factory: factory.id,
    });
  });
  return lab.facts({
    scenario: "candidate-blind-single-property",
    note: "single-issue PUT + read-back: both write and each reads its own value before the other's write",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
  });
}

export function candidateBulkList(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab(CAS_PREMISE_MODEL);
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  candidateWriteThenLaunch(lab, (factory) => {
    const job = lab.tracker.submitListSet({
      site: ticket.site,
      issueId: Number(ticket.stableId),
      propertyKey: CLAIM_PROPERTY_KEY,
      value: claimFor(factory, `${factory.id}-1`),
      factory: factory.id,
    });
    lab.tracker.applyJob(job.taskId);
  });
  return lab.facts({
    scenario: "candidate-bulk-list",
    note: "POST /issue/properties (all-or-nothing list, no filter): the transaction is not a test-and-write",
    outcomes: { A: outcomeText(lab.f("A").outcome()), B: outcomeText(lab.f("B").outcome()) },
  });
}

export function candidateAssignment(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket, { accountId: "account-a" });
  lab.factory("B", ticket, { accountId: "account-b" });
  raceBlindMarks(
    lab,
    (factory) =>
      lab.tracker.setAssigneeBlind({
        site: ticket.site,
        issueId: Number(ticket.stableId),
        accountId: factory.accountId,
        factory: factory.id,
      }),
    (factory) => lab.tracker.issueView(ticket.site, Number(ticket.stableId)).assignee === factory.accountId,
  );
  return lab.facts({
    scenario: "candidate-assignment",
    note: "assignment is a blind, last-write-wins field; each factory reads its own account and runs",
    details: { "final assignee": String(lab.tracker.issueView(ticket.site, Number(ticket.stableId)).assignee) },
  });
}

export function candidateLabelEdit(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  raceBlindMarks(
    lab,
    (factory) =>
      lab.tracker.addLabelBlind({
        site: ticket.site,
        issueId: Number(ticket.stableId),
        label: `msf-claim:${factory.id}`,
        factory: factory.id,
      }),
    (factory) =>
      lab.tracker.issueView(ticket.site, Number(ticket.stableId)).labels.includes(`msf-claim:${factory.id}`),
  );
  return lab.facts({
    scenario: "candidate-label-edit",
    note: "a common edit adding a per-factory label: labels accumulate, so both factories read their own mark and run",
    details: { labels: lab.tracker.issueView(ticket.site, Number(ticket.stableId)).labels.join(",") },
  });
}

export function candidateWorkflowTransition(): SceneFacts {
  const ticket = defaultTicket();
  const lab = new Lab();
  lab.seed(ticket);
  lab.factory("A", ticket);
  lab.factory("B", ticket);
  raceBlindMarks(
    lab,
    (factory) =>
      lab.tracker.transitionBlind({
        site: ticket.site,
        issueId: Number(ticket.stableId),
        status: `Claimed by ${factory.id}`,
        factory: factory.id,
      }),
    (factory) => lab.tracker.issueView(ticket.site, Number(ticket.stableId)).status === `Claimed by ${factory.id}`,
  );
  return lab.facts({
    scenario: "candidate-workflow-transition",
    note: "a transition is a blind status write; it carries no condition tied to the claim and needs an unapproved workflow change",
    details: { "final status": lab.tracker.issueView(ticket.site, Number(ticket.stableId)).status },
  });
}

export function runScenarios(): SceneFacts[] {
  return [
    freeTicketProgresses(),
    contestedSimultaneousCas(),
    contestedSimultaneousDocumented(),
    sameTicketDifferentDestinations("cas"),
    sameTicketDifferentDestinations("documented"),
    twoSitesSamePresentationKey(),
    subIssuesRunInParallel(),
    distinctTicketsRunInParallel(),
    existingClaimIsRespected(),
    lostResponseDoesNotLaunch(),
    failedReadDoesNotAuthorize(),
    failedJobWritesNothing(),
    failureBeforeScheduling(),
    currentValueTransfer("documented"),
    currentValueTransfer("cas"),
    noLocalReservationProvesNoAbandonment(),
    deathAndTimeDoNotAuthorizeTakeover(),
    contactLossDoesNotAuthorizeTakeover(),
    localRecoveryKeepsTheAttempt(),
    claimWithoutWorkerIsNotAbandoned(),
    partialClaimHoldsWithoutAttempt(),
    malformedClaimIsUncertainty(),
    legacyClaimIsRespected(),
    manualReleaseNeedsConfirmedEnd(),
    nonParticipantBreaksThePremise(),
    staleSearchObservationStillLosesTheCas(),
    staleVerificationOnlyAddsUncertainty(),
    asyncTaskOrderDoesNotDecide(),
    candidateBlindSingleProperty(),
    candidateBulkList(),
    candidateAssignment(),
    candidateLabelEdit(),
    candidateWorkflowTransition(),
  ];
}
