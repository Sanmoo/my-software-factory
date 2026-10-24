#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AGENT_INVENTORY_SCHEMA,
  AgentResourcesError,
  expectedSkills,
  parseAgentResources,
  sha256,
} from "../scripts/agent-resources.mjs";

/**
 * Provision the factory's agent environment INTO the worker image (issue #159,
 * ADR 0001). This runs during `docker build`, never at worker startup:
 *
 *   - Pi must already be installed at the declared exact version;
 *   - the selected upstream skills are fetched at the declared immutable
 *     revision and copied UNCHANGED, with the upstream LICENSE and attribution;
 *   - the delegation extension is installed at its exact version, with its
 *     operating-guidance skill and bundled references kept inside the package
 *     so their relative links still resolve;
 *   - the factory-owned reviewer agent definitions are copied unchanged.
 *
 * Everything is staged beside the destination and swapped in only after every
 * check passes: an invalid declaration, an unavailable revision, a missing
 * skill/reference, a wrong package version or a digest mismatch fails the
 * build and leaves any previous destination untouched.
 */

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(HERE);

export class ProvisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvisionError";
  }
}

function fail(message) {
  throw new ProvisionError(message);
}

function requireDirectory(path, what) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail(`${what} is missing: ${path}`);
  }
  if (stats.isSymbolicLink()) fail(`${what} must not be a symlink: ${path}`);
  if (!stats.isDirectory()) fail(`${what} is not a directory: ${path}`);
  return path;
}

function requireFile(path, what) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail(`${what} is missing: ${path}`);
  }
  if (stats.isSymbolicLink()) fail(`${what} must not be a symlink: ${path}`);
  if (!stats.isFile()) fail(`${what} is not a file: ${path}`);
  return path;
}

/** Every regular file under `dir`, relative POSIX paths, sorted. Symlinks are
 *  rejected: provisioned content must be plain files, never a link out. */
export function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`provisioned content must not be a symlink: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(dir, path).split("\\").join("/"));
      else fail(`unsupported file type in provisioned content: ${path}`);
    }
  };
  walk(requireDirectory(dir, "resource directory"));
  return files.sort();
}

/** A deterministic content digest of a directory: file paths plus bytes. */
export function directoryDigest(dir) {
  const hash = createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** A deterministic content digest of one file. */
export function fileDigest(file) {
  return `sha256:${sha256(readFileSync(file))}`;
}

function copyTree(source, destination) {
  requireDirectory(source, "resource source");
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) fail(`provisioned content must not be a symlink: ${from}`);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, lstatSync(from).mode & 0o777);
    } else {
      fail(`unsupported file type in provisioned content: ${from}`);
    }
  }
}

function frontmatterName(file) {
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) fail(`${file} has no YAML frontmatter`);
  const nameLine = /^name:\s*(.+)$/m.exec(match[1]);
  if (nameLine === null) fail(`${file} has no frontmatter "name"`);
  return nameLine[1].trim().replace(/^["']|["']$/g, "");
}

function requireSkill(directory, expectedName, what) {
  const skillFile = requireFile(join(directory, "SKILL.md"), `${what} SKILL.md`);
  const actual = frontmatterName(skillFile);
  if (actual !== expectedName) {
    fail(`${what} declares skill name "${actual}", expected "${expectedName}"`);
  }
  return directory;
}

/** Run a command, turning a failure into a ProvisionError that names only the
 *  command — never an environment value or another secret. */
async function runCommand(run, command, args, options = {}) {
  try {
    return await run(command, args, options);
  } catch (error) {
    const detail = error instanceof Error && error.message !== "" ? `: ${error.message.split("\n")[0]}` : "";
    fail(`${what(command, args)} failed${detail}`);
  }
}

function what(command, args) {
  return `${command} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`;
}

async function fetchSkills(declaration, workDir, run) {
  const repoDir = join(workDir, "skills-repo");
  mkdirSync(repoDir, { recursive: true });
  await runCommand(run, "git", ["init", "--quiet"], { cwd: repoDir });
  await runCommand(run, "git", ["remote", "add", "origin", declaration.skills.repository], { cwd: repoDir });
  await runCommand(run, "git", ["fetch", "--quiet", "--force", "--tags", "origin"], { cwd: repoDir });
  await runCommand(run, "git", ["checkout", "--quiet", "--detach", declaration.skills.revision], { cwd: repoDir });
  const { stdout } = await runCommand(run, "git", ["rev-parse", "HEAD"], { cwd: repoDir });
  const head = String(stdout).trim();
  if (head !== declaration.skills.revision) {
    fail(`upstream skills checkout is ${head}, declared ${declaration.skills.revision}`);
  }
  return repoDir;
}

async function installExtension(extension, prefix, workDir, run) {
  mkdirSync(prefix, { recursive: true });
  writeFileSync(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "msf-agent-extensions", private: true }, null, 2)}\n`,
    "utf8",
  );
  const npmCache = join(workDir, "npm-cache");
  await runCommand(
    run,
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=peer",
      "--omit=dev",
      "--no-save",
      "--prefix",
      prefix,
      `${extension.package}@${extension.version}`,
    ],
    { cwd: workDir, env: { ...process.env, npm_config_cache: npmCache } },
  );
  const installed = requireDirectory(join(prefix, "node_modules", extension.package), `extension ${extension.package}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  } catch {
    fail(`extension ${extension.package} installed without a readable package.json`);
  }
  if (manifest.name !== extension.package || manifest.version !== extension.version) {
    fail(
      `extension ${extension.package}@${extension.version} installed as ${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
  requireDependencies(manifest, installed);
  return installed;
}

/** Node's resolution order: the package's own node_modules first, then each
 *  ancestor's. A declared dependency that resolves nowhere fails the build. */
function resolveDependency(fromDir, name) {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Validate the extension's dependency closure at build time (issue #159): a
 * `dependencies` entry that did not install is a broken provisioning, not a
 * runtime surprise for the worker. Peer dependencies are excluded on purpose
 * (`--omit=peer`): Pi supplies them at run time from the image's own install.
 */
function requireDependencies(manifest, installed) {
  const declared = manifest.dependencies ?? {};
  const missing = Object.keys(declared).filter(
    (name) => typeof name === "string" && resolveDependency(installed, name) === null,
  );
  if (missing.length > 0) {
    fail(
      `extension ${String(manifest.name)}@${String(manifest.version)} is missing declared dependenc` +
        `${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`,
    );
  }
}

function installedPackages(nodeModules) {
  const versions = {};
  if (!existsSync(nodeModules)) return versions;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        readPackage(join(nodeModules, entry.name, scoped.name), versions);
      }
    } else {
      readPackage(join(nodeModules, entry.name), versions);
    }
  }
  return versions;
}

