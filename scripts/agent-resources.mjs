import { createHash } from "node:crypto";

/**
 * The factory's agent-resource declaration: the set the worker image
 * provisions and the launch loads. Validation, canonical form and digests
 * live here with no I/O and no dependencies, so the image build and the
 * runtime preflight share one interpretation; unknown keys are rejected, so a
 * typo fails the build instead of silently changing the effective set.
 */

export const AGENT_RESOURCES_SCHEMA = "msf-agent-resources/v1";
export const AGENT_INVENTORY_SCHEMA = "msf-agent-inventory/v1";
/** The committed declaration's file name, recorded in the image inventory. */
export const AGENT_DECLARATION_FILE = "agent-resources.yaml";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const IMMUTABLE_REVISION = /^[0-9a-f]{40}$/;
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The procedure roles the declaration must fill, one skill and one reviewer
 *  agent each: the worker prompt and launch flags derive their names here. */
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

/** A POSIX path relative to its root, which can never escape it. */
function relativePath(value, where) {
  const path = nonEmptyString(value, where);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\s'"]/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    fail(`${where} must be a normalized relative path without quotes or spaces, got "${path}"`);
  }
  return path;
}

function parsePi(value) {
  const pi = object(value, "pi");
  exactKeys(pi, ["package", "version", "license"], "pi");
  return {
    package: nonEmptyString(pi.package, "pi.package"),
    version: exactVersion(pi.version, "pi.version"),
    // The installed package manifest must declare exactly this licence: one
    // that changed upstream fails the build instead of shipping unnoticed.
    license: nonEmptyString(pi.license, "pi.license"),
  };
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

/** Validate a parsed declaration document and return its normalized form. */
export function normalizeAgentResources(document, source = AGENT_DECLARATION_FILE) {
  const doc = object(document, source);
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

/** The declaration's canonical text: key order and formatting are fixed by the
 *  normalized form, so the same declaration always yields the same bytes. */
export function canonicalDeclaration(declaration) {
  return `${JSON.stringify(declaration, null, 2)}\n`;
}

/** The declaration's identity: its canonical digest, recorded by the image and
 *  recomputed by the checkout that launches against it. */
export function declarationDigest(declaration) {
  return sha256(canonicalDeclaration(declaration));
}

/** The skills the image must carry, in the order the launch loads them: the
 *  selected upstream skills, then each extension's operating guidance. */
export function expectedSkills(declaration) {
  return [
    ...declaration.skills.selected.map((skill) => ({
      name: skill.name,
      origin: "git",
      upstreamPath: skill.path,
      revision: declaration.skills.revision,
      imagePath: skillImagePath(skill.name),
    })),
    ...declaration.extensions.map((extension) => ({
      name: extension.guidance.name,
      origin: "npm",
      upstreamPath: extension.guidance.path,
      revision: extension.version,
      imagePath: `${extensionImagePath(extension.package)}/${extension.guidance.path}`,
    })),
  ];
}

/** Where a skill directory sits, relative to the image's agent dir. */
export function skillImagePath(name) {
  return `skills/${name}`;
}

/** Where an extension's package root sits, relative to the image's agent dir. */
export function extensionImagePath(packageName) {
  return `extensions/node_modules/${packageName}`;
}

/**
 * Compare the inventory an image recorded with the declaration of the
 * checkout about to launch. Returns human-readable mismatches; empty means the
 * image really is the declared set. The comparison is by content identity —
 * versions, revisions and paths — never by the mutable Docker tag.
 */
export function compareAgentInventory(declaration, declarationSha256, inventory) {
  const mismatches = [];
  const record = object(inventory, "image inventory");
  if (record.schema !== AGENT_INVENTORY_SCHEMA) {
    return [`image inventory schema is "${String(record.schema)}", expected "${AGENT_INVENTORY_SCHEMA}"`];
  }
  const recordedDeclaration = object(record.declaration, "image inventory.declaration");
  if (recordedDeclaration.sha256 !== declarationSha256) {
    mismatches.push(`the image was provisioned from a different ${AGENT_DECLARATION_FILE} than this checkout`);
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
    } else if (found.path !== expected.imagePath) {
      // A resource somewhere else in the image is not the declared one: the
      // launch loads the declared path.
      mismatches.push(
        `skill "${expected.name}" is at ${String(found.path)} in the image, declared at ${expected.imagePath}`,
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
    } else if (found.path !== extensionImagePath(extension.package)) {
      mismatches.push(
        `extension "${extension.package}" is at ${String(found.path)} in the image, ` +
          `declared at ${extensionImagePath(extension.package)}`,
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
