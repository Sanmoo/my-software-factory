import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isObject } from "../core/values.js";

// Machine-local settings of one run: where the profiles and checkouts live on this host. They
// are not part of the versioned configuration (R01): paths and the image are the operator's.

export interface LocalSettings {
  // Docker image the jobs run in.
  image: string;
  // Pi agent directory of each pi-auth reference named by the configuration (and of each runtimeProfile).
  profiles: Record<string, string>;
  // Where the links of each runtime profile may lead (besides the profile directory itself). A link whose
  // destination is elsewhere is not followed (ADR 0002). A profile without an entry has no declaration here.
  allowedRoots: Record<string, string[]>;
  // Local checkout each job area is cloned from, by repository (owner/repo).
  checkouts: Record<string, string>;
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
function rootMap(raw: unknown): Record<string, string[]> | string {
  if (raw === undefined) return {};
  if (!isObject(raw)) return "allowedRoots deve ser um objeto";
  const result: Record<string, string[]> = {};
  for (const [profile, roots] of Object.entries(raw)) {
    if (!Array.isArray(roots)) return `allowedRoots.${profile} deve ser uma lista de caminhos`;
    const expanded: string[] = [];
    for (const [index, root] of roots.entries()) {
      const path = typeof root === "string" && root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
      if (typeof path !== "string" || !isAbsolute(path)) return `allowedRoots.${profile}[${index}] deve ser um caminho absoluto (ou começar com ~/)`;
      expanded.push(path);
    }
    result[profile] = expanded;
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
  if (raw.image !== undefined && (typeof raw.image !== "string" || raw.image.trim() === "")) {
    return "image deve ser texto não vazio";
  }
  return { image: (raw.image as string | undefined) ?? DEFAULT_IMAGE, profiles, allowedRoots, checkouts };
}

export async function loadLocalSettings(path: string): Promise<LocalSettings | string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `configuração local não pode ser lida: ${path}`;
  }
  try {
    return parseLocalSettings(JSON.parse(text));
  } catch {
    return "configuração local: JSON inválido";
  }
}
