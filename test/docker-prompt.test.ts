import assert from "node:assert/strict";
import test from "node:test";
import { COMPLETION_SIGNAL } from "../src/runtime/docker-invocation.js";
import { continuationPrompt, implementPrompt } from "../src/runtime/docker-prompt.js";
import type { RunModels } from "../src/runtime/docker-config.js";

const models: RunModels = {
  implementer: "github-copilot/gpt-6-luna",
  "reviewer-standards": "github-copilot/gpt-6-luna",
  "reviewer-spec": "github-copilot/gpt-6-luna",
  default: "github-copilot/gpt-6-luna",
};

const job = {
  ref: { tracker: "github" as const, project: "acme/app", id: "6" },
  repository: "acme/app",
  targetBranch: "main",
  branch: "msf/job-github-acme-app-6",
  baseSha: "1111111111111111111111111111111111111111",
  models,
  review: {
    specPath: "docs/spec.md",
    specSha256: "a".repeat(64),
    standardsPath: "CODING_STANDARDS.md",
    standardsSha256: "b".repeat(64),
  },
};

test("the first invocation runs the installed /implement skill on the work item, base and branch", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /\/skill:implement/);
  assert.ok(prompt.includes("github:acme/app#6"), "work item identity");
  assert.ok(prompt.includes(job.baseSha), "review base");
  assert.ok(prompt.includes(job.branch), "authorized branch");
  assert.ok(prompt.includes("/home/agent/workspace"), "work only in the job area");
});

test("every agent role is named with its explicit model, and the default role is used for other subagents", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /implementer.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /reviewer-standards.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /reviewer-spec.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /default.*other subagent/);
  assert.match(prompt, /no other model/);
});

test("reviewers get the base, the exact diff command, the spec and the standards, with their digests", () => {
  const prompt = implementPrompt(job);
  assert.ok(prompt.includes("git -c core.pager=cat diff --no-color --no-ext-diff --no-textconv"), "exact diff command");
  assert.ok(prompt.includes(`docs/spec.md (sha256 ${"a".repeat(64)})`), "spec with digest");
  assert.ok(prompt.includes(`CODING_STANDARDS.md (sha256 ${"b".repeat(64)})`), "standards with digest");
  assert.match(prompt, /A review without that material is not an approval/);
});

test("the result protocol asks for one structured result and the completion signal", () => {
  const prompt = implementPrompt(job);
  for (const status of ["needs_help", "pr_ready", "interrupted"]) {
    assert.ok(prompt.includes(`"status":"${status}"`), `${status} shape`);
  }
  assert.ok(prompt.includes("<msf-result>"), "result tag");
  assert.ok(prompt.includes(COMPLETION_SIGNAL), "completion signal");
  assert.ok(prompt.includes('"reviews"'), "review evidence for pr_ready");
});

test("the agent is told not to merge and not to deploy to production", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /Never merge/);
  assert.match(prompt, /Never deploy to production/);
});

test("a continuation carries the operator's input when there is one, and says so when there is none", () => {
  const withNote = continuationPrompt({ ...job, kind: "resume", note: "Approved: export slugify(text) from src/slugify.ts." });
  assert.ok(withNote.includes("Approved: export slugify(text) from src/slugify.ts."));
  assert.doesNotMatch(withNote, /\/skill:implement/, "the session already carries the skill");
  const withoutNote = continuationPrompt({ ...job, kind: "correction" });
  assert.match(withoutNote, /No new operator input/);
  assert.ok(withoutNote.includes("<msf-result>"), "same result protocol");
  assert.ok(withoutNote.includes(job.baseSha));
});
