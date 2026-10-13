import type { ProjectConfig } from "../config/types.js";
import type { Mergeability, PrLookup, PrSnapshot } from "../pr/port.js";
import type { IssueRef, Known } from "../tracker/port.js";
import { jobBranch } from "./job.js";
import type { PrRef } from "./result.js";

// Pure judgement of pull requests against what the factory expects.
// No I/O here: the admission reads the PR port and applies the verdicts.

// What a job's PR must look like: the repository of the job, the target branch of the
// project as base, and the job branch as head.
export interface Delivery {
  repository: string;
  targetBranch: string;
  headBranch: string;
}

export function deliveryOf(project: ProjectConfig, ref: IssueRef): Delivery {
  return { repository: project.repository, targetBranch: project.targetBranch, headBranch: jobBranch(ref) };
}

// A known conflict of the PR with its base branch. Unknown mergeability is neither a conflict
// nor the absence of one, so it is not reported as either.
export const isConflicting = (mergeable: Known<Mergeability> | undefined): boolean =>
  mergeable?.known === true && mergeable.value === "conflicting";

export type ReadyVerdict = { valid: true } | { valid: false; reason: string };

// A "PR pronto" result is accepted only if the PR exists, is open, has the target branch as
// base and the job branch as head. The PR must belong to the job's repository, which is
// checked before the PR is read (see misplacedRepository).
export function judgeReadyPr(lookup: PrLookup, delivery: Delivery): ReadyVerdict {
  if (lookup.status === "not-found") return { valid: false, reason: "PR não encontrado no github.com" };
  const pr = lookup.pr;
  if (pr.state !== "open") return { valid: false, reason: `PR não está aberto (estado: ${pr.state})` };
  const mismatch = branchMismatch(pr, delivery);
  return mismatch === undefined ? { valid: true } : { valid: false, reason: mismatch };
}

export function misplacedRepository(ref: PrRef, delivery: Delivery): string | undefined {
  return ref.repository === delivery.repository
    ? undefined
    : `PR de outro repositório (${ref.repository}); o trabalho é de ${delivery.repository}`;
}

// What polling observes about a PR the factory already tracks.
export type TrackedVerdict =
  | { kind: "open"; pr: PrSnapshot }
  | { kind: "merged"; pr: PrSnapshot }
  | { kind: "closed" }
  | { kind: "invalid"; reason: string };

export function judgeTrackedPr(lookup: PrLookup, delivery: Delivery): TrackedVerdict {
  if (lookup.status === "not-found") return { kind: "invalid", reason: "PR não encontrado no github.com" };
  const pr = lookup.pr;
  if (pr.state === "closed") return { kind: "closed" };
  const mismatch = branchMismatch(pr, delivery);
  if (mismatch !== undefined) return { kind: "invalid", reason: mismatch };
  return pr.state === "merged" ? { kind: "merged", pr } : { kind: "open", pr };
}

function branchMismatch(pr: PrSnapshot, delivery: Delivery): string | undefined {
  if (pr.baseBranch !== delivery.targetBranch) {
    return `base ${pr.baseBranch}, esperada ${delivery.targetBranch}`;
  }
  if (pr.headBranch !== delivery.headBranch) {
    return `head ${pr.headBranch}, esperado ${delivery.headBranch}`;
  }
  return undefined;
}
