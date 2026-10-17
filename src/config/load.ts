import { readFile } from "node:fs/promises";
import type { ConfigResult } from "./types.js";
import { parseConfig } from "./validate.js";
import { parseYamlDocument } from "./yaml.js";

// Reads a configuration file and validates it. The format is chosen by the discovered file, never
// by its content: an invalid YAML document is an invalid YAML document, with no attempt to read it
// as JSON. Parser details are not echoed, so a malformed file cannot leak its contents into the
// error output (ticket #72).
export async function loadConfigFile(path: string): Promise<ConfigResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, issues: [{ path, message: "arquivo de configuração não pode ser lido" }] };
  }
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return { ok: false, issues: [{ path, message: parsed.message }] };
  return parseConfig(parsed.value);
}
