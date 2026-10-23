import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";

import { WORKER_IMAGE } from "../worker-image.js";
import { IMAGE_INVENTORY_PATH, loadAgentResources, verifyAgentInventory } from "../runtime/inventory.js";
import { agentGuidancePath, workerFlagArgs } from "../runtime/sandcastle.js";

/**
 * The provisioned environment's actual behaviour (issue #159). Arguments
 * alone do not prove loading: these tests start the real image, point Pi at a
 * target project carrying UNDECLARED skills and reviewer agents, start with an
 * empty HOME and no personal profile, and read what Pi actually loaded from a
 * probe extension. Docker and the built image are mandatory in the gateway
 * (MSF_REQUIRE_DOCKER); a missing prerequisite fails there, never skips.
 */

const RESOURCES = loadAgentResources();

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function missingDockerReason(): string | undefined {
  try {
    docker(["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    return "docker is not reachable — the provisioned image cannot be exercised";
  }
  try {
    docker(["image", "inspect", WORKER_IMAGE]);
  } catch {
    return `the worker image ${WORKER_IMAGE} is not built here (npm run build:image)`;
  }
  return undefined;
}

const skipReason = missingDockerReason();
if (skipReason !== undefined && process.env.MSF_REQUIRE_DOCKER === "1") {
  throw new Error(`the quality gateway requires the provisioned-image check, but ${skipReason}`);
}

const PROBE_EXTENSION = [
  'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  'import { writeFileSync } from "node:fs";',
  "export default function (api: ExtensionAPI) {",
  '  api.on("session_start", () => {',
  '    const commands = api.getCommands().map((c) => c.name).filter((name) => name.startsWith("skill:")).sort();',
  "    const tools = api.getAllTools().map((tool) => tool.name).sort();",
  '    writeFileSync("/tmp/msf-probe/loaded.json", JSON.stringify({ commands, tools }));',
  "  });",
  "}",
].join("\n");

/** The production launch flags, plus the probe extension (the only extra). */
function piCommand(): string {
  return [
    "pi",
    "-p",
    "--mode",
    "text",
    "--model",
    "openai/gpt-4o",
    ...workerFlagArgs(RESOURCES),
    "--extension",
    "/tmp/msf-probe/extension.ts",
    '"hello"',
  ].join(" ");
}

function behaviourScript(): string {
  const guidance = `${agentGuidancePath(RESOURCES.declaration.extensions[0]!)}/SKILL.md`;
  return [
    "set -e",
    "mkdir -p /tmp/msf-probe /tmp/msf-project /tmp/msf-home",
    "mkdir -p /tmp/msf-project/.pi/skills/undeclared-skill /tmp/msf-project/.agents/skills/undeclared-legacy",
    'printf -- "---\\nname: undeclared-skill\\ndescription: must not load\\n---\\n" > /tmp/msf-project/.pi/skills/undeclared-skill/SKILL.md',
    'printf -- "---\\nname: undeclared-legacy\\ndescription: must not load\\n---\\n" > /tmp/msf-project/.agents/skills/undeclared-legacy/SKILL.md',
    `cat > /tmp/msf-probe/extension.ts <<'PROBE_EOF'\n${PROBE_EXTENSION}\nPROBE_EOF`,
    "cd /tmp/msf-project",
    "set +e",
    `HOME=/tmp/msf-home PI_CODING_AGENT_DIR=/home/agent/.pi/agent ${piCommand()} >/tmp/msf-probe/stdout 2>/tmp/msf-probe/stderr`,
    "set -e",
    'if [ ! -f /tmp/msf-probe/loaded.json ]; then',
    '  echo "LOADED=missing"',
    '  echo "IMAGE_DOES_NOT_CARRY_THE_DECLARED_RESOURCES — rebuild with npm run build:image" >&2',
    "else",
    '  echo "LOADED=$(cat /tmp/msf-probe/loaded.json)"',
    "fi",
    'if [ -e /home/agent/.pi/agent/npm ]; then echo "CACHE=present"; else echo "CACHE=absent"; fi',
    'echo "SKILLS=$(ls /home/agent/.pi/agent/skills | sort | tr \'\\n\' \',\')"',
    `test -f ${guidance} && echo "GUIDANCE=present"`,
    'if grep -qi "npm install\\|installing" /tmp/msf-probe/stderr; then echo "INSTALL=yes"; else echo "INSTALL=no"; fi',
  ].join("\n");
}

function line(output: string, prefix: string): string {
  const found = output.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert.ok(found, `missing ${prefix} in:\n${output}`);
  return found.slice(prefix.length);
}

describe("the provisioned worker image — what Pi actually loads", { skip: skipReason }, () => {
  test("only the declared skills, guidance and reviewer tools load — no host profile, no project discovery", { timeout: 120_000 }, () => {
    const output = docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", WORKER_IMAGE, "-c", behaviourScript()]);

    const loadedLine = line(output, "LOADED=");
    assert.notEqual(loadedLine, "missing", "the image does not carry the declared resources; rebuild with npm run build:image");
    const loaded = JSON.parse(loadedLine) as { commands: string[]; tools: string[] };
    const expectedSkills = [
      ...RESOURCES.declaration.skills.selected.map((skill) => `skill:${skill.name}`),
      ...RESOURCES.declaration.extensions.map((extension) => `skill:${extension.guidance.name}`),
    ].sort();
    assert.deepEqual(loaded.commands, expectedSkills);
    assert.ok(!loaded.commands.some((command) => command.includes("undeclared")), "project skills are ignored");
    assert.deepEqual(loaded.tools, ["bash", "edit", "read", "subagent", "subagents_enable", "write"]);

    assert.equal(line(output, "CACHE="), "absent", "an empty runtime cache is the starting state");
    const expectedDirs = RESOURCES.declaration.skills.selected
      .map((skill) => skill.name)
      .sort()
      .join(",");
    assert.equal(line(output, "SKILLS="), `${expectedDirs},`);
    assert.equal(line(output, "GUIDANCE="), "present", "the extension's operating guidance ships inside its package");
    assert.equal(line(output, "INSTALL="), "no", "the session installs no skill or extension");
  });

  test("the image's own inventory matches the committed declaration", () => {
    const inventoryText = docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "cat",
      WORKER_IMAGE,
      IMAGE_INVENTORY_PATH,
    ]);
    const inventory = verifyAgentInventory(RESOURCES, inventoryText);

    assert.equal(inventory.pi.version, "1.3.0");
    assert.deepEqual(
      inventory.skills.map((skill) => skill.name).sort(),
      [
        ...RESOURCES.declaration.skills.selected.map((skill) => skill.name),
        ...RESOURCES.declaration.extensions.map((extension) => extension.guidance.name),
      ].sort(),
    );
    assert.equal(inventory.extensions[0]?.package, "pi-subagents");
    assert.equal(inventory.extensions[0]?.version, "0.79.1");
    assert.deepEqual(inventory.agents.map((agent) => agent.name).sort(), ["code-reviewer", "spec-reviewer"]);
  });
});

