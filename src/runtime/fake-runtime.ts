import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { AGENT_MARKER } from "../tracker/port.js";
import { DESFECHO_FILENAME, type OutcomeRecord } from "../state/outcome.js";
import type { IssueRef } from "../tracker/port.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "./port.js";
import { appendAttemptEvent } from "./attempt-logs.js";
import { SESSIONS_SUBDIR } from "../layout.js";

/**
 * The fake runtime: worker launches that return scriptable outcomes, to
 * exercise the ruler without any container (ticket 13 consumes it).
 *
 * Scripted outcomes, per launch, in order (the last repeats once exhausted):
 *   pr-open             — writes the record (class pr-open) and opens a PR via the tracker
 *   clean-without-pr    — writes the record (class clean-without-pr), no PR
 *   blocked-self-report — writes the record (class blocked-self-report), no PR
 *   abrupt-death        — writes nothing: the absence of the record is the class
 *
 * A launch may also be told to die by a model provider outage: the fake records the
 * provider's failing stream line into the attempt's log (the same artifact the
 * real runtime writes), so the factory's own detection reads it (issue 144).
 *
 * Issue #146: the runtime also carries the stop contract. A cooperative
 * request ends a parked launch as an abrupt death with no record — exactly the
 * footprint of a stopped session; a forced stop ends it the same way and says
 * the worker is gone. The options let a test choose a worker that ignores the
 * request or a force that cannot confirm the end, the two failure modes the
 * factory must survive without lying.
 */

export type ScriptedOutcome = SessionResult["outcome"];

export interface FakeWorkerRuntimeOptions {
  outcomes?: ScriptedOutcome[];
  /** Needed so the fake can actually open the PR the script promises. */
  tracker?: FakeTrackerAdapter;
  /** Deterministic timing control for scenario tests: each launch awaits the
   * returned promise (before applying its outcome) — a worker can be parked
   * mid-flight, or a signal fired at the act of its launch, without sleeps. */
  hold?: (request: WorkRequest, index: number) => Promise<void> | void;
  /** The provider error of one launch, when the session died upstream: the
   *  provider's message becomes the failing stream line of the attempt's log.
   *  Null keeps the launch a plain abrupt death. */
  modelProviderErrors?: (request: WorkRequest, index: number) => string | null;
  /** The worker ignores the cooperative request (a hung session): only the
   * hold or the forced stop ends it. */
  ignoreStop?: boolean;
  /** The forced stop cannot confirm the end: the worker survives it. */
  forceUnconfirmed?: boolean;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The session of one launch while it can still be stopped. */
interface FakeSession {
  ref: IssueRef;
  /** Ends the parked launch either way. */
  wake: Deferred;
  /** The cooperative request; the launch reports the stop through it. */
  cooperative: Deferred;
  /** The forced stop; the launch reports the stop through it. */
  forced: Deferred;
}

/** The work key the factory uses: "<repo>#<n>". */
const keyOf = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

/** The launch of one work among a run's results, by issue number. Concurrent
 * admissions reach the runtime in no contractual order, so a test asks for the
 * work it means instead of indexing by position. */
export function launchOf(
  launched: readonly SessionResult[],
  number: number,
): SessionResult | undefined {
  return launched.find((result) => result.request.ref.number === number);
}

export class FakeWorkerRuntime implements WorkerRuntime {
  readonly launched: WorkRequest[] = [];
  /** The works a cooperative stop was requested for, in order. */
  readonly stopRequests: string[] = [];
  /** The works a forced stop was requested for, in order. */
  readonly forcedStops: string[] = [];
  /** Instance-level hold hook — settable by tests after construction. */
  hold?: (request: WorkRequest, index: number) => Promise<void> | void;
  private readonly script: ScriptedOutcome[];
  private readonly sessions = new Map<string, FakeSession>();
  private cursor = 0;

  constructor(private readonly options: FakeWorkerRuntimeOptions = {}) {
    this.script = options.outcomes ?? [];
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    const index = this.launched.push(request) - 1;
    const key = keyOf(request.ref);
    const session: FakeSession = {
      ref: request.ref,
      wake: deferred(),
      cooperative: deferred(),
      forced: deferred(),
    };
    this.sessions.set(key, session);

    try {
      const hold = this.hold ?? this.options.hold;
      const work = hold === undefined ? Promise.resolve("work") : Promise.resolve(hold(request, index)).then(() => "work");
      // A hung worker ignores the cooperative request: only its own hold or
      // the forced stop ends it. The race is honest: a worker that finished
      // before reacting to the stop still has its confirmed outcome.
      const stopSource = this.options.ignoreStop === true ? session.forced.promise : session.wake.promise;
      const stopped = stopSource.then(() => "stop");
      const winner = await Promise.race([work, stopped]);
      if (winner === "stop") return { request, outcome: "abrupt-death" };
    } finally {
      this.sessions.delete(key);
    }

    this.startSession(request);
    const outcome = this.next();
    await this.apply(outcome, request, index);
    return { request, outcome };
  }

