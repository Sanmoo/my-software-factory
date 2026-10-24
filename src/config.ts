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
export const DEFAULT_NOTIFICATIONS = true;

/** The "a/b" shape a model id ("provider/model-id") and a GitHub repo ("owner/name") share. */
const SLASH_PAIR = /^[^/\s]+\/[^/\s]+$/;
export const DEFAULT_LABELS: Labels = {
  ready: "ready-for-agent",
  claimed: "agent-claimed",
  blocked: "agent-blocked",
};

/**
 * The recovery budget (issue 123): an interruption (an attempt that ended
 * with no outcome record) is not a failure, so it never consumes an attempt —
 * it spends this finite, persisted allowance instead. Values fixed by the
 * #111 experiment (3 recoveries, waits 1/4/16 s) and configurable per factory.
 */
export interface RecoveryBudget {
  /** Automatic recoveries allowed for one attempt; 0 pauses on the 1st interruption. */
  maxRecoveries: number;
  /** Wait before each recovery, by index; the last value repeats. */
  waitsMs: readonly number[];
}

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxRecoveries: 3,
  waitsMs: [1_000, 4_000, 16_000],
};

/**
 * The model provider's failure budget (issue 144): the worker model's provider
 * is the inference service, never the ticket provider (GLOSSARY: Model
 * provider). An attempt whose stream ended in a model provider error
 * (`stopReason: error` + the model provider's `errorMessage`) is not an interruption
 * of the agent, so it retries on this dedicated schedule
 * instead of spending the interruption budget of issue 123. The waits are
 * deliberately longer than the recovery backoff: they must cross a short
 * upstream outage, and every retry also carries the session's own internal
 * retries. Exhausting it parks the work "awaiting model provider" and asks
 * the operator for help — never a block.
 */
export interface ModelProviderBudget {
  /** Retries allowed for one attempt after model provider failures. */
  maxRetries: number;
  /** Wait before each retry, by index; the last value repeats. */
  waitsMs: readonly number[];
}

export const DEFAULT_MODEL_PROVIDER_BUDGET: ModelProviderBudget = {
  maxRetries: 4,
  waitsMs: [15_000, 30_000, 60_000, 120_000],
};

/**
 * The liveness observation of the factory (issue 118): while Docker does not
 * answer, the factory cannot tell a live worker from a dead one, so it stops
 * launching instead of guessing. The warning threshold is how long the
 * unavailability must last before the operator is told — the diagnosis starts
 * at the first failure, the notice is once per episode.
 */
export interface LivenessPolicy {
  /** Continuous unavailability before the one notice of an episode; 60 s by default. */
  unavailableWarnMs: number;
}

export const DEFAULT_LIVENESS_POLICY: LivenessPolicy = {
  unavailableWarnMs: 60_000,
};

/**
 * The retrospective (issue 141, ADR 0006): a factory job triggered by the
 * orchestrator once `threshold` works were archived since the last report.
 * The model is optional and defaults to the worker model; the language governs
 * the report and every filed item (one language per round), and
 * `factory-items-destination` is required when enabled — target-repo items go
 * to the repo concerned, never to a configured destination.
 */
export interface RetroConfig {
  /** The job's switch: when false no round ever starts — automatic or `msf retro`. */
  enabled: boolean;
  /** Archived works since the last report that trigger a round. */
  threshold: number;
  /** Retrospective model; null inherits the worker model. */
  model: string | null;
  /** The round's language (report and filed issues), BCP 47-ish tag; English by default. */
  language: string;
  /** The "owner/name" destination for factory-axis items; required when enabled. */
  factoryItemsDestination: string | null;
}

