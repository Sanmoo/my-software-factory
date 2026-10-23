// Hand-maintained types for the companion .mjs module: keep them in sync.
import type { AgentInventory } from "../scripts/agent-resources.mjs";

export class ProvisionError extends Error {}

export interface ProvisionOptions {
  declarationPath: string;
  dest: string;
  inventoryPath: string;
  repositoryRoot?: string;
  run?: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  workDir?: string;
  keepWorkDir?: boolean;
}

export function listFiles(dir: string): string[];
export function directoryDigest(dir: string): string;
export function fileDigest(file: string): string;
export function provisionAgentResources(options: ProvisionOptions): Promise<AgentInventory>;
