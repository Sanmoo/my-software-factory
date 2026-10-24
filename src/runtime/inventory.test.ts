import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  AGENT_DECLARATION_PATH,
  AgentImageMismatchError,
  IMAGE_INVENTORY_PATH,
  loadAgentResources,
  verifyAgentInventory,
} from "./inventory.js";

/**
 * The declaration the image must match (issue #159). The launch reads the
 * declaration in the checkout and the inventory the image recorded, compares
 * them by identity, and refuses a stale/hand-built image — never trusting the
 * mutable Docker tag.
 */

function fixtureDeclaration(): Record<string, unknown> {
  return {
    schema: "msf-agent-resources/v1",
    pi: { package: "@earendil-works/pi-coding-agent", version: "1.3.0", license: "MIT" },
    skills: {
      repository: "https://example.invalid/skills.git",
      revision: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      selected: [{ name: "implement", path: "skills/implement", role: "implement" }],
    },
    extensions: [
      {
        package: "pi-subagents",
        version: "0.79.1",
        license: "MIT",
        entry: "index.js",
        guidance: { name: "pi-subagents", path: "skills/pi-subagents" },
      },
    ],
    agents: [{ name: "code-reviewer", path: "agents/code-reviewer.md", role: "standards" }],
  };
}

function matchingInventory(declarationPath: string, declaration: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "msf-agent-inventory/v1",
    declaration: {
      file: "agent-resources.json",
      sha256: loadAgentResources(declarationPath).sha256,
    },
    pi: (declaration as { pi: unknown }).pi,
    skills: [
      {
        name: "implement",
        origin: "git",
        upstreamPath: "skills/implement",
        revision: (declaration as { skills: { revision: string } }).skills.revision,
        path: "skills/implement",
        digest: "sha256:x",
      },
      {
        name: "pi-subagents",
        origin: "npm",
        upstreamPath: "skills/pi-subagents",
        revision: "0.79.1",
        path: "extensions/node_modules/pi-subagents/skills/pi-subagents",
        digest: "sha256:x",
      },
    ],
    extensions: [
      {
        package: "pi-subagents",
        version: "0.79.1",
        license: "MIT",
        path: "extensions/node_modules/pi-subagents",
        entry: "index.js",
        digest: "sha256:x",
        dependencies: { acorn: "8.18.0" },
        guidance: { name: "pi-subagents", path: "extensions/node_modules/pi-subagents/skills/pi-subagents", digest: "sha256:x" },
      },
    ],
    agents: [{ name: "code-reviewer", source: "factory:agents/code-reviewer.md", path: "agents/code-reviewer.md", digest: "sha256:x" }],
  };
}

