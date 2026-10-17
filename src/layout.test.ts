import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, WORKSPACE_SUBPATHS } from "./layout.js";

describe("layout", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-layout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("guarantees the workspace and its PT-BR derived subpaths", () => {
    const layout = ensureWorkspace(root);

    assert.equal(layout.root, root);
    for (const sub of Object.values(WORKSPACE_SUBPATHS)) {
      const path = join(root, sub);
      assert.ok(existsSync(path), `${sub}/ must exist`);
      assert.ok(statSync(path).isDirectory(), `${sub}/ must be a directory`);
    }
    assert.equal(layout.repos, join(root, "repos"));
    assert.equal(layout.works, join(root, "trabalhos"));
    assert.equal(layout.archive, join(root, "arquivo"));
  });

  test("is idempotent — an existing workspace is never an error", () => {
    ensureWorkspace(root);
    const layout = ensureWorkspace(root);

    assert.equal(layout.repos, join(root, "repos"));
  });

  test("creates nested parents that do not exist yet", () => {
    const nested = join(root, "a", "b", "ws");
    const layout = ensureWorkspace(nested);
    assert.ok(existsSync(join(nested, "trabalhos")));
  });
});
