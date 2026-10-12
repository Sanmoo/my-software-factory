import type { Runner, RunnerContext, RunnerOutput, Workspace } from "./runner.js";

// Deterministic runner for tests and the MVP slice before the Docker runner (#6).
// The script decides each call's output; an Error means the runner failed.
export type FakeScript = (context: RunnerContext) => RunnerOutput | Error | Promise<RunnerOutput | Error>;

export class FakeRunner implements Runner {
  readonly calls: RunnerContext[] = [];
  // Set to say the triage skill is missing, as a runner whose profile lacks it would.
  triageBlocker: string | undefined;
  // Set to say a required item of the runtime profile is missing, as a runner whose profile lacks it would.
  runtimeBlockerReason: string | undefined;

  constructor(private readonly script: FakeScript) {}

  async run(context: RunnerContext): Promise<RunnerOutput> {
    this.calls.push({ ...context });
    const step = await this.script(context);
    if (step instanceof Error) throw step;
    return step;
  }

  async runtimeBlocker(): Promise<string | undefined> {
    return this.runtimeBlockerReason;
  }

  async triageUnavailable(): Promise<string | undefined> {
    return this.triageBlocker;
  }
}

export const finished = (...results: unknown[]): RunnerOutput => ({ kind: "finished", results });

// Reports the session and area of an output, as a runner that knows them would. Accepts the
// pending output of a gate too, so a runner can report its workspace when it finishes.
export function withWorkspace(output: RunnerOutput, workspace: Workspace): RunnerOutput;
export function withWorkspace(output: Promise<RunnerOutput>, workspace: Workspace): Promise<RunnerOutput>;
export function withWorkspace(
  output: RunnerOutput | Promise<RunnerOutput>,
  workspace: Workspace,
): RunnerOutput | Promise<RunnerOutput> {
  if (output instanceof Promise) return output.then((resolved) => ({ ...resolved, workspace }));
  return { ...output, workspace };
}
