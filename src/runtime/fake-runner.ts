import type { Runner, RunnerContext, RunnerOutput } from "./runner.js";

// Deterministic runner for tests and the MVP slice before the Docker runner (#6).
// The script decides each call's output; an Error means the runner failed.
export type FakeScript = (context: RunnerContext) => RunnerOutput | Error | Promise<RunnerOutput | Error>;

export class FakeRunner implements Runner {
  readonly calls: RunnerContext[] = [];

  constructor(private readonly script: FakeScript) {}

  async run(context: RunnerContext): Promise<RunnerOutput> {
    this.calls.push({ ...context });
    const step = await this.script(context);
    if (step instanceof Error) throw step;
    return step;
  }
}

export const finished = (...results: unknown[]): RunnerOutput => ({ kind: "finished", results });
