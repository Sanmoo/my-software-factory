import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isObject } from "../core/values.js";
import { parseYamlDocument } from "../config/yaml.js";

// Machine-local settings of one run: where the profiles and checkouts live on this host. They
// are not part of the versioned configuration: paths and the image are the operator's.

export interface LocalSettings {
  // Docker image the jobs run in.
  image: string;
  // Pi agent directory of each pi-auth reference named by the configuration (and of each runtimeProfile).
  profiles: Record<string, string>;
  // Where the links of each runtime profile may lead (besides the profile directory itself). A link whose
  // destination is elsewhere is not followed (ADR 0002). A profile without an entry has no declaration here.
  allowedRoots: Record<string, string[]>;
  // The operator's mise declaration on this host, by runtime profile (ADR 0002, ADR 0004): the tools the
  // container converges come from it, never from a host binary mounted inside. A `~/` is the operator's
  // home. A profile without an entry has no declaration, so only its `required.tools` would fail.
  mise: Record<string, string>;
  // Local checkout each job area is cloned from, by repository (owner/repo).
  checkouts: Record<string, string>;
  // The operator attention's desktop notification channel (ticket #59). Best-effort: the
  // pendings are persistent state and do NOT depend on it; a failed or absent channel only
  // makes the notification attempt result visible. Absent block: enabled, platform default.
  // `command`, when given, replaces the platform default and may carry `{title}`/`{body}`
  // placeholders. There is deliberately no Herdr notification: the technical proof found no
  // notification command in herdr 0.9.3.
  notifications?: { enabled: boolean; command?: string };
}

export const DEFAULT_IMAGE = "msf-docker-runner:local";

function pathMap(raw: unknown, name: string): Record<string, string> | string {
  if (!isObject(raw)) return `${name} deve ser um objeto`;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !isAbsolute(value)) return `${name}.${key} deve ser um caminho absoluto`;
    result[key] = value;
  }
  return result;
}

// A leading ~/ is the operator's home directory; any other root must be absolute.
function expandPath(root: unknown): string | undefined {
  const path = typeof root === "string" && root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
  return typeof path === "string" && isAbsolute(path) ? path : undefined;
}

function rootMap(raw: unknown): Record<string, string[]> | string {
  if (raw === undefined) return {};
  if (!isObject(raw)) return "allowedRoots deve ser um objeto";
  const result: Record<string, string[]> = {};
  for (const [profile, roots] of Object.entries(raw)) {
    if (!Array.isArray(roots)) return `allowedRoots.${profile} deve ser uma lista de caminhos`;
    const expanded: string[] = [];
    for (const [index, root] of roots.entries()) {
      const path = expandPath(root);
      if (path === undefined) return `allowedRoots.${profile}[${index}] deve ser um caminho absoluto (ou começar com ~/)`;
      expanded.push(path);
    }
    result[profile] = expanded;
  }
  return result;
}

// The same rule for the operator's mise declaration: one path per runtime profile, ~/ allowed.
function miseMap(raw: unknown): Record<string, string> | string {
  if (raw === undefined) return {};
  if (!isObject(raw)) return "mise deve ser um objeto de caminho por perfil";
  const result: Record<string, string> = {};
  for (const [profile, value] of Object.entries(raw)) {
    const path = expandPath(value);
    if (path === undefined) return `mise.${profile} deve ser um caminho absoluto (ou começar com ~/)`;
    result[profile] = path;
  }
  return result;
}

export function parseLocalSettings(raw: unknown): LocalSettings | string {
  if (!isObject(raw)) return "configuração local deve ser um objeto";
  const profiles = pathMap(raw.profiles, "profiles");
  if (typeof profiles === "string") return profiles;
  const checkouts = pathMap(raw.checkouts, "checkouts");
  if (typeof checkouts === "string") return checkouts;
  const allowedRoots = rootMap(raw.allowedRoots);
  if (typeof allowedRoots === "string") return allowedRoots;
  const mise = miseMap(raw.mise);
  if (typeof mise === "string") return mise;
  if (raw.image !== undefined && (typeof raw.image !== "string" || raw.image.trim() === "")) {
    return "image deve ser texto não vazio";
  }
  const notificationsBlock = raw.notifications === undefined ? undefined : raw.notifications;
  if (notificationsBlock !== undefined) {
    if (!isObject(notificationsBlock)) return "notifications deve ser um objeto";
    if (notificationsBlock.enabled !== undefined && typeof notificationsBlock.enabled !== "boolean") {
      return "notifications.enabled deve ser booleano";
    }
    if (notificationsBlock.command !== undefined
      && (typeof notificationsBlock.command !== "string" || notificationsBlock.command.trim() === "")) {
      return "notifications.command deve ser um comando não vazio";
    }
  }
  return {
    image: (raw.image as string | undefined) ?? DEFAULT_IMAGE,
    profiles, allowedRoots, mise, checkouts,
    ...(notificationsBlock === undefined ? {}
      : { notifications: {
        enabled: (notificationsBlock as { enabled?: unknown }).enabled !== false,
        ...((notificationsBlock as { command?: unknown }).command === undefined ? {}
          : { command: (notificationsBlock as { command: string }).command }),
      } }),
  };
}

export async function loadLocalSettings(path: string): Promise<LocalSettings | string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `configuração local não pode ser lida: ${path}`;
  }
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return `configuração local inválida em ${path}: ${parsed.message}`;
  return parseLocalSettings(parsed.value);
}
