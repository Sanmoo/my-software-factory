import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AGENT_MARKER } from "../tracker/port.js";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { buildWorkerPrompt, WORK_MOUNT } from "./prompt.js";
import type { WorkRequest } from "./port.js";

/**
 * The worker prompt (ticket 17): the issue, the PR and its comments when a
 * round exists, the diff of the work branch — and the worker's THREE
 * obligations (the worker's ruler; the factory's ruler reads only the
 * structured facts these obligations produce).
 */

const baseRequest = (overrides: Partial<WorkRequest> = {}): WorkRequest => ({
  ref: { repo: "Sanmoo/my-tasks", number: 42 },
  workDir: "/ws/trabalhos/Sanmoo/my-tasks#42",
  branch: "agent-issue-42",
  repoDir: "/ws/repos/Sanmoo#my-tasks",
  baseBranch: "main",
  attempt: 1,
  material: {
    issue: { title: "Add the greeting endpoint", body: "Add a `greet` endpoint to the API." },
    diff: "diff --git a/x b/x\n+hello",
  },
  ...overrides,
});

// The feedback-round request (ticket 84): the base fixture with an open PR
// whose conversation the worker must judge, not blindly obey. Derived from
// `baseRequest` so the issue/diff fixtures stay in one place.
const feedbackRequest = (comments: { author: string; body: string }[]): WorkRequest =>
  baseRequest({
    material: {
      ...baseRequest().material,
      pr: {
        number: 7,
        comments: comments.map((c, i) => ({
          id: String(i + 1),
          author: c.author,
          body: c.body,
          createdAt: "2026-02-14T00:00:00Z",
        })),
      },
    },
  });

describe("worker prompt — the material the session starts from", () => {
  test("carries the issue title and body", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /Sanmoo\/my-tasks#42/);
    assert.match(prompt, /Add the greeting endpoint/);
    assert.match(prompt, /Add a `greet` endpoint to the API\./);
  });

  test("carries the branch facts: branch, base, attempt", () => {
    const prompt = buildWorkerPrompt(
      baseRequest({ attempt: 3 }),
      { blockedLabel: DEFAULT_LABELS.blocked },
    );
    assert.match(prompt, /agent-issue-42/);
    assert.match(prompt, /born from main/);
    assert.match(prompt, /attempt 3/);
  });

  test("carries the diff of the work branch", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /\+hello/);
  });

  test("with no open PR: instructs opening one against the base with Closes linkage", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /gh pr create/);
    assert.match(prompt, /Closes #42/);
    assert.match(prompt, /--base main/);
  });

  test("with an open PR: the round's conversation is in the prompt, opening a new PR is forbidden", () => {
    const request = baseRequest({
      material: {
        issue: { title: "t", body: "b" },
        pr: {
          number: 7,
          comments: [
            { id: "1", author: "human", body: "Please split the module.", createdAt: "2026-02-14T00:00:00Z" },
            { id: "2", author: "bot-do-samuca", body: "Done earlier.", createdAt: "2026-02-14T01:00:00Z" },
          ],
        },
        diff: "diff --git a/y b/y",
      },
    });
    const prompt = buildWorkerPrompt(request, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /PR #7/);
    assert.match(prompt, /Please split the module\./);
    assert.match(prompt, /human/);
    assert.doesNotMatch(prompt, /gh pr create/);
  });
});

