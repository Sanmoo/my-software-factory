import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

/**
 * Config of the factory (msf.yaml), verbatim shape from ticket 06:
 *
 *   worker-gh-account: bot-do-samuca
 *   worker-model: provider/model-id
 *   repos:
 *     - Sanmoo/my-tasks
 *   concurrency: 2
 *   workspace: ~/.local/share/msf
 *   labels:
 *     ready: ready-for-agent
 *     claimed: agent-claimed
 *     blocked: agent-blocked
 *
 * `worker-gh-account`, `worker-model` and `repos` are required. Every optional field
 * defaults in the factory — a missing optional field is never an error.
 */

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_WORKSPACE = "~/.local/share/msf";
export const DEFAULT_LABELS: Labels = {
  ready: "ready-for-agent",
  claimed: "agent-claimed",
  blocked: "agent-blocked",
};

/**
 * The profile snapshot's allowed roots (ticket 18 wiring): EMPTY by default —
 * no root is pre-declared (no operator-personal path belongs in the product).
 * A profile with symlinks then fails the snapshot fail-closed, naming the
 * link and the config key that declares it: `profile-allowed-roots` names
 * the roots THIS operator's profile legitimately reaches (dotfiles,
 * .agents, omarchy… — whatever the machine actually has).
 */
export const DEFAULT_PROFILE_ALLOWED_ROOTS: readonly string[] = [];

export interface Labels {
  ready: string;
  claimed: string;
  blocked: string;
}

export interface Config {
  /** The dedicated bot account: PRs arrive from it, claims are assigned to it. */
  workerGhAccount: string;
  /** Pi model used for each worker session. */
  workerModel: string;
  /** Target repos whose issues feed the pool. */
  repos: string[];
  /** The `y` — worker slots in process. */
  concurrency: number;
  /** Workspace root (tilde expanded): repos/, trabalhos/, arquivo/ live under it. */
  workspace: string;
  /** The 3-label vocabulary, configurable per project. */
  labels: Labels;
  /** Roots the profile may reach through links (tilde-expanded); the
   * profile's own real path is always allowed (ticket 17). */
  profileAllowedRoots: string[];
  /** Stale (dangling) profile links are skipped and logged instead of
   * blocking the launch. Off by default — fail closed (ticket 17). */
  profileSkipDanglingLinks: boolean;
  /** Where the config was loaded from. */
  configPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Load and validate a config file (msf.yaml). Fails fast on missing required fields. */
export function loadConfig(filePath: string): Config {
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    throw new ConfigError(`config file not found: ${absolute}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ConfigError(`failed to parse ${absolute}: ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`config must be a YAML mapping: ${absolute}`);
  }
  const doc = parsed as Record<string, unknown>;

  const workerGhAccount = requireString(doc, "worker-gh-account");
  const workerModel = requireString(doc, "worker-model");
  if (!/^[^/\s]+\/[^/\s]+$/.test(workerModel)) {
    throw new ConfigError('config field "worker-model" must be "provider/model-id"');
  }
  const repos = requireRepos(doc);
  const concurrency = optionalConcurrency(doc);
  const workspace = optionalWorkspace(doc);
  const labels = optionalLabels(doc);
  const profileAllowedRoots = optionalProfileAllowedRoots(doc);
  const profileSkipDanglingLinks = optionalProfileSkipDanglingLinks(doc);

  return {
    workerGhAccount,
    workerModel,
    repos,
    concurrency,
    workspace,
    labels,
    profileAllowedRoots,
    profileSkipDanglingLinks,
    configPath: absolute,
  };
}

/** Load `msf.yaml` from a directory (the cwd), or from an explicit override path. */
export function loadConfigFrom(dir: string, overridePath?: string): Config {
  return loadConfig(overridePath ?? join(dir, "msf.yaml"));
}

function requireString(doc: Record<string, unknown>, key: string): string {
  const value = doc[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config field "${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireRepos(doc: Record<string, unknown>): string[] {
  const value = doc["repos"];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`config field "repos" is required and must be a list of "owner/name" strings`);
  }
  return (value as string[]).map((repo) => repo.trim());
}

function optionalConcurrency(doc: Record<string, unknown>): number {
  const value = doc["concurrency"];
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`config field "concurrency" must be a positive integer when given`);
  }
  return value;
}

function optionalWorkspace(doc: Record<string, unknown>): string {
  const value = doc["workspace"];
  if (value === undefined) return expandTilde(DEFAULT_WORKSPACE);
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config field "workspace" must be a non-empty string when given`);
  }
  return expandTilde(value.trim());
}

function optionalLabels(doc: Record<string, unknown>): Labels {
  const value = doc["labels"];
  if (value === undefined) return { ...DEFAULT_LABELS };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config field "labels" must be a mapping when given`);
  }
  const given = value as Record<string, unknown>;
  const pick = (key: keyof Labels, fallback: string): string => {
    const raw = given[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ConfigError(`config field "labels.${key}" must be a non-empty string when given`);
    }
    return raw.trim();
  };
  return {
    ready: pick("ready", DEFAULT_LABELS.ready),
    claimed: pick("claimed", DEFAULT_LABELS.claimed),
    blocked: pick("blocked", DEFAULT_LABELS.blocked),
  };
}

function optionalProfileAllowedRoots(doc: Record<string, unknown>): string[] {
  const value = doc["profile-allowed-roots"];
  if (value === undefined) return DEFAULT_PROFILE_ALLOWED_ROOTS.map(expandTilde);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`config field "profile-allowed-roots" must be a list of path strings when given`);
  }
  return (value as string[]).map((item) => expandTilde(item.trim()));
}

function optionalProfileSkipDanglingLinks(doc: Record<string, unknown>): boolean {
  const value = doc["profile-skip-dangling-links"];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ConfigError(`config field "profile-skip-dangling-links" must be a boolean when given`);
  }
  return value;
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
