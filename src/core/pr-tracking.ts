import type { ProjectConfig } from "../config/types.js";
import type { Mergeability, PrFeedback, PrLookup, PrPort, PrSnapshot } from "../pr/port.js";
import type { Runner } from "../runtime/runner.js";
import type { Known } from "../tracker/port.js";
import { Announcements } from "./announcements.js";
import { describeItem, judgeConflict, judgePrFeedback, needsTriage, receiveFeedback } from "./feedback.js";
import { IssueWrites } from "./issue-writes.js";
import { recordPrStatus, type Job, type PrStatus } from "./job.js";
import type { JobRegistry } from "./job-registry.js";
import { deliveryOf, judgeReadyPr, judgeTrackedPr, misplacedRepository, type Delivery } from "./pr-rules.js";
import type { PrRef } from "./result.js";
import { messageOf } from "./values.js";

const statusKey = (status: PrStatus): string => JSON.stringify([status.checks, status.review, status.mergeable]);

const describeKnown = <T extends string>(label: string, known: Known<T>): string =>
  known.known ? `${label}: ${known.value}` : `${label}: desconhecido (${known.reason})`;

// Unknown mergeability is said as unknown: it is neither a conflict nor the absence of one.
const describeMergeable = (mergeable: Known<Mergeability>): string => {
  if (!mergeable.known) return `mergeabilidade desconhecida (${mergeable.reason})`;
  return mergeable.value === "conflicting" ? "PR em conflito" : "sem conflito";
};

const describeStatus = (status: PrStatus): string =>
  `${describeKnown("CI", status.checks)}; ${describeKnown("review", status.review)}; ${describeMergeable(status.mergeable)}`;

// Validates and follows PRs; it never admits or executes an invocation.
export class PrTracking {
  constructor(
    private readonly prs: PrPort,
    private readonly writes: IssueWrites,
    private readonly registry: Pick<JobRegistry, "job" | "persist" | "apply">,
    private readonly announcements: Announcements,
    private readonly runner: Pick<Runner, "triageUnavailable">,
  ) {}

  // A "PR pronto" result is accepted only after the PR port confirms it. An
  // invalid PR is a help request. A PR that cannot be read is neither success nor help: the
  // operator decides, so the job needs intervention.
  async acceptPr(key: string, pr: PrRef, delivery: Delivery, invocation?: string): Promise<void> {
    const misplaced = misplacedRepository(pr, delivery);
    if (misplaced !== undefined) {
      await this.refusePr(key, pr, misplaced, invocation);
      return;
    }
    let lookup: PrLookup;
    try {
      lookup = await this.prs.readPr(pr);
    } catch (error) {
      await this.registry.apply(key, "intervention-required", {
        message: `PR não pôde ser confirmado: ${messageOf(error)}`,
        reason: `PR não pôde ser confirmado no github.com: ${messageOf(error)}`,
        invocation,
      });
      return;
    }
    const verdict = judgeReadyPr(lookup, delivery);
    if (!verdict.valid) {
      await this.refusePr(key, pr, verdict.reason, invocation);
      return;
    }
    await this.registry.apply(key, "waiting-for-pr", { message: `PR validado: ${pr.repository}#${pr.number}`, pr, invocation });
    if (lookup.status === "found") await this.observe(key, lookup.pr);
  }

  private async refusePr(key: string, pr: PrRef, reason: string, invocation?: string): Promise<void> {
    await this.registry.apply(key, "waiting-for-help", {
      message: `PR pronto recusado: ${reason}`,
      question: `PR pronto não confirmado (${pr.repository}#${pr.number}): ${reason}. Corrija o PR ou informe o próximo passo.`,
      context: "",
      invocation,
    });
  }

