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

// ---- issue #19: a correction for a conflict with the target branch -------------------------

test("a conflict correction rebases the job branch onto the remote target and force-pushes only that branch", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", conflict: true });
  assert.match(prompt, /conflicts with main on github\.com/);
  assert.ok(prompt.includes("git fetch origin main"), "fetch the remote target");
  assert.ok(prompt.includes("git rebase origin/main"), "rebase onto the remote target");
  assert.ok(prompt.includes(`git push --force-with-lease origin ${job.branch}`), "force-with-lease, on the job branch only");
  assert.match(prompt, /Never merge main into the branch/, "no merge of the target into the branch");
  assert.match(prompt, /Never merge the pull request/, "no merge of the PR");
});

test("a conflict correction asks for help when it cannot decide how to resolve a conflict", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", conflict: true });
  assert.match(prompt, /cannot decide how to resolve a conflict, ask for help with needs_help/);
});

test("a conflict correction reviews against the target it was rebased onto, not the old base", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", conflict: true });
  assert.ok(prompt.includes("the review base origin/main"), "the reviewers are given the rebased target");
  assert.ok(prompt.includes("--binary origin/main <HEAD sha>"), "the exact diff is measured from the rebased target");
  assert.ok(!prompt.includes(job.baseSha), "the old base of the job is never a review base after the rebase");
});

test("a correction for any other feedback does not carry the conflict rules", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction" });
  assert.doesNotMatch(prompt, /force-with-lease/);
  assert.doesNotMatch(prompt, /rebase/);
});

test("a conflict correction still carries the operator's input, when there is one", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", conflict: true, note: "prefira a versão nova" });
  assert.match(prompt, /Operator input: prefira a versão nova/);
  assert.match(prompt, /force-with-lease/);
});

// ---- issue #20: the agent answers in the threads and resolves those with a delivered change ----

const correction = () => continuationPrompt({ ...job, kind: "correction" });

test("a correction tells the agent to answer in the thread itself, with the marker, citing the pushed SHA and a short description", () => {
  const prompt = correction();
  assert.match(prompt, /inline comment[^.]*answer in the same thread/i);
  assert.match(prompt, /addPullRequestReviewThreadReply/, "how to answer in a thread");
  assert.match(prompt, /reply[^.]*must start with <!-- msf:agent -->/i, "the inline reply carries the marker too");
  assert.match(prompt, /SHA of the pushed commit/);
  assert.match(prompt, /short description of the change/);
  assert.match(prompt, /description[^.]*still explain the change[^.]*history is rewritten/i, "the description outlives a rewritten SHA");
});

test("a correction resolves only the thread whose change was already pushed, and leaves refused or questioned threads open", () => {
  const prompt = correction();
  assert.match(prompt, /resolveReviewThread/, "how to resolve a thread");
  assert.match(prompt, /resolve a thread only after[^.]*change[^.]*pushed/i);
  assert.match(prompt, /refuse[^.]*question[^.]*(leave|stays?)[^.]*open/i);
});

test("a conversation comment, which belongs to no thread, gets a marked reply and nothing to resolve", () => {
  const prompt = correction();
  assert.match(prompt, /conversation comment[^.]*not in a thread[^.]*reply[^.]*marker/i);
});

test("the prompt says that reading feedback is not resolving it: only a delivered change resolves a thread", () => {
  assert.match(correction(), /never resolve a thread for any other reason/i);
});

test("the answer and resolve rules do not widen the correction into a rebase or a force-push", () => {
  assert.doesNotMatch(correction(), /force-with-lease|rebase/);
});

test("the thread rules ride on corrections, which carry PR feedback, and not on the first invocation or a plain resume", () => {
  assert.doesNotMatch(implementPrompt(job), /resolveReviewThread/);
  assert.doesNotMatch(continuationPrompt({ ...job, kind: "resume" }), /resolveReviewThread/);
});

