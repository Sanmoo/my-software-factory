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
  "OPENAI_API_KEY",
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
 * Validate an explicitly supplied auth file without ever echoing its content.
 * Returns a diagnostic for the operator, or null when the file is usable.
 */
export function authFileProblem(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return `worker-auth-file is not a regular file: ${path}`;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `worker-auth-file is not a Pi auth.json object: ${path}`;
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return `worker-auth-file is not valid JSON: ${path}`;
    return `worker-auth-file is unreadable: ${path}`;
  }
}

/** The operator-facing directive when neither auth source is present. */
export const NO_MODEL_AUTH_MESSAGE =
  "no model credentials for the worker: set a Pi-supported provider API key in the factory's environment " +
  `(${PI_MODEL_AUTH_ENV_VARS.slice(0, 4).join(", ")}, ...) or set worker-auth-file in msf.yaml. ` +
  "Credentials are never read from a personal Pi profile.";
