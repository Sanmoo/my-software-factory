import { AGENT_MARKER } from "../tracker/port.js";
import { DESFECHO_FILENAME, type OutcomeClass } from "../state/outcome.js";
import type { WorkRequest } from "./port.js";

/**
 * The worker prompt (ticket 17, policy per ticket 84) — the only "interface"
 * between the factory and the agent inside the container (prototype,
 * runtime/). It carries the whole context of the session (issue, PR
 * conversation, diff of the work branch — never session memory), the
 * worker's THREE obligations and, on feedback rounds, the policy for judging
 * review comments instead of obeying them indiscriminately.
 *
 *   1. always write the structured outcome record before ending;
 *   2. end every feedback round by commenting on the PR what was addressed;
 *   3. self-report blocked (marker + label) and exit when stuck.
 *
 * Every session that changes code (the initial implementation or a feedback
 * round — ticket 85) also follows the implementation procedure: the operator's
 * /implement and /code-review skills, loaded from the profile the container
 * carries. The prompt adapts those skills to Pi (there is no tool named
 * "Skill": loading a SKILL.md and executing its instructions IS using the
 * skill) and fixes the one-way order: pin the round's SHA, implement,
 * validate, commit LOCALLY, review via two parallel subagents, fix, and only
 * then publish. The factory never reads this prose back — the review is the
 * worker's obligation, not the factory's inference.
 *
 * This is the worker's ruler, in prose for a reader of prose. The factory's
 * ruler (state/outcome.ts) never reads it back: it reads only the structured
 * facts the obligations produce — the schema of desfecho.json, the PR fact,
 * the label and the marker. The contract between the two sides is the
 * artifact schema, never the text.
 */

/**
 * Container paths are layout, not prose: where the host binds the work's
 * artifacts inside the container. Kept here so the prompt and the runtime
 * agree on the contract without runtime importing sandcastle internals.
 */
export const WORK_MOUNT = "/msf-work";
export const PROFILE_MOUNT = "/msf-profile";

/** The completion signal: when the agent prints it, the iteration loop ends. */
export const COMPLETION_SIGNAL = "<promise>MSF-RESULT</promise>";

export interface PromptOptions {
  /** The blocked label as configured (config.labels.blocked) — the worker
   * adds it verbatim on a self-report. */
  blockedLabel: string;
}

const desfechoPath = `${WORK_MOUNT}/${DESFECHO_FILENAME}`;

/**
 * The record schema the worker must write, rendered as the example the
 * prompt teaches. Field names are the artifact contract with the factory's
 * ruler — kept verbatim with `OutcomeRecord` (state/outcome.ts). The optional
 * `paths` (story 19: "classe, tentativa, PR, caminhos") records the artifact
 * paths of this attempt — the trail the human (and the factory) reads after.
 */
function outcomeSchemaExample(request: WorkRequest): string {
  const pr = `,\n     "pr": {"repo": "${request.ref.repo}", "number": <the PR number>, "branch": "${request.branch}"}`;
  const paths = `,\n     "paths": {"<artifact name>": "<path, relative to the work dir>"}`;
  return (
    `{\n` +
    `     "class": <one of: "pr-open" | "blocked-self-report" | "clean-without-pr">,\n` +
    `     "attempt": ${request.attempt}${pr}${paths}   ("pr" only with a PR; "paths" optional)\n` +
    `   }`
  );
}

/**
 * Where the round's review reports live (ticket 85): the Standards and Spec
 * reports of each attempt, distinguishable across attempts, referenced in
 * the outcome record's "paths". Relative to the work dir.
 */
export function reviewReportPath(attempt: number, axis: "standards" | "spec"): string {
  return `revisao/tentativa-${attempt}-${axis}.md`;
}

/**
 * The implementation procedure (ticket 85): the operator's /implement and
 * /code-review skills, loaded from the profile, adapted to Pi and chained in
 * a fixed one-way order. Mandatory for every code-changing session; exempt
 * for purely explanatory ones. The prose is the worker's ruler — the factory
 * reads only the structured facts (the reports in "paths", the outcome).
 */