test("a conflict correction carries the thread rules too, so feedback delivered with a rebase is still answered", () => {
  assert.match(continuationPrompt({ ...job, kind: "correction", conflict: true }), /resolveReviewThread/);
});
// ---- issue #21: triage of PR feedback -------------------------------------------------------

test("the triage invokes the gh-address-comments skill explicitly and forbids any change of code and any push", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", triage: "list", note: "comentário inline de ana em README.md (thread PRRT_1): troque" });
  assert.ok(prompt.startsWith("/skill:gh-address-comments"), "the skill is invoked by name, as the model cannot invoke it");
  assert.match(prompt, /Do not change any code, do not commit and do not push/);
  assert.match(prompt, /Operator input: comentário inline de ana em README\.md/);
});

test("the triage ends as a help request whose question is the numbered list, and does not ask for a ready PR", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction", triage: "list" });
  assert.match(prompt, /Number every thread and comment/);
  assert.match(prompt, /summary and a proposed treatment/);
  assert.match(prompt, /end with needs_help whose question is that numbered list/);
  assert.match(prompt, /1 and 3/, "the question shows how to choose");
  assert.match(prompt, /<msf-result>/, "same result protocol");
  assert.doesNotMatch(prompt, /report a PR as ready/i, "nothing is reviewed or delivered by the triage");
  assert.doesNotMatch(prompt, /force-with-lease|rebase/, "the branch is not rewritten while the operator reads the list");
});

test("the resume after the triage applies only the items the operator chose", () => {
  const prompt = continuationPrompt({ ...job, kind: "resume", triage: "apply", note: "1 e 3" });
  assert.doesNotMatch(prompt, /^\/skill:/, "the session already carries the triage");
  assert.match(prompt, /Operator input: 1 e 3/);
  assert.match(prompt, /Apply only the items the operator chose/);
  assert.match(prompt, /item the operator did not cite: take no action, write no reply and leave its thread open/);
  assert.match(prompt, /do not ask about it again/);
  assert.match(prompt, /"2: reply that X".*reply in the thread without resolving it/s);
});

test("the resume after the triage answers and resolves by the thread rules: marker, cited SHA, resolve only after the push", () => {
  const prompt = continuationPrompt({ ...job, kind: "resume", triage: "apply" });
  assert.match(prompt, /reply[^.]*must start with <!-- msf:agent -->/i, "inline replies carry the marker too");
  assert.match(prompt, /SHA of the pushed commit/);
  assert.match(prompt, /resolve a thread only after[^.]*change[^.]*pushed/i);
  assert.match(prompt, /refuse[^.]*question[^.]*(leave|stays?)[^.]*open/i);
  assert.match(prompt, /conversation comment[^.]*not in a thread[^.]*reply[^.]*marker/i);
});

test("the resume after the triage keeps the review of both axes and the result protocol", () => {
  const prompt = continuationPrompt({ ...job, kind: "resume", triage: "apply" });
  assert.match(prompt, /review it on two axes, standards and spec/);
  assert.ok(prompt.includes("<msf-result>"));
  assert.ok(prompt.includes(job.baseSha));
});

test("the resume after the triage rebases with force-with-lease only on the job branch when the batch had a conflict", () => {
  const prompt = continuationPrompt({ ...job, kind: "resume", triage: "apply", conflict: true });
  assert.ok(prompt.includes(`git push --force-with-lease origin ${job.branch}`));
  assert.match(prompt, /Never merge main into the branch/);
  assert.ok(prompt.includes("the review base origin/main"));
});

test("a conflict held by the triage is rechecked before the rebase, since it may be gone when the operator answers", () => {
  const prompt = continuationPrompt({ ...job, kind: "resume", triage: "apply", conflict: true });
  assert.match(prompt, /confirm it still exists/);
  assert.match(prompt, /only if the pull request still conflicts with main/);
});

test("a correction without a human comment does not invoke the triage", () => {
  const prompt = continuationPrompt({ ...job, kind: "correction" });
  assert.doesNotMatch(prompt, /gh-address-comments/);
  assert.doesNotMatch(prompt, /Apply only the items/);
});
