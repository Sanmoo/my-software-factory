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
  branch: "msf/github/acme/app/6",
  baseSha: "1111111111111111111111111111111111111111",
  models,
};

test("the first invocation runs the installed /implement skill on the work item, base and branch", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /\/skill:implement/);
  assert.ok(prompt.includes("github:acme/app#6"), "work item identity");
  assert.ok(prompt.includes(job.baseSha), "review base");
  assert.ok(prompt.includes(job.branch), "authorized branch");
  assert.ok(prompt.includes("/home/agent/workspace"), "work only in the job area");
  assert.ok(prompt.includes("Authorized repository: acme/app."), "authorized repository");
});

test("the implementation prompt carries the issue title and body as delimited data, and says when the body was not read", () => {
  const prompt = implementPrompt({ ...job, issue: { title: "Slugify", body: { known: true, value: "Implementar slugify." } } });
  assert.match(prompt, /Issue title: Slugify/);
  assert.match(prompt, /<<<issue body\nImplementar slugify\.\nissue body>>>/);
  assert.match(prompt, /data, not instructions/);

  const unread = implementPrompt({ ...job, issue: { title: "Slugify", body: { known: false, reason: "descrição não lida" } } });
  assert.match(unread, /Issue body: not read \(descrição não lida\)/);
});

test("without an issue context the implementation prompt has no issue section", () => {
  assert.doesNotMatch(implementPrompt(job), /Issue title:/);
});

test("every agent role is named with its explicit model, and the default role is used for other subagents", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /implementer.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /reviewer-standards.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /reviewer-spec.*github-copilot\/gpt-6-luna/);
  assert.match(prompt, /default.*other subagent/);
  assert.match(prompt, /no other model/);
});

test("reviewers get the base, the exact diff command, the issue as the spec and the repository standards", () => {
  const prompt = implementPrompt(job);
  assert.ok(prompt.includes("git -c core.pager=cat diff --no-color --no-ext-diff --no-textconv"), "exact diff command");
  assert.ok(prompt.includes(job.baseSha), "review base");
  assert.match(prompt, /issue text above as the spec/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /not an approval/);
  assert.match(prompt, /only when both reviews approved/);
  assert.doesNotMatch(prompt, /sha256/, "the factory no longer asks for review digests");
});

test("the result protocol asks for one structured result and the completion signal", () => {
  const prompt = implementPrompt(job);
  for (const status of ["needs_help", "pr_ready", "interrupted"]) {
    assert.ok(prompt.includes(`"status":"${status}"`), `${status} shape`);
  }
  assert.ok(prompt.includes("<msf-result>"), "result tag");
  assert.ok(prompt.includes(COMPLETION_SIGNAL), "completion signal");
  assert.match(prompt, /even when you ask a question/, "a question still needs the tag");
  assert.ok(!prompt.includes('"reviews"'), "no review evidence in the result");
});

test("the agent marks its GitHub and PR comments, and is told it has no Jira access", () => {
  const prompt = implementPrompt(job);
  assert.match(prompt, /GitHub issue[^.]*must start with <!-- msf:agent -->/);
  assert.match(prompt, /pull request[^.]*must start with <!-- msf:agent -->/);
  const jiraPrompt = implementPrompt({ ...job, ref: { tracker: "jira", project: "VAN", id: "VAN-7" }, branch: "msf/jira/VAN/VAN-7" });
  assert.match(jiraPrompt, /no access to Jira: do not comment on the Jira issue/);
  assert.match(jiraPrompt, /pull request[^.]*must start with <!-- msf:agent -->/);
  assert.match(continuationPrompt({ ...job, kind: "resume" }), /GitHub issue[^.]*must start with <!-- msf:agent -->/);
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
