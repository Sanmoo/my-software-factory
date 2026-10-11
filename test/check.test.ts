import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkInstance } from "../src/cli/check.js";
import type { AdmissionDeps } from "../src/core/admission.js";
import { git } from "../src/runtime/docker-area.js";
import { parseConfig } from "../src/config/validate.js";
import { projectEligibility } from "../src/config/project-eligibility.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";

const MODEL = "github-copilot/gpt-6-luna";
const config = parseConfig({
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
  return dir;
}

const sandbox: SandboxBoundary = { preflight: async () => ({ token: "t" }), run: async () => { throw new Error("unused"); } };
const deps = { tracker: { discoverCandidates: async () => [{}, {}] }, eligibility: (p) => projectEligibility(instance, p) } as unknown as AdmissionDeps;

test("a ready instance passes every line, read-only", async () => {
  const dir = await checkout(["docs/spec.md", "CODING_STANDARDS.md"]);
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: "/p" }, checkouts: { "acme/app": dir } },
  });
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.ok(lines.some((l) => /2 issue\(s\)/.test(l.detail)));
});

test("a repository without the review inputs fails the check and says which file", async () => {
  const dir = await checkout(["docs/spec.md"]);
  const lines = await checkInstance({
    config: config.config, instance, deps, sandbox,
    local: { image: "img", profiles: { personal: "/p" }, checkouts: { "acme/app": dir } },
  });
  const failed = lines.filter((l) => !l.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.what, /CODING_STANDARDS\.md/);
});

test("a failing Docker preflight and a wrong origin are reported, not thrown", async () => {
  const dir = await checkout(["docs/spec.md", "CODING_STANDARDS.md"]);
  await git(dir, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  const lines = await checkInstance({
    config: config.config, instance, deps,
    sandbox: { ...sandbox, preflight: async () => { throw new Error("Docker is unavailable"); } },
    local: { image: "img", profiles: { personal: "/p" }, checkouts: { "acme/app": dir } },
  });
  const failed = lines.filter((l) => !l.ok).map((l) => l.detail).join("\n");
  assert.match(failed, /Docker is unavailable/);
  assert.match(failed, /origin .* não aponta para acme\/app/);
});
