import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { AGENT_MARKER } from "../tracker/port.js";
import { DESFECHO_FILENAME, type OutcomeRecord } from "../state/outcome.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { workKeyOf } from "../pool/work-key.js";
import type { LiveWorker } from "../state/liveness.js";
import { appendAttemptEvent } from "./attempt-logs.js";
import { SESSIONS_SUBDIR } from "../layout.js";
import { deferred, type Deferred } from "./deferred.js";
import type { RetroRequest, SessionResult, WorkRequest, WorkerRuntime } from "./port.js";

/**
 * The fake runtime: worker launches that return scriptable outcomes, to
 * exercise the ruler without any container.
 *
 * Scripted outcomes, per launch, in order (the last repeats once exhausted):
 *   pr-open             — writes the record (class pr-open) and opens a PR via the tracker
 *   clean-without-pr    — writes the record (class clean-without-pr), no PR
 *   blocked-self-report — writes the record (class blocked-self-report), no PR
 *   abrupt-death        — writes nothing: the absence of the record is the class
 *
 * A launch may also be told to die by a model provider outage: the fake records the
 * provider's failing stream line into the attempt's log (the same artifact the
 * real runtime writes), so the factory's own detection reads it.
 *
 * The runtime also carries the stop contract. A cooperative
 * request ends a parked launch as an abrupt death with no record — exactly the
 * footprint of a stopped session; a forced stop ends it the same way and says
 * the worker is gone. The options let a test choose a worker that ignores the
 * request or a force that cannot confirm the end, the two failure modes the
 * factory must survive without lying.
 */

export type ScriptedOutcome = SessionResult["outcome"];

/**
 * What one retrospective round's agent is scripted to do: write
 * the report (or die without it) and file a declared set of items. The fake
 * writes the same two artifacts the real agent writes, so the factory's
 * artifact contract — the report as the marker, the result record as the
 * filing ledger — is what the tests exercise.
 */
export interface RetroScript {
  /** False models a round that ended without its report (an abrupt death). */
  report?: boolean;
  /** The items the round filed, by destination. */
  filed?: Array<{ repo: string; number: number; title?: string }>;
  /** The candidates the round discarded, with the reason recorded in the report. */
  discarded?: Array<{ title: string; reason: string }>;
}

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
  /** One scripted retrospective round per launch; the last repeats. */
  retro?: RetroScript[];
  /** Deterministic control over a round's duration, like `hold` for workers. */
  holdRetro?: (request: RetroRequest, index: number) => Promise<void> | void;
}

/** The session of one launch while it can still be stopped. */
interface FakeSession {
  work: WorkIdentity;
  /** Ends the parked launch either way. */
  wake: Deferred;
  /** The cooperative request: what a test's hold awaits to end voluntarily
   *  inside the window (the launch itself reacts to `wake`/`forced`). */
  cooperative: Deferred;
  /** The forced stop; the launch reports the stop through it. */
  forced: Deferred;
}

/** The launch of one work among a run's results, by its Work key. Concurrent
 * admissions reach the runtime in no contractual order, so a test asks for the
 * work it means instead of indexing by position. */
export function launchOf(
  launched: readonly SessionResult[],
  work: WorkIdentity,
): SessionResult | undefined {
  const key = workKeyOf(work);
  return launched.find((result) => workKeyOf(result.request.work) === key);
}

export class FakeWorkerRuntime implements WorkerRuntime {
  readonly launched: WorkRequest[] = [];
  /** Every retrospective launch, in order — the retro launch shape as recorded. */
  readonly retroLaunched: RetroRequest[] = [];
  /** The works a cooperative stop was requested for, in order. */
  readonly stopRequests: string[] = [];
  /** The works a forced stop was requested for, in order. */
  readonly forcedStops: string[] = [];
  /** The sessions this fake continued — the launch carried a
   *  resume, so the work's own session was reopened instead of a new one. */
  readonly resumed: WorkRequest[] = [];
  /** Instance-level hold hook — settable by tests after construction. */
  hold?: (request: WorkRequest, index: number) => Promise<void> | void;
  /** Instance-level round hold hook — settable by tests after construction. */
  holdRetro?: (request: RetroRequest, index: number) => Promise<void> | void;
  private readonly script: ScriptedOutcome[];
  private readonly retroScript: RetroScript[];
  private readonly sessions = new Map<string, FakeSession>();
  private cursor = 0;

  constructor(private readonly options: FakeWorkerRuntimeOptions = {}) {
    this.script = options.outcomes ?? [];
    this.retroScript = options.retro ?? [];
  }

