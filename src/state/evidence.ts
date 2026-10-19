import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { WorkspaceLayout } from "../layout.js";

/**
 * The evidence of one fell attempt, pointed at by the blocked comment (issue
 * 103). The three locations live under the factory workspace on the host and
 * are consulted on the filesystem when the comment is prepared — the outcome
 * record's `paths` is never the source, because it may be empty, incomplete
 * or belong to another attempt.
 *
 * `dir` is the attempt's dir as the runtime/registry used it: the same dir is
 * probed and shown (workspace-relative), so the comment can only name what it
 * consulted. Every SHOWN path is workspace-relative — the host's absolute
 * paths never leave the process.
 */

/** What a filesystem query says about one location — an unknown answer is never absence. */
export type EvidencePresence = "present" | "absent" | "could not be verified";

export interface EvidenceLocation {
  /** Path relative to the factory workspace — the only form ever shown. */
  path: string;
  presence: EvidencePresence;
}

/** The three locations the operator opens by hand after a fall. */
export interface WorkEvidence {
  workDir: EvidenceLocation;
  eventLog: EvidenceLocation;
  sandcastleLog: EvidenceLocation;
}

/** Probe the three locations of one attempt: `dir` inside the workspace. */
export async function readWorkEvidence(
  workspace: WorkspaceLayout,
  dir: string,
  attempt: number,
): Promise<WorkEvidence> {
  const shownDir = relative(workspace.root, dir).split(sep).join("/");
  const [dirPresence, logPresence, sandcastlePresence] = await Promise.all([
    presenceOf(dir),
    presenceOf(join(dir, `log-${attempt}.jsonl`)),
    presenceOf(join(dir, "sessao", `sandcastle-${attempt}.log`)),
  ]);
  return {
    workDir: { path: `${shownDir}/`, presence: dirPresence },
    eventLog: { path: `${shownDir}/log-${attempt}.jsonl`, presence: logPresence },
    sandcastleLog: {
      path: `${shownDir}/sessao/sandcastle-${attempt}.log`,
      presence: sandcastlePresence,
    },
  };
}

/**
 * Present or absent only when the filesystem answered so; any other failure
 * (permissions, I/O, a symlink loop) is "could not be verified" — an
 * unverifiable location is never reported absent and never blocks the comment.
 */
async function presenceOf(path: string): Promise<EvidencePresence> {
  try {
    await stat(path);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "could not be verified";
  }
}

/**
 * The evidence block of the blocked comment: the base named up front, then
 * every location with its state. Shown even when a location is absent or
 * unverifiable — the operator must see WHERE to look, not only that it failed.
 */
export function renderWorkEvidence(evidence: WorkEvidence): string {
  return [
    "evidence — every path is relative to the factory workspace on the host " +
      "(the workspace of msf.yaml; not the repository, the work dir or the container):",
    `  reservation:    ${evidence.workDir.path} — ${evidence.workDir.presence}`,
    `  event log:      ${evidence.eventLog.path} — ${evidence.eventLog.presence}`,
    `  sandcastle log: ${evidence.sandcastleLog.path} — ${evidence.sandcastleLog.presence}`,
  ].join("\n");
}
