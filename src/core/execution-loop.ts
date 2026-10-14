import type { ContinuationContext, IssueContext, Runner, RunnerContext, RunKind, RunnerOutput } from "../runtime/runner.js";
import type { IssueRef } from "../tracker/port.js";
import { Announcements } from "./announcements.js";
import type { PlanStep, TriageOutcome } from "./feedback.js";
import type { JobRegistry } from "./job-registry.js";
import type { Delivery } from "./pr-rules.js";
import { parseRunOutput, type PrRef } from "./result.js";

// Every result carries how the invocation's triage step ended; Admission records it
// only after interpreting the result, preserving transition-before-triage ordering.
export type ExecutionOutcome = (
  | { status: "pr_ready"; pr: PrRef }
  | { status: "needs_help"; question: string; context: string }
  | { status: "interrupted"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "runner_failure" }
  | { status: "iteration_limit"; reason: string }
) & { triage: { step: PlanStep | undefined; outcome: TriageOutcome } };

// Owns dispatched invocations and their persistence-level errors.
export class ExecutionLoop {
  private readonly runs = new Set<Promise<void>>();
  private readonly runErrors: unknown[] = [];

  constructor(
    private readonly runner: Runner,
    private readonly registry: Pick<JobRegistry, "update" | "note">,
    private readonly announcements: Announcements,
    private readonly interpret: (key: string, outcome: ExecutionOutcome, delivery: Delivery, invocation: string) => Promise<void>,
  ) {}

  // Waits for every dispatched runner to finish; returns the errors of runs that failed
  // at the persistence level (runner failures are job results, not errors).
  async settle(): Promise<unknown[]> {
    while (this.runs.size > 0) await Promise.all(this.runs);
    return [...this.runErrors];
  }

  dispatch(
    key: string,
    ref: IssueRef,
    kind: RunKind,
    maxIterations: number,
    delivery: Delivery,
    invocation: string,
    continuation?: ContinuationContext,
    issue?: IssueContext,
  ): void {
    const run: Promise<void> = this.execute(key, ref, kind, maxIterations, delivery, invocation, continuation, issue)
      .then((outcome) => this.interpret(key, outcome, delivery, invocation))
      .catch((error: unknown) => {
        this.runErrors.push(error);
      });
    this.runs.add(run);
    void run.then(() => this.runs.delete(run));
  }

  // Up to maxIterations invocations of the runner. A final output that is absent,
  // ambiguous or invalid is never success and stops the job at once.
  async execute(
    key: string,
    ref: IssueRef,
    kind: RunKind,
    maxIterations: number,
    delivery: Delivery,
    invocation: string,
    continuation?: ContinuationContext,
    issue?: IssueContext,
  ): Promise<ExecutionOutcome> {
    const step: PlanStep | undefined = continuation?.plan.step;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      let output: RunnerOutput;
      const context: RunnerContext = {
        jobId: key,
        ref,
        repository: delivery.repository,
        kind,
        iteration,
        maxIterations,
        invocation,
        ...(continuation ? { continuation } : {}),
        ...(issue ? { issue } : {}),
      };
      try {
        output = await this.runner.run(context);
      } catch {
        this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "falha-do-runner" }, { invocation, level: "erro" });
        return { status: "runner_failure", triage: { step, outcome: "incomplete" } };
      }
      if (output.workspace) await this.registry.update(key, { workspace: output.workspace });
      if (output.kind === "continue") {
        this.announcements.emitFor(key, "invocação-encerrada", "iteração encerrada sem resultado final", { iteração: `${iteration}/${maxIterations}`, resultado: "sem-resultado" }, { invocation, level: "atenção" });
        if (iteration < maxIterations) {
          await this.registry.note(key, `iteração ${iteration}/${maxIterations} (${kind}) sem resultado final; nova iteração`);
        }
        continue;
      }
      const parsed = parseRunOutput(output.results);
      if (!parsed.ok) {
        const reason = `resultado inválido: ${parsed.reason}`;
        this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: "inválido" }, { invocation, level: "atenção" });
        return { status: "invalid", reason, triage: { step, outcome: "incomplete" } };
      }
      const result = parsed.result;
      this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: result.status }, { invocation });
      switch (result.status) {
        case "needs_help":
          return { ...result, triage: { step, outcome: "help" } };
        case "pr_ready":
          if (step === "list") {
            // The operator has not chosen yet: a PR taken as ready now would drop the triaged comments.
            const reason = "triagem terminou com PR pronto em vez de pedido de ajuda; os comentários não foram escolhidos pelo operador";
            return { status: "invalid", reason, triage: { step, outcome: "incomplete" } };
          }
          return { ...result, triage: { step, outcome: "complete" } };
        case "interrupted":
          return { ...result, triage: { step, outcome: "incomplete" } };
      }
    }
    const reason = `limite de iterações (${maxIterations}) atingido sem resultado válido`;
    return { status: "iteration_limit", reason, triage: { step, outcome: "incomplete" } };
  }
}