function readPackage(directory, versions) {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed.name === "string" && typeof parsed.version === "string") {
      versions[parsed.name] = parsed.version;
    }
  } catch {
    fail(`installed package manifest is unreadable: ${manifest}`);
  }
}

/**
 * Markdown links are relative to the file; inline code paths in the upstream
 * skills and guidance are sometimes written relative to the skill root. Both
 * forms are collected so the existence check can accept either resolution.
 */
function referencedPaths(markdown) {
  const references = [];
  const seen = new Set();
  const add = (target, kind) => {
    const key = `${kind}:${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ target, kind });
  };
  for (const match of markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(match[1], "link");
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (/^(?:\.{1,2}\/|references\/|docs\/)/.test(token) && /\.(?:md|markdown|json|ya?ml|sh|ts|js|mjs)$/.test(token)) {
      add(token, "code");
    }
  }
  return references;
}

/**
 * Verify every auxiliary reference a markdown file names: the target must
 * exist inside the provisioned root, so a bundled file renamed or absent
 * upstream fails the build instead of shipping a skill whose links lead
 * nowhere.
 */
function validateReferences(directory, allowedRoot, what) {
  const root = resolve(allowedRoot);
  for (const file of listFiles(directory).filter((candidate) => candidate.endsWith(".md"))) {
    const absolute = join(directory, file);
    const markdown = readFileSync(absolute, "utf8");
    for (const reference of referencedPaths(markdown)) {
      const raw = reference.target;
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
      const target = raw.split("#")[0].split("?")[0];
      if (target === "") continue;
      const bases = reference.kind === "link" ? [dirname(absolute)] : [dirname(absolute), resolve(directory), root];
      const candidates = bases.map((base) => resolve(base, target));
      let found = false;
      let escaped = false;
      for (const candidate of candidates) {
        const inside = relative(root, candidate);
        if (inside.startsWith("..") || isAbsolute(inside)) {
          escaped = true;
          continue;
        }
        if (existsSync(candidate)) {
          found = true;
          break;
        }
      }
      if (!found) {
        fail(
          escaped
            ? `${what} reference escapes its provisioned root: ${file} → ${raw}`
            : `${what} references a missing file: ${file} → ${raw}`,
        );
      }
    }
  }
}

async function installedPi(declaration, run) {
  const { stdout: rootOut } = await runCommand(run, "npm", ["root", "--global"]);
  const globalRoot = String(rootOut).trim();
  const packageDir = join(globalRoot, declaration.pi.package);
  const manifestFile = requireFile(join(packageDir, "package.json"), `installed Pi package ${declaration.pi.package}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    fail(`installed Pi package ${declaration.pi.package} has an unreadable package.json`);
  }
  if (manifest.name !== declaration.pi.package || manifest.version !== declaration.pi.version) {
    fail(
      `Pi is installed as ${String(manifest.name)}@${String(manifest.version)}, ` +
        `declared ${declaration.pi.package}@${declaration.pi.version}`,
    );
  }
  if (manifest.license !== declaration.pi.license) {
    fail(
      `installed Pi declares the license ${String(manifest.license)}, ` +
        `declared ${declaration.pi.license} — review the attribution before shipping it`,
    );
  }
  const { stdout: versionOut } = await runCommand(run, "pi", ["--version"]);
  const reported = String(versionOut).trim();
  if (reported !== declaration.pi.version) {
    fail(`pi --version reports ${reported}, declared ${declaration.pi.version}`);
  }
  // The package is the license's source of truth; copy the file when it ships
  // one (Pi 1.3.0 declares MIT in its manifest and ships no LICENSE).
  const shippedLicense = join(packageDir, "LICENSE");
  return {
    package: manifest.name,
    version: manifest.version,
    licenseFile: existsSync(shippedLicense) ? shippedLicense : null,
  };
}

