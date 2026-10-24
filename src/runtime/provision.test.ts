import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { provisionAgentResources, type ProvisionOptions } from "../../docker/provision-agent.mjs";
import { declarationDigest, normalizeAgentResources } from "../../scripts/agent-resources.mjs";

/**
 * The build-time provisioning contract: resources are fetched at immutable
 * revisions, copied unchanged, installed at exact versions, recorded
 * in an inventory, and a failure leaves any previous destination untouched.
 *
 * The external boundaries are simulated here (a local git repository for the
 * skills source, a fake npm that writes the package tree); the real image
 * build exercises the real npm registry and the real upstream revision.
 */

interface Fixture {
  dir: string;
  repositoryRoot: string;
  declarationPath: string;
  dest: string;
  inventoryPath: string;
  revision: string;
  upstreamSkill: string;
  globalRoot: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeFixture(
  options: {
    skills?: boolean;
    extensionVersion?: string;
    skillName?: string;
    brokenReference?: boolean;
    omitDependency?: string;
  } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "msf-provision-fixture-"));
  const skillsRepo = join(dir, "upstream");
  const skillName = options.skillName ?? "implement";
  mkdirSync(join(skillsRepo, "skills/engineering", skillName), { recursive: true });
  writeFileSync(
    join(skillsRepo, "skills/engineering", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Fixture skill.\n---\n\n# Fixture\n\nSee \`references/notes.md\`.\n` +
      (options.brokenReference === true ? "\nSee [missing](references/missing.md).\n" : ""),
    "utf8",
  );
  mkdirSync(join(skillsRepo, "skills/engineering", skillName, "references"), { recursive: true });
  writeFileSync(join(skillsRepo, "skills/engineering", skillName, "references", "notes.md"), "upstream notes\n", "utf8");
  writeFileSync(join(skillsRepo, "LICENSE"), "MIT fixture license\n", "utf8");
  git(skillsRepo, "init", "--initial-branch", "main");
  git(skillsRepo, "config", "user.email", "fixture@msf.local");
  git(skillsRepo, "config", "user.name", "msf fixture");
  git(skillsRepo, "add", ".");
  git(skillsRepo, "commit", "-m", "fixture");
  const revision = git(skillsRepo, "rev-parse", "HEAD");

  const repositoryRoot = join(dir, "factory");
  mkdirSync(join(repositoryRoot, "agents"), { recursive: true });
  writeFileSync(
    join(repositoryRoot, "agents", "code-reviewer.md"),
    "---\nname: code-reviewer\ndescription: Fixture reviewer.\ntools: read\n---\n\nReview the diff.\n",
    "utf8",
  );

  const declaration = {
    schema: "msf-agent-resources/v1",
    pi: { package: "@earendil-works/pi-coding-agent", version: "1.3.0", license: "MIT" },
    skills: {
      repository: skillsRepo,
      revision: options.skills === false ? "f".repeat(40) : revision,
      license: "MIT (fixture LICENSE)",
      selected: [{ name: skillName, path: `skills/engineering/${skillName}`, role: "implement" }],
    },
    extensions: [
      {
        package: "pi-subagents",
        version: options.extensionVersion ?? "0.79.1",
        license: "MIT (fixture LICENSE)",
        entry: "index.js",
        guidance: { name: "pi-subagents", path: "skills/pi-subagents" },
      },
    ],
    agents: [{ name: "code-reviewer", path: "agents/code-reviewer.md", role: "standards" }],
  };
  const declarationPath = join(dir, "agent-resources.json");
  writeFileSync(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");

  // The installed global Pi the provisioner reads back (package, version and
  // declared license — the manifest is the license's source of truth).
  const globalRoot = join(dir, "global");
  const piDir = join(globalRoot, "@earendil-works/pi-coding-agent");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0", license: "MIT" }),
    "utf8",
  );

  return {
    dir,
    repositoryRoot,
    declarationPath,
    dest: join(dir, "agent"),
    inventoryPath: join(dir, "inventory.json"),
    revision,
    upstreamSkill: join(skillsRepo, "skills/engineering", skillName),
    globalRoot,
  };
}

