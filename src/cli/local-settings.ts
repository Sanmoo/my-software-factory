import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isObject } from "../core/values.js";

// Machine-local settings of one run: where the profiles and checkouts live on this host. They
// are not part of the versioned configuration (R01): paths and the image are the operator's.

export interface LocalSettings {
  // Docker image the jobs run in.
  image: string;
  // Pi agent directory of each pi-auth reference named by the configuration (and of each runtimeProfile).
  profiles: Record<string, string>;
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

export function parseLocalSettings(raw: unknown): LocalSettings | string {
  if (!isObject(raw)) return "configuração local deve ser um objeto";
  const profiles = pathMap(raw.profiles, "profiles");
  if (typeof profiles === "string") return profiles;
  const checkouts = pathMap(raw.checkouts, "checkouts");
  if (typeof checkouts === "string") return checkouts;
  if (raw.image !== undefined && (typeof raw.image !== "string" || raw.image.trim() === "")) {
    return "image deve ser texto não vazio";
  }
  return { image: (raw.image as string | undefined) ?? DEFAULT_IMAGE, profiles, checkouts };
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
