// Hand-maintained types for the companion .mjs module: keep them in sync.
export interface AgentResourcesDeclaration {
  schema: "msf-agent-resources/v1";
  pi: { package: string; version: string };
  skills: {
    repository: string;
    revision: string;
    license: string;
    selected: Array<{ name: string; path: string }>;
  };
  extensions: Array<{
    package: string;
    version: string;
    license: string;
    entry: string;
    guidance: { name: string; path: string };
  }>;
  agents: Array<{ name: string; path: string }>;
}

export interface AgentInventory {
  schema: string;
  declaration: { file: string; sha256: string };
  pi: { package: string; version: string };
  skills: Array<{
    name: string;
    origin: "git" | "npm";
    upstreamPath: string;
    revision: string;
    path: string;
    digest: string;
  }>;
  extensions: Array<{
    package: string;
    version: string;
    license: string;
    path: string;
    entry: string;
    digest: string;
    dependencies: Record<string, string>;
    guidance: { name: string; path: string; digest: string };
  }>;
  agents: Array<{ name: string; source: string; path: string; digest: string }>;
}

export class AgentResourcesError extends Error {}

export const AGENT_RESOURCES_SCHEMA: "msf-agent-resources/v1";
export const AGENT_INVENTORY_SCHEMA: "msf-agent-inventory/v1";

export function parseAgentResources(text: string, source?: string): AgentResourcesDeclaration;
export function sha256(text: string): string;
export function expectedSkills(declaration: AgentResourcesDeclaration): Array<{
  name: string;
  origin: "git" | "npm";
  upstreamPath: string;
  revision: string;
  imagePath: string;
}>;
export function compareAgentInventory(
  declaration: AgentResourcesDeclaration,
  declarationSha256: string,
  inventory: unknown,
): string[];