/** A license file's name inside `licenses/`: the package name flattened to a
 *  single file name (a scoped name's `/` would nest a directory that does not
 *  exist, and the copy would fail). */
function licenseFileName(packageName) {
  return `${packageName.replaceAll("/", "-")}-LICENSE`;
}

function attribution(declaration, piInstall) {
  const lines = [
    "# Factory agent resources",
    "",
    "Provisioned into this image from the factory's committed declaration.",
    "",
    `- Pi: ${declaration.pi.package}@${declaration.pi.version} — ${declaration.pi.license} ` +
      `(${piInstall.licenseFile === null ? "declared by the installed package, which ships no LICENSE file" : "LICENSE under licenses/"})`,
    `- Skills: ${declaration.skills.repository}@${declaration.skills.revision} — ${declaration.skills.license}`,
    ...declaration.skills.selected.map((skill) => `  - ${skill.name}: ${skill.path}`),
    ...declaration.extensions.map(
      (extension) =>
        `- Extension: ${extension.package}@${extension.version} — ${extension.license}` +
        `\n  - Guidance: ${extension.guidance.name}: ${extension.guidance.path}`,
    ),
    `- Reviewer agents: factory-owned (${declaration.agents.map((agent) => agent.path).join(", ")})`,
    "",
    "The available licenses of the declared resources are under `licenses/`.",
    "Upstream skill content is copied unchanged.",
    "",
  ];
  return lines.join("\n");
}

/**
 * Provision the whole set into `dest` and record `inventoryPath`.
 * All failure-prone work happens in a staging directory; the destination is
 * replaced only after every check passed.
 */
