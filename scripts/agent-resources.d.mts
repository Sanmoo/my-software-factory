// Hand-maintained types for the companion .mjs module: keep them in sync.
export type SkillRole = "implement" | "tdd" | "review" | "design" | "pr";
export type AgentRole = "standards" | "spec";

export interface AgentResourcesDeclaration {
  schema: "msf-agent-resources/v1";
  pi: { package: string; version: string; license: string };
  skills: {
    repository: string;
    revision: string;
    license: string;
    selected: Array<{ name: string; path: string; role: SkillRole }>;
  };
  extensions: Array<{
    package: string;
    version: string;
    license: string;
    entry: string;
    guidance: { name: string; path: string };
  }>;
  agents: Array<{ name: string; path: string; role: AgentRole }>;
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
export const AGENT_DECLARATION_FILE: "agent-resources.yaml";
export const SKILL_ROLES: readonly SkillRole[];
export const AGENT_ROLES: readonly AgentRole[];
export const AGENT_INVENTORY_SCHEMA: "msf-agent-inventory/v1";

export function normalizeAgentResources(document: unknown, source?: string): AgentResourcesDeclaration;
export function sha256(input: string | Uint8Array): string;
export function canonicalDeclaration(declaration: AgentResourcesDeclaration): string;
export function declarationDigest(declaration: AgentResourcesDeclaration): string;
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
