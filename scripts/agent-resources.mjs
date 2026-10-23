import { createHash } from "node:crypto";

/**
 * The factory-owned agent-resource declaration (issue #159, ADR 0001).
 *
 * One file declares everything the worker image provisions: Pi at an exact
 * version, the selected upstream skills at an immutable revision, the
 * delegation extension at an exact version with its operating guidance, and
 * the factory-owned reviewer agent definitions. The provisioning script and
 * the runtime preflight share these validators so a declaration typo fails
 * the image build AND a stale image fails the launch — never a silent
 * substitution.
 */

export const AGENT_RESOURCES_SCHEMA = "msf-agent-resources/v1";
export const AGENT_INVENTORY_SCHEMA = "msf-agent-inventory/v1";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const IMMUTABLE_REVISION = /^[0-9a-f]{40}$/;
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The roles the factory's implementation procedure composes (issue #159): the
 * declaration names WHICH skill/agent fills each role, so the prompt derives
 * its names and paths from this file instead of keeping a second list.
 */
export const SKILL_ROLES = ["implement", "tdd", "review", "design", "pr"];
export const AGENT_ROLES = ["standards", "spec"];

export class AgentResourcesError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentResourcesError";
  }
}

function fail(message) {
  throw new AgentResourcesError(message);
}

function object(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, where) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`${where} has unknown key(s): ${extra.join(", ")}`);
  for (const key of keys) {
    if (!(key in value)) fail(`${where} is missing "${key}"`);
  }
}

function nonEmptyString(value, where) {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
  return value.trim();
}

function exactVersion(value, where) {
  const version = nonEmptyString(value, where);
  if (!EXACT_VERSION.test(version)) fail(`${where} must be an exact x.y.z version, got "${version}"`);
  return version;
}

function revision(value, where) {
  const rev = nonEmptyString(value, where);
  if (!IMMUTABLE_REVISION.test(rev)) fail(`${where} must be a 40-character lowercase git commit SHA, got "${rev}"`);
  return rev;
}

function role(value, allowed, where) {
  const name = nonEmptyString(value, where);
  if (!allowed.includes(name)) fail(`${where} must be one of ${allowed.join(", ")}, got "${name}"`);
  return name;
}

function resourceName(value, where) {
  const name = nonEmptyString(value, where);
  if (!RESOURCE_NAME.test(name)) fail(`${where} must be lowercase letters, digits and single hyphens, got "${name}"`);
  return name;
}

/** A repository-relative POSIX path that can never escape the checkout. */
function relativePath(value, where) {
  const path = nonEmptyString(value, where);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\s'"]/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    fail(`${where} must be a normalized repository-relative path without quotes or spaces, got "${path}"`);
  }
  return path;
}

function parsePi(value) {
  const pi = object(value, "pi");
  exactKeys(pi, ["package", "version"], "pi");
  return { package: nonEmptyString(pi.package, "pi.package"), version: exactVersion(pi.version, "pi.version") };
}

function parseSkills(value) {
  const skills = object(value, "skills");
  exactKeys(skills, ["repository", "revision", "license", "selected"], "skills");
  const selected = skills.selected;
  if (!Array.isArray(selected) || selected.length === 0) {
    fail("skills.selected must be a non-empty list of skill entries");
  }
  const seen = new Set();
  const roles = new Set();
  const parsed = selected.map((entry, index) => {
    const where = `skills.selected[${index}]`;
    const skill = object(entry, where);
    exactKeys(skill, ["name", "path", "role"], where);
    const name = resourceName(skill.name, `${where}.name`);
    if (seen.has(name)) fail(`${where}.name duplicates "${name}"`);
    seen.add(name);
    const skillRole = role(skill.role, SKILL_ROLES, `${where}.role`);
    if (roles.has(skillRole)) fail(`${where}.role duplicates "${skillRole}"`);
    roles.add(skillRole);
    return { name, path: relativePath(skill.path, `${where}.path`), role: skillRole };
  });
  return {
    repository: nonEmptyString(skills.repository, "skills.repository"),
    revision: revision(skills.revision, "skills.revision"),
    license: nonEmptyString(skills.license, "skills.license"),
    selected: parsed,
  };
}

function parseExtensions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("extensions must be a non-empty list");
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const where = `extensions[${index}]`;
    const extension = object(entry, where);
    exactKeys(extension, ["package", "version", "license", "entry", "guidance"], where);
    const packageName = nonEmptyString(extension.package, `${where}.package`);
    if (seen.has(packageName)) fail(`${where}.package duplicates "${packageName}"`);
    seen.add(packageName);
    const guidance = object(extension.guidance, `${where}.guidance`);
    exactKeys(guidance, ["name", "path"], `${where}.guidance`);
    return {
      package: packageName,
      version: exactVersion(extension.version, `${where}.version`),
      license: nonEmptyString(extension.license, `${where}.license`),
      entry: relativePath(extension.entry, `${where}.entry`),
      guidance: {
        name: resourceName(guidance.name, `${where}.guidance.name`),
        path: relativePath(guidance.path, `${where}.guidance.path`),
      },
    };
  });
}

function parseAgents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("agents must be a non-empty list of factory-owned reviewer definitions");
  }
  const seen = new Set();
  const roles = new Set();
  return value.map((entry, index) => {
    const where = `agents[${index}]`;
    const agent = object(entry, where);
    exactKeys(agent, ["name", "path", "role"], where);
    const name = resourceName(agent.name, `${where}.name`);
    if (seen.has(name)) fail(`${where}.name duplicates "${name}"`);
    seen.add(name);
    const agentRole = role(agent.role, AGENT_ROLES, `${where}.role`);
    if (roles.has(agentRole)) fail(`${where}.role duplicates "${agentRole}"`);
    roles.add(agentRole);
    return { name, path: relativePath(agent.path, `${where}.path`), role: agentRole };
  });
}

