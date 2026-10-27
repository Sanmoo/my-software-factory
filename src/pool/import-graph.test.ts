import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { posixPath, relativeSpecifiers } from "../runtime/image-staging.js";

/**
 * The pool's side of the Work record contract: the ledgers read
 * and write the record through its owner (`src/work-record/`), never through
 * the state derivation or the runtime compatibility re-exports that closed the
 * model-provider ↔ recovery ↔ outcome cycle. This scan names the forbidden
 * edges, so re-introducing one fails here instead of only in a human review.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Production sources only: tests may cross the compatibility seams to seed fixtures. */
function productionSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) sources.push(path);
    }
  };
  walk(SRC);
  return sources.map((path) => posixPath(relative(SRC, path)));
}

/** The source's imports, comments removed: an import inside a comment is never
 *  an edge of the graph. */
function importedSpecifiers(source: string): string[] {
  return relativeSpecifiers(source.replace(/\/\*[\s\S]*?\*\//g, ""));
}

function graphOf(files: readonly string[]): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets = importedSpecifiers(readFileSync(join(SRC, file), "utf8"))
      .map((specifier) => posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/, ".ts"))
      .filter((target) => known.has(target));
    graph.set(file, targets);
  }
  return graph;
}

/** The first import cycle among `scope`, as the path that closes it; null when acyclic. */
function findCycle(graph: ReadonlyMap<string, string[]>, scope: readonly string[]): string[] | null {
  const inScope = new Set(scope);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!inScope.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    path.pop();
    return null;
  };

  for (const node of scope) {
    const cycle = visit(node);
    if (cycle !== null) return cycle;
  }
  return null;
}

describe("the pool's source import graph — one Work record owner, no ledger cycle ", () => {
  const files = productionSources();
  const graph = graphOf(files);
  const imports = (from: string, to: string): boolean => graph.get(from)?.includes(to) ?? false;

  test("the recovery and model-provider decisions do not import each other", () => {
    assert.equal(
      imports("pool/model-provider.ts", "pool/recovery.ts"),
      false,
      "pool/model-provider.ts → pool/recovery.ts: the model-provider decision must not depend on the recovery decision",
    );
    assert.equal(
      imports("pool/recovery.ts", "pool/model-provider.ts"),
      false,
      "pool/recovery.ts → pool/model-provider.ts: the recovery decision must not depend on the model-provider decision",
    );
  });

  test("the ledgers never import the state derivation", () => {
    for (const from of ["pool/recovery.ts", "pool/model-provider.ts"]) {
      for (const to of graph.get(from) ?? []) {
        assert.equal(
          to.startsWith("state/"),
          false,
          `${from} → ${to}: the ledgers read record facts through work-record/, never through state/`,
        );
      }
    }
  });

  test("no pool module reads a record part through the state or runtime compatibility re-exports", () => {
    const recordSeams = new Set([
      "state/evidence.ts",
      "runtime/continuity-artifacts.ts",
      "runtime/attempt-logs.ts",
      "runtime/session-log.ts",
    ]);
    for (const from of files.filter((file) => file.startsWith("pool/"))) {
      for (const to of graph.get(from) ?? []) {
        assert.equal(recordSeams.has(to), false, `${from} → ${to}: the record part is owned by work-record/`);
      }
    }
  });

  test("the registry takes only the fall ruler's policy from state/outcome", () => {
    const source = readFileSync(join(SRC, "pool/registry.ts"), "utf8");
    const statement = /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/state\/outcome\.js["']/.exec(source);
    assert.ok(statement, "pool/registry.ts no longer imports state/outcome — update this pin if the fall ruler moved");
    const names = statement[1]!
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name !== "");
    assert.deepEqual(
      names,
      ["isRecordedFailure"],
      "pool/registry.ts → state/outcome.ts: only the fall ruler's isRecordedFailure may cross; every record fact comes from work-record/outcome",
    );
  });

  test("the record's readers and its parts have no import cycle", () => {
    const cycle = findCycle(graph, [
      "pool/model-provider.ts",
      "pool/recovery.ts",
      "pool/registry.ts",
      "state/outcome.ts",
      "work-record/outcome.ts",
      "work-record/recovery.ts",
      "work-record/model-provider.ts",
      "work-record/record.ts",
    ]);
    assert.equal(cycle, null, cycle === null ? "" : `import cycle: ${cycle.join(" → ")}`);
  });
});
