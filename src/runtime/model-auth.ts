import { readFileSync, statSync } from "node:fs";

/**
 * Model credentials are operational secrets, separate from the agent
 * resources (issue #159, ADR 0001). They arrive in one of two explicit ways:
 *
 *   - Pi-supported provider API-key environment variables, read from the
 *     factory's environment and forwarded into the worker container;
 *   - an explicitly supplied Pi `auth.json` file (`worker-auth-file` in
 *     msf.yaml), mounted read-only and copied into the container's agent dir.
 *
 * Nothing is read from a personal Pi profile, nothing is baked into the image,
 * and no diagnostic prints a secret value.
 */

/**
 * Pi's documented provider API-key variables (docs/providers.md, Pi 1.3.0).
 * Only these are forwarded: an unrelated ambient secret never rides the
 * worker container.
 */
export const PI_MODEL_AUTH_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "ANT_LING_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_STS_REGIONAL_ENDPOINTS",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "VERTEX_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "RADIUS_API_KEY",
  "TYPESAFE_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "COPILOT_GITHUB_TOKEN",
];

/** The supported provider variables actually present, values included. */
export function modelAuthEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of PI_MODEL_AUTH_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Validate a file the operator supplies into the agent dir (auth.json or
 * models.json) without ever echoing its content. `what` names it to the
 * operator. Returns a diagnostic, or null when the file is usable.
 */
export function agentFileProblem(what: string, path: string): string | null {
  try {
    if (!statSync(path).isFile()) return `${what} is not a regular file: ${path}`;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `${what} is not a Pi JSON object: ${path}`;
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return `${what} is not valid JSON: ${path}`;
    return `${what} is unreadable: ${path}`;
  }
}

/** The operator-facing directive when neither auth source is present. It names
 *  the documented examples, not the allow-list's first entries. */
export const NO_MODEL_AUTH_MESSAGE =
  "no model credentials for the worker: set a Pi-supported provider API key in the factory's environment " +
  "(e.g. OPENCODE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY) or set worker-auth-file in msf.yaml. " +
  "Credentials are never read from a personal Pi profile.";
