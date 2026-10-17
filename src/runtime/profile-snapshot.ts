import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RuntimeProfileConfig } from "../config/types.js";
import { isObject, messageOf } from "../core/values.js";

// Runtime profile resolved on the host (ADR 0002). The operator's Pi profile is a chain of links
// (profile -> ~/.pi/agent -> ~/.agents -> dotfiles); the container must not follow them. The profile is
// walked here, every link is resolved at every level, and only destinations inside the allowed roots
// count. What results is a snapshot of real files, which is all the container mounts.

export interface ProfileSource {
  dir: string; // the profile directory (it may itself be a link)
  allowedRoots: readonly string[]; // where links may lead, besides the profile directory itself
  // The operator's mise declaration on this host, when local.json declares one for the profile. It is
  // carried into the snapshot as a real file (ADR 0002, ADR 0004); the tools the container converges
  // come from it, never from a host binary mounted inside.
  mise?: string;
}

export interface SnapshotItem {
  path: string; // relative to the profile, with / separators
  source: string; // the real file it is copied from
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface SnapshotPlan {
  included: SnapshotItem[];
  skipped: SkippedItem[];
  // Package sources dropped from the container's copy of settings.json.
  excluded: string[];
  // Why the job cannot run with this profile: a required item missing, broken, cyclic or out of the roots.
  blockers: string[];
  // The container's settings.json: the host's without the excluded packages.
  settingsText?: string;
}

// Entries at the root of the profile that are carried when present, besides the required files.
const ROOT_FILES = ["settings.json", "auth.json", "keybindings.json", "AGENTS.md", "models-store.json"];
const DIRECTORIES = ["skills", "extensions", "agents"];
// The Pi package tree is converged inside the container from the operator's lock (ADR 0004): only the
// declaration and its lock are carried, never node_modules, which holds the host's platform bindings.
const NPM_DIR = "npm";
const NPM_FILES = ["package.json", "package-lock.json"];
// Fixed snapshot-relative path of the operator's mise declaration inside the snapshot.
const MISE_DECLARATION = "mise/config.toml";
const MAX_HOPS = 40;

interface Context {
  profile: string; // real path of the profile directory
  roots: string[]; // real paths of the allowed roots, the profile included
  mise?: string; // the declared mise declaration, as given by local.json
}

const within = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

async function contextOf(source: ProfileSource): Promise<Context | string> {
  let profile: string;
  try {
    profile = await realpath(source.dir);
  } catch (error) {
    return `perfil ${source.dir} não pôde ser lido: ${messageOf(error)}`;
  }
  const roots = [profile];
  for (const root of source.allowedRoots) roots.push(await realpath(root).catch(() => resolve(root)));
  // The declared mise declaration is authoritative (its path is machine-local, ADR 0002): its real file
  // is allowed wherever it lives, and a link it carries is resolved by the same rule as everything else.
  const declared = source.mise;
  if (declared !== undefined) roots.push(await realpath(declared).catch(() => resolve(declared)));
  return { profile, roots, ...(declared === undefined ? {} : { mise: declared }) };
}

// The chain of links a failing link leads through, as `a -> b -> c`, and whether it ends in a cycle.
async function chainFrom(start: string): Promise<{ text: string; cyclic: boolean }> {
  const hops = [start];
  const seen = new Set([start]);
  let current = start;
  for (let step = 0; step < MAX_HOPS; step += 1) {
    const next = resolve(dirname(current), await readlink(current));
    hops.push(next);
    if (seen.has(next)) return { text: hops.join(" -> "), cyclic: true };
    seen.add(next);
    const info = await lstat(next).catch(() => undefined);
    if (info === undefined || !info.isSymbolicLink()) return { text: hops.join(" -> "), cyclic: false };
    current = next;
  }
  return { text: hops.join(" -> "), cyclic: true };
}

// Why a path does not resolve to a place inside the roots: the first link on the way that does not, with
// where it leads. Only called after the resolution failed, so there is a link to name or the path is just absent.
async function explain(path: string, roots: readonly string[], failure: unknown): Promise<string> {
  let current: string = sep;
  for (const part of path.split(sep).filter((segment) => segment !== "")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) break;
    if (!info.isSymbolicLink()) continue;
    const real = await realpath(current).catch(() => undefined);
    if (real === undefined) {
      const chain = await chainFrom(current);
      return chain.cyclic ? `link cíclico: ${chain.text}` : `link quebrado: ${chain.text}`;
    }
    if (!within(real, roots)) {
      return `destino fora das raízes permitidas: ${current} -> ${await readlink(current)} (destino final ${real})`;
    }
  }
  const code = (failure as { code?: string } | undefined)?.code;
  return code === "ELOOP" ? "link cíclico" : "ausente";
}

type Resolution = { ok: true; real: string } | { ok: false; reason: string };

