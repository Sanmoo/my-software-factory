import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";

import {
  AGENT_DECLARATION_FILE,
  declarationDigest,
  type AgentResourcesDeclaration,
} from "../../scripts/agent-resources.mjs";
import {
  AGENT_DECLARATION_PATH,
  AgentImageMismatchError,
  IMAGE_INVENTORY_PATH,
  loadAgentResources,
  verifyAgentInventory,
  type LoadedAgentResources,
} from "./inventory.js";

/**
 * The declaration the image must match. The launch reads the declaration of
 * the checkout and the inventory the image recorded, compares them by content
 * identity, and refuses a stale or hand-built image — never trusting the
 * mutable Docker tag.
 */

const FIXTURE_YAML = [
  "schema: msf-agent-resources/v1",
  "pi:",
  '  package: "@earendil-works/pi-coding-agent"',
  '  version: "1.0.0"',
  "  license: MIT",
  "skills:",
  "  repository: https://example.invalid/skills.git",
  '  revision: "0123456789abcdef0123456789abcdef01234567"',
  "  license: MIT",
  "  selected:",
  "    - name: implement",
  "      path: skills/implement",
  "      role: implement",
  "extensions:",
  "  - package: pi-subagents",
  '    version: "0.1.0"',
  "    license: MIT",
  "    entry: index.js",
  "    guidance:",
  "      name: pi-subagents",
  "      path: skills/pi-subagents",
  "agents:",
  "  - name: code-reviewer",
  "    path: agents/code-reviewer.md",
  "    role: standards",
  "",
].join("\n");

/** A temp declaration file holding the fixture, with `edits` applied to it. */
function fixtureFile(dir: string, edits: Array<[string, string]> = []): string {
  const path = join(dir, "agent-resources.yaml");
  writeFileSync(path, edits.reduce((text, [from, to]) => text.replace(from, to), FIXTURE_YAML), "utf8");
  return path;
}

/** The inventory a correctly provisioned image records for `loaded`. */
function matchingInventory(loaded: LoadedAgentResources): Record<string, unknown> {
  const declaration: AgentResourcesDeclaration = loaded.declaration;
  const extension = declaration.extensions[0]!;
  const guidancePath = `extensions/node_modules/${extension.package}/${extension.guidance.path}`;
  return {
    schema: "msf-agent-inventory/v1",
    declaration: { file: "agent-resources.yaml", sha256: loaded.digest },
    pi: declaration.pi,
    skills: [
      {
        name: "implement",
        origin: "git",
        upstreamPath: "skills/implement",
        revision: declaration.skills.revision,
        path: "skills/implement",
        digest: "sha256:x",
      },
      {
        name: extension.guidance.name,
        origin: "npm",
        upstreamPath: extension.guidance.path,
        revision: extension.version,
        path: guidancePath,
        digest: "sha256:x",
      },
    ],
    extensions: [
      {
        package: extension.package,
        version: extension.version,
        license: extension.license,
        path: `extensions/node_modules/${extension.package}`,
        entry: extension.entry,
        digest: "sha256:x",
        dependencies: { acorn: "8.18.0" },
        guidance: { name: extension.guidance.name, path: guidancePath, digest: "sha256:x" },
      },
    ],
    agents: [
      {
        name: "code-reviewer",
        source: "factory:agents/code-reviewer.md",
        path: "agents/code-reviewer.md",
        digest: "sha256:x",
      },
    ],
  };
}

