import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { IMAGE_ROOT } from "../layout.js";

/**
 * What the worker image must carry of the factory-owned code the worker runs.
 * A tool's compiled entry and every module it loads through a relative import
 * are one closure: the image provisions exactly it, and the launch preflight
 * requires exactly it inside the image. A module the tool imports cannot be
 * missing from the image, and a dissolved compatibility re-export cannot be
 * staged as dead weight.
 */

/** The compiled guardrail entry, relative to `dist/` and to the image's /opt/msf. */
export const GUARDRAIL_ENTRY_MODULE = "runtime/guardrail/extension.js";

/** `dist/` of the running build: this module lives at dist/runtime/. */
export const COMPILED_ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface MissingModule {
  /** The module that names the import, or "." for an entry the tree lacks. */
  from: string;
  /** The root-relative module the relative import resolves to. */
  module: string;
}

export interface ModuleImportClosure {
  /** Every module reachable from the entries, entry first then discovery order. */
  modules: string[];
  /** Relative imports that resolve to no module; named so the build can fail by name. */
  missing: MissingModule[];
}

/**
 * Follow the STATIC relative imports of `entryModules` under `rootDir` — the
 * same specifiers Node resolves when the extension loads — including literal
 * dynamic imports. A target the tree lacks is reported, never dropped: the
 * image would otherwise refuse the extension at session start, when the
 * preflight can only see the files that ARE there.
 */
export function relativeImportClosure(rootDir: string, entryModules: readonly string[]): ModuleImportClosure {
  const root = resolve(rootDir);
  const modules: string[] = [];
  const missing: MissingModule[] = [];
  const seen = new Set<string>();
  const queue = entryModules.map(posixPath);
  while (queue.length > 0) {
    const module = queue.shift()!;
    if (seen.has(module)) continue;
    seen.add(module);
    const absolute = resolve(root, module);
    if (!existsSync(absolute)) {
      missing.push({ from: ".", module });
      continue;
    }
    modules.push(module);
    for (const specifier of relativeSpecifiers(readFileSync(absolute, "utf8"))) {
      const target = resolve(dirname(absolute), specifier);
      if (!existsSync(target)) {
        missing.push({ from: module, module: posixPath(relative(root, target)) });
        continue;
      }
      queue.push(posixPath(relative(root, target)));
    }
  }
  return { modules, missing };
}

/** The `/opt/msf/...` files the image must hold for the built guardrail. Throws
 *  when the compiled tree is incomplete: a launch cannot be guarded by it. */
export function guardrailContainerModules(rootDir: string = COMPILED_ROOT): string[] {
  return containerModules(GUARDRAIL_ENTRY_MODULE, rootDir);
}

/** The `/opt/msf/...` files the image must hold for one factory-owned tool: its
 *  compiled entry and every module its relative imports load. Throws when the
 *  compiled tree is incomplete — the image would otherwise fail at the tool
 *  call, when the launch can only see the files that ARE there. */
export function containerModules(entryModule: string, rootDir: string = COMPILED_ROOT): string[] {
  const closure = relativeImportClosure(rootDir, [entryModule]);
  if (closure.missing.length > 0) {
    const details = closure.missing
      .map((entry) => `${entry.module}${entry.from === "." ? " (the entry)" : ` (imported by ${entry.from})`}`)
      .join(", ");
    throw new Error(`the compiled image tool ${entryModule} is incomplete — missing ${details}; run npm run build`);
  }
  return closure.modules.map((module) => `${IMAGE_ROOT}/${module}`);
}

export function posixPath(path: string): string {
  return path.split(sep).join("/");
}

/** The relative specifiers a source imports or re-exports, static and dynamic:
 *  `from "./x.js"`, `import "./x.js"` and `import("./x.js")`. One scanner serves
 *  the image closure and the source import-graph pin, so the two cannot read
 *  the same tree differently. */
export function relativeSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+["'](\.\.?\/[^"']+)["']/g,
    /^\s*import\s+["'](\.\.?\/[^"']+)["']/gm,
    /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}
