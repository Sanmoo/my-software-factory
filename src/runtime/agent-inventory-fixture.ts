import { extensionImagePath, skillImagePath } from "../../scripts/agent-resources.mjs";

import type { LoadedAgentResources } from "./inventory.js";

/**
 * The inventory a correctly provisioned image records for a declaration —
 * shared by the runtime tests so the accepted shape lives in one place: a
 * second hand-built copy would drift from the first and still pass, because
 * the comparison reads only the fields below.
 *
 * The digests are placeholders on purpose: the launch compares versions,
 * revisions and paths, never file contents (the declaration carries no
 * expected digests to compare against).
 */
export function provisionedInventory(loaded: LoadedAgentResources): Record<string, unknown> {
  const { declaration } = loaded;
  return {
    schema: "msf-agent-inventory/v1",
    declaration: { file: "agent-resources.yaml", sha256: loaded.digest },
    pi: { package: declaration.pi.package, version: declaration.pi.version },
    skills: [
      ...declaration.skills.selected.map((skill) => ({
        name: skill.name,
        origin: "git",
        upstreamPath: skill.path,
        revision: declaration.skills.revision,
        path: skillImagePath(skill.name),
        digest: "sha256:fixture",
      })),
      ...declaration.extensions.map((extension) => ({
        name: extension.guidance.name,
        origin: "npm",
        upstreamPath: extension.guidance.path,
        revision: extension.version,
        path: `${extensionImagePath(extension.package)}/${extension.guidance.path}`,
        digest: "sha256:fixture",
      })),
    ],
    extensions: declaration.extensions.map((extension) => ({
      package: extension.package,
      version: extension.version,
      license: extension.license,
      path: extensionImagePath(extension.package),
      entry: extension.entry,
      digest: "sha256:fixture",
      dependencies: {},
      guidance: {
        name: extension.guidance.name,
        path: `${extensionImagePath(extension.package)}/${extension.guidance.path}`,
        digest: "sha256:fixture",
      },
    })),
    agents: declaration.agents.map((agent) => ({
      name: agent.name,
      source: `factory:${agent.path}`,
      path: agent.path,
      digest: "sha256:fixture",
    })),
  };
}
