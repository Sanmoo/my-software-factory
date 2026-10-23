import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentResourcesError,
  compareAgentInventory,
  parseAgentResources,
  sha256,
  type AgentInventory,
  type AgentResourcesDeclaration,
} from "../../scripts/agent-resources.mjs";

/**
 * The factory's committed agent-resource declaration and the image's recorded
 * inventory (issue #159). The declaration says what the worker MUST have; the
 * inventory says what the image ACTUALLY provisioned. The launch compares the
 * two by content identity — never by the mutable Docker tag — so a stale or
 * hand-built image is refused instead of silently running a different set.
 */

/** Where the image records what it provisioned (root-owned, outside the
 *  writable agent directory). */
export const IMAGE_INVENTORY_PATH = "/opt/msf/agent-inventory.json";

/** The declaration committed next to the compiled factory. */
export const AGENT_DECLARATION_PATH = fileURLToPath(new URL("../../agent-resources.json", import.meta.url));

export class AgentImageMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentImageMismatchError";
  }
}

export interface LoadedAgentResources {
  declaration: AgentResourcesDeclaration;
  /** The raw bytes the image must have been built from. */
  raw: string;
  sha256: string;
}

/** Read and validate the committed declaration (unknown keys are errors). */
export function loadAgentResources(path: string = AGENT_DECLARATION_PATH): LoadedAgentResources {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new AgentImageMismatchError(`agent-resource declaration is unreadable: ${path}`);
  }
  try {
    return { declaration: parseAgentResources(raw, path), raw, sha256: sha256(raw) };
  } catch (error) {
    if (error instanceof AgentResourcesError) throw new AgentImageMismatchError(error.message);
    throw error;
  }
}

/** Parse the inventory an image printed and compare it with the declaration. */
export function verifyAgentInventory(loaded: LoadedAgentResources, inventoryText: string): AgentInventory {
  let inventory: unknown;
  try {
    inventory = JSON.parse(inventoryText);
  } catch {
    throw new AgentImageMismatchError(
      `the worker image carries no readable agent inventory at ${IMAGE_INVENTORY_PATH}; rebuild it with npm run build:image`,
    );
  }
  const mismatches = compareAgentInventory(loaded.declaration, loaded.sha256, inventory);
  if (mismatches.length > 0) {
    throw new AgentImageMismatchError(
      `the worker image does not match this checkout's ${basename(AGENT_DECLARATION_PATH)}: ${mismatches.join("; ")}. ` +
        `Rebuild it with: npm run build:image`,
    );
  }
  return inventory as AgentInventory;
}