describe("worker prompt — the three obligations (the worker's ruler)", () => {
  const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

  test("obligation 1: the structured outcome record, always, before ending — with the schema", () => {
    assert.match(prompt, new RegExp(`${WORK_MOUNT}/${DESFECHO_FILENAME}`));
    assert.match(prompt, /pr-open/);
    assert.match(prompt, /blocked-self-report/);
    assert.match(prompt, /clean-without-pr/);
    assert.match(prompt, /"attempt": 1/);
    assert.match(prompt, /"pr".*"repo".*"number".*"branch"/s);
  });

  test("obligation 1: the schema example shows the optional `paths` — the record's artifact trail (story 19)", () => {
    // The record carries classe, tentativa, PR, caminhos — the schema example
    // must teach `paths`, or the worker never learns the field exists.
    assert.match(prompt, /"paths": \{"<artifact name>": "<path, relative to the work dir>"\}/);
    assert.match(prompt, /"paths" is optional: the paths of the artifacts this session wrote/);
    assert.match(prompt, /"paths" optional\)/, "the example marks paths as the optional member it is");
  });

  test("obligation 2: every feedback round ends with a marked comment on the PR", () => {
    assert.match(prompt, /comment on the PR/i);
    assert.match(prompt, new RegExp(`comment MUST start with[\\s\\S]*${AGENT_MARKER}`));
  });

  test("obligation 3: blocked self-report — marker + label + exit", () => {
    assert.match(prompt, new RegExp(AGENT_MARKER));
    assert.match(prompt, /--add-label agent-blocked/);
    assert.match(prompt, /blocked-self-report/);
  });

  test("the blocked label is the factory's configured one, not a hardcode", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: "parado" });
    assert.match(prompt, /--add-label parado/);
  });

  test("the prompt ends with the completion signal the runtime listens for", () => {
    assert.match(prompt, /MSF-RESULT/);
  });
});

