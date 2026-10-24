import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AGENT_MARKER } from "../tracker/port.js";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { buildWorkerPrompt, reviewReportPath, WORK_MOUNT } from "./prompt.js";
import type { WorkRequest } from "./port.js";
import { githubWork, launchedNumber } from "../e2e/work-fixtures.js";

/**
 * The worker prompt (ticket 17): the issue, the PR and its comments when a
 * round exists, the diff of the work branch — and the worker's THREE
 * obligations (the worker's ruler; the factory's ruler reads only the
 * structured facts these obligations produce).
 */

const baseRequest = (overrides: Partial<WorkRequest> = {}): WorkRequest => ({
  work: githubWork("Sanmoo/my-tasks", 42),
  workDir: "/ws/trabalhos/Sanmoo/my-tasks#42",
  branch: "agent-issue-42",
  repoDir: "/ws/repos/Sanmoo#my-tasks",
  baseBranch: "main",
  attempt: 1,
  material: {
    ticket: { title: "Add the greeting endpoint", body: "Add a `greet` endpoint to the API." },
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
  test("a resumed attempt says it CONTINUES the native session and reconciles external effects before repeating them (issue #146)", () => {
    const resumed = buildWorkerPrompt(baseRequest(), {
      blockedLabel: DEFAULT_LABELS.blocked,
      continuesSession: true,
    });
    assert.match(resumed, /This session CONTINUES attempt 1/);
    assert.match(resumed, /reopened the SAME native session/);
    assert.match(resumed, /Before repeating any EXTERNAL effect/);
    assert.match(resumed, /do NOT repeat it blindly/);
    assert.match(resumed, /guardrail journals every external effect before it runs/);

    const fresh = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.doesNotMatch(fresh, /This session CONTINUES/);

    // A claimed attempt that died before writing any session has nothing to
    // reopen: the runtime says so, and the prompt never claims continuity.
    const nothingToResume = buildWorkerPrompt(baseRequest(), {
      blockedLabel: DEFAULT_LABELS.blocked,
    });
    assert.doesNotMatch(nothingToResume, /This session CONTINUES/);
  });

  test("carries the issue title and body", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /Sanmoo\/my-tasks#42/);
    assert.match(prompt, /Add the greeting endpoint/);
    assert.match(prompt, /Add a `greet` endpoint to the API\./);
  });

  test("tells the worker Docker is available inside the container — and that its binds resolve on the host (ADR 0003)", () => {
    // The blocked round this exists for: an agent that needs Docker reported
    // "there is no Docker here" because nothing said there was.
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /Docker works inside this container/);
    assert.match(prompt, /npm run build:image/);
    assert.match(prompt, /host's siblings/);
  });

  test("a blocked-resume prompt includes human ticket replies and reconciles them with the ticket body", () => {
    const request = baseRequest({
      material: {
        ...baseRequest().material,
        ticket: {
          title: "Configure worker model",
          body: "Blocked by #86: do not proceed until it is closed.",
        },
        ticketReplies: [
          {
            id: "reply-1",
            author: "Sanmoo",
            body: "The #86 dependency was removed on GitHub; the issue text is stale. Please proceed.",
            createdAt: "2026-10-18T13:25:07Z",
          },
        ],
      },
    });
    const prompt = buildWorkerPrompt(request, { blockedLabel: DEFAULT_LABELS.blocked });

    assert.match(prompt, /Blocked by #86: do not proceed until it is closed\./);
    assert.match(prompt, /human replies on the ticket since your last blocked report/i);
    assert.match(prompt, /The #86 dependency was removed on GitHub; the issue text is stale\. Please proceed\./);
    assert.match(prompt, /reconcile.*ticket body|ticket body.*reconcile/i);
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
        ticket: { title: "t", body: "b" },
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
describe("worker prompt — the implementation procedure (ticket 85)", () => {
  const initial = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

  const feedbackRequest = baseRequest({
    material: {
      ticket: { title: "t", body: "b" },
      pr: {
        number: 7,
        comments: [
          { id: "1", author: "human", body: "Please split the module.", createdAt: "2026-02-14T00:00:00Z" },
        ],
      },
      diff: "diff --git a/y b/y",
    },
  });

  test("the initial implementation carries the mandatory implement–review cycle", () => {
    assert.match(initial, /## The implementation procedure — MANDATORY for this session/);
    assert.match(initial, /skills\/implement\/SKILL\.md/);
    assert.match(initial, /skills\/code-review\/SKILL\.md/);
  });

  test("a feedback round that changes code carries the SAME cycle (story 2)", () => {
    const prompt = buildWorkerPrompt(feedbackRequest, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /## The implementation procedure — MANDATORY for this session/);
    assert.match(prompt, /skills\/implement\/SKILL\.md/);
    assert.match(prompt, /applicable PR comments/, "the reviewers' spec context names the feedback comments");
  });

  test("a purely explanatory session is exempt from the cycle (story 3)", () => {
    assert.match(initial, /purely explanatory answer\) skips it/);
  });

  test("using a skill means loading the SKILL.md and executing it — no literal `Skill` tool is demanded (stories 4, 5)", () => {
    assert.match(initial, /READ its SKILL\.md and EXECUTE its instructions/);
    assert.match(initial, /no tool named "Skill"/);
    assert.match(initial, /merely mentioning[\s\S]*without loading it is not following it/);
    assert.doesNotMatch(initial, /call the Skill tool/i);
  });

  test("the order is fixed: pin the round's SHA, implement, validate, commit LOCALLY, review, fix, publish last (stories 7, 8)", () => {
    const pin = initial.indexOf("PIN the round");
    const implement = initial.indexOf("IMPLEMENT per /implement");
    const validate = initial.indexOf("VALIDATE:");
    const commit = initial.indexOf("COMMIT locally on the branch");
    const review = initial.indexOf("REVIEW per /code-review");
    const fix = initial.indexOf("FIX what the review found");
    const publish = initial.indexOf("ONLY THEN publish");
    assert.ok(pin > -1 && implement > pin && validate > implement && commit > validate && review > commit && fix > review && publish > fix);
    assert.match(initial, /git rev-parse HEAD/);
    assert.match(initial, /stays fixed through[\s\S]*every fix cycle/, "the round's SHA never moves within the round");
    assert.match(initial, /git diff <starting-sha>\.\.\.HEAD/, "the review compares against the round's SHA");
    assert.match(initial, /new commits on the branch[\s\S]*re-run the review against the SAME starting SHA/, "fixes are new commits, re-reviewed");
  });

  test("the review runs as TWO SEPARATE subagents, IN PARALLEL — never one agent, never self-review (stories 9-11, 16)", () => {
    assert.match(initial, /TWO SEPARATE subagent runs, issued IN PARALLEL/);
    assert.match(initial, /one for the Standards/);
    assert.match(initial, /one for the Spec axis/);
    assert.match(
      initial,
      /set the registered agent explicitly: `code-reviewer` for Standards and\s+`spec-reviewer` for Spec; never use the generic `default` agent/,
    );
    assert.match(initial, /never your own inline review/);
  });

  test("a missing axis is a mandatory-capability failure: blocked, not silent self-review (story 16)", () => {
    assert.match(initial, /if an axis CANNOT run — a skill file missing from the profile, the subagent tool failing —/);
    assert.match(initial, /mandatory capability being absent: self-report blocked \(obligation 3\)/);
    assert.match(initial, /NEVER[\s\S]*silently replace the subagents with your own review/);
  });

  test("documented-standard violations and missing requirements block completion; smells are judgement calls (stories 13, 14)", () => {
    assert.match(initial, /violations of documented standards and missing or incorrect\s+requirements block completion/);
    assert.match(initial, /Code smells are judgement calls, not\s+violations/);
    assert.match(initial, /apply them or justify/);
  });

  test("the blocked procedure preserves the local work and any existing PR (stories 17, 18)", () => {
    assert.match(initial, /keep the local commits and\s+any existing PR/);
    assert.match(initial, /push nothing new, recreate no branch, discard nothing/);
    assert.match(initial, /obligation 3 applies unchanged/);
  });

  test("the two axis reports land in the attempt's artifacts and ride the outcome record's paths (stories 19, 20)", () => {
    assert.match(initial, new RegExp(reviewReportPath(1, "standards").replace(/\//g, "\\/")));
    assert.match(initial, new RegExp(reviewReportPath(1, "spec").replace(/\//g, "\\/")));
    assert.match(initial, /list\s+both files in the "paths" of the outcome record/);
    const attempt2 = buildWorkerPrompt(baseRequest({ attempt: 2 }), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(attempt2, new RegExp(reviewReportPath(2, "standards").replace(/\//g, "\\/")), "reports distinguish attempts");
  });

  test("a failed axis leaves its evidence, never a fabricated success report", () => {
    assert.match(initial, /A failed axis leaves its evidence and the reason; never write a/);
    assert.match(initial, /success report for an axis that did not run/);
  });

  test("the reviewers receive the spec context: the issue and, in feedback, the applicable comments (story 12)", () => {
    assert.match(initial, /spec \(the issue and, in a feedback\s+round, the applicable PR comments\)/);
    const prompt = buildWorkerPrompt(feedbackRequest, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /applicable PR comments/);
  });

  test("the procedure is additive: the three obligations and the completion signal survive intact", () => {
    const prompt = buildWorkerPrompt(feedbackRequest, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, new RegExp(AGENT_MARKER));
    assert.match(prompt, /--add-label agent-blocked/);
    assert.match(prompt, /MSF-RESULT/);
    assert.match(prompt, /"paths" is optional/);
  });
});

describe("worker prompt — the repair round (issue 107)", () => {
  const repairRequest = (overrides: Partial<WorkRequest> = {}): WorkRequest =>
    baseRequest({
      baseBranch: "release/next",
      attempt: 2,
      material: {
        ticket: { title: "t", body: "b" },
        diff: "",
        pr: { number: 7, comments: [] },
        repair: {
          reasons: ["conflicts", "required-checks"],
          observedHeadSha: "abc123",
          baseBranch: "release/next",
          checks: [
            { name: "build", status: "completed", conclusion: "failure", detailsUrl: "https://ci/build" },
            { name: "e2e", status: "completed", conclusion: "timed_out" },
          ],
        },
      },
      ...overrides,
    });

  test("names the confirmed reasons, the current base and the rebase target", () => {
    const prompt = buildWorkerPrompt(repairRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /## The repair round/);
    assert.match(prompt, /Conflicts with the PR's current base/);
    assert.match(prompt, /release\/next/);
    assert.match(prompt, /git rebase origin\/release\/next/);
    assert.match(prompt, /Required checks failed or timed out/);
    assert.match(prompt, /build/);
    assert.match(prompt, /e2e/);
  });

  test("pins the force-with-lease to the observed head and forbids plain --force", () => {
    const prompt = buildWorkerPrompt(repairRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /--force-with-lease=agent-issue-42:abc123/);
    assert.match(prompt, /Never use plain `--force`/);
    assert.match(prompt, /lease is rejected[\s\S]*do NOT retry with a refreshed lease/);
    assert.match(prompt, /keep your local commits/);
  });

  test("timeout is investigated, never re-run; external causes and product decisions ask for help", () => {
    const prompt = buildWorkerPrompt(repairRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /timeout is a cause to diagnose/);
    assert.match(prompt, /NEVER a reason to re-run the same check/);
    assert.match(prompt, /outside your authorization, self-report blocked/);
    assert.match(prompt, /product or architecture decision[\s\S]*self-report blocked/);
  });

  test("keeps validation and the two independent reviews, and never weakens protections", () => {
    const prompt = buildWorkerPrompt(repairRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /keep the full validation and the two independent reviews/);
    assert.match(prompt, /Never weaken, skip or hide a required check or protection/);
    assert.match(prompt, /## The implementation procedure — MANDATORY for this session/);
  });

  test("when human review comments coexist, the repair round also points at the feedback policy", () => {
    const request = repairRequest();
    request.material.pr = {
      number: 7,
      comments: [
        { id: "1", author: "humano", body: "please rename it", createdAt: "2026-02-14T00:00:00Z" },
      ],
    };
    const prompt = buildWorkerPrompt(request, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /Human review comments are also present/);
    assert.match(prompt, /## The feedback-round policy/);
    assert.match(prompt, /please rename it/);
  });

  test("a resumed round takes over the local work: inspect it, never reset it (issue 112)", () => {
    const prompt = buildWorkerPrompt(
      repairRequest({
        material: {
          ticket: { title: "t", body: "b" },
          diff: "",
          pr: { number: 7, comments: [] },
          repair: {
            reasons: ["conflicts"],
            observedHeadSha: "abc123",
            baseBranch: "release/next",
            checks: [],
            resuming: 2,
            localWork: {
              headSha: "def456789012",
              commits: 2,
              uncommitted: true,
              operationInProgress: "rebase",
            },
          },
        },
      }),
      { blockedLabel: DEFAULT_LABELS.blocked },
    );

    assert.match(prompt, /## The repair round — the factory is RESUMING attempt 2/);
    assert.match(prompt, /ended abruptly BEFORE publishing it/);
    assert.match(prompt, /that round is not charged to the budget/);
    assert.match(prompt, /2 commits on the branch, HEAD def456789012, uncommitted changes, a rebase in progress/);
    assert.match(prompt, /existing commits are REUSED, never redone/);
    assert.match(prompt, /uncommitted changes are READ and completed, never discarded/);
    assert.match(prompt, /inspected and finished or aborted deliberately — never restarted blind/);
    assert.match(prompt, /Never reset, checkout or recreate the branch/);
    // The reviews must cover what is actually published; prior evidence is
    // never presumed valid across a session (issue 112, stories 15-16).
    assert.match(prompt, /reuse evidence from attempt 2 ONLY for content that is byte-identical/);
    assert.match(prompt, /the two reviews must run again/);
    assert.match(prompt, /--force-with-lease=agent-issue-42:abc123/, "the lease is still pinned");
  });

  test("a fresh repair round carries no resumption prose", () => {
    const prompt = buildWorkerPrompt(repairRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.doesNotMatch(prompt, /RESUMING/);
    assert.doesNotMatch(prompt, /reuse evidence from attempt/);
  });
});

describe("worker prompt — the ticket source and the code destination are separate facts", () => {
  const jiraRequest = (url?: string): WorkRequest =>
    baseRequest({
      work: {
        ticket: {
          provider: "jira",
          site: "acme.atlassian.net",
          stableId: "10042",
          key: "ABC-42",
          ...(url === undefined ? {} : { url }),
        },
        destination: { provider: "github", site: "github.com", repo: "Sanmoo/my-tasks" },
      },
      workDir: "/ws/trabalhos/jira@acme.atlassian.net@10042@Sanmoo%2Fmy-tasks",
    });

  test("a Jira ticket reaches the worker without a GitHub issue number or issue-editing commands", () => {
    const prompt = buildWorkerPrompt(jiraRequest("https://acme.atlassian.net/browse/ABC-42"), {
      blockedLabel: DEFAULT_LABELS.blocked,
    });

    assert.match(prompt, /ABC-42/);
    assert.match(prompt, /jira:acme\.atlassian\.net/, "the origin and its site are named");
    assert.match(prompt, /Repository: Sanmoo\/my-tasks/, "the destination is presented separately");
    assert.match(prompt, /https:\/\/acme\.atlassian\.net\/browse\/ABC-42/);
    assert.doesNotMatch(prompt, /Closes #/, "a Jira key never becomes a GitHub closing number");
    assert.doesNotMatch(prompt, /gh issue edit/, "the worker is not told to edit a fictional GitHub issue");
    assert.doesNotMatch(prompt, /sanmoo\/my-tasks\/issues\/10042/i, "no GitHub issue URL is synthesized");
  });

  test("a resumed Jira session is not told to read a fictional GitHub issue", () => {
    const prompt = buildWorkerPrompt(jiraRequest(), {
      blockedLabel: DEFAULT_LABELS.blocked,
      continuesSession: true,
    });

    assert.match(prompt, /CONTINUES attempt/);
    assert.match(prompt, /`gh pr view`/);
    assert.doesNotMatch(prompt, /`gh issue view`/, "the GitHub issue command belongs to a GitHub ticket only");
  });

  test("a Jira ticket without a presentation URL is still named, and no address is invented", () => {
    const prompt = buildWorkerPrompt(jiraRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

    assert.match(prompt, /ABC-42/);
    assert.doesNotMatch(prompt, /https?:\/\/[^\s]*ABC-42/);
  });

  test("the GitHub prompt keeps its closing syntax and issue-editing self-report", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

    assert.match(prompt, /`Closes #42`/);
    assert.match(prompt, /gh issue edit 42 --repo Sanmoo\/my-tasks --add-label agent-blocked/);
  });
});
