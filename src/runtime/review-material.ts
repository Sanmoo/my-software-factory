import { createHash } from "node:crypto";

// Review material shared by the runner and the prompt. The agent is told this exact command,
// and the runner computes the same bytes after the run. Explicit prefixes and --no-ext-diff
// keep the output independent of the operator's diff.* configuration.
export const DIFF_ARGS = (base: string, head: string): string[] => [
  "diff", "--no-color", "--no-ext-diff", "--no-textconv",
  "--src-prefix=a/", "--dst-prefix=b/", "--binary", base, head,
];

export function diffCommandText(base: string, head: string): string {
  return ["git -c core.pager=cat", ...DIFF_ARGS(base, head)].join(" ");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