  // Polling of a PR the job waits for: CI and review are recorded, a merge into
  // the target branch completes the job, and a PR closed without merge interrupts it.
  async trackPr(
    job: Job,
    project: ProjectConfig | undefined,
    report: { pular(key: string, motivo: string): void; falhar(key: string, mensagem: string): void },
  ): Promise<void> {
    if (!project) {
      report.pular(job.key, "projeto do trabalho não está habilitado na instância");
      return;
    }
    const pr = job.pr;
    if (!pr) {
      await this.registry.apply(job.key, "intervention-required", {
        message: "trabalho aguardando PR sem referência de PR",
        reason: "trabalho aguardando PR sem referência de PR",
      });
      return;
    }
    let lookup: PrLookup;
    try {
      lookup = await this.prs.readPr(pr);
    } catch (error) {
      report.falhar(job.key, `PR não pôde ser lido: ${messageOf(error)}`);
      return;
    }
    const verdict = judgeTrackedPr(lookup, deliveryOf(project, job.ref));
    switch (verdict.kind) {
      case "open":
        await this.observe(job.key, verdict.pr);
        // Comments first: a batch with a human comment waits for its triage, and a job that went to the
        // human because of it takes no conflict (issue #21).
        await this.collectPrFeedback(job, pr, report);
        await this.collectConflict(job, verdict.pr, report);
        return;
      case "merged":
        await this.announceMerge(job, pr, project.targetBranch);
        await this.complete(job, report, project.targetBranch);
        return;
      case "closed": {
        const reason = `PR fechado sem merge: ${pr.repository}#${pr.number}; não reaberto, issue fora de done`;
        await this.registry.apply(job.key, "interrupted", { message: reason, reason });
        return;
      }
      case "invalid": {
        const reason = `PR acompanhado não confere: ${verdict.reason}`;
        await this.registry.apply(job.key, "intervention-required", { message: reason, reason });
        return;
      }
    }
  }

