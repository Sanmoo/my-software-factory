import { readFile } from "node:fs/promises";
import type { ConfigResult } from "./types.js";
import { parseConfig } from "./validate.js";

// Reads a configuration file and validates it. Parser details are not echoed,
// so a malformed file cannot leak its contents into the error output.
export async function loadConfigFile(path: string): Promise<ConfigResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, issues: [{ path, message: "arquivo de configuração não pode ser lido" }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path, message: "JSON inválido" }] };
  }
  return parseConfig(raw);
}
