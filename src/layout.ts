import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { OPERATIONAL_LOG_FILENAME } from "./log.js";

/**
 * The workspace: root of clones, worktrees, works, the archive and the
 * retrospective reports.
 *
 * Disk names are taken decisions, not code, and stay in PT-BR:
 *   <workspace>/repos/ — single clone per target repo
 *   <workspace>/trabalhos/ — a work's per-attempt artifacts while it runs
 *                             (sessao/, log-<n>.jsonl, desfecho.json)
 *   <workspace>/arquivo/ — works moved here on done; nothing is deleted
 *   <workspace>/retros/ — the retrospective reports (the next marker)
 */

/** The work's session subdir, on disk as decided: <work dir>/sessao. */
export const SESSIONS_SUBDIR = "sessao";

/** The PT-BR subpath names as decided on disk. */
export const WORKSPACE_SUBPATHS = {
  repos: "repos",
  works: "trabalhos",
  archive: "arquivo",
  retros: "retros",
} as const;

/**
 * Where the retrospective round reads and writes inside its container: the
 * archive and the works are mounted read-only, the retros directory
 * read-write (the report is the only artifact that leaves the round). Layout,
 * not prose — the prompt and the runtime agree on these paths here.
 */
export const RETRO_MOUNT_PATHS = {
  retros: "/msf-retros",
  archive: "/msf-arquivo",
  works: "/msf-trabalhos",
  operationalLog: `/msf-${OPERATIONAL_LOG_FILENAME}`,
} as const;

export interface WorkspaceLayout {
  root: string;
  repos: string;
  works: string;
  archive: string;
  /** The retrospective reports: the marker of the next window. */
  retros: string;
}

/** Directory of one work's artifacts: <workspace>/trabalhos/<repo>#<n>/ */
export function workDir(layout: WorkspaceLayout, repo: string, number: number): string {
  return join(layout.works, `${repo}#${number}`);
}

/** The work dir a registry key ("<repo>#<n>", the registry's relative key) names. */
export function workDirOfKey(layout: WorkspaceLayout, key: string): string {
  return join(layout.works, key);
}

/** The layout of a workspace root, without touching the disk. */
export function workspaceLayout(root: string): WorkspaceLayout {
  return {
    root,
    repos: join(root, WORKSPACE_SUBPATHS.repos),
    works: join(root, WORKSPACE_SUBPATHS.works),
    archive: join(root, WORKSPACE_SUBPATHS.archive),
    retros: join(root, WORKSPACE_SUBPATHS.retros),
  };
}

/** Guarantee the workspace and its derived subpaths exist (idempotent). */
export function ensureWorkspace(root: string): WorkspaceLayout {
  const layout = workspaceLayout(root);
  for (const path of [layout.root, layout.repos, layout.works, layout.archive, layout.retros]) {
    mkdirSync(path, { recursive: true });
  }
  return layout;
}
