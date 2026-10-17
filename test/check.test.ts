import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkInstance, type CheckOptions } from "../src/cli/check.js";
import type { AdmissionDeps } from "../src/core/admission.js";
import { git } from "../src/runtime/docker-area.js";
import { populateProfile } from "./support/runtime-profile.js";
import { PROFILE_NPM_STAMP, SHARED_MISE_DIR } from "../src/runtime/docker-invocation.js";
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

// The persistent toolchain root of the factory home. The tests below seed it when they care about
// what the check reports; an absent tree is reported, never treated as a failure (ADR 0004).
const TOOLCHAINS = join(tmpdir(), "msf-check-toolchains");
const check = (options: Omit<CheckOptions, "toolchainsDir"> & { toolchainsDir?: string }) =>
  checkInstance({ toolchainsDir: TOOLCHAINS, ...options });

// The local settings of the test's own tmpdir: image, the profile, where its links may lead and the
// checkout. No mise declaration unless a test declares one.
const localOf = (personal: string, dir: string) => ({
  image: "img", profiles: { personal }, allowedRoots: { personal: [] }, mise: {}, checkouts: { "acme/app": dir },
});

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
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    local: localOf(empty, dir),
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /skills\/implement\/SKILL\.md/);
});

test("a ready instance passes every line, read-only", async () => {
  const dir = await checkout([]);
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    local: localOf(await profile(), dir),
  });
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.ok(lines.some((l) => /2 issue\(s\)/.test(l.detail)));
});

test("a failing Docker preflight and a wrong origin are reported, not thrown", async () => {
  const dir = await checkout([]);
  await git(dir, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  const lines = await check({
    config: config.config, instance, deps,
    sandbox: { ...sandbox, preflight: async () => { throw new Error("Docker is unavailable"); } },
    local: localOf(await profile(), dir),
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
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    local: localOf(await profile(), dir),
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /1 commit\(s\) que não estão em origin\/main/);
});

test("a checkout that never fetched origin/main fails instead of skipping the unpushed-commit check", async () => {
  const dir = await checkout([]);
  await git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    local: localOf(await profile(), dir),
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /origin\/main desconhecida/);
});

test("a profile without the gh-address-comments skill fails the check, and the check does not link it", async () => {
  const dir = await checkout([]);
  const personal = await profile();
  await rm(join(personal, "skills", "gh-address-comments"), { recursive: true });
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    local: localOf(personal, dir),
  });
  assert.match(lines.filter((l) => !l.ok).map((l) => l.detail).join("\n"), /skills\/gh-address-comments\/SKILL\.md/);
  await assert.rejects(access(join(personal, "skills", "gh-address-comments")), "the operator's profile is left as it was");
});

test("an image without python3 fails the check, naming the skill that needs it", async () => {
  const dir = await checkout([]);
  const asked: Array<[string, string]> = [];
  const lines = await check({
    config: config.config, instance, deps,
    sandbox: { ...sandbox, imageHas: async (image, command) => { asked.push([image, command]); return false; } },
    local: localOf(await profile(), dir),
  });
  assert.deepEqual(asked, [["img", "mise"], ["img", "rg"], ["img", "fd"], ["img", "python3"]]);
  const failed = lines.filter((l) => !l.ok).map((l) => l.detail).join("\n");
  assert.match(failed, /python3.*img.*gh-address-comments/);
  assert.match(failed, /mise, rg, fd não existe\(m\) na imagem img/);
});

test("the check reports the toolchain state read-only: an absent tree is the first invocation's business", async () => {
  const dir = await checkout([]);
  const personal = await profile();
  const lines = await check({
    config: config.config, instance, deps, sandbox,
    toolchainsDir: join(dir, "toolchains"),
    local: localOf(personal, dir),
  });
  const state = lines.find((line) => line.what === "perfil de runtime personal: toolchain persistente")!;
  assert.equal(state.ok, true);
  assert.match(state.detail, /ainda não convergidos/);
  assert.match(state.detail, /declaração de mise: não configurada em local\.yaml/);
});

test("the check reports the converged tree, the installed tools and the declared mise declaration", async () => {
  const dir = await checkout([]);
  const personal = await profile();
  const toolchainsDir = join(dir, "toolchains");
  const miseConfig = join(dir, "mise", "config.toml");
  await mkdir(join(toolchainsDir, "personal", "npm"), { recursive: true });
  // O diretório de dados do mise é COMPARTILHADO pelos perfis (spec #74): vive na raiz das toolchains,
  // não dentro do diretório do perfil.
  await mkdir(join(toolchainsDir, SHARED_MISE_DIR, "shims"), { recursive: true });
  await writeFile(join(toolchainsDir, "personal", "npm", PROFILE_NPM_STAMP), "a1b2c3d4e5f6a7b8\n");
  await writeFile(join(toolchainsDir, SHARED_MISE_DIR, "shims", "rtk"), "#!/bin/sh\n");
  await writeFile(join(toolchainsDir, SHARED_MISE_DIR, "shims", "node"), "#!/bin/sh\n");
  await mkdir(dirname(miseConfig), { recursive: true });
  await writeFile(miseConfig, '[tools]\nrtk = "latest"\n');
  const lines = await check({
    config: config.config, instance, deps, sandbox, toolchainsDir,
    local: { ...localOf(personal, dir), mise: { personal: miseConfig } },
  });
  const state = lines.find((line) => line.what === "perfil de runtime personal: toolchain persistente")!;
  assert.match(state.detail, /selo a1b2c3d4e5f6/);
  assert.match(state.detail, /ferramentas do mise: node, rtk/);
  assert.match(state.detail, new RegExp(`declaração de mise: ${miseConfig.replace(/[.\\/]/g, "\\$&")}`));
  assert.deepEqual(lines.filter((line) => !line.ok), [], "the check never fails on the toolchain state");
});
