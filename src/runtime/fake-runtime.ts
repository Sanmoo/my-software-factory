import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeTrackerAdapter } from "../tracker/fake-adapter.js";
import { DESFECHO_FILENAME, type OutcomeRecord } from "../state/outcome.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "./port.js";

/**
 * The fake runtime: worker launches that return scriptable outcomes, to
 * exercise the ruler without any container (ticket 13 consumes it).
 *
 * Scripted outcomes, per launch, in order (the last repeats once exhausted):
 *   pr-open             — writes the record (class pr-open) and opens a PR via the tracker
 *   clean-without-pr    — writes the record (class clean-without-pr), no PR
 *   blocked-self-report — writes the record (class blocked-self-report), no PR
 *   abrupt-death        — writes nothing: the absence of the record is the class
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
}

export class FakeWorkerRuntime implements WorkerRuntime {
  readonly launched: WorkRequest[] = [];
  /** Instance-level hold hook — settable by tests after construction. */
  hold?: (request: WorkRequest, index: number) => Promise<void> | void;
  private readonly script: ScriptedOutcome[];
  private cursor = 0;

  constructor(private readonly options: FakeWorkerRuntimeOptions = {}) {
    this.script = options.outcomes ?? [];
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    const index = this.launched.push(request) - 1;
    const hold = this.hold ?? this.options.hold;
    if (hold) await hold(request, index);
    this.startSession(request);
    const outcome = this.next();
    await this.apply(outcome, request);
    return { request, outcome };
  }

  /** The attempt begins: the runtime writes the session dir and the
   * attempt's event log the moment the session is up (ticket 13). An attempt
   * that dies abruptly leaves exactly this — a start line and no end. */
  private startSession(request: WorkRequest): void {
    mkdirSync(join(request.workDir, "sessao"), { recursive: true });
    this.event(request, "session-start");
  }

  private event(request: WorkRequest, event: string, extra: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ event, attempt: request.attempt, ...extra });
    appendFileSync(join(request.workDir, `log-${request.attempt}.jsonl`), `${line}\n`, "utf8");
  }

  private next(): ScriptedOutcome {
    if (this.script.length === 0) return "abrupt-death";
    const outcome = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    return outcome ?? "abrupt-death";
  }

  private async apply(outcome: ScriptedOutcome, request: WorkRequest): Promise<void> {
    if (outcome === "abrupt-death") return; // the process died mid-flight: nothing further is written

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
          `addressed the feedback (attempt ${request.attempt}) — see the new commits on ${request.branch}`,
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