export const DEFAULT_RETRO: RetroConfig = {
  enabled: false,
  threshold: 5,
  model: null,
  language: "en",
  factoryItemsDestination: null,
};

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
  /** An explicitly supplied Pi authentication file (auth.json). Its contents
   * are never baked into the image and never read from a personal profile;
   * model credentials may instead come from Pi's supported provider env vars. */
  workerAuthFile: string | null;
  /** The interruption-recovery budget: finite and separate from the attempts. */
  recovery: RecoveryBudget;
  /** The model provider's failure budget: its own retries and backoff (issue 144). */
  modelProvider: ModelProviderBudget;
  /** How the operational cycle reads Docker's silence (issue 118). */
  liveness: LivenessPolicy;
  /** The retrospective job's trigger, model, language and destinations (issue 141). */
  retro: RetroConfig;
  notifications: boolean;
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
  if (!SLASH_PAIR.test(workerModel)) {
    throw new ConfigError('config field "worker-model" must be "provider/model-id"');
  }
  const repos = requireRepos(doc);
  const concurrency = optionalConcurrency(doc);
  const workspace = optionalWorkspace(doc);
  const labels = optionalLabels(doc);
  const workerAuthFile = optionalWorkerAuthFile(doc);
  const recovery = optionalRecovery(doc);
  const modelProvider = optionalModelProvider(doc);
  const liveness = optionalLiveness(doc);
  const retro = optionalRetro(doc);
  const notifications = optionalNotifications(doc);

  return {
    workerGhAccount,
    workerModel,
    repos,
    concurrency,
    workspace,
    labels,
    workerAuthFile,
    recovery,
    modelProvider,
    liveness,
    retro,
    notifications,
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

/** `worker-auth-file` is optional: absent means model credentials come from
 *  Pi's supported provider environment variables. */
function optionalWorkerAuthFile(doc: Record<string, unknown>): string | null {
  const value = doc["worker-auth-file"];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config field "worker-auth-file" must be a non-empty path when given`);
  }
  return expandTilde(value.trim());
}

function optionalRecovery(doc: Record<string, unknown>): RecoveryBudget {
  const budget = optionalBudget(doc, "recovery", "max");
  return {
    maxRecoveries: budget?.max ?? DEFAULT_RECOVERY_BUDGET.maxRecoveries,
    waitsMs: budget?.waitsMs ?? [...DEFAULT_RECOVERY_BUDGET.waitsMs],
  };
}

function optionalModelProvider(doc: Record<string, unknown>): ModelProviderBudget {
  const budget = optionalBudget(doc, "model-provider", "max-retries");
  return {
    maxRetries: budget?.max ?? DEFAULT_MODEL_PROVIDER_BUDGET.maxRetries,
    waitsMs: budget?.waitsMs ?? [...DEFAULT_MODEL_PROVIDER_BUDGET.waitsMs],
  };
}

/** The fields both finite budgets share, validated once: a non-negative
 *  maximum and a non-empty list of waits. Null when the mapping is absent —
 *  the caller applies its documented default. */
function optionalBudget(
  doc: Record<string, unknown>,
  key: string,
  maxKey: string,
): { max: number | undefined; waitsMs: number[] | undefined } | null {
  const value = doc[key];
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config field "${key}" must be a mapping when given`);
  }
  const given = value as Record<string, unknown>;

  const max = given[maxKey];
  if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) {
    throw new ConfigError(`config field "${key}.${maxKey}" must be a non-negative integer when given`);
  }

  const waits = given["waits-ms"];
  if (
    waits !== undefined &&
    (!Array.isArray(waits) ||
      waits.length === 0 ||
      waits.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0))
  ) {
    throw new ConfigError(
      `config field "${key}.waits-ms" must be a non-empty list of non-negative milliseconds when given`,
    );
  }

  return { max: max as number | undefined, waitsMs: waits as number[] | undefined };
}

function optionalNotifications(doc: Record<string, unknown>): boolean {
  return optionalBoolean(doc, "notifications", DEFAULT_NOTIFICATIONS);
}

function optionalLiveness(doc: Record<string, unknown>): LivenessPolicy {
  const value = doc.liveness;
  if (value === undefined) return { ...DEFAULT_LIVENESS_POLICY };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config field "liveness" must be a mapping when given`);
  }
  const given = value as Record<string, unknown>;
  const warn = given["unavailable-warn-ms"];
  if (warn !== undefined && (typeof warn !== "number" || !Number.isFinite(warn) || warn < 0)) {
    throw new ConfigError(
      `config field "liveness.unavailable-warn-ms" must be a non-negative number of milliseconds when given`,
    );
  }
  return { unavailableWarnMs: (warn as number | undefined) ?? DEFAULT_LIVENESS_POLICY.unavailableWarnMs };
}

/**
 * The `retro:` block (issue 141). Every field defaults except the destination:
 * enabling the job without `factory-items-destination` is a boot failure, so a
 * round can never run with nowhere to file its factory-axis items.
 */
function optionalRetro(doc: Record<string, unknown>): RetroConfig {
  const value = doc["retro"];
  if (value === undefined) return { ...DEFAULT_RETRO };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config field "retro" must be a mapping when given`);
  }
  const given = value as Record<string, unknown>;

  const enabled = given["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ConfigError(`config field "retro.enabled" must be a boolean when given`);
  }

  const threshold = given["threshold"];
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1)
  ) {
    throw new ConfigError(`config field "retro.threshold" must be a positive integer when given`);
  }

  const model = given["model"];
  if (model !== undefined && (typeof model !== "string" || !SLASH_PAIR.test(model.trim()))) {
    throw new ConfigError('config field "retro.model" must be "provider/model-id" when given');
  }

  const language = given["language"];
  if (language !== undefined && (typeof language !== "string" || language.trim() === "")) {
    throw new ConfigError(`config field "retro.language" must be a non-empty string when given`);
  }

  const destination = given["factory-items-destination"];
  if (
    destination !== undefined &&
    (typeof destination !== "string" || !SLASH_PAIR.test(destination.trim()))
  ) {
    throw new ConfigError('config field "retro.factory-items-destination" must be "owner/name" when given');
  }

  const resolvedEnabled = enabled ?? DEFAULT_RETRO.enabled;
  const resolvedDestination = destination === undefined ? null : (destination as string).trim();
  if (resolvedEnabled && resolvedDestination === null) {
    throw new ConfigError(
      'config field "retro.factory-items-destination" is required when "retro.enabled" is true',
    );
  }
  return {
    enabled: resolvedEnabled,
    threshold: (threshold as number | undefined) ?? DEFAULT_RETRO.threshold,
    model: model === undefined ? null : (model as string).trim(),
    language: language === undefined ? DEFAULT_RETRO.language : (language as string).trim(),
    factoryItemsDestination: resolvedDestination,
  };
}

function optionalBoolean(doc: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = doc[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(`config field "${key}" must be a boolean when given`);
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