// One path to its real file or directory, accepted only inside the roots. Shared by the walk and by the
// required items, so there is one rule for what a link may lead to.
async function resolveItem(path: string, ctx: Context): Promise<Resolution> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return { ok: false, reason: await explain(path, ctx.roots, error) };
  }
  if (!within(real, ctx.roots)) return { ok: false, reason: await explain(path, ctx.roots, undefined) };
  return { ok: true, real };
}

interface Settings {
  text: string;
  excluded: string[];
}

const sourceOf = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : isObject(entry) && typeof entry.source === "string" ? entry.source : undefined;

async function readSettings(ctx: Context, exclude: readonly string[]): Promise<{ settings?: Settings; packages?: string[]; problem?: string }> {
  const resolved = await resolveItem(join(ctx.profile, "settings.json"), ctx);
  if (!resolved.ok) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved.real, "utf8"));
  } catch {
    return { problem: "settings.json: JSON inválido; os pacotes não podem ser conhecidos" };
  }
  if (!isObject(parsed)) return { problem: "settings.json: JSON inválido; os pacotes não podem ser conhecidos" };
  const entries = Array.isArray(parsed.packages) ? (parsed.packages as unknown[]) : [];
  const kept = entries.filter((entry) => !exclude.includes(sourceOf(entry) ?? ""));
  const excluded = entries.flatMap((entry) => {
    const source = sourceOf(entry);
    return source !== undefined && exclude.includes(source) ? [source] : [];
  });
  const text = `${JSON.stringify({ ...parsed, packages: kept }, null, 2)}\n`;
  return { settings: { text, excluded }, packages: kept.flatMap((entry) => sourceOf(entry) ?? []) };
}

// The operator's mise declaration as a real file of the snapshot, or why it is not one.
async function resolveMise(ctx: Context): Promise<{ ok: true; item: SnapshotItem } | { ok: false; reason: string }> {
  if (ctx.mise === undefined) {
    return { ok: false, reason: "declaração de mise do operador não declarada em local.json para este perfil" };
  }
  const resolved = await resolveItem(ctx.mise, ctx);
  if (!resolved.ok) return { ok: false, reason: `declaração de mise ${ctx.mise}: ${resolved.reason}` };
  if (!(await stat(resolved.real)).isFile()) {
    return { ok: false, reason: `declaração de mise ${ctx.mise}: não é arquivo (${resolved.real})` };
  }
  return { ok: true, item: { path: MISE_DECLARATION, source: resolved.real } };
}

// The required items must resolve; the packages must be listed in the container's settings.json.
async function requiredBlockers(ctx: Context, config: RuntimeProfileConfig): Promise<{ blockers: string[]; settings?: Settings }> {
  const { required } = config;
  const items = [
    ...required.files,
    ...required.skills.map((name) => `skills/${name}/SKILL.md`),
    ...required.agents.map((name) => `agents/${name}.md`),
  ];
  const blockers: string[] = [];
  for (const item of items) {
    const resolved = await resolveItem(join(ctx.profile, ...item.split("/")), ctx);
    if (!resolved.ok) {
      blockers.push(`obrigatório ${item}: ${resolved.reason}`);
    } else if (!(await stat(resolved.real)).isFile()) {
      blockers.push(`obrigatório ${item}: não é arquivo (${resolved.real})`);
    }
  }
  const { settings, packages, problem } = await readSettings(ctx, config.excludePackages);
  if (problem !== undefined) blockers.push(problem);
  if (packages !== undefined) {
    for (const wanted of required.packages) {
      if (!packages.includes(wanted)) blockers.push(`pacote obrigatório ${wanted} não está no settings.json do perfil`);
    }
  } else if (problem === undefined && required.packages.length > 0 && !items.includes("settings.json")) {
    blockers.push("pacotes obrigatórios exigem settings.json do perfil, que não resolve");
  }
  // A required tool comes from the operator's mise declaration: without it there is nothing to converge.
  if (required.tools.length > 0) {
    const mise = await resolveMise(ctx);
    if (!mise.ok) blockers.push(`ferramentas obrigatórias (${required.tools.join(", ")}): ${mise.reason}`);
  }
  return { blockers, ...(settings === undefined ? {} : { settings }) };
}

// The blockers of a profile, cheap: only the required items are resolved. The admission asks this before
// the claim; the snapshot walk (planSnapshot) uses the same resolution.
export async function checkRequired(source: ProfileSource, config: RuntimeProfileConfig): Promise<string[]> {
  const ctx = await contextOf(source);
  if (typeof ctx === "string") return [ctx];
  return (await requiredBlockers(ctx, config)).blockers;
}

// Whether one file of the profile resolves inside the roots (e.g. a skill the triage needs).
export async function resolves(source: ProfileSource, path: string): Promise<boolean> {
  const ctx = await contextOf(source);
  if (typeof ctx === "string") return false;
  const resolved = await resolveItem(join(ctx.profile, ...path.split("/")), ctx);
  return resolved.ok && (await stat(resolved.real)).isFile();
}

