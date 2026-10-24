import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import {
  AGENT_DECLARATION_FILE,
  AgentResourcesError,
  declarationDigest,
  normalizeAgentResources,
} from "./agent-resources.mjs";

/**
 * The host-side loader of the committed declaration: YAML in, validated
 * declaration plus its canonical digest out. The image never parses YAML — it
 * receives the canonical form staged by `npm run build:image` — so the parser
 * stays on the operator's side and the engine only ever sees validated data.
 */

export function parseAgentDeclaration(text, source = AGENT_DECLARATION_FILE) {
  let document;
  try {
    document = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new AgentResourcesError(`${source} is not valid YAML: ${detail}`);
  }
  const declaration = normalizeAgentResources(document, source);
  return { declaration, digest: declarationDigest(declaration) };
}

export function loadAgentDeclaration(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new AgentResourcesError(`agent-resource declaration is unreadable: ${path}`);
  }
  return parseAgentDeclaration(text, path);
}
