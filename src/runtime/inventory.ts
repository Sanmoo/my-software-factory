import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentDeclaration } from "../../scripts/agent-declaration.mjs";
import { IMAGE_ROOT } from "../layout.js";
import {
  AGENT_DECLARATION_FILE,
  AgentResourcesError,
  compareAgentInventory,
  type AgentInventory,
  type AgentResourcesDeclaration,
} from "../../scripts/agent-resources.mjs";

/**
 * The factory's committed agent-resource declaration and the inventory the
 * image recorded while provisioning it. The declaration says what the worker
 * MUST have, the inventory what the image ACTUALLY holds; the launch compares
 * the two by content identity — never by the mutable Docker tag — and refuses
 * a stale or hand-built image.
 */

/** Where the image records what it provisioned (root-owned, outside the
 *  writable agent directory). */
export const IMAGE_INVENTORY_PATH = `${IMAGE_ROOT}/agent-inventory.json`;

/** The declaration committed next to the compiled factory. */
export const AGENT_DECLARATION_PATH = fileURLToPath(new URL(`../../${AGENT_DECLARATION_FILE}`, import.meta.url));

export class AgentImageMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentImageMismatchError";
  }
}

export interface LoadedAgentResources {
  declaration: AgentResourcesDeclaration;
  /** The declaration's canonical digest — the same value the image records. */
  digest: string;
}

/** Read and validate the committed declaration (unknown keys are errors). */
export function loadAgentResources(path: string = AGENT_DECLARATION_PATH): LoadedAgentResources {
  try {
    return loadAgentDeclaration(path);
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
  const mismatches = compareAgentInventory(loaded.declaration, loaded.digest, inventory);
  if (mismatches.length > 0) {
    throw new AgentImageMismatchError(
      `the worker image does not match this checkout's ${basename(AGENT_DECLARATION_PATH)}: ${mismatches.join("; ")}. ` +
        `Rebuild it with: npm run build:image`,
    );
  }
  return inventory as AgentInventory;
}