describe("the factory's agent-resource declaration and image inventory", () => {
  test("the committed declaration is valid, with exact versions and an immutable skill revision", () => {
    const loaded = loadAgentResources();

    assert.match(loaded.declaration.pi.version, /^\d+\.\d+\.\d+$/);
    assert.match(loaded.declaration.extensions[0]!.version, /^\d+\.\d+\.\d+$/);
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
    assert.match(loaded.digest, /^[0-9a-f]{64}$/);
    assert.equal(basename(AGENT_DECLARATION_PATH), AGENT_DECLARATION_FILE, "the file name has one home");
    assert.equal(IMAGE_INVENTORY_PATH, "/opt/msf/agent-inventory.json");
  });

  test("the declaration's identity is its effective set, not its bytes: reformatting keeps the digest, a content change does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    try {
      const plain = loadAgentResources(fixtureFile(dir));
      const reformatted = loadAgentResources(
        fixtureFile(dir, [
          [
            "pi:\n  package: \"@earendil-works/pi-coding-agent\"\n  version: \"1.0.0\"\n  license: MIT\n",
            "# a comment the parser ignores\npi:\n  license: \"MIT\"\n  version: '1.0.0'\n  package: \"@earendil-works/pi-coding-agent\"\n",
          ],
        ]),
      );

      assert.equal(reformatted.digest, plain.digest, "comments, quoting and key order are not the identity");
      assert.equal(reformatted.digest, declarationDigest(reformatted.declaration));

      const changed = loadAgentResources(fixtureFile(dir, [['version: "1.0.0"', 'version: "1.0.1"']]));
      assert.notEqual(changed.digest, plain.digest, "a different set is a different declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declaration typo is rejected instead of silently changing the effective set", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    try {
      const path = fixtureFile(dir, [["      role: implement", "      role: implement\n      typo: true"]]);

      assert.throws(() => loadAgentResources(path), (error: unknown) => {
        assert.ok(error instanceof AgentImageMismatchError);
        assert.match(error.message, /unknown key/);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mutable skill reference is rejected: only a 40-hex commit is immutable", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    try {
      const path = fixtureFile(dir, [['revision: "0123456789abcdef0123456789abcdef01234567"', "revision: main"]]);
      assert.throws(() => loadAgentResources(path), /commit SHA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unparseable declaration fails with the file named, never a silent default", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-declaration-"));
    try {
      const path = join(dir, "agent-resources.yaml");
      writeFileSync(path, "pi: [unclosed\n", "utf8");
      assert.throws(() => loadAgentResources(path), /agent-resources\.yaml is not valid YAML/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the image inventory matching the declaration is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    try {
      const loaded = loadAgentResources(fixtureFile(dir));

      const inventory = verifyAgentInventory(loaded, JSON.stringify(matchingInventory(loaded)));

      assert.equal(inventory.pi.version, "1.0.0");
      assert.deepEqual(inventory.extensions[0]?.dependencies, { acorn: "8.18.0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale image is refused: different declaration, Pi version, skill revision or undeclared extra", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    try {
      const loaded = loadAgentResources(fixtureFile(dir));
      const stale = structuredClone(matchingInventory(loaded)) as {
        declaration: { sha256: string };
        pi: { version: string };
        skills: Array<Record<string, unknown>>;
      };
      stale.declaration.sha256 = "0".repeat(64);
      stale.pi.version = "0.9.0";
      stale.skills[0]!.revision = "f".repeat(40);
      stale.skills.push({
        name: "evil",
        origin: "git",
        upstreamPath: "skills/evil",
        revision: "e".repeat(40),
        path: "skills/evil",
        digest: "sha256:x",
      });

      assert.throws(() => verifyAgentInventory(loaded, JSON.stringify(stale)), (error: unknown) => {
        assert.ok(error instanceof AgentImageMismatchError);
        assert.match(error.message, /different agent-resources\.yaml/);
        assert.match(error.message, /Pi is .*0\.9\.0/);
        assert.match(error.message, /skill "implement" is/);
        assert.match(error.message, /skill "evil" is in the image but not declared/);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declaration whose effective set changed is refused even when the versions match", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    try {
      // The image was built from the fixture; the checkout declares one more
      // agent. Same Pi, same skills — only the declared set differs.
      const built = loadAgentResources(fixtureFile(dir));
      const edited = loadAgentResources(
        fixtureFile(dir, [
          [
            "  - name: code-reviewer",
            "  - name: spec-reviewer\n    path: agents/spec-reviewer.md\n    role: spec\n  - name: code-reviewer",
          ],
        ]),
      );

      assert.throws(() => verifyAgentInventory(edited, JSON.stringify(matchingInventory(built))), (error: unknown) => {
        assert.ok(error instanceof AgentImageMismatchError);
        assert.match(error.message, /different agent-resources\.yaml/);
        assert.match(error.message, /reviewer agent "spec-reviewer" is missing from the image/);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an image that put a declared resource somewhere else is refused — the launch loads the declared path", () => {
    const dir = mkdtempSync(join(tmpdir(), "msf-inventory-"));
    try {
      const loaded = loadAgentResources(fixtureFile(dir));
      const misplaced = structuredClone(matchingInventory(loaded)) as {
        skills: Array<{ path: string }>;
        extensions: Array<{ path: string }>;
      };
      misplaced.skills[0]!.path = "skills/elsewhere";
      misplaced.extensions[0]!.path = "extensions/node_modules/other";

      assert.throws(() => verifyAgentInventory(loaded, JSON.stringify(misplaced)), (error: unknown) => {
        assert.ok(error instanceof AgentImageMismatchError);
        assert.match(error.message, /skill "implement" is at skills\/elsewhere in the image, declared at skills\/implement/);
        assert.match(
          error.message,
          /extension "pi-subagents" is at extensions\/node_modules\/other in the image, declared at extensions\/node_modules\/pi-subagents/,
        );
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an image without a readable inventory is refused with the rebuild command", () => {
    const loaded = loadAgentResources();
    assert.throws(() => verifyAgentInventory(loaded, ""), /rebuild it with npm run build:image/i);
  });

  test("the declaration file is the committed one, not a Docker tag", () => {
    const text = readFileSync(AGENT_DECLARATION_PATH, "utf8");
    assert.match(text, /revision: "[0-9a-f]{40}"/);
  });
});