describe("the provisioned worker image — model authentication", { skip: skipReason }, () => {
  test("the absent-credential failure is explicit and carries no secret", () => {
    let stderr = "";
    try {
      execFileSync(
        "docker",
        ["run", "--rm", "--network", "none", "-e", "PI_CODING_AGENT_DIR=/tmp", "--entrypoint", "pi", WORKER_IMAGE, "auth", "check", "--model", "openai/gpt-4o", "--json", "--no-refresh"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      assert.match(failed.stdout ?? "", /not_ready/);
      assert.match(failed.stdout ?? "", /credentials_not_configured/);
      stderr = failed.stderr ?? "";
      assert.doesNotMatch(stderr, /api[_-]?key/i);
    }
    assert.equal(stderr.includes("sentinel"), false);
  });

  test("a provider env var authenticates the model without printing its value", () => {
    const stdout = docker([
      "run", "--rm", "--network", "none", "-e", "PI_CODING_AGENT_DIR=/tmp", "-e", "OPENAI_API_KEY=sentinel-secret-value",
      "--entrypoint", "pi", WORKER_IMAGE, "auth", "check", "--model", "openai/gpt-4o", "--json", "--no-refresh",
    ]);
    assert.match(stdout, /"status":"ready"/);
    assert.ok(!stdout.includes("sentinel-secret-value"), "the diagnostic never echoes the credential");
  });

  test("an explicitly supplied auth file authenticates without being baked into the image", () => {
    const script = [
      "set -e",
      "mkdir -p /tmp/msf-auth",
      'printf \'{"openai":{"type":"api_key","key":"sentinel-file-secret"}}\' > /tmp/msf-auth/auth.json',
      "chmod 600 /tmp/msf-auth/auth.json",
      "PI_CODING_AGENT_DIR=/tmp/msf-auth exec pi auth check --model openai/gpt-4o --json --no-refresh",
    ].join("\n");
    const stdout = docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", WORKER_IMAGE, "-c", script]);
    assert.match(stdout, /"status":"ready"/);
    assert.ok(!stdout.includes("sentinel-file-secret"));
    // The image itself ships no auth.json — the secret only ever arrives at launch.
    assert.throws(() => docker(["run", "--rm", "--network", "none", "--entrypoint", "cat", WORKER_IMAGE, "/home/agent/.pi/agent/auth.json"]));
  });
});