function implementationProcedure(request: WorkRequest): string {
  const attempt = request.attempt;
  const standardsReport = reviewReportPath(attempt, "standards");
  const specReport = reviewReportPath(attempt, "spec");
  return [
    `## The implementation procedure — MANDATORY for this session`,
    ``,
    `This session changes code (the initial implementation of the issue, or a feedback round`,
    `addressing the PR comments above), so the FULL implement–review cycle below is mandatory.`,
    `Only a session that produces no code change at all (a purely explanatory answer) skips it.`,
    ``,
    `Your profile carries the operator's skills, and skills are how procedures reach you:`,
    ``,
    `- To use a skill, READ its SKILL.md and EXECUTE its instructions. Reading the file and doing`,
    `  what it says IS using a skill in Pi — there is no tool named "Skill", and merely mentioning`,
    `  \`/implement\` without loading it is not following it.`,
    `- The skills this session must load and obey:`,
    `  - \`~/.pi/agent/skills/implement/SKILL.md\` — the implementation procedure;`,
    `  - \`~/.pi/agent/skills/code-review/SKILL.md\` — the two-axis review (Standards + Spec).`,
    `  Where /implement says to call the "tdd" skill at a seam, load`,
    `  \`~/.pi/agent/skills/tdd/SKILL.md\` and follow it the same way.`,
    ``,
    `The order is fixed and one-way — publishing happens ONLY after the review:`,
    ``,
    `1. PIN the round: \`git rev-parse HEAD\` — the round's starting SHA. It stays fixed through`,
    `   every fix cycle of this round; the review always compares against it.`,
    `2. IMPLEMENT per /implement: the issue above (plus the applicable PR comments, in a feedback`,
    `   round) is the ticket. Where /implement says to ask, the ticket is unambiguous: proceed.`,
    `3. VALIDATE: typecheck and single test files as you go; the FULL test suite at the end.`,
    `4. COMMIT locally on the branch: commits exist BEFORE the review — /code-review reviews a`,
    `   committed diff since the starting SHA, and an empty diff fails there.`,
    `5. REVIEW per /code-review, against the starting SHA of step 1:`,
    `   - TWO SEPARATE subagent runs, issued IN PARALLEL (the subagent tool): one for the Standards`,
    `     axis, one for the Spec axis — never one agent doing both, never your own inline review;`,
    `   - each reviewer's context: the diff \`git diff <starting-sha>...HEAD\`, the commit list, the`,
    `     spec (the issue and, in a feedback round, the applicable PR comments), the repo's`,
    `     documented standards files and the smell baseline the skill defines;`,
    `   - if an axis CANNOT run — a skill file missing from the profile, the subagent tool failing —`,
    `     that is a mandatory capability being absent: self-report blocked (obligation 3). NEVER`,
    `     silently replace the subagents with your own review and move on.`,
    `6. FIX what the review found: violations of documented standards and missing or incorrect`,
    `   requirements block completion — fix them, validate, commit (new commits on the branch) and`,
    `   re-run the review against the SAME starting SHA. Code smells are judgement calls, not`,
    `   violations: apply them or justify, in the round's summary, each one you decline. If a`,
    `   blocking finding cannot be resolved, self-report blocked (obligation 3).`,
    `7. ONLY THEN publish: push the branch and open or update the PR, as "The pull request" says.`,
    ``,
    `Write each axis's report to the work dir — ${standardsReport} and ${specReport} — and list`,
    `both files in the "paths" of the outcome record (obligation 1), so the human can inspect the`,
    `review that was actually run. A failed axis leaves its evidence and the reason; never write a`,
    `success report for an axis that did not run.`,
    ``,
    `Blocked anywhere in this procedure, obligation 3 applies unchanged: keep the local commits and`,
    `any existing PR, push nothing new, recreate no branch, discard nothing — report the blockage`,
    `and stop. A human resumes from there.`,
    ``,
  ].join("\n");
}