/**
 * Parse and validate a declaration. Unknown keys are rejected on purpose:
 * a typo must fail the build, never silently change the effective set.
 */
export function parseAgentResources(text, source = "agent-resources.json") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const doc = object(parsed, source);
  exactKeys(doc, ["schema", "pi", "skills", "extensions", "agents"], source);
  if (doc.schema !== AGENT_RESOURCES_SCHEMA) {
    fail(`${source}.schema must be "${AGENT_RESOURCES_SCHEMA}", got "${String(doc.schema)}"`);
  }
  return {
    schema: AGENT_RESOURCES_SCHEMA,
    pi: parsePi(doc.pi),
    skills: parseSkills(doc.skills),
    extensions: parseExtensions(doc.extensions),
    agents: parseAgents(doc.agents),
  };
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The skills the image must carry, in the exact order the launch loads them:
 * the selected upstream skills first, then each extension's operating guidance.
 * Paths are relative to the agent directory inside the worker image.
 */
export function expectedSkills(declaration) {
  return [
    ...declaration.skills.selected.map((skill) => ({
      name: skill.name,
      origin: "git",
      upstreamPath: skill.path,
      revision: declaration.skills.revision,
      imagePath: `skills/${skill.name}`,
    })),
    ...declaration.extensions.map((extension) => ({
      name: extension.guidance.name,
      origin: "npm",
      upstreamPath: extension.guidance.path,
      revision: extension.version,
      imagePath: `extensions/node_modules/${extension.package}/${extension.guidance.path}`,
    })),
  ];
}

/**
 * Compare the inventory recorded by the image with the MSF declaration of the
 * checkout that is about to launch. Returns human-readable mismatches; empty
 * means the image really is the declared set. Field comparison (not the Docker
 * tag) is the proof: a stale or hand-built image fails here.
 */
export function compareAgentInventory(declaration, declarationSha256, inventory) {
  const mismatches = [];
  const record = object(inventory, "image inventory");
  if (record.schema !== AGENT_INVENTORY_SCHEMA) {
    return [`image inventory schema is "${String(record.schema)}", expected "${AGENT_INVENTORY_SCHEMA}"`];
  }
  const recordedDeclaration = object(record.declaration, "image inventory.declaration");
  if (recordedDeclaration.sha256 !== declarationSha256) {
    mismatches.push("the image was provisioned from a different agent-resources.json than this checkout");
  }

  const pi = object(record.pi, "image inventory.pi");
  if (pi.package !== declaration.pi.package || pi.version !== declaration.pi.version) {
    mismatches.push(
      `Pi is ${String(pi.package)}@${String(pi.version)}, declared ${declaration.pi.package}@${declaration.pi.version}`,
    );
  }

  const skills = Array.isArray(record.skills) ? record.skills : [];
  for (const expected of expectedSkills(declaration)) {
    const found = skills.find((skill) => skill?.name === expected.name);
    if (found === undefined) {
      mismatches.push(`skill "${expected.name}" is missing from the image`);
    } else if (found.revision !== expected.revision || found.upstreamPath !== expected.upstreamPath) {
      mismatches.push(
        `skill "${expected.name}" is ${String(found.origin)}@${String(found.revision)} ${String(found.upstreamPath)}, ` +
          `declared ${expected.origin}@${expected.revision} ${expected.upstreamPath}`,
      );
    }
  }
  const expectedNames = new Set(expectedSkills(declaration).map((skill) => skill.name));
  for (const skill of skills) {
    if (!expectedNames.has(skill?.name)) mismatches.push(`skill "${String(skill?.name)}" is in the image but not declared`);
  }

  const extensions = Array.isArray(record.extensions) ? record.extensions : [];
  for (const extension of declaration.extensions) {
    const found = extensions.find((candidate) => candidate?.package === extension.package);
    if (found === undefined) {
      mismatches.push(`extension "${extension.package}" is missing from the image`);
    } else if (found.version !== extension.version || found.entry !== extension.entry) {
      mismatches.push(
        `extension "${extension.package}" is ${String(found.version)} (${String(found.entry)}), ` +
          `declared ${extension.version} (${extension.entry})`,
      );
    }
  }
  const expectedPackages = new Set(declaration.extensions.map((extension) => extension.package));
  for (const extension of extensions) {
    if (!expectedPackages.has(extension?.package)) {
      mismatches.push(`extension "${String(extension?.package)}" is in the image but not declared`);
    }
  }

  const agents = Array.isArray(record.agents) ? record.agents : [];
  for (const agent of declaration.agents) {
    const found = agents.find((candidate) => candidate?.name === agent.name);
    if (found === undefined) {
      mismatches.push(`reviewer agent "${agent.name}" is missing from the image`);
    } else if (found.path !== agent.path) {
      mismatches.push(`reviewer agent "${agent.name}" comes from ${String(found.path)}, declared ${agent.path}`);
    }
  }
  const expectedAgentNames = new Set(declaration.agents.map((agent) => agent.name));
  for (const agent of agents) {
    if (!expectedAgentNames.has(agent?.name)) {
      mismatches.push(`reviewer agent "${String(agent?.name)}" is in the image but not declared`);
    }
  }

  return mismatches;
}