describe("worker prompt — the feedback-round policy (ticket 84)", () => {
  const promptFor = (comments: { author: string; body: string }[]): string =>
    buildWorkerPrompt(feedbackRequest(comments), { blockedLabel: DEFAULT_LABELS.blocked });

  test("the round no longer commands addressing every comment indiscriminately", () => {
    const prompt = promptFor([{ author: "human", body: "Please split the module." }]);
    assert.doesNotMatch(prompt, /address every comment/i);
  });

  test("verifiable, in-scope problems are fixed directly, without asking first", () => {
    const prompt = promptFor([{ author: "human", body: "This throw loses the cause. Include it." }]);
    assert.match(prompt, /verifiable/i);
    assert.match(prompt, /fix/i);
  });

  test("optional suggestions are evaluated, not turned into work automatically, and never discarded silently", () => {
    const prompt = promptFor([{ author: "human", body: "You could use a lookup table here." }]);
    assert.match(prompt, /optional|suggest|preference/i);
    assert.match(prompt, /not discard|never discard|not silently/i);
  });

  test("product, architecture and scope decisions go to the user before changing the code", () => {
    for (const comment of [
      "Rename the public endpoint to /v2/greet.",
      "Rewrite this on a queue-based architecture.",
      "Also handle the billing feature while you are here.",
    ]) {
      const prompt = promptFor([{ author: "human", body: comment }]);
      assert.match(prompt, /ask|present|await|user dec/i);
    }
  });

  test("ambiguous comments motivate an objective question, not an arbitrary interpretation", () => {
    const prompt = promptFor([{ author: "human", body: "Hmm, this part feels off." }]);
    assert.match(prompt, /ambigu/i);
    assert.match(prompt, /question/i);
  });

  test("disagreement is grounded: evidence and concrete consequences, in a technical tone", () => {
    const prompt = promptFor([{ author: "human", body: "I would not have used a Map here." }]);
    assert.match(prompt, /disagree|justify|evidence/i);
    assert.match(prompt, /consequence/i);
  });

  test("conflicts between reviewers are presented for the user's decision", () => {
    const prompt = promptFor([
      { author: "reviewer-a", body: "Extract this into a helper." },
      { author: "reviewer-b", body: "Keep it inline, the helper hides the flow." },
    ]);
    assert.match(prompt, /conflict/i);
  });

  test("a mixed round: independent fixes proceed; changes depending on a pending decision wait", () => {
    const prompt = promptFor([
      { author: "human", body: "Fix the typo in the error message." },
      { author: "human", body: "Should we also expose this over gRPC? I think yes." },
    ]);
    assert.match(prompt, /independent/i);
    assert.match(prompt, /wait|pend|confirm/i);
  });

  test("confirmation is contextual: a choice authorizes only it; questions never authorize; ambiguous answers do not authorize", () => {
    const prompt = promptFor([{ author: "human", body: "Use the lookup table?" }]);
    assert.match(prompt, /only|solely/i);
    assert.match(prompt, /question|acknowledg|ambiguous/i);
    assert.match(prompt, /not.{0,40}(approv|authoriz)|(approv|authoriz).{0,40}not/i);
  });

  test("a new message starts a new analysis — it is not, by itself, an authorization", () => {
    const prompt = promptFor([{ author: "human", body: "Ping." }]);
    assert.match(prompt, /new message|fresh|re-?evaluat|new round|new session/i);
    assert.match(prompt, /not.{0,60}authoriz/i);
  });

  test("an unambiguous yes to a single clear question is enough — no magic words", () => {
    const prompt = promptFor([{ author: "human", body: "Use the lookup table?" }]);
    assert.match(prompt, /"?yes"?|\bsim\b/i);
    assert.doesNotMatch(prompt, /magic word|exact(ly)? (word|phrase)|reply with .*(confirm|approve)/i);
  });

  test("multiple pending proposals: ambiguous answers must not be read as blanket approval", () => {
    const prompt = promptFor([
      { author: "human", body: "Use the lookup table?" },
      { author: "human", body: "Also cache the results?" },
    ]);
    assert.match(prompt, /clarif|ask|ambiguous/i);
  });

  test("the conversation is the memory: recognize handled requests and pending decisions, do not blindly reapply old comments", () => {
    const prompt = promptFor([
      { author: "human", body: "Fix the typo." },
      { author: "bot-do-samuca", body: "Done in commit abc." },
      { author: "human", body: "Use the lookup table?" },
    ]);
    assert.match(prompt, /already (addressed|handled|done)|already (been )?(addressed|handled)|reappl|history|context of the conversation|conversation/i);
    assert.match(prompt, /pend/i);
  });

  test("every round ends with a consolidated reply on the PR: done, pending, why, and the decision needed", () => {
    const prompt = promptFor([{ author: "human", body: "Fix the typo in the error message." }]);
    assert.match(prompt, /consolidat/i);
    assert.match(prompt, /what (was|you) (changed|addressed|did)|done|addressed/i);
    assert.match(prompt, /pend/i);
    assert.match(prompt, /decision/i);
  });

  test("a discussion-only round ends normally: no artificial commits and no artificial block", () => {
    const prompt = promptFor([{ author: "human", body: "Use the lookup table?" }]);
    assert.match(prompt, /without (making )?(changes|commits)|discussion-only|no change/i);
    assert.match(prompt, /not.{0,60}block/i);
  });

  test("awaiting a user decision is not an operational impossibility", () => {
    const prompt = promptFor([{ author: "human", body: "Use the lookup table?" }]);
    assert.match(prompt, /not.{0,80}blocked-self-report/i);
  });

  test("the marker contract survives the policy change (regression)", () => {
    const prompt = promptFor([{ author: "human", body: "Fix the typo." }]);
    assert.match(prompt, new RegExp(`comment MUST start with[\\s\\S]*${AGENT_MARKER}`));
  });
});

describe("worker prompt — the initial round carries no feedback obligations (ticket 84)", () => {
  const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

  test("with no open PR, the feedback-round policy is absent and the round reply stays scoped to rounds with a PR", () => {
    assert.doesNotMatch(prompt, /## The feedback-round policy/);
    // Obligation 2 remains conditioned on a session that has PR comments to
    // answer — the initial round inherits no such duty.
    assert.match(
      prompt,
      /every feedback round \(a session that judged and answered the PR's comments/,
    );
  });
});
