import type { IssueRef } from "../tracker/port.js";
import { refKey } from "../tracker/port.js";
import { COMPLETION_SIGNAL } from "./docker-invocation.js";
import type { RunModels } from "./docker-config.js";
import { diffCommandText } from "./review-material.js";

// Prompts for the Pi invocation inside the container (R07). The result protocol is the
// contract the runner checks in docker-output.ts; keep the two in step.

export interface ReviewMaterial {
  specPath: string;
  specSha256: string;
  standardsPath: string;
  standardsSha256: string;
}

export interface JobPromptInput {
  ref: IssueRef;
  repository: string;
  targetBranch: string;
  branch: string;
  baseSha: string;
  models: RunModels;
  review: ReviewMaterial;
}

function roleLines(models: RunModels): string {
  return [
    `- implementer (you): ${models.implementer}`,
    `- reviewer-standards: ${models["reviewer-standards"]}`,
    `- reviewer-spec: ${models["reviewer-spec"]}`,
    `- default: every other subagent you create ${models.default}`,
    "Use exactly these models: no other model for any agent or subagent.",
  ].join("\n");
}

function reviewRules(input: JobPromptInput): string {
  const { review, baseSha } = input;
  return [
    "Review: after the implementation is committed, review it on two axes, standards and spec.",
    `Give each reviewer: the review base ${baseSha}, the full text of this exact diff`,
    `(\`${diffCommandText(baseSha, "<HEAD sha>")}\`), the spec ${review.specPath} (sha256 ${review.specSha256})`,
    `and the standards ${review.standardsPath} (sha256 ${review.standardsSha256}).`,
    "A review without that material is not an approval.",
  ].join("\n");
}

const RESULT_PROTOCOL = [
  "Result protocol: end your final message with exactly one structured result, then the completion signal.",
  `- Needs a human decision: <msf-result>{"status":"needs_help","question":"...","context":"..."}</msf-result>`,
  `- PR ready: <msf-result>{"status":"pr_ready","pr":{"repository":"owner/repo","number":N},"reviews":[...]}</msf-result>`,
  "  only when the pull request exists and both reviews are approved. Each review entry is",
  '  {"axis":"standards"|"spec","model":"<reviewer model>","verdict":"approved"|"rejected"|"inconclusive",',
  '   "base":"<base sha>","head":"<HEAD sha>","diffSha256":"<sha256 of the exact diff>",',
  '   "specSha256":"...","standardsSha256":"..."}.',
  `- Any other stop: <msf-result>{"status":"interrupted","reason":"..."}</msf-result>`,
  `Then print ${COMPLETION_SIGNAL}.`,
  "Never merge a pull request. Never deploy to production.",
].join("\n");

export function implementPrompt(input: JobPromptInput): string {
  return [
    "/skill:implement",
    `Work item: ${refKey(input.ref)}. Authorized repository: ${input.repository}.`,
    `Work only in /home/agent/workspace, on branch ${input.branch}, created from ${input.targetBranch} at base ${input.baseSha}.`,
    `Read the spec ${input.review.specPath} and the standards ${input.review.standardsPath} in the workspace before implementing.`,
    "Models:",
    roleLines(input.models),
    reviewRules(input),
    RESULT_PROTOCOL,
  ].join("\n\n");
}

// A resume or correction continues the same Pi session; the skill is not invoked again.
export function continuationPrompt(input: JobPromptInput & { kind: "resume" | "correction"; note?: string }): string {
  const operator = input.note && input.note.trim() !== ""
    ? `Operator input: ${input.note.trim()}`
    : "No new operator input was supplied with this continuation.";
  return [
    `Continue the ${input.kind} of work item ${refKey(input.ref)} from this session, on branch ${input.branch} at base ${input.baseSha}.`,
    operator,
    "Models stay the same:",
    roleLines(input.models),
    reviewRules(input),
    RESULT_PROTOCOL,
  ].join("\n\n");
}