export async function planSnapshot(source: ProfileSource, config: RuntimeProfileConfig): Promise<SnapshotPlan> {
  const ctx = await contextOf(source);
  if (typeof ctx === "string") return { included: [], skipped: [], excluded: [], blockers: [ctx] };
  const { blockers, settings } = await requiredBlockers(ctx, config);
  const included: SnapshotItem[] = [];
  const skipped: SkippedItem[] = [];

  const visit = async (abs: string, rel: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const info = await lstat(abs).catch(() => undefined);
    if (info === undefined) return;
    let real = abs;
    let isDirectory = info.isDirectory();
    let isFile = info.isFile();
    if (info.isSymbolicLink()) {
      const resolved = await resolveItem(abs, ctx);
      if (!resolved.ok) {
        skipped.push({ path: rel, reason: resolved.reason });
        return;
      }
      real = resolved.real;
      const target = await stat(real);
      isDirectory = target.isDirectory();
      isFile = target.isFile();
      if (isDirectory && ancestors.has(real)) {
        skipped.push({ path: rel, reason: `link cíclico: ${abs} -> ${await readlink(abs)} volta a ${real}, já percorrido` });
        return;
      }
    }
    if (isFile) {
      included.push({ path: rel, source: real });
    } else if (isDirectory) {
      if (abs.split(sep).at(-1) === ".git") {
        skipped.push({ path: rel, reason: "diretório .git não é copiado" });
        return;
      }
      const inside = new Set(ancestors).add(real);
      for (const entry of (await readdir(real)).sort()) await visit(join(real, entry), `${rel}/${entry}`, inside);
    } else {
      skipped.push({ path: rel, reason: "não é arquivo regular nem diretório" });
    }
  };

  // One directory of the profile whose only carried entries are the named files: the directory link is
  // resolved first (ADR 0002), so node_modules is never walked and a foreign destination is not followed.
  const visitNested = async (dirName: string, names: readonly string[], ancestors: ReadonlySet<string>): Promise<void> => {
    const abs = join(ctx.profile, dirName);
    const info = await lstat(abs).catch(() => undefined);
    if (info === undefined) return;
    let real = abs;
    if (info.isSymbolicLink()) {
      const resolved = await resolveItem(abs, ctx);
      if (!resolved.ok) {
        skipped.push({ path: dirName, reason: resolved.reason });
        return;
      }
      real = resolved.real;
    }
    if (!(await stat(real)).isDirectory()) return;
    for (const name of names) await visit(join(real, name), `${dirName}/${name}`, ancestors);
  };

  const top = new Set([ctx.profile]);
  for (const name of new Set([...ROOT_FILES, ...config.required.files])) await visit(join(ctx.profile, name), name, top);
  for (const name of DIRECTORIES) await visit(join(ctx.profile, name), name, top);
  // The lock that pins the Pi packages: only the two declaring files are carried, never node_modules.
  await visitNested(NPM_DIR, NPM_FILES, top);
  // The operator's mise declaration, at its fixed snapshot path. A profile that declares none has
  // nothing to carry: absence is only reported when the job actually needed it (required tools).
  if (ctx.mise !== undefined) {
    const mise = await resolveMise(ctx);
    if (mise.ok) included.push(mise.item);
    else if (config.required.tools.length === 0) skipped.push({ path: MISE_DECLARATION, reason: mise.reason });
  }
  return {
    included, skipped, blockers,
    excluded: settings?.excluded ?? [],
    ...(settings === undefined ? {} : { settingsText: settings.text }),
  };
}

// Writes the snapshot: real files only, the container's settings.json, and the modes of the sources.
// Recreated from scratch every time, so nothing stays from an earlier invocation.
export async function writeSnapshot(plan: SnapshotPlan, dir: string): Promise<void> {
  if (plan.blockers.length > 0) throw new Error(`perfil de runtime bloqueado: ${plan.blockers.join("; ")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const item of plan.included) {
    const target = join(dir, ...item.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (item.path === "settings.json" && plan.settingsText !== undefined) {
      await writeFile(target, plan.settingsText);
      await chmod(target, (await stat(item.source)).mode & 0o777);
    } else {
      await copyFile(item.source, target);
    }
  }
}

// What went in and what stayed out, for the detailed log of the invocation. Files of a directory item are
// counted (a skill, an extension) instead of listed one by one.
export function describePlan(plan: SnapshotPlan): string[] {
  const groups = new Map<string, string[]>();
  for (const item of plan.included) {
    const parts = item.path.split("/");
    const key = DIRECTORIES.includes(parts[0]!) && parts.length > 2 ? parts.slice(0, 2).join("/") : item.path;
    groups.set(key, [...(groups.get(key) ?? []), item.path]);
  }
  const lines = [...groups.entries()].map(([key, files]) =>
    files.length === 1 ? `incluído: ${files[0]}` : `incluído: ${key}/ (${files.length} arquivos)`);
  for (const item of plan.skipped) lines.push(`fora: ${item.path} — ${item.reason}`);
  for (const source of plan.excluded) lines.push(`pacote excluído do settings.json do container: ${source}`);
  return lines;
}