  // A conflict of the open PR with its target branch becomes a correction with a slot and
  // a reason of its own. It is judged on the commits read now, so a failing feedback read never hides it.
  private async collectConflict(job: Job, snapshot: PrSnapshot, report: { pular(key: string, motivo: string): void }): Promise<void> {
    const current = this.registry.job(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const input = judgeConflict(snapshot, new Set(current.consumed ?? []));
    if (input === undefined) return;
    const outcome = receiveFeedback(current, [input], "conflito do PR recebido");
    if ("reason" in outcome) {
      report.pular(current.key, `conflito do PR ${outcome.reason}`);
      return;
    }
    await this.registry.persist(outcome.job);
    this.announcements.announceFeedback(current.key, [input]);
  }

  // Feedback on an open PR: human comments (conversation, inline, review bodies), and failing checks, become
  // a correction with a slot and priority. A case the factory cannot decide goes to the human,
  // and its items are consumed so they are not asked again.
  private async collectPrFeedback(job: Job, pr: PrRef, report: { pular(key: string, motivo: string): void; falhar(key: string, mensagem: string): void }): Promise<void> {
    let feedback: PrFeedback;
    try {
      feedback = await this.prs.readFeedback(pr);
    } catch (error) {
      report.falhar(job.key, `feedback do PR não pôde ser lido: ${messageOf(error)}`);
      return;
    }
    const current = this.registry.job(job.key);
    if (!current || current.state !== "waiting-for-pr") return;
    const judgement = judgePrFeedback(feedback, new Set(current.consumed ?? []), pr);
    if (judgement.inputs.length === 0 && judgement.undecidable === undefined) return;
    const consumed = judgement.inputs.flatMap((input) => (input.key === undefined ? [] : [input.key]));
    if (judgement.undecidable === undefined) {
      if (needsTriage(judgement.inputs)) {
        // A human comment is never corrected without its triage (issue #21): without the skill the
        // operator is asked, and nothing is consumed, so the comments come back with the PR.
        const unavailable = await this.runner.triageUnavailable?.({ ref: current.ref, repository: current.repository });
        if (unavailable !== undefined) {
          await this.registry.apply(job.key, "waiting-for-help", {
            message: `triagem do feedback do PR indisponível: ${unavailable}`,
            question: `Há comentário humano novo no PR (${pr.repository}#${pr.number}) e a triagem com /skill:gh-address-comments não pode rodar: ${unavailable}.`
              + " Nenhuma correção foi feita e nenhum item foi consumido: eles voltam a ser lidos quando o PR for acompanhado de novo."
              + " Resolva a causa e responda para retomar, ou libere o trabalho.",
            context: "",
          });
          return;
        }
      }
      const outcome = receiveFeedback(current, judgement.inputs, "feedback do PR recebido");
      if ("reason" in outcome) {
        report.pular(job.key, `feedback do PR ${outcome.reason}`);
        return;
      }
      await this.registry.persist(outcome.job);
      this.announcements.announceFeedback(job.key, judgement.inputs);
      return;
    }
    const items = judgement.inputs.length === 0 ? "" : ` Itens: ${judgement.inputs.map(describeItem).join("; ")}.`;
    await this.registry.apply(job.key, "waiting-for-help", {
      message: `feedback do PR exige decisão humana: ${judgement.undecidable}`,
      question: `Feedback do PR (${pr.repository}#${pr.number}) não pode ser decidido pela factory: ${judgement.undecidable}.`
        + `${items} Responda com a orientação ou libere o trabalho.`,
      context: "",
      consumed,
    });
  }

  // The external merge of the linked PR, seen once: recorded on the job before it is announced,
  // so the next polls (while `done` is still pending) do not repeat it. The factory never merges.
  private async announceMerge(job: Job, pr: PrRef, targetBranch: string): Promise<void> {
    const current = this.registry.job(job.key) ?? job;
    if (current.mergeDetected !== undefined) return;
    await this.registry.persist({ ...current, mergeDetected: new Date().toISOString() });
    this.announcements.emitFor(job.key, "merge-detectado", "merge detectado", {
      pr: `${pr.repository}#${pr.number}`, destino: targetBranch, origem: "externa",
    }, { level: "progresso" });
  }

  // Merge confirmed by the PR port: the issue is done only when the tracker confirms it by
  // reread. Until then the job keeps waiting and the next poll tries again.
  private async complete(job: Job, report: { falhar(key: string, mensagem: string): void }, targetBranch: string): Promise<void> {
    const decision = await this.writes.complete(job.ref, { job: job.key, reason: "conclusão-após-merge" });
    if (decision.status === "pending") {
      this.announcements.emitFor(job.key, "conclusão-pendente", "merge confirmado; done ainda não confirmado", {
        motivo: decision.reason, próximo: "nova tentativa no próximo polling",
      }, { level: "atenção" });
      report.falhar(job.key, `PR mesclado; done ainda não confirmado pelo tracker (${decision.reason}): nova tentativa no próximo polling`);
      return;
    }
    await this.registry.apply(job.key, "done", {
      message: `PR mesclado em ${targetBranch}: issue done confirmada por releitura`,
    });
  }

  // Stores the latest PR observation; the log gets a line only when CI or review changed.
  private async observe(key: string, pr: PrSnapshot): Promise<void> {
    const current = this.registry.job(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const status: PrStatus = { checks: pr.checks, review: pr.review, mergeable: pr.mergeable };
    if (current.prStatus && statusKey(current.prStatus) === statusKey(status)) return;
    await this.registry.persist(recordPrStatus(current, status, describeStatus(status)));
    this.announcements.emitFor(key, "acompanhamento-pr", "acompanhamento do PR alterado", {
      pr: `${pr.ref.repository}#${pr.ref.number}`,
      ci: status.checks.known ? status.checks.value : `desconhecido (${status.checks.reason})`,
      review: status.review.known ? status.review.value : `desconhecido (${status.review.reason})`,
      mergeabilidade: describeMergeable(status.mergeable),
    });
  }
}
