import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkInstance } from "../src/cli/check.js";
import type { AdmissionDeps } from "../src/core/admission.js";
import { git } from "../src/runtime/docker-area.js";
import { populateProfile } from "./support/runtime-profile.js";
import { parseConfig } from "../src/config/validate.js";
import type { ProjectConfig } from "../src/config/types.js";
import { projectEligibility } from "../src/config/project-eligibility.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";

const MODEL = "github-copilot/gpt-6-luna";
const config = parseConfig({
  runtimeProfiles: {
    personal: {
      required: { files: ["settings.json", "auth.json"], packages: ["npm:pi-subagents"], skills: ["implement", "gh-address-comments"], agents: [] },
      excludePackages: ["npm:pi-lens"],
    },
  },
  credentials: { MODEL: { kind: "pi-auth", ref: "personal" } },
  instances: [{
    name: "personal", maxConcurrent: 1, pollIntervalSeconds: 60, maxIterations: 5, modelAuth: "MODEL",
    projects: [{
      name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
      prIntegration: "github.com", runtimeProfile: "personal", githubAccount: "acme-bot",
      labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
      models: { implementer: MODEL, "reviewer-standards": MODEL, "reviewer-spec": MODEL, default: MODEL },
    }],
  }],
});
assert.ok(config.ok);
const instance = config.config.instances[0]!;

async function checkout(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "msf-check-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  await git(dir, "config", "user.name", "T");
  await git(dir, "config", "user.email", "t@invalid");
  await mkdir(join(dir, "docs"), { recursive: true });
  for (const file of files) await writeFile(join(dir, file), "x\n");
  await writeFile(join(dir, "README.md"), "x\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  await git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

const sandbox: SandboxBoundary = { preflight: async () => ({ token: "t" }), imageHas: async () => true, run: async () => { throw new Error("unused"); } };
const deps = { tracker: { discoverCandidates: async () => [{}, {}] }, eligibility: (p: ProjectConfig) => projectEligibility(instance, p) } as unknown as AdmissionDeps;

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "msf-profile-"));
  await populateProfile(dir);
  await mkdir(join(dir, "skills", "implement"), { recursive: true });
  await writeFile(join(dir, "skills", "implement", "SKILL.md"), "x\n");
  await mkdir(join(dir, "skills", "gh-address-comments"), { recursive: true });
  await writeFile(join(dir, "skills", "gh-address-comments", "SKILL.md"), "x\n");
  return dir;
}

test("a profile without the implement skill fails the check", async () => {
  const dir = await checkout([]);
  const empty = await mkdtemp(join(tmpdir(), "msf-profile-"));
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: empty }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /skills\/implement\/SKILL\.md/);
});

test("a ready instance passes every line, read-only", async () => {
  const dir = await checkout([]);
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: await profile() }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.ok(lines.some((l) => /2 issue\(s\)/.test(l.detail)));
});

test("a failing Docker preflight and a wrong origin are reported, not thrown", async () => {
  const dir = await checkout([]);
  await git(dir, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  const lines = await checkInstance({
    config: config.config, instance, deps,
    sandbox: { ...sandbox, preflight: async () => { throw new Error("Docker is unavailable"); } },
    local: { image: "img", profiles: { personal: await profile() }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  const failed = lines.filter((l) => !l.ok).map((l) => l.detail).join("\n");
  assert.match(failed, /Docker is unavailable/);
  assert.match(failed, /origin .* não aponta para acme\/app/);
});

test("a checkout whose target branch is ahead of origin fails: those commits would ride in the PR", async () => {
  const dir = await checkout([]);
  await writeFile(join(dir, "local.txt"), "x\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "unpushed");
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: await profile() }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /1 commit\(s\) que não estão em origin\/main/);
});

test("a checkout that never fetched origin/main fails instead of skipping the unpushed-commit check", async () => {
  const dir = await checkout([]);
  await git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: await profile() }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /origin\/main desconhecida/);
});

test("a profile without the gh-address-comments skill fails the check, and the check does not link it", async () => {
  const dir = await checkout([]);
  const personal = await profile();
  await rm(join(personal, "skills", "gh-address-comments"), { recursive: true });
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /skills\/gh-address-comments\/SKILL\.md/);
  await assert.rejects(access(join(personal, "skills", "gh-address-comments")), "the operator's profile is left as it was");
});

test("an image without python3 fails the check, naming the skill that needs it", async () => {
  const dir = await checkout([]);
  const asked: Array<[string, string]> = [];
  const lines = await checkInstance({
    config: config.config, instance, deps,
    sandbox: { ...sandbox, imageHas: async (image, command) => { asked.push([image, command]); return false; } },
    local: { image: "img", profiles: { personal: await profile() }, allowedRoots: { personal: [] }, checkouts: { "acme/app": dir } },
  });
  assert.deepEqual(asked, [["img", "python3"]]);
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /python3.*img.*gh-address-comments/);
});