describe("the factory's agent-resource declaration and image inventory", () => {
  let dir: string;

  test("the committed declaration is valid, with exact versions and an immutable skill revision", () => {
    const loaded = loadAgentResources();

    assert.equal(loaded.declaration.pi.version, "1.3.0");
    assert.match(loaded.declaration.skills.revision, /^[0-9a-f]{40}$/);
    assert.deepEqual(
      loaded.declaration.skills.selected.map((skill) => skill.name),
      ["implement", "tdd", "code-review", "pr", "codebase-design"],
    );
    assert.equal(loaded.declaration.extensions[0]?.package, "pi-subagents");
    assert.deepEqual(
      loaded.declaration.agents.map((agent) => agent.name),
      ["code-reviewer", "spec-reviewer"],
    );
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
    assert.equal(AGENT_DECLARATION_PATH, new URL("../../agent-resources.json", import.meta.url).pathname);
    assert.equal(IMAGE_INVENTORY_PATH, "/opt/msf/agent-inventory.json");
  });

  test("a declaration typo is rejected instead of silently changing the effective set", () => {
    dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    const path = join(dir, "agent-resources.json");
    const bad = fixtureDeclaration();
    (bad as { skills: Record<string, unknown> }).skills.selected = [
      { name: "implement", path: "skills/implement", role: "implement", typo: true },
    ];
    writeFileSync(path, JSON.stringify(bad), "utf8");

    assert.throws(() => loadAgentResources(path), (error: unknown) => {
      assert.ok(error instanceof AgentImageMismatchError);
      assert.match(error.message, /unknown key/);
      return true;
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a mutable skill reference is rejected: only a 40-hex commit is immutable", () => {
    dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    const path = join(dir, "agent-resources.json");
    const bad = fixtureDeclaration();
    (bad as { skills: Record<string, unknown> }).skills.revision = "main";
    writeFileSync(path, JSON.stringify(bad), "utf8");

    assert.throws(() => loadAgentResources(path), /commit SHA/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the image inventory matching the declaration is accepted", () => {
    dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    const path = join(dir, "agent-resources.json");
    const declaration = fixtureDeclaration();
    writeFileSync(path, JSON.stringify(declaration), "utf8");
    const loaded = loadAgentResources(path);

    const inventory = verifyAgentInventory(loaded, JSON.stringify(matchingInventory(path, declaration)));

    assert.equal(inventory.pi.version, "1.3.0");
    assert.deepEqual(inventory.extensions[0]?.dependencies, { acorn: "8.18.0" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stale image is refused: different declaration, Pi version, skill revision or undeclared extra", () => {
    dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    const path = join(dir, "agent-resources.json");
    const declaration = fixtureDeclaration();
    writeFileSync(path, JSON.stringify(declaration), "utf8");
    const loaded = loadAgentResources(path);

    const stale = matchingInventory(path, declaration);
    (stale as { declaration: { sha256: string } }).declaration.sha256 = "0".repeat(64);
    (stale as { pi: { version: string } }).pi.version = "1.2.0";
    (stale as { skills: Array<{ revision: string }> }).skills[0]!.revision = "f".repeat(40);
    (stale as { skills: Array<Record<string, unknown>> }).skills.push({
      name: "evil",
      origin: "git",
      upstreamPath: "skills/evil",
      revision: "e".repeat(40),
      path: "skills/evil",
      digest: "sha256:x",
    });

    assert.throws(() => verifyAgentInventory(loaded, JSON.stringify(stale)), (error: unknown) => {
      assert.ok(error instanceof AgentImageMismatchError);
      assert.match(error.message, /different agent-resources\.json/);
      assert.match(error.message, /Pi is .*1\.2\.0/);
      assert.match(error.message, /skill "implement" is/);
      assert.match(error.message, /skill "evil" is in the image but not declared/);
      return true;
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("an image that put a declared resource somewhere else is refused — the launch loads the declared path", () => {
    dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    const path = join(dir, "agent-resources.json");
    const declaration = fixtureDeclaration();
    writeFileSync(path, JSON.stringify(declaration), "utf8");
    const loaded = loadAgentResources(path);

    const misplaced = matchingInventory(path, declaration);
    (misplaced as { skills: Array<{ path: string }> }).skills[0]!.path = "skills/elsewhere";
    (misplaced as { extensions: Array<{ path: string }> }).extensions[0]!.path = "extensions/node_modules/other";

    assert.throws(() => verifyAgentInventory(loaded, JSON.stringify(misplaced)), (error: unknown) => {
      assert.ok(error instanceof AgentImageMismatchError);
      assert.match(error.message, /skill "implement" is at skills\/elsewhere in the image, declared at skills\/implement/);
      assert.match(
        error.message,
        /extension "pi-subagents" is at extensions\/node_modules\/other in the image, declared at extensions\/node_modules\/pi-subagents/,
      );
      return true;
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("an image without a readable inventory is refused with the rebuild command", () => {
    const loaded = loadAgentResources();
    assert.throws(() => verifyAgentInventory(loaded, ""), /rebuild it with npm run build:image/i);
  });

  test("the declaration file is the committed one, not a Docker tag", () => {
    const text = readFileSync(AGENT_DECLARATION_PATH, "utf8");
    assert.match(text, /"revision": "[0-9a-f]{40}"/);
  });
});