/** The external-boundary simulation: real git on a local repository, a fake
 *  `pi --version`, and an npm that materialises the package tree. */
function fakeRun(install: {
  extensionVersion?: string;
  globalRoot: string;
  omitDependency?: string;
  manifestLicense?: string;
  licenseText?: string;
}) {
  return async (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<{ stdout: string; stderr: string }> => {
    if (command === "git") {
      return { stdout: execFileSync("git", args, { ...options, encoding: "utf8" }), stderr: "" };
    }
    if (command === "pi") return { stdout: "1.3.0\n", stderr: "" };
    if (command === "npm" && args[0] === "root") return { stdout: `${install.globalRoot}\n`, stderr: "" };
    if (command === "npm") {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const spec = args[args.length - 1]!;
      const version = install.extensionVersion ?? spec.slice(spec.lastIndexOf("@") + 1);
      const packageDir = join(prefix, "node_modules", "pi-subagents");
      mkdirSync(join(packageDir, "skills", "pi-subagents"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "pi-subagents",
          version,
          license: install.manifestLicense ?? "MIT",
          dependencies: { acorn: "^8.18.0" },
        }),
        "utf8",
      );
      writeFileSync(join(packageDir, "index.js"), "export default function () {}\n", "utf8");
      writeFileSync(
        join(packageDir, "LICENSE"),
        install.licenseText ?? "MIT fixture extension license\n",
        "utf8",
      );
      writeFileSync(
        join(packageDir, "skills", "pi-subagents", "SKILL.md"),
        "---\nname: pi-subagents\ndescription: Delegate.\n---\n\nDelegate with the subagent tool.\n",
        "utf8",
      );
      if (install.omitDependency !== "acorn") {
        mkdirSync(join(prefix, "node_modules", "acorn"), { recursive: true });
        writeFileSync(
          join(prefix, "node_modules", "acorn", "package.json"),
          JSON.stringify({ name: "acorn", version: "8.18.0" }),
          "utf8",
        );
      }
      return { stdout: "installed\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

function options(fixture: Fixture, extra: Partial<ProvisionOptions> = {}): ProvisionOptions {
  return {
    declarationPath: fixture.declarationPath,
    dest: fixture.dest,
    inventoryPath: fixture.inventoryPath,
    repositoryRoot: fixture.repositoryRoot,
    workDir: join(fixture.dir, "work"),
    run: fakeRun({ globalRoot: fixture.globalRoot }),
    ...extra,
  };
}

describe("agent-resource provisioning at image build time", () => {
  test("the declared skills, delegation guidance, licenses and reviewer agents land in the image with an inventory", async () => {
    const fixture = makeFixture();
    try {
      const inventory = await provisionAgentResources(options(fixture));

      // Upstream skill content is byte-identical, supporting files included.
      assert.equal(
        readFileSync(join(fixture.dest, "skills/implement/SKILL.md"), "utf8"),
        readFileSync(join(fixture.upstreamSkill, "SKILL.md"), "utf8"),
      );
      assert.equal(
        readFileSync(join(fixture.dest, "skills/implement/references/notes.md"), "utf8"),
        "upstream notes\n",
      );
      assert.equal(readFileSync(join(fixture.dest, "licenses/skills-LICENSE"), "utf8"), "MIT fixture license\n");
      assert.ok(existsSync(join(fixture.dest, "licenses/pi-subagents-LICENSE")));
      assert.match(readFileSync(join(fixture.dest, "ATTRIBUTION.md"), "utf8"), new RegExp(fixture.revision));
      assert.ok(existsSync(join(fixture.dest, "agents/code-reviewer.md")));
      assert.ok(existsSync(join(fixture.dest, "extensions/node_modules/pi-subagents/index.js")));
      assert.ok(existsSync(join(fixture.dest, "extensions/node_modules/pi-subagents/skills/pi-subagents/SKILL.md")));

      assert.equal(inventory.schema, "msf-agent-inventory/v1");
      assert.equal(inventory.pi.version, "1.3.0");
      // The inventory names the committed declaration and the digest of its
      // canonical form — the value the launching checkout recomputes.
      assert.equal(inventory.declaration.file, "agent-resources.yaml");
      assert.equal(
        inventory.declaration.sha256,
        declarationDigest(normalizeAgentResources(JSON.parse(readFileSync(fixture.declarationPath, "utf8")))),
      );
      assert.deepEqual(
        inventory.skills.map((skill) => [skill.name, skill.origin, skill.revision]),
        [
          ["implement", "git", fixture.revision],
          ["pi-subagents", "npm", "0.79.1"],
        ],
      );
      assert.equal(inventory.extensions[0]?.dependencies["acorn"], "8.18.0");
      assert.deepEqual(inventory.agents.map((agent) => agent.name), ["code-reviewer"]);
      assert.match(inventory.agents[0]?.path ?? "", /^agents\//);
      assert.deepEqual(JSON.parse(readFileSync(fixture.inventoryPath, "utf8")), inventory);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an invalid declaration fails the build and leaves a previous destination untouched", async () => {
    const fixture = makeFixture();
    try {
      mkdirSync(fixture.dest, { recursive: true });
      writeFileSync(join(fixture.dest, "previous.txt"), "previous image content\n", "utf8");
      const bad = JSON.parse(readFileSync(fixture.declarationPath, "utf8")) as { skills: { revision: string } };
      bad.skills.revision = "main";
      writeFileSync(fixture.declarationPath, JSON.stringify(bad), "utf8");

      await assert.rejects(provisionAgentResources(options(fixture)), /commit SHA/);
      assert.equal(readFileSync(join(fixture.dest, "previous.txt"), "utf8"), "previous image content\n");
      assert.ok(!existsSync(fixture.inventoryPath), "no inventory is recorded for a failed provisioning");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an unavailable revision fails without substituting another one", async () => {
    const fixture = makeFixture({ skills: false });
    try {
      mkdirSync(fixture.dest, { recursive: true });
      writeFileSync(join(fixture.dest, "previous.txt"), "previous image content\n", "utf8");

      await assert.rejects(provisionAgentResources(options(fixture)), /git .* failed/);
      assert.equal(readFileSync(join(fixture.dest, "previous.txt"), "utf8"), "previous image content\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a declared skill missing from the revision fails, never silently omitted", async () => {
    const fixture = makeFixture({ skillName: "implement" });
    try {
      mkdirSync(fixture.dest, { recursive: true });
      writeFileSync(join(fixture.dest, "previous.txt"), "previous image content\n", "utf8");
      const bad = JSON.parse(readFileSync(fixture.declarationPath, "utf8")) as {
        skills: { selected: Array<{ name: string; path: string; role: string }> };
      };
      bad.skills.selected = [{ name: "code-review", path: "skills/engineering/code-review", role: "review" }];
      writeFileSync(fixture.declarationPath, JSON.stringify(bad), "utf8");

      await assert.rejects(provisionAgentResources(options(fixture)), /selected skill "code-review" SKILL\.md is missing/);
      assert.equal(readFileSync(join(fixture.dest, "previous.txt"), "utf8"), "previous image content\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an extension whose installed manifest declares another license fails the build — the declaration is verified", async () => {
    const fixture = makeFixture();
    try {
      await assert.rejects(
        provisionAgentResources(
          options(fixture, { run: fakeRun({ globalRoot: fixture.globalRoot, manifestLicense: "Apache-2.0" }) }),
        ),
        /extension pi-subagents declares the license Apache-2\.0, declared MIT/,
      );
      assert.ok(!existsSync(fixture.dest), "nothing is swapped in");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a shipped LICENSE for which the upgrade changed the license fails the build — attribution is not copied blind", async () => {
    const fixture = makeFixture();
    try {
      await assert.rejects(
        provisionAgentResources(
          options(fixture, { run: fakeRun({ globalRoot: fixture.globalRoot, licenseText: "Apache License 2.0\n" }) }),
        ),
        /extension "pi-subagents" LICENSE does not name the declared license "MIT \(fixture LICENSE\)"/,
      );
      assert.ok(!existsSync(fixture.dest));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("the upstream skills LICENSE must name the declared license", async () => {
    const fixture = makeFixture();
    try {
      const bad = JSON.parse(readFileSync(fixture.declarationPath, "utf8")) as {
        skills: { license: string };
      };
      bad.skills.license = "Apache-2.0 (upstream LICENSE)";
      writeFileSync(fixture.declarationPath, JSON.stringify(bad), "utf8");

      await assert.rejects(
        provisionAgentResources(options(fixture)),
        /upstream skills LICENSE does not name the declared license "Apache-2\.0 \(upstream LICENSE\)"/,
      );
      assert.ok(!existsSync(fixture.dest));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an extension installed at the wrong version fails — no silent substitution", async () => {
    const fixture = makeFixture();
    try {
      await assert.rejects(
        provisionAgentResources(
          options(fixture, { run: fakeRun({ globalRoot: fixture.globalRoot, extensionVersion: "0.79.0" }) }),
        ),
        /installed as pi-subagents@0\.79\.0/,
      );
      assert.ok(!existsSync(fixture.dest), "nothing is swapped in");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("Pi installed at the wrong version fails before any resource is copied", async () => {
    const fixture = makeFixture();
    try {
      const badGlobal = join(fixture.dir, "global-bad");
      const badPi = join(badGlobal, "@earendil-works/pi-coding-agent");
      mkdirSync(badPi, { recursive: true });
      writeFileSync(
        join(badPi, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.9" }),
        "utf8",
      );
      await assert.rejects(
        provisionAgentResources(options(fixture, { run: fakeRun({ globalRoot: badGlobal }) })),
        /Pi is installed as @earendil-works\/pi-coding-agent@1\.2\.9, declared .*@1\.3\.0/,
      );
      assert.ok(!existsSync(fixture.dest));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a Pi license that changed under the declaration fails the build — attribution is verified, not assumed", async () => {
    const fixture = makeFixture();
    try {
      const badGlobal = join(fixture.dir, "global-license");
      const badPi = join(badGlobal, "@earendil-works/pi-coding-agent");
      mkdirSync(badPi, { recursive: true });
      writeFileSync(
        join(badPi, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0", license: "Apache-2.0" }),
        "utf8",
      );
      await assert.rejects(
        provisionAgentResources(options(fixture, { run: fakeRun({ globalRoot: badGlobal }) })),
        /installed Pi declares the license Apache-2\.0, declared MIT/,
      );
      assert.ok(!existsSync(fixture.dest));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a Pi that ships a LICENSE has it copied into the image's licenses/ under its package name", async () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.globalRoot, "@earendil-works/pi-coding-agent", "LICENSE"), "MIT pi license\n", "utf8");

      await provisionAgentResources(options(fixture));

      assert.equal(
        readFileSync(join(fixture.dest, "licenses", "@earendil-works-pi-coding-agent-LICENSE"), "utf8"),
        "MIT pi license\n",
      );
      assert.match(readFileSync(join(fixture.dest, "ATTRIBUTION.md"), "utf8"), /MIT \(LICENSE under licenses\/\)/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a declared dependency that did not install fails the build — the closure is validated, not just recorded", async () => {
    const fixture = makeFixture({ omitDependency: "acorn" });
    try {
      mkdirSync(fixture.dest, { recursive: true });
      writeFileSync(join(fixture.dest, "previous.txt"), "previous image content\n", "utf8");

      await assert.rejects(
        provisionAgentResources(
          options(fixture, { run: fakeRun({ globalRoot: fixture.globalRoot, omitDependency: "acorn" }) }),
        ),
        /missing declared dependency: acorn/,
      );
      assert.equal(readFileSync(join(fixture.dest, "previous.txt"), "utf8"), "previous image content\n");
      assert.ok(!existsSync(fixture.inventoryPath));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a required bundled reference missing from the revision fails the build", async () => {
    const fixture = makeFixture({ brokenReference: true });
    try {
      mkdirSync(fixture.dest, { recursive: true });
      writeFileSync(join(fixture.dest, "previous.txt"), "previous image content\n", "utf8");

      await assert.rejects(
        provisionAgentResources(options(fixture)),
        /references a missing file: SKILL\.md → references\/missing\.md/,
      );
      assert.equal(readFileSync(join(fixture.dest, "previous.txt"), "utf8"), "previous image content\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
