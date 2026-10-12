#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const ignoredDirectories = new Set(["node_modules", ".worktrees", ".smoke", ".pilot", "docs"]);
const directiveStart = /^(eslint-(?:disable|enable)\b|oxlint-(?:disable|enable)\b)(.*)$/i;
const allowedDirective = /^oxlint-disable-(?:line|next-line)\s+([a-z0-9-]+\/[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+\/[a-z0-9-]+)*)\s+--\s+(\S[\s\S]*)$/;

async function typescriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await typescriptFiles(path.join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

function directivesIn(comment) {
  return comment.value.split(/\r?\n/).flatMap((text, lineDelta) => {
    const candidate = text.replace(/^\s*\*?\s*/, "");
    const match = candidate.match(directiveStart);
    if (!match) return [];
    return [{ directive: match[1], tail: match[2], lineDelta }];
  });
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) throw new Error("usage: lint-suppressions.mjs <directory> [...]");
  let violations = 0;
  const files = [];

  for (const root of roots) {
    files.push(...await typescriptFiles(root));
  }
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const parsed = parseSync(file, source, { sourceType: "module" });
    if (parsed.errors.length > 0) {
      const error = parsed.errors[0];
      throw new Error(`Cannot validate suppression comments in ${file}: ${error.message}`);
    }
    for (const comment of parsed.comments) {
      for (const found of directivesIn(comment)) {
        const line = lineAt(source, comment.start) + found.lineDelta;
        if (!found.directive.toLowerCase().startsWith("oxlint-")) {
          console.error(`${file}:${line}: ESLint suppression aliases are not allowed; use a justified Oxlint line directive`);
          violations += 1;
          continue;
        }
        const match = `${found.directive}${found.tail}`.match(allowedDirective);
        if (!match || match[1].split(",").some((rule) => rule.trim() === "all")) {
          console.error(`${file}:${line}: invalid suppression; use oxlint-disable-line or oxlint-disable-next-line with specific rule name(s) and -- reason`);
          violations += 1;
        }
      }
    }
  }

  if (violations > 0) {
    process.exitCode = 1;
    return;
  }

  const oxlint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/oxlint/bin/oxlint");
  const result = spawnSync(process.execPath, [oxlint, ...roots], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