  /** The scripted round writes the same two artifacts the agent writes — the
   *  report and the result record — so a test observes the factory's contract,
   *  not the fake's prose. A round with `report: false` leaves neither. */
  async launchRetro(request: RetroRequest): Promise<void> {
    const index = this.retroLaunched.push(request) - 1;
    const hold = this.holdRetro ?? this.options.holdRetro;
    if (hold !== undefined) await hold(request, index);
    const script = this.retroScriptFor(index);
    if (script === undefined || script.report === false) return;
    const filed = script.filed ?? [];
    const discarded = script.discarded ?? [];
    writeFileSync(
      request.reportPath,
      [
        `# Retrospective ${request.round} (${request.language})`,
        "",
        request.summary,
        "",
        "## Candidates",
        "",
        "| Candidate | Outcome |",
        "| --- | --- |",
        ...filed.map(
          (item) => `| ${item.title ?? `${item.repo}#${item.number}`} | filed ${item.repo}#${item.number} |`,
        ),
        ...discarded.map((item) => `| ${item.title} | discarded: ${item.reason} |`),
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      request.resultPath,
      `${JSON.stringify(
        {
          round: request.round,
          language: request.language,
          filed: filed.map((item) => ({ repo: item.repo, number: item.number, title: item.title ?? "" })),
          discarded,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  /** The script of one round; the last scripted round repeats. */
  private retroScriptFor(index: number): RetroScript | undefined {
    return this.retroScript[Math.min(index, this.retroScript.length - 1)];
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    const index = this.launched.push(request) - 1;
    const key = workKeyOf(request.work);
    const session: FakeSession = {
      work: request.work,
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
  requestStop(work: WorkIdentity): void {
    const key = workKeyOf(work);
    this.stopRequests.push(key);
    const session = this.sessions.get(key);
    if (session === undefined) return;
    session.cooperative.resolve();
    if (this.options.ignoreStop !== true) session.wake.resolve();
  }

  /** Force the session gone; a fake container is instantly removed. */
  async forceStop(work: WorkIdentity): Promise<void> {
    const key = workKeyOf(work);
    this.forcedStops.push(key);
    if (this.options.forceUnconfirmed === true) {
      throw new Error(`fake: the worker of ${key} survived the forced stop`);
    }
    const session = this.sessions.get(key);
    if (session === undefined) return;
    session.forced.resolve();
    session.wake.resolve();
  }

  /** The sessions alive right now: a stopped launch still counts until it
   *  ended. Not part of the port — it is the double's own view of its
   *  "containers", which a test hands to the cycle as its liveness probe. */
  async liveWorkers(): Promise<LiveWorker[]> {
    return [...this.sessions.keys()].map((key) => ({ key, containerId: `fake-${key}`, ageMs: 0 }));
  }

  /** Resolves once a cooperative stop was requested for this work — the seam a
   *  test's hold awaits to end voluntarily inside the cooperative window. */
  whenStopRequested(work: WorkIdentity): Promise<void> {
    return this.sessions.get(workKeyOf(work))?.cooperative.promise ?? Promise.resolve();
  }

  /** The attempt begins: the runtime writes the session dir, the attempt's
   * event log and the Pi session file the moment the session is up. An
   * attempt that dies abruptly leaves exactly this — a
   * start line and no end. */
  private startSession(request: WorkRequest): void {
    mkdirSync(join(request.workDir, SESSIONS_SUBDIR), { recursive: true });
    this.event(request, "session-start");
    if (request.session === undefined) return;
    const file = this.sessionFile(request);
    mkdirSync(join(file, ".."), { recursive: true });
    if (request.session.mode === "resume") {
      this.resumed.push(request);
      appendFileSync(
        file,
        `${JSON.stringify({ type: "message", id: `resume-${request.attempt}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `continue attempt ${request.attempt}` } })}\n`,
        "utf8",
      );
      return;
    }
    const header = {
      type: "session",
      version: 3,
      id: request.session.sessionId,
      cwd: "/fake/worker",
      timestamp: new Date().toISOString(),
    };
    const first = {
      type: "message",
      id: "prompt-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: request.material.ticket.title },
    };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`, "utf8");
  }

  /** Where Pi would persist the session inside the bind-mounted dir. */
  private sessionFile(request: WorkRequest): string {
    const id = request.session?.sessionId ?? "no-session";
    return join(request.workDir, SESSIONS_SUBDIR, "--fake-worker--", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
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
      // turn's ending from it. One identity per launch keeps the
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
      // Same branch, same PR: when the work's PR is already
      // open on this branch, the worker reuses it — a feedback round never
      // opens a second PR.
      const feedback = await tracker.readPullRequestFeedback({ work: request.work, pullRequest: null });
      const existing = feedback.known ? feedback.value.pr : null;
      const reused = existing !== null && existing.state === "open" && existing.headBranch === request.branch;
      if (reused && existing) {
        pr = { repo: request.work.destination.repo, number: existing.number, branch: request.branch };
        // The norma: the worker ends EVERY feedback round by
        // commenting on the PR what it addressed — the ball goes back to the
        // human, derivable from the PR alone.
        tracker.addPrComment(
          { repo: request.work.destination.repo, prNumber: existing.number },
          tracker.workerAccount,
          `${AGENT_MARKER} addressed the feedback (attempt ${request.attempt}) — see the new commits on ${request.branch}`,
        );
      } else {
        const opened = await tracker.openPullRequest({
          work: request.work,
          headBranch: request.branch,
          baseBranch: "main",
          title: `work ${request.work.ticket.key}`,
        });
        pr = { repo: request.work.destination.repo, number: opened.number, branch: request.branch };
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
