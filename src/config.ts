import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { withNativeRankOrdering } from "./tracker/jira-jql.js";

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
 *   jira:
 *     - site: acme.atlassian.net          # a Jira Cloud site
 *       account: bot@acme.example         # the Atlassian login (Basic auth user)
 *       token-env: MSF_JIRA_ACME_TOKEN    # the NAME of the local variable holding the API token
 *       jql: project = ABC AND assignee = currentUser()
 *       destination: Sanmoo/my-tasks      # the GitHub repository the Work delivers to
 *
 * `worker-gh-account`, `worker-model` and `repos` are required; `repos` may be
 * omitted when a Jira source supplies its own explicit destinations. Every
 * optional field defaults in the factory — a missing optional field is never an
 * error. A Jira API token is never a YAML value: only the name of the local
 * environment variable that holds it (`token-env`).
 */

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_WORKSPACE = "~/.local/share/msf";
export const DEFAULT_NOTIFICATIONS = true;
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

export interface Labels {
  ready: string;
  claimed: string;
  blocked: string;
}

/**
 * One Jira Cloud selection (issue 128): the site, the account the API token
 * authenticates as, the local credential reference, the operator's JQL and the
 * GitHub repository the Work delivers to.
 *
 * `tokenEnv` is the NAME of the local environment variable carrying the API
 * token — the token value never enters this file, a log or a message. The JQL
 * is stored with its effective ordering: native Rank ascending, supplied when
 * the operator gave none and refused when they gave a conflicting one.
 */
export interface JiraSourceConfig {
  /** The Jira Cloud site host (`<tenant>.atlassian.net`). */
  site: string;
  /** The Atlassian account email the API token belongs to. */
  account: string;
  /** The name of the local environment variable holding the API token. */
  tokenEnv: string;
  /** The selection query, with `ORDER BY Rank ASC` made explicit. */
  jql: string;
  /** The GitHub repository (`owner/name`) receiving the Work's code. */
  destination: string;
}

export interface Config {
  /** The dedicated bot account: PRs arrive from it, claims are assigned to it. */
  workerGhAccount: string;
  /** Pi model used for each worker session. */
  workerModel: string;
  /** Target repos whose issues feed the pool. */
  repos: string[];
  /** Jira Cloud sources, read-only in this slice (issue 128); [] = GitHub-only. */
  jira: JiraSourceConfig[];
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(workerModel)) {
    throw new ConfigError('config field "worker-model" must be "provider/model-id"');
  }
  const jira = optionalJiraSources(doc);
  // A Jira source names its own destination repository: a Jira-only factory
  // needs no GitHub Issues repo list, never a fabricated one.
  const repos = doc["repos"] === undefined && jira.length > 0 ? [] : requireRepos(doc);
  const concurrency = optionalConcurrency(doc);
  const workspace = optionalWorkspace(doc);
  const labels = optionalLabels(doc);
  const workerAuthFile = optionalWorkerAuthFile(doc);
  const recovery = optionalRecovery(doc);
  const modelProvider = optionalModelProvider(doc);
  const liveness = optionalLiveness(doc);
  const notifications = optionalNotifications(doc);

  return {
    workerGhAccount,
    workerModel,
    repos,
    jira,
    concurrency,
    workspace,
    labels,
    workerAuthFile,
    recovery,
    modelProvider,
    liveness,
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

/** The Jira sources, strictly shaped: an unknown field (notably a token
 *  value) is refused instead of silently ignored (issue 128). */
function optionalJiraSources(doc: Record<string, unknown>): JiraSourceConfig[] {
  const value = doc["jira"];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`config field "jira" must be a list of Jira sources when given`);
  }
  const sources = value.map((entry, index) => jiraSource(entry, index));
  assertOneIdentityPerSite(sources);
  return sources;
}

const JIRA_SOURCE_FIELDS = ["site", "account", "token-env", "jql", "destination"] as const;

/** Keys that would carry the credential itself — never a config value. */
const JIRA_SECRET_FIELDS = ["token", "api-token", "apiToken", "apitoken", "password", "secret"];

const JIRA_CLOUD_SITE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const JIRA_TOKEN_ENV = /^[A-Z][A-Z0-9_]*$/;

function jiraSource(value: unknown, index: number): JiraSourceConfig {
  const label = `jira[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config field "${label}" must be a mapping when given`);
  }
  const given = value as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (JIRA_SECRET_FIELDS.includes(key)) {
      throw new ConfigError(
        `config field "${label}.${key}" is not a config value: the Jira API token never belongs in versionable YAML — ` +
          `name the local environment variable that holds it with "token-env" instead`,
      );
    }
    if (!(JIRA_SOURCE_FIELDS as readonly string[]).includes(key)) {
      throw new ConfigError(
        `config field "${label}.${key}" is not a Jira source field (${JIRA_SOURCE_FIELDS.join(", ")})`,
      );
    }
  }

  const site = requireJiraString(given, label, "site").toLowerCase();
  if (!JIRA_CLOUD_SITE.test(site)) {
    throw new ConfigError(
      `config field "${label}.site" must be a Jira Cloud site host such as "<tenant>.atlassian.net" (got "${site}")`,
    );
  }

  const account = requireJiraString(given, label, "account");
  if (!/^\S+@\S+$/.test(account)) {
    throw new ConfigError(
      `config field "${label}.account" must be the Atlassian account email the API token authenticates as`,
    );
  }

  const tokenEnv = requireJiraString(given, label, "token-env");
  if (!JIRA_TOKEN_ENV.test(tokenEnv)) {
    throw new ConfigError(
      `config field "${label}.token-env" must be the NAME of a local environment variable ` +
        `(A-Z, 0-9 and _, e.g. MSF_JIRA_TOKEN), never the API token value`,
    );
  }

  const jql = requireJiraString(given, label, "jql");
  const ordering = withNativeRankOrdering(jql);
  if (!ordering.ok) {
    throw new ConfigError(
      `config field "${label}.jql" has a conflicting ordering: ${ordering.because}. ` +
        `The factory orders Jira candidates by native Rank ascending and never silently overrides the query`,
    );
  }

  const destination = requireJiraString(given, label, "destination");
  if (!/^[^/\s]+\/[^/\s]+$/.test(destination)) {
    throw new ConfigError(`config field "${label}.destination" must be a GitHub repository as "owner/name"`);
  }

  return { site, account, tokenEnv, jql: ordering.jql, destination };
}

function requireJiraString(given: Record<string, unknown>, label: string, key: string): string {
  const value = given[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config field "${label}.${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

/** One site, one authenticated identity: two accounts would silently act as
 *  whichever adapter won, and the factory never falls back to another account. */
function assertOneIdentityPerSite(sources: readonly JiraSourceConfig[]): void {
  const identities = new Map<string, { account: string; tokenEnv: string }>();
  for (const source of sources) {
    const known = identities.get(source.site);
    if (known === undefined) {
      identities.set(source.site, { account: source.account, tokenEnv: source.tokenEnv });
      continue;
    }
    if (known.account !== source.account || known.tokenEnv !== source.tokenEnv) {
      throw new ConfigError(
        `config field "jira" declares the site "${source.site}" with more than one authenticated identity — ` +
          `one site has one account and one credential reference (no account fallback)`,
      );
    }
  }
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
