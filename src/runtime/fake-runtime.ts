import { mkdirSync, writeFileSync } from "node:fs";
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
}

export class FakeWorkerRuntime implements WorkerRuntime {
  readonly launched: WorkRequest[] = [];
  private readonly script: ScriptedOutcome[];
  private cursor = 0;

  constructor(private readonly options: FakeWorkerRuntimeOptions = {}) {
    this.script = options.outcomes ?? [];
  }

  async launch(request: WorkRequest): Promise<SessionResult> {
    this.launched.push(request);
    const outcome = this.next();
    await this.apply(outcome, request);
    return { request, outcome };
  }

  private next(): ScriptedOutcome {
    if (this.script.length === 0) return "abrupt-death";
    const outcome = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    return outcome ?? "abrupt-death";
  }

  private async apply(outcome: ScriptedOutcome, request: WorkRequest): Promise<void> {
    if (outcome === "abrupt-death") return;

    let pr: OutcomeRecord["pr"];
    if (outcome === "pr-open") {
      const tracker = this.options.tracker;
      if (!tracker) throw new Error("fake runtime: pr-open needs a tracker to open the PR");
      const opened = await tracker.openPr({
        repo: request.ref.repo,
        issueNumber: request.ref.number,
        headBranch: request.branch,
        baseBranch: "main",
        title: `work ${request.ref.repo}#${request.ref.number}`,
      });
      pr = { repo: request.ref.repo, number: opened.number, branch: request.branch };
    }

    const record: OutcomeRecord = {
      class: outcome,
      attempt: request.attempt,
      ...(pr === undefined ? {} : { pr }),
    };
    mkdirSync(request.workDir, { recursive: true });
    writeFileSync(join(request.workDir, DESFECHO_FILENAME), JSON.stringify(record, null, 2), "utf8");
  }
}
