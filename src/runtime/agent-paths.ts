import type {
  AgentResourcesDeclaration,
  AgentRole,
  SkillRole,
} from "../../scripts/agent-resources.mjs";

/**
 * Where the image-provisioned agent resources live inside the worker
 * container, derived from the single declaration in `agent-resources.json`
 * (issue #159, ADR 0001). The launch flags and the worker prompt both read
 * the layout from here, so neither keeps a second list of skills, agents or
 * extension paths to drift from the declaration.
 */

/** The image's agent dir; only `sessions/` is a host bind inside it. */
export const AGENT_DIR = "/home/agent/.pi/agent";
export const AGENT_SKILLS_DIR = `${AGENT_DIR}/skills`;

export function agentSkillPath(name: string): string {
  return `${AGENT_SKILLS_DIR}/${name}`;
}

export function agentExtensionEntry(extension: { package: string; entry: string }): string {
  return `${AGENT_DIR}/extensions/node_modules/${extension.package}/${extension.entry}`;
}

export function agentGuidancePath(extension: {
  package: string;
  guidance: { path: string };
}): string {
  return `${AGENT_DIR}/extensions/node_modules/${extension.package}/${extension.guidance.path}`;
}

export interface AgentLayout {
  /** The declared skill filling each procedure role, with its image path. */
  skills: Record<SkillRole, { name: string; path: string }>;
  /** The declared reviewer agent filling each review role. */
  reviewers: Record<AgentRole, string>;
  /** Every declared extension's operating guidance, with its image path. */
  guidance: Array<{ package: string; name: string; path: string }>;
}

function byRole<T extends { role: string }>(
  entries: readonly T[],
  role: string,
  what: string,
): T {
  const found = entries.find((entry) => entry.role === role);
  if (found === undefined) {
    throw new Error(`agent-resources.json declares no ${what} for role "${role}"`);
  }
  return found;
}

/**
 * The launch/prompt layout of a validated declaration. Missing procedure roles
 * throw: a declaration that cannot compose the worker's procedure must fail
 * the launch, never leave the prompt pointing at paths that do not exist.
 */
export function agentLayout(declaration: AgentResourcesDeclaration): AgentLayout {
  const skill = (role: SkillRole) => {
    const declared = byRole(declaration.skills.selected, role, "skill");
    return { name: declared.name, path: agentSkillPath(declared.name) };
  };
  return {
    skills: {
      implement: skill("implement"),
      tdd: skill("tdd"),
      review: skill("review"),
      design: skill("design"),
      pr: skill("pr"),
    },
    reviewers: {
      standards: byRole(declaration.agents, "standards", "reviewer agent").name,
      spec: byRole(declaration.agents, "spec", "reviewer agent").name,
    },
    guidance: declaration.extensions.map((extension) => ({
      package: extension.package,
      name: extension.guidance.name,
      path: agentGuidancePath(extension),
    })),
  };
}
