// Hand-maintained types for the companion .mjs module: keep them in sync.
import type { AgentResourcesDeclaration } from "./agent-resources.mjs";

export interface LoadedDeclaration {
  declaration: AgentResourcesDeclaration;
  digest: string;
}

export function parseAgentDeclaration(text: string, source?: string): LoadedDeclaration;
export function loadAgentDeclaration(path: string): LoadedDeclaration;
