import type { ContinuationContext, IssueContext, Runner, RunnerContext, RunKind, RunnerOutput } from "../runtime/runner.js";
import type { IssueRef } from "../tracker/port.js";
import { Announcements } from "./announcements.js";
import { recordTriageOutcome, type PlanStep, type TriageOutcome } from "./feedback.js";
import { JobRegistry } from "./job-registry.js";
import type { Delivery } from "./pr-rules.js";
import { parseRunOutput, type PrRef } from "./result.js";

// Owns dispatched invocations and their persistence-level errors.
export class ExecutionLoop {
  private readonly runs = new Set<Promise<void>>();
  private readonly runErrors: unknown[] = [];

  constructor(
    private readonly runner: Runner,
    private readonly registry: JobRegistry,
    private readonly announcements: Announcements,
    private readonly acceptPr: (key: string, pr: PrRef, delivery: Delivery, invocation: string) => Promise<void>,
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
    const run: Promise<void> = this.execute(key, ref, kind, maxIterations, delivery, invocation, continuation, issue).catch((error: unknown) => {
      this.runErrors.push(error);
    });
    this.runs.add(run);
    void run.then(() => this.runs.delete(run));
  }

  // Up to maxIterations invocations of the runner. A final output that is absent,
  // ambiguous or invalid is never success and stops the job at once.
  private async execute(
    key: string,
    ref: IssueRef,
    kind: RunKind,
    maxIterations: number,
    delivery: Delivery,
    invocation: string,
    continuation?: ContinuationContext,
    issue?: IssueContext,
  ): Promise<void> {
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
        await this.registry.apply(key, "intervention-required", {
          message: "runner falhou sem resultado estruturado",
          reason: "runner falhou sem resultado estruturado",
          invocation,
        });
        await this.settleTriage(key, step, "incomplete");
        return;
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
        await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
        await this.settleTriage(key, step, "incomplete");
        return;
      }
      const result = parsed.result;
      this.announcements.emitFor(key, "invocação-encerrada", "invocação encerrada", { resultado: result.status }, { invocation });
      switch (result.status) {
        case "needs_help":
          await this.registry.apply(key, "waiting-for-help", {
            message: `pedido de ajuda: ${result.question}`,
            question: result.question,
            context: result.context,
            invocation,
          });
          await this.settleTriage(key, step, "help");
          return;
        case "pr_ready":
          if (step === "list") {
            // The operator has not chosen yet: a PR taken as ready now would drop the triaged comments.
            const reason = "triagem terminou com PR pronto em vez de pedido de ajuda; os comentários não foram escolhidos pelo operador";
            await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
            await this.settleTriage(key, step, "incomplete");
            return;
          }
          await this.acceptPr(key, result.pr, delivery, invocation);
          await this.settleTriage(key, step, "complete");
          return;
        case "interrupted":
          await this.registry.apply(key, "interrupted", { message: `interrompido: ${result.reason}`, reason: result.reason, invocation });
          await this.settleTriage(key, step, "incomplete");
          return;
      }
    }
    const reason = `limite de iterações (${maxIterations}) atingido sem resultado válido`;
    await this.registry.apply(key, "intervention-required", { message: reason, reason, invocation });
    await this.settleTriage(key, step, "incomplete");
  }

  // Records how the invocation that carries a triage step ended: the phase advances, stays or is
  // cleared by the module that owns it (issue #21).
  private async settleTriage(key: string, step: PlanStep | undefined, outcome: TriageOutcome): Promise<void> {
    if (step === undefined) return;
    const current = this.registry.job(key);
    if (!current) return;
    const next = recordTriageOutcome(current, step, outcome);
    if (next !== current) await this.registry.persist(next);
  }

}
