import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { GUARDRAIL_CONTAINER_FILE, GUARDRAIL_CONTAINER_MODULES } from "./sandcastle.js";
import {
  COMPILED_ROOT,
  GUARDRAIL_ENTRY_MODULE,
  guardrailContainerModules,
  relativeImportClosure,
} from "./image-staging.js";
import { IMAGE_ROOT } from "../layout.js";

/**
 * The image-side half of the continuity guardrail: the staging
 * build provisions the extension's relative-import closure, and the launch
 * preflight requires those exact modules inside the image. The closure is a
 * fact of the compiled tree, never a hand list that drifts from it.
 */

describe("the guardrail's image closure ", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "msf-guardrail-closure-"));
    for (const [path, source] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source, "utf8");
    }
    return root;
  }

  test("the closure follows relative imports from the entry — a literal dynamic one included — and nothing else", () => {
    const dist = tree({
      "runtime/guardrail/extension.js":
        'import { guard } from "./delegation.js";\nimport "../effects.js";\nexport default () => import("./lazy.js");\n',
      "runtime/guardrail/delegation.js": 'export * from "../json-line.js";\n',
      "runtime/guardrail/lazy.js": "export {};\n",
      "runtime/json-line.js": "export {};\n",
      "runtime/effects.js": "export {};\n",
      "runtime/unrelated.js": "export {};\n",
    });

    assert.deepEqual(relativeImportClosure(dist, ["runtime/guardrail/extension.js"]), {
      modules: [
        "runtime/guardrail/extension.js",
        "runtime/guardrail/delegation.js",
        "runtime/effects.js",
        "runtime/guardrail/lazy.js",
        "runtime/json-line.js",
      ],
      missing: [],
    });
  });

  test("a relative import the tree cannot resolve is reported by its exact module name", () => {
    const dist = tree({
      "runtime/guardrail/extension.js": 'export * from "./delegation.js";\nexport * from "../../work-record/continuity.js";\n',
      "runtime/guardrail/delegation.js": "export {};\n",
    });

    assert.deepEqual(relativeImportClosure(dist, ["runtime/guardrail/extension.js"]), {
      modules: ["runtime/guardrail/extension.js", "runtime/guardrail/delegation.js"],
      missing: [{ from: "runtime/guardrail/extension.js", module: "work-record/continuity.js" }],
    });
  });

  test("an entry the tree lacks is reported too, never silently an empty closure", () => {
    const dist = tree({ "runtime/unrelated.js": "export {};\n" });

    assert.deepEqual(relativeImportClosure(dist, ["runtime/guardrail/extension.js"]), {
      modules: [],
      missing: [{ from: ".", module: "runtime/guardrail/extension.js" }],
    });
    assert.throws(() => guardrailContainerModules(dist), /missing runtime\/guardrail\/extension\.js \(the entry\)/);
  });

  test("the launch preflight requires exactly what the built guardrail loads — the Work record parts in, the compatibility re-exports out", () => {
    const closure = relativeImportClosure(COMPILED_ROOT, [GUARDRAIL_ENTRY_MODULE]);

    assert.deepEqual(closure.missing, [], "the built tree carries every module the extension imports");
    assert.deepEqual(
      GUARDRAIL_CONTAINER_MODULES,
      closure.modules.map((module) => `${IMAGE_ROOT}/${module}`),
    );
    assert.equal(GUARDRAIL_CONTAINER_FILE, `${IMAGE_ROOT}/${GUARDRAIL_ENTRY_MODULE}`);
    assert.ok(
      GUARDRAIL_CONTAINER_MODULES.includes(`${IMAGE_ROOT}/work-record/continuity.js`),
      "the in-container guardrail reads the Work record through its own module",
    );
    for (const reexport of ["runtime/continuity-artifacts.js", "runtime/session-log.js", "runtime/attempt-logs.js"]) {
      assert.ok(
        !GUARDRAIL_CONTAINER_MODULES.includes(`${IMAGE_ROOT}/${reexport}`),
        `${reexport} is a compatibility re-export and is not part of the guardrail`,
      );
    }
  });
});