export function buildWorkerPrompt(request: WorkRequest, options: PromptOptions): string {
  const { material } = request;
  const repo = request.ref.repo;
  const number = request.ref.number;
  const pr = material.pr;

  return [
    `You are the worker of my-software-factory. The factory reserved issue ${repo}#${number} for you and launched this session to do it.`,
    ``,
    `## Your work`,
    ``,
    `- Repository: ${repo} — your cwd is a git worktree of it.`,
    `- Branch: ${request.branch} (born from ${request.baseBranch}; this is attempt ${request.attempt} on it).`,
    `  The branch already exists and is the memory of the work: commit on it, never recreate it.`,
    `- The GitHub CLI \`gh\` is authenticated via GH_TOKEN; its account is the factory's worker account — every push, PR and comment must come from it.`,
    `- You are unrestricted inside this container: use your tools freely. The confinement is the container, not paralysis.`,
    ``,
    `## The issue: ${material.issue.title}`,
    ``,
    material.issue.body,
    ``,
    pr === undefined
      ? [
          `## The pull request`,
          ``,
          `No PR exists yet for this work. When the work is ready:`,
          `1. commit your changes on ${request.branch},`,
          `2. \`git push -u origin ${request.branch}\`,`,
          `3. open the PR: \`gh pr create --base ${request.baseBranch} --head ${request.branch}\` —`,
          `   title summarizing the change, body containing \`Closes #${number}\` so the human's merge closes the issue.`,
          ``,
          `The PR is the end state of your work: the factory waits for it.`,
        ].join("\n")
      : [
          `## The pull request`,
          ``,
          `PR #${pr.number} is already open for this work (same branch, same PR — never open another).`,
          `This session is a feedback round: read every comment below, judge each one before acting (policy below), push to ${request.branch} (the PR updates itself), and obey the obligations.`,
          ``,
          ...pr.comments.flatMap((comment, index) => [
            `--- comment ${index + 1} by ${comment.author} ---`,
            comment.body,
            ``,
          ]),
          `
## The feedback-round policy — judge each comment before acting

Review comments are requests, not orders. For each one, decide what it is, then act accordingly:

- Verifiable problem, in scope, with a solution that requires no product or architecture decision: fix it directly on this branch and push. Do not ask before fixing what is objectively broken or contrary to the project's conventions.
- Optional suggestion or style preference: evaluate it against the project's conventions and context. Do not turn a preference into work automatically, and never discard it silently: when you recommend not implementing it, say so on the PR with your reasons and leave the point to the user's decision.
- Product decision, architecture change, or scope expansion (the review suggests changing what the issue asked for): do not implement. Present it on the PR first: the request, the relevant evidence or ambiguity, your recommendation, and the concrete consequences of implementing it and of not implementing it.
- Conflicts between reviewers: do not pick a side by order or insistence. Present both positions to the user for a decision, with your recommendation and the concrete consequences of each side.
- Ambiguous comment: ask an objective question on the PR. Do not implement an arbitrary interpretation.
- Disagreement: justify it with evidence and state the concrete consequences of following, and of not following, the comment. Keep the tone technical, not defensive.

Independent fixes proceed in the same round; only changes that depend on a pending decision wait for it. Never treat one pending proposal as a reason to stop delivering everything else.

Confirmation is interpreted semantically, in the context of the conversation:

- The conversation you received is the memory of the round: recognize from it the requests already addressed, the pending proposals and the decisions taken afterwards. Do not blindly reapply comments from the history or requests that were already handled.
- A new message from the user starts another analysis of the context — it does not authorize a pending proposal by itself. Re-evaluate the context before acting.
- When the user explicitly picks one of several pending proposals, that choice authorizes only that proposal — do not extend the authorization to the other pending points.
- A single, unambiguous question answered with a clear "yes" is enough to proceed — no special commands or prescribed wording are required.
- Questions, acknowledgments and ambiguous answers are not approval. With multiple pending proposals, an ambiguous answer requires clarification — do not read it as blanket approval.

End the round with one consolidated reply on the PR (marked, obligation 2): what you addressed, what remains pending and why, what you recommend not doing and why, and the decision you need from the user — each pending point with an objective question. Awaiting a user decision is not being stuck: a discussion-only round ends normally, with no artificial commits, and is not a self-report of blocked — do not write "blocked-self-report" for a decision that is pending on the PR.
          `,
        ].join("\n"),
    ``,
    `## The diff of the work branch so far`,
    ``,
    material.diff === ""
      ? `(empty — this branch has no changes yet)`
      : `\`\`\`diff\n${material.diff}\n\`\`\``,
    ``,
    implementationProcedure(request),
    `## Your obligations — the factory reads them as structured facts; never skip one`,
    ``,
    `1. BEFORE the session ends, ALWAYS write the structured outcome record to ${desfechoPath} — JSON exactly in this schema:`,
    ``,
    `   ${outcomeSchemaExample(request)}`,
    ``,
    `   - "class" is one of:`,
    `     - "pr-open": you opened the PR (include the "pr" object with its number);`,
    `     - "blocked-self-report": you self-reported blocked (obligation 3);`,
    `     - "clean-without-pr": the session ended without a PR and without blocked.`,
    `   - "attempt" is ${request.attempt}, the number above.`,
    `   - "pr" is present when you opened the PR (class "pr-open") — the PR's repo, number and branch.`,
    `   - "paths" is optional: the paths of the artifacts this session wrote, keyed by artifact name, relative to the work dir — record it whenever the session wrote artifacts worth finding again.`,
    `   Write it in EVERY case — success, feedback round, or blocked — before you exit.`,
    `   Its absence is recorded by the factory as an abrupt death.`,
    ``,
    `2. At the end of every feedback round (a session that judged and answered the PR's comments — with changes or discussion-only),`,
    `   comment on the PR with the consolidated round reply, as the feedback-round policy above defines it. The comment MUST start with`,
    `   this exact line, then the summary the human reads:`,
    `   ${AGENT_MARKER}`,
    `   Every comment or review you post on the PR must start with that line.`,
    `   A comment without it is read as the human, even from this same account,`,
    `   and the factory will launch another round.`,
    ``,
    `3. If you get stuck and cannot proceed, self-report blocked and stop:`,
    `   - add the label to the issue: \`gh issue edit ${number} --repo ${repo} --add-label ${options.blockedLabel}\`,`,
    `   - comment on the ISSUE (not the PR), the comment starting with this exact line:`,
    `     ${AGENT_MARKER}`,
    `     followed by a short explanation of what blocks the work,`,
    `   - write the outcome record with "class": "blocked-self-report",`,
    `   - then end the session. A human resumes from there.`,
    ``,
    `## Completion signal`,
    ``,
    `When the outcome record is written and the session is done, print exactly this line as your final text:`,
    ``,
    COMPLETION_SIGNAL,
    ``,
  ].join("\n");
}

/** The outcome classes the worker may declare — the artifact vocabulary. */
export const WORKER_OUTCOME_CLASSES: readonly OutcomeClass[] = [
  "pr-open",
  "blocked-self-report",
  "clean-without-pr",
];
