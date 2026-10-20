import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The workspace: root of clones, worktrees, works and the archive.
 *
 * Disk names are decided in tickets 05/10 and stay in PT-BR — layout of disk
 * is a taken decision, not code:
 *   <workspace>/repos/      — single clone per target repo
 *   <workspace>/trabalhos/  — a work's per-attempt artifacts while it runs (sessao/, log-<n>.jsonl, desfecho.json)
 *   <workspace>/arquivo/    — works moved here on done; nothing is ever deleted
 */

/** The PT-BR subpath names as decided on disk. */
export const WORKSPACE_SUBPATHS = {
  repos: "repos",
  works: "trabalhos",
  archive: "arquivo",
} as const;

export interface WorkspaceLayout {
  root: string;
  repos: string;
  works: string;
  archive: string;
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
  };
}

/** Guarantee the workspace and its derived subpaths exist (idempotent). */
export function ensureWorkspace(root: string): WorkspaceLayout {
  const layout = workspaceLayout(root);
  for (const path of [layout.root, layout.repos, layout.works, layout.archive]) {
    mkdirSync(path, { recursive: true });
  }
  return layout;
}
