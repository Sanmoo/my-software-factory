import type { Job, JobState } from "../core/job.js";
import { isConflicting } from "../core/pr-rules.js";

// Operator-facing wording for job states, shared by `status` and `logs`.
const LABELS: Record<JobState, string> = {
  running: "em execução",
  "waiting-for-help": "aguardando ajuda",
  "waiting-for-pr": "aguardando PR",
  interrupted: "interrompido",
  "intervention-required": "intervenção necessária",
  done: "concluído",
  released: "liberado (sem acompanhamento)",
};

export const stateLabel = (state: JobState): string => LABELS[state];

// One line summary: the question for a help request, the reason for an interruption or
// an intervention, the PR reference for a PR waiting for its checks.
export function summaryOf(job: Job): string {
  switch (job.state) {
    case "waiting-for-help":
      return job.question ?? "";
    case "waiting-for-pr":
      if (!job.pr) return "";
      return `${job.pr.repository}#${job.pr.number}${isConflicting(job.prStatus?.mergeable) ? " — PR em conflito" : ""}`;
    case "interrupted":
    case "intervention-required":
    case "released":
      return job.reason ?? "";
    default:
      return "";
  }
}