  /** Ask the session to end; the launch promise resolves with its aftermath. */
  requestStop(ref: IssueRef): void {
    const key = keyOf(ref);
    this.stopRequests.push(key);
    const session = this.sessions.get(key);
    if (session === undefined) return;
    session.cooperative.resolve();
    if (this.options.ignoreStop !== true) session.wake.resolve();
  }

  /** Force the session gone; a fake container is instantly removed. */
  async forceStop(ref: IssueRef): Promise<void> {
    const key = keyOf(ref);
    this.forcedStops.push(key);
    if (this.options.forceUnconfirmed === true) {
      throw new Error(`fake: the worker of ${key} survived the forced stop`);
    }
    const session = this.sessions.get(key);
    if (session === undefined) return;
    session.forced.resolve();
    session.wake.resolve();
  }

  /** The sessions alive right now: a stopped launch still counts until it ended. */
  async liveWorkers(): Promise<ReadonlyArray<{ key: string }>> {
    return [...this.sessions.keys()].map((key) => ({ key }));
  }

  /** Resolves once a cooperative stop was requested for this work — the seam a
   *  test's hold awaits to end voluntarily inside the cooperative window. */
  whenStopRequested(ref: IssueRef): Promise<void> {
    return this.sessions.get(keyOf(ref))?.cooperative.promise ?? Promise.resolve();
  }

  /** The attempt begins: the runtime writes the session dir and the
   * attempt's event log the moment the session is up (ticket 13). An attempt
   * that dies abruptly leaves exactly this — a start line and no end. */
  private startSession(request: WorkRequest): void {
    mkdirSync(join(request.workDir, SESSIONS_SUBDIR), { recursive: true });
    this.event(request, "session-start");
  }

  private event(request: WorkRequest, event: string, extra: Record<string, unknown> = {}): void {
    appendAttemptEvent(request.workDir, request.attempt, { event, ...extra });
  }

  private next(): ScriptedOutcome {
    if (this.script.length === 0) return "abrupt-death";
    const outcome = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    return outcome ?? "abrupt-death";
  }

  private async apply(outcome: ScriptedOutcome, request: WorkRequest, index: number): Promise<void> {
    if (outcome === "abrupt-death") {
      // A model provider outage leaves the provider's own stream line behind — the
      // real runtime records pi's stdout verbatim, and the factory reads the
      // turn's ending from it (issue 144). One identity per launch keeps the
      // fake's failures as distinct as real sessions'.
      const message = this.options.modelProviderErrors?.(request, index) ?? null;
      if (message !== null) {
        this.event(request, "agent-raw", {
          iteration: 1,
          line: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              provider: "fake",
              model: "fake/model",
              stopReason: "error",
              errorMessage: message,
              timestamp: 1_700_000_000_000 + index,
            },
          }),
        });
      }
      return; // the process died mid-flight: nothing further is written
    }

    let pr: OutcomeRecord["pr"];
    if (outcome === "pr-open") {
      const tracker = this.options.tracker;
      if (!tracker) throw new Error("fake runtime: pr-open needs a tracker to open the PR");
      // Same branch, same PR (ticket 04 Q10): when the work's PR is already
      // open on this branch, the worker reuses it — a feedback round never
      // opens a second PR.
      const feedback = await tracker.readPrFeedback(request.ref);
      const existing = feedback.known ? feedback.value.pr : null;
      const reused = existing !== null && existing.state === "open" && existing.headBranch === request.branch;
      if (reused && existing) {
        pr = { repo: request.ref.repo, number: existing.number, branch: request.branch };
        // The norma (ticket 07 Q3): the worker ends EVERY feedback round by
        // commenting on the PR what it addressed — the ball goes back to the
        // human, derivable from the PR alone.
        tracker.addPrComment(
          { repo: request.ref.repo, prNumber: existing.number },
          tracker.workerAccount,
          `${AGENT_MARKER} addressed the feedback (attempt ${request.attempt}) — see the new commits on ${request.branch}`,
        );
      } else {
        const opened = await tracker.openPr({
          repo: request.ref.repo,
          issueNumber: request.ref.number,
          headBranch: request.branch,
          baseBranch: "main",
          title: `work ${request.ref.repo}#${request.ref.number}`,
        });
        pr = { repo: request.ref.repo, number: opened.number, branch: request.branch };
      }
    }

    const record: OutcomeRecord = {
      class: outcome,
      attempt: request.attempt,
      ...(pr === undefined ? {} : { pr }),
    };
    mkdirSync(request.workDir, { recursive: true });
    writeFileSync(join(request.workDir, DESFECHO_FILENAME), JSON.stringify(record, null, 2), "utf8");
    this.event(request, "session-end", { outcome });
  }
}