export async function provisionAgentResources(options) {
  const {
    declarationPath,
    dest,
    inventoryPath,
    repositoryRoot = REPOSITORY_ROOT,
    run = execFileAsync,
    workDir = mkdtempSync(join(tmpdir(), "msf-provision-")),
  } = options;

  let rawDeclaration;
  try {
    rawDeclaration = readFileSync(declarationPath, "utf8");
  } catch {
    fail(`agent-resource declaration is unreadable: ${declarationPath}`);
  }
  let declaration;
  try {
    declaration = parseAgentResources(rawDeclaration, declarationPath);
  } catch (error) {
    if (error instanceof AgentResourcesError) fail(error.message);
    throw error;
  }

  const piInstall = await installedPi(declaration, run);
  const installed = { package: piInstall.package, version: piInstall.version };

  const staging = `${resolve(dest)}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const repoDir = await fetchSkills(declaration, workDir, run);
    const skillsRoot = join(staging, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    for (const skill of declaration.skills.selected) {
      const source = requireSkill(join(repoDir, skill.path), skill.name, `selected skill "${skill.name}"`);
      const target = join(skillsRoot, skill.name);
      copyTree(source, target);
      if (directoryDigest(source) !== directoryDigest(target)) {
        fail(`skill "${skill.name}" changed while being copied`);
      }
      validateReferences(target, target, `skill "${skill.name}"`);
    }

    // Reviewer agents are factory-owned files: copied unchanged at their
    // declared repository paths (the inventory records the same paths).
    for (const agent of declaration.agents) {
      const source = requireFile(join(repositoryRoot, agent.path), `reviewer agent "${agent.name}"`);
      if (frontmatterName(source) !== agent.name) {
        fail(`reviewer agent ${agent.path} declares name "${frontmatterName(source)}", expected "${agent.name}"`);
      }
      const target = join(staging, agent.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, lstatSync(source).mode & 0o777);
    }

    const licensesRoot = join(staging, "licenses");
    mkdirSync(licensesRoot, { recursive: true });
    const extensionsRoot = join(staging, "extensions");
    const extensionRecords = [];
    for (const extension of declaration.extensions) {
      const installedPackageRoot = await installExtension(extension, extensionsRoot, workDir, run);
      requireFile(join(installedPackageRoot, extension.entry), `extension "${extension.package}" entry`);
      const guidance = requireSkill(
        join(installedPackageRoot, extension.guidance.path),
        extension.guidance.name,
        `extension "${extension.package}" guidance`,
      );
      validateReferences(guidance, installedPackageRoot, `extension "${extension.package}" guidance`);
      const license = requireFile(join(installedPackageRoot, "LICENSE"), `extension "${extension.package}" LICENSE`);
      copyFileSync(license, join(licensesRoot, licenseFileName(extension.package)));
      extensionRecords.push({
        package: extension.package,
        version: extension.version,
        license: extension.license,
        path: `extensions/node_modules/${extension.package}`,
        entry: extension.entry,
        digest: directoryDigest(installedPackageRoot),
        dependencies: installedPackages(join(extensionsRoot, "node_modules")),
        guidance: {
          name: extension.guidance.name,
          path: `extensions/node_modules/${extension.package}/${extension.guidance.path}`,
          digest: directoryDigest(guidance),
        },
      });
    }

    copyFileSync(requireFile(join(repoDir, "LICENSE"), "upstream skills LICENSE"), join(licensesRoot, "skills-LICENSE"));
    if (piInstall.licenseFile !== null) {
      copyFileSync(piInstall.licenseFile, join(licensesRoot, licenseFileName(declaration.pi.package)));
    }

    const skills = expectedSkills(declaration).map((skill) => {
      const imagePath = skill.imagePath;
      const directory = join(staging, imagePath);
      requireSkill(directory, skill.name, `provisioned skill "${skill.name}"`);
      return {
        name: skill.name,
        origin: skill.origin,
        upstreamPath: skill.upstreamPath,
        revision: skill.revision,
        path: imagePath,
        digest: directoryDigest(directory),
      };
    });

    const agents = declaration.agents.map((agent) => {
      return {
        name: agent.name,
        source: `factory:${agent.path}`,
        path: agent.path,
        digest: fileDigest(join(staging, agent.path)),
      };
    });

    writeFileSync(join(staging, "ATTRIBUTION.md"), attribution(declaration, piInstall), "utf8");

    const inventory = {
      schema: AGENT_INVENTORY_SCHEMA,
      declaration: { file: basename(declarationPath), sha256: sha256(rawDeclaration) },
      pi: installed,
      skills,
      extensions: extensionRecords,
      agents,
    };

    const resolvedDest = resolve(dest);
    const backup = `${resolvedDest}.previous-${process.pid}`;
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(resolvedDest)) renameSync(resolvedDest, backup);
    try {
      renameSync(staging, resolvedDest);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, resolvedDest);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });

    mkdirSync(dirname(resolve(inventoryPath)), { recursive: true });
    const inventoryTemp = `${resolve(inventoryPath)}.tmp-${process.pid}`;
    writeFileSync(inventoryTemp, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    renameSync(inventoryTemp, resolve(inventoryPath));

    return inventory;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--declaration", "--dest", "--inventory"].includes(flag)) {
      fail(`unknown argument "${flag}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of ["declaration", "dest", "inventory"]) {
    if (args[required] === undefined) fail(`--${required} is required`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventory = await provisionAgentResources({
    declarationPath: args.declaration,
    dest: args.dest,
    inventoryPath: args.inventory,
  });
  process.stdout.write(
    `provisioned Pi ${inventory.pi.package}@${inventory.pi.version}, ` +
      `${inventory.skills.length} skill(s), ${inventory.extensions.length} extension(s), ` +
      `${inventory.agents.length} reviewer agent(s)\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`provision-agent: ${message}\n`);
    process.exitCode = 1;
  });
}
