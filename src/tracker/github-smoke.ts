import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGitHubAdapter,
  defaultCommandRunner,
  ghCliEnv,
  readGhToken,
  type CommandRunner,
} from "./github-adapter.js";
import { type ContractHarness, type ContractIssue } from "./contract.js";
import { AGENT_MARKER, type Candidate, type IssueRef, type TrackerPort } from "./port.js";
import { derivePool } from "../state/derive.js";
import { DEFAULT_LABELS } from "../config.js";

/**
 * The real smoke of the GitHub adapter (ticket 16), in the empirical-proof
 * pattern of wayfinder ticket 09: against a REAL repo (default
 * `Sanmoo/my-tasks`, the config's example repo) with the bot account, ONE
 * issue's full cycle is executed, verified and reverted — nothing stays
 * behind (comments deleted, labels and assignees removed, blockers unlinked,
 * PR closed, branch deleted, issue closed).
 *
 * The port contract suite against the real adapter runs OFFLINE in `npm test`
 * over the in-memory REST sim (`github-sim.ts`); the real repo cannot host it
 * within the shared-IP REST budget (60 req/h) — the full cycle alone is its
 * empirical proof on the real thing.
 *
 * Credential- AND budget-gated: without the bot token in the gh keyring the
 * smoke is SKIPPED with the reason — never faked; with the token but a REST
 * budget that cannot host the cycle, also SKIPPED with the numbers. Run
 * explicitly: `npm run smoke:github`. Overrides: MSF_SMOKE_REPO,
 * MSF_SMOKE_ACCOUNT.
 */

const SMOKE_BODY = `seeded by the msf ticket-16 smoke — reverted by its cleanup\n\n${AGENT_MARKER}`;

/** The full cycle is planned to stay under this many REST calls. */
const PLANNED_REST_CALLS = 55;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Journal {
  /** Issues created by the harness (issues can't be deleted via the API; they are closed). */
  issues: number[];
  /** PRs created (closed on cleanup — deletion is not offered by GitHub). */
  prs: number[];
  /** Branch refs created here or by the adapter (deleted on cleanup). */
  branches: Set<string>;
  /** Comments created, by their issue/PR number and comment id (deleted on cleanup). */
  comments: { containerNumber: number; commentId: string }[];
  /** Native blockers added (unlinked on cleanup). */
  blockers: { issueNumber: number; blockerNumber: number }[];
  /** Labels created in the repo itself (deleted on cleanup, only if we created them). */
  repoLabelsCreated: string[];
}

class RealGithubHarness implements ContractHarness {
  readonly name = "real (gh CLI)";
  readonly journal: Journal = { issues: [], prs: [], branches: new Set(), comments: [], blockers: [], repoLabelsCreated: [] };
  /** Internal issue ids (the dependencies API speaks ids, not numbers). */
  private readonly issueIds = new Map<number, number>();
  private readonly runner: CommandRunner;
  private readonly token: string;

  constructor(
    readonly repo: string,
    readonly workerAccount: string,
    readonly claimedLabel: string,
    readonly adapter: TrackerPort,
    token: string,
    runner: CommandRunner = defaultCommandRunner,
  ) {
    this.token = token;
    this.runner = runner;
  }

  getAdapter(): TrackerPort {
    return this.adapter;
  }

  async reset(): Promise<void> {
    // the real repo is shared across checks; cleanup is the only reversion
  }

  // ---- the REST plumbing (gh api, bodies over stdin, never argv) ----

  private async rest(
    path: string,
    init: { method?: "POST" | "PATCH" | "DELETE" | "PUT"; input?: unknown; tolerate?: (stderr: string) => boolean } = {},
  ): Promise<unknown> {
    const args = ["api", ...(init.method ? ["-X", init.method] : []), path];
    const { stdout } = await this.gh(
      init.input === undefined ? args : [...args, "--input", "-"],
      {
        ...(init.input === undefined ? {} : { input: JSON.stringify(init.input) }),
        ...(init.tolerate ? { tolerate: init.tolerate } : {}),
      },
    );
    return stdout.trim() === "" ? null : JSON.parse(stdout);
  }

  private async restOrNull(path: string): Promise<unknown | null> {
    try {
      return await this.rest(path);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      if (stderr.includes("Not Found") || stderr.includes("HTTP 404")) return null;
      throw error;
    }
  }

  private async gh(
    args: string[],
    options: { input?: string; tolerate?: (stderr: string) => boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runner("gh", args, { env: ghCliEnv(this.token), ...(options.input === undefined ? {} : { input: options.input }) });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (options.tolerate && options.tolerate(stderr)) return { stdout: "", stderr };
      throw error;
    }
  }

  // ---- seeding over REST ----

  async createIssue(input: { title: string; labels?: string[]; closed?: boolean }): Promise<ContractIssue> {
    for (const label of input.labels ?? []) {
      await this.ensureRepoLabel(label);
    }
    const created = (await this.rest(`repos/${this.repo}/issues`, {
      method: "POST",
      input: { title: input.title, body: SMOKE_BODY, labels: input.labels ?? [] },
    })) as { number: number; id: number; created_at: string; labels: { name: string }[] };
    const ref = { repo: this.repo, number: created.number };
    this.journal.issues.push(ref.number);
    this.issueIds.set(ref.number, created.id);
    if (input.closed) {
      await this.rest(`repos/${this.repo}/issues/${ref.number}`, {
        method: "PATCH",
        input: { state: "closed", state_reason: "completed" },
      });
    }
    // label application on the issue itself is authoritative in the POST
    // response (only the label-filtered LISTING lags — GitHub's index);
    // settle on the issue's own labels, polling only when the response lags
    const firstLabel = (input.labels ?? [])[0];
    if (firstLabel !== undefined) {
      await this.settleLabelOnIssue(ref, firstLabel, created.labels?.map((l) => l.name));
    }
    return { ref, createdAt: created.created_at };
  }

  /** The label must be readable back on the issue itself (immediate); the
   *  label-filtered listing may lag — fullCycle's op1 waits for that bounded. */
  private async settleLabelOnIssue(
    ref: IssueRef,
    label: string,
    knownLabels?: string[],
    timeoutMs = 30_000,
  ): Promise<void> {
    if (knownLabels?.includes(label)) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = (await this.rest(`repos/${this.repo}/issues/${ref.number}`)) as {
        labels: { name: string }[];
      };
      if (view.labels.some((l) => l.name === label)) return;
      if (Date.now() > deadline) {
        throw new Error(`issue ${this.repo}#${ref.number} never carries "${label}" (label application lag)`);
      }
      await sleep(5_000);
    }
  }

  private async listingNumbers(label: string): Promise<number[]> {
    // REST listing (gh issue list is GraphQL under the hood — never touched)
    const nodes = (await this.rest(
      `repos/${this.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=500`,
    )) as { number: number }[];
    return nodes.map((item) => item.number);
  }

  async missingRef(): Promise<IssueRef> {
    // the REST listing returns issues only (never PRs), but issues and PRs
    // share the numbering: newest issue number + 1_000_000 is safely missing
    const items = (await this.restOrNull(
      `repos/${this.repo}/issues?state=all&sort=created&direction=desc&per_page=1`,
    )) as { number: number }[] | null;
    const max = items?.[0]?.number ?? 0;
    return { repo: this.repo, number: max + 1_000_000 };
  }

  private async issueId(number: number): Promise<number> {
    const known = this.issueIds.get(number);
    if (known !== undefined) return known;
    const issue = (await this.rest(`repos/${this.repo}/issues/${number}`)) as { id: number };
    this.issueIds.set(number, issue.id);
    return issue.id;
  }

  async addBlocker(ref: IssueRef, blocker: IssueRef): Promise<void> {
    await this.rest(`repos/${this.repo}/issues/${ref.number}/dependencies/blocked_by`, {
      method: "POST",
      input: { issue_id: await this.issueId(blocker.number) },
    });
    this.journal.blockers.push({ issueNumber: ref.number, blockerNumber: blocker.number });
  }

  async addComment(ref: IssueRef, _author: string, body: string): Promise<void> {
    const comment = (await this.rest(`repos/${this.repo}/issues/${ref.number}/comments`, {
      method: "POST",
      input: { body },
    })) as { id: number };
    this.journal.comments.push({ containerNumber: ref.number, commentId: String(comment.id) });
  }

  async ensureBranch(branch: string, baseBranch = "main"): Promise<void> {
    const existed = await this.branchExists(branch);
    if (!existed) {
      const base = (await this.rest(`repos/${this.repo}/git/ref/heads/${baseBranch}`)) as { object: { sha: string } };
      await this.rest(`repos/${this.repo}/git/refs`, {
        method: "POST",
        input: { ref: `refs/heads/${branch}`, sha: base.object.sha },
        tolerate: (stderr) => stderr.includes("Reference already exists"),
      });
      this.journal.branches.add(branch);
    }
    // one commit beyond the base, so a PR can exist
    const path = `msf-smoke/${Date.now()}-${Math.floor(Math.random() * 10_000)}.txt`;
    await this.rest(`repos/${this.repo}/contents/${path}`, {
      method: "PUT",
      input: {
        message: "msf smoke probe commit",
        content: Buffer.from("smoke").toString("base64"),
        branch,
      },
    });
  }

  async createPullRequest(
    issue: IssueRef,
    input?: { headBranch?: string; baseBranch?: string },
  ): Promise<number> {
    const headBranch = input?.headBranch ?? `agent-issue-${issue.number}`;
    const baseBranch = input?.baseBranch ?? (await this.defaultBranch());
    await this.ensureBranch(headBranch, baseBranch);
    const pull = (await this.rest(`repos/${this.repo}/pulls`, {
      method: "POST",
      input: {
        title: `msf smoke: work #${issue.number}`,
        head: headBranch,
        base: baseBranch,
        body: `Closes #${issue.number}\n\n${SMOKE_BODY}`,
      },
    })) as { number: number };
    this.journal.prs.push(pull.number);
    return pull.number;
  }

  async branchExists(branch: string): Promise<boolean> {
    const exists = (await this.restOrNull(`repos/${this.repo}/branches/${branch}`)) !== null;
    if (exists) {
      // journal it: a branch the ADAPTER created (pushBranch) must be reverted too
      this.journal.branches.add(branch);
    }
    return exists;
  }

  async closePullRequest(_issue: IssueRef, prNumber: number): Promise<void> {
    await this.rest(`repos/${this.repo}/pulls/${prNumber}`, {
      method: "PATCH",
      input: { state: "closed" },
    });
  }

  /** The repo's label names — the pre/post inventory for adapter-created labels. */
  async repoLabelNames(): Promise<Set<string>> {
    const nodes = (await this.rest(`repos/${this.repo}/labels?per_page=100`)) as { name: string }[];
    return new Set(nodes.map((n) => n.name));
  }

  /** Delete a repo label — the adapter's ensureLabelExists is OUTSIDE the
   *  journal; the pre/post sweep reverts what IT created. */
  async deleteRepoLabel(label: string): Promise<void> {
    await this.rest(`repos/${this.repo}/labels/${label}`, {
      method: "DELETE",
      tolerate: (stderr) => stderr.includes("Not Found"),
    });
  }

  private async ensureRepoLabel(label: string): Promise<void> {
    // gh prints the 422 body to stdout, not stderr: an existing label answers
    // "Validation Failed (HTTP 422)" — tolerated as already-exists. Only a
    // label WE actually create is journaled: a pre-existing label must never
    // be deleted by the cleanup.
    let alreadyExisted = false;
    await this.rest(`repos/${this.repo}/labels`, {
      method: "POST",
      input: { name: label },
      tolerate: (stderr) => {
        if (/already.?exists|HTTP 422/i.test(stderr)) {
          alreadyExisted = true;
          return true;
        }
        return false;
      },
    });
    if (!alreadyExisted) this.journal.repoLabelsCreated.push(label);
  }

  async defaultBranch(): Promise<string> {
    const repo = (await this.rest(`repos/${this.repo}`)) as { default_branch: string };
    return repo.default_branch;
  }

  // ---- the reversion: every artifact back out of the repo ----

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const containers = [...new Set([...this.journal.issues, ...this.journal.prs])];

    // PRs: closed (GitHub offers no PR deletion)
    for (const pr of this.journal.prs) {
      try {
        const pull = (await this.rest(`repos/${this.repo}/pulls/${pr}`)) as { state: string };
        if (pull.state === "open") {
          await this.rest(`repos/${this.repo}/pulls/${pr}`, { method: "PATCH", input: { state: "closed" } });
        }
      } catch (error) {
        failures.push(`pr #${pr}: ${(error as Error).message}`);
      }
    }

    // branches: deleted
    for (const branch of this.journal.branches) {
      try {
        await this.rest(`repos/${this.repo}/git/refs/heads/${branch}`, {
          method: "DELETE",
          tolerate: (stderr) => stderr.includes("does not exist"),
        });
      } catch (error) {
        failures.push(`branch ${branch}: ${(error as Error).message}`);
      }
    }

    // comments: deleted straight from the journal (the ids were captured at
    // creation — no listing round-trip; each DELETE's 204 is its own proof)
    for (const { containerNumber, commentId } of this.journal.comments) {
      try {
        await this.rest(`repos/${this.repo}/issues/comments/${commentId}`, { method: "DELETE" });
      } catch (error) {
        failures.push(`comment ${commentId} (on #${containerNumber}): ${(error as Error).message}`);
      }
    }

    // issues: blockers unlinked (only where journaled), then labels +
    // assignees cleared and closed in ONE patch
    for (const issue of this.journal.issues) {
      try {
        const hasBlockers = this.journal.blockers.some((b) => b.issueNumber === issue);
        if (hasBlockers) {
          const blockers = (await this.restOrNull(
            `repos/${this.repo}/issues/${issue}/dependencies/blocked_by`,
          )) as { id: number }[] | null;
          for (const blocker of blockers ?? []) {
            await this.rest(`repos/${this.repo}/issues/${issue}/dependencies/blocked_by/${blocker.id}`, {
              method: "DELETE",
            });
          }
        }
        await this.rest(`repos/${this.repo}/issues/${issue}`, {
          method: "PATCH",
          input: { labels: [], assignees: [], state: "closed", state_reason: "not_planned" },
        });
      } catch (error) {
        failures.push(`issue #${issue}: ${(error as Error).message}`);
      }
    }

    // repo labels we created: deleted
    for (const label of [...new Set(this.journal.repoLabelsCreated)]) {
      try {
        await this.rest(`repos/${this.repo}/labels/${label}`, {
          method: "DELETE",
          tolerate: (stderr) => stderr.includes("Not Found"),
        });
      } catch (error) {
        failures.push(`repo label ${label}: ${(error as Error).message}`);
      }
    }

    // verification pass: nothing left behind (state/labels/assignees/PR/branch
    // re-reads; the comment deletions above are proven by their own 204s)
    for (const issue of this.journal.issues) {
      try {
        const view = (await this.rest(`repos/${this.repo}/issues/${issue}`)) as {
          state: string;
          labels: unknown[];
          assignees: unknown[];
        };
        if (view.state !== "closed") failures.push(`issue #${issue} still open`);
        if (view.labels.length !== 0) failures.push(`issue #${issue} still has labels`);
        if (view.assignees.length !== 0) failures.push(`issue #${issue} still has assignees`);
      } catch (error) {
        failures.push(`issue #${issue} verification: ${(error as Error).message}`);
      }
    }
    for (const pr of this.journal.prs) {
      try {
        const pull = (await this.rest(`repos/${this.repo}/pulls/${pr}`)) as { state: string };
        if (pull.state !== "closed") failures.push(`pr #${pr} still open`);
      } catch (error) {
        failures.push(`pr #${pr} verification: ${(error as Error).message}`);
      }
    }
    for (const branch of this.journal.branches) {
      if (await this.branchExists(branch)) failures.push(`branch ${branch} still exists`);
    }
    for (const label of [...new Set(this.journal.repoLabelsCreated)]) {
      if ((await this.restOrNull(`repos/${this.repo}/labels/${label}`)) !== null) {
        failures.push(`repo label ${label} still exists`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`reversion incomplete:\n  - ${failures.join("\n  - ")}`);
    }
    console.log(`  ✔ reverted: ${this.journal.issues.length} issue(s) closed, ${this.journal.prs.length} PR(s) closed, ${this.journal.branches.size} branch(es) deleted, all comments/labels/assignees/blockers removed`);
    this.journal.issues = [];
    this.journal.prs = [];
    this.journal.branches = new Set();
    this.journal.comments = [];
    this.journal.blockers = [];
    this.journal.repoLabelsCreated = [];
    this.issueIds.clear();
  }
}

/** The full cycle of one issue: every operation executed, verified — reverted by cleanup. */
async function fullCycle(harness: RealGithubHarness, adapter: TrackerPort): Promise<void> {
  const repo = harness.repo;
  const account = harness.workerAccount;

  // seed
  const issue = await harness.createIssue({ title: "msf t16 smoke: full cycle", labels: [DEFAULT_LABELS.ready] });
  const blocker = await harness.createIssue({ title: "msf t16 smoke: blocker", closed: true });
  await harness.addBlocker(issue.ref, blocker.ref);
  console.log(`seeded issue ${repo}#${issue.ref.number} with blocker #${blocker.ref.number} (closed)`);

  // 1. candidates: the issue appears, with createdAt for age priority.
  // The label-filtered listing is GitHub's search index — a FRESH issue can
  // lag minutes; bounded wait (30s interval), then an honest failure.
  let candidate: Candidate | undefined;
  const listingDeadline = Date.now() + 150_000;
  for (;;) {
    const candidates = await adapter.listCandidates(repo, DEFAULT_LABELS.ready);
    candidate = candidates.find((c) => c.ref.number === issue.ref.number);
    if (candidate) break;
    if (Date.now() > listingDeadline) {
      throw new Error("op1: the seeded issue never reached the ready-label listing within 150s (index lag)");
    }
    console.log("op1 waiting: the label-filtered listing lags for fresh issues (30s)…");
    await sleep(30_000);
  }
  console.log(`op1 EXECUTED+VERIFIED: listCandidates → ${repo}#${candidate.ref.number} createdAt ${candidate.createdAt}`);

  // 2. read the issue
  const snapshot = await adapter.readIssue(issue.ref);
  if (!snapshot.known || snapshot.value.title !== "msf t16 smoke: full cycle") {
    throw new Error("op2: snapshot mismatch");
  }
  console.log("op2 EXECUTED+VERIFIED: readIssue → title, state, labels, createdAt");

  // 3. native blockers, closed via the API
  const blockers = await adapter.readBlockers(issue.ref);
  if (!blockers.known || blockers.value.length !== 1 || blockers.value[0]?.state !== "closed") {
    throw new Error("op3: blockers mismatch");
  }
  console.log("op3 EXECUTED+VERIFIED: readBlockers → native blocked_by, terminal (closed)");

  // 4. claim — WITH the ready label this time: the reservation is the swap
  // (ready→claimed), ticket 12's mirrored composite write on the real repo
  await adapter.claim(issue.ref, account, DEFAULT_LABELS.ready);
  const claimed = await adapter.readIssue(issue.ref);
  if (
    !claimed.known ||
    !claimed.value.labels.includes(DEFAULT_LABELS.claimed) ||
    claimed.value.labels.includes(DEFAULT_LABELS.ready) ||
    claimed.value.assignees[0] !== account
  ) {
    throw new Error("op4: claim swap not visible in the re-read");
  }
  console.log(`op4 EXECUTED+VERIFIED: claim → ready swapped away, label ${DEFAULT_LABELS.claimed} + assignee ${account}`);

  // 5. release — with the ready label: the 1st-fall swap BACK (claimed→ready,
  // ticket 13's mirrored composite write on the real repo)
  await adapter.releaseClaim(issue.ref, account, DEFAULT_LABELS.ready);
  const released = await adapter.readIssue(issue.ref);
  if (
    !released.known ||
    released.value.labels.includes(DEFAULT_LABELS.claimed) ||
    !released.value.labels.includes(DEFAULT_LABELS.ready) ||
    released.value.assignees.length !== 0
  ) {
    throw new Error("op5: release swap not visible in the re-read");
  }
  console.log("op5 EXECUTED+VERIFIED: releaseClaim → claimed swapped away, the ready label back, assignee gone");
  await adapter.claim(issue.ref, account);

  // 5b. block — the 2nd-consecutive-fall swap (claimed→blocked, the claim held)
  await adapter.blockClaim(issue.ref, DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked);
  const blockedState = await adapter.readIssue(issue.ref);
  if (
    !blockedState.known ||
    blockedState.value.labels.includes(DEFAULT_LABELS.claimed) ||
    !blockedState.value.labels.includes(DEFAULT_LABELS.blocked) ||
    blockedState.value.assignees[0] !== account
  ) {
    throw new Error("op5b: block swap not visible in the re-read");
  }
  console.log(`op5b EXECUTED+VERIFIED: blockClaim → claimed swapped away, label ${DEFAULT_LABELS.blocked} on, claim held`);

  // 9c. push the work branch via git, credential helper baked into the clone
  const branch = `agent-issue-${issue.ref.number}`;
  await adapter.pushBranch({ repo, branch });
  if (!(await harness.branchExists(branch))) throw new Error("op9c: branch not on the remote");
  console.log(`op9c EXECUTED+VERIFIED: pushBranch → ${branch} on the remote (git, bot credential)`);
  // the branch needs a commit beyond the base for a PR to exist
  await harness.ensureBranch(branch);

  // 9b. open the PR
  const pr = await adapter.openPr({
    repo,
    issueNumber: issue.ref.number,
    headBranch: branch,
    baseBranch: await harness.defaultBranch(),
    title: `work #${issue.ref.number}`,
  });
  console.log(`op9b EXECUTED: openPr → ${repo}#${pr.number}`);

  // 9a. PR feedback: conversation comment + re-read
  await harness.addComment({ repo, number: pr.number }, "a-human", "smoke: PR feedback");
  const feedback = await adapter.readPrFeedback(issue.ref);
  if (!feedback.known || feedback.value.pr?.number !== pr.number || feedback.value.pr?.state !== "open") {
    throw new Error("op9a: PR feedback mismatch");
  }
  if (!feedback.value.comments.some((c) => c.body === "smoke: PR feedback")) {
    throw new Error("op9a: PR conversation comment missing");
  }
  console.log(`op9a EXECUTED+VERIFIED: readPrFeedback → PR #${feedback.value.pr.number} open, conversation readable`);

  // 7. comment on the issue (the port carries the marker)
  await adapter.comment(issue.ref, "smoke: blocked valve test");
  // 8. read comments back (a seeded "human" one plus ours)
  await harness.addComment(issue.ref, "a-human", "smoke: human note");
  const comments = await adapter.readComments(issue.ref);
  if (!comments.known) throw new Error("op8: comments unknown");
  if (!comments.value.some((c) => c.body === "smoke: human note")) throw new Error("op8: human comment missing");
  if (!comments.value.some((c) => c.body.startsWith(AGENT_MARKER) && c.body.includes("smoke: blocked valve test"))) {
    throw new Error("op7: marked comment missing");
  }
  console.log("op7+op8 EXECUTED+VERIFIED: comment → marker carried; readComments → both readable");

  // derivation over the real adapter: the pool derivation of ticket 11 —
  // the blocked claim holds the work out of the pool (the ready label came
  // back in op5, but the claim's assignee is held until the terminal state)
  const pool = await derivePool(adapter, [repo], DEFAULT_LABELS);
  if (pool.some((entry) => entry.ref.number === issue.ref.number)) {
    throw new Error("derive: the blocked claim must NOT be eligible");
  }
  console.log("extra EXECUTED+VERIFIED: derivePool over the real adapter → the blocked claim kept out of the pool");

  // 6. done
  await adapter.markDone(issue.ref);
  const done = await adapter.readIssue(issue.ref);
  if (!done.known || done.value.state !== "closed" || done.value.stateReason !== "completed") {
    throw new Error("op6: done not visible in the re-read");
  }
  console.log("op6 EXECUTED+VERIFIED: markDone → closed as completed");

  // rank: the honest null
  const rank = await adapter.rank(issue.ref);
  if (!rank.known || rank.value !== null) throw new Error("rank: not known-null");
  console.log("rank EXECUTED+VERIFIED: known(null) — priority is age");
}

async function main(): Promise<void> {
  const repo = process.env.MSF_SMOKE_REPO ?? "Sanmoo/my-tasks";
  const account = process.env.MSF_SMOKE_ACCOUNT ?? "bot-do-samuca";

  console.log(`smoke: ticket 16 — the real GitHub adapter, over ${repo} as ${account}`);

  let token: string;
  try {
    token = await readGhToken(account);
  } catch (error) {
    console.log(`SKIPPED: credential unavailable — ${(error as Error).message}`);
    console.log("nothing was executed; nothing to revert");
    return;
  }

  // the rate gate: GET /rate_limit is free; the cycle must fit the hour window
  const budget = await restBudget(token);
  if (budget.remaining < PLANNED_REST_CALLS) {
    const minutes = Math.max(0, Math.round((budget.resetAt - Date.now()) / 60_000));
    console.log(
      `SKIPPED: REST budget cannot host the full cycle — ${budget.remaining}/${budget.limit} remaining, ` +
        `the cycle is planned for ~${PLANNED_REST_CALLS} calls, window resets in ~${minutes} min. ` +
        `Run again in the fresh window: npm run smoke:github`,
    );
    console.log("nothing was executed; nothing to revert");
    return;
  }
  console.log(`budget gate: ${budget.remaining}/${budget.limit} REST calls remaining — the cycle plans ~${PLANNED_REST_CALLS}`);

  const clonesDir = mkdtempSync(join(tmpdir(), "msf-smoke-clones-"));
  const adapter = await createGitHubAdapter({ account, clonesDir });
  const harness = new RealGithubHarness(repo, account, DEFAULT_LABELS.claimed, adapter, token);

  // the pre/post label inventory: the ADAPTER's ensureLabelExists creates repo
  // labels outside the harness's journal — anything new in the smoke's label
  // vocabulary is reverted here, whoever created it
  const vocabulary = new Set([DEFAULT_LABELS.ready, DEFAULT_LABELS.claimed, DEFAULT_LABELS.blocked]);
  let labelsBefore: Set<string>;
  try {
    labelsBefore = await harness.repoLabelNames();
  } catch (error) {
    console.error(`smoke FAILED: the label inventory read failed: ${(error as Error).message}`);
    rmSync(clonesDir, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    console.log("\n== full cycle: every operation executed, verified — reverted at the end ==");
    await fullCycle(harness, adapter);
    console.log("\n== reversion ==");
    await harness.cleanup();
    console.log("smoke PASSED: all operations executed and verified; nothing left behind in the repo");
  } catch (error) {
    console.log("\n== reversion (after a failure) ==");
    try {
      await harness.cleanup();
      console.log("reversion completed despite the failure above");
    } catch (cleanupError) {
      console.error(`ADDITIONALLY, reversion failed: ${(cleanupError as Error).message}`);
    }
    throw error;
  } finally {
    try {
      const labelsAfter = await harness.repoLabelNames();
      for (const label of labelsAfter) {
        if (!labelsBefore.has(label) && vocabulary.has(label)) {
          await harness.deleteRepoLabel(label);
          console.log(`  ✔ reverted: repo label "${label}" (created by the adapter this run)`);
        }
      }
    } catch (sweepError) {
      console.error(`ADDITIONALLY, the adapter-created label sweep failed: ${(sweepError as Error).message}`);
    }
    rmSync(clonesDir, { recursive: true, force: true });
  }
}

/** The free rate-limit read: how many REST calls the hour window still allows. */
async function restBudget(token: string): Promise<{ remaining: number; limit: number; resetAt: number }> {
  const { stdout } = await defaultCommandRunner(
    "gh",
    ["api", "rate_limit", "--jq", ".resources.core"],
    { env: ghCliEnv(token) },
  );
  const core = JSON.parse(stdout) as { remaining: number; limit: number; reset: number };
  return { remaining: core.remaining, limit: core.limit, resetAt: core.reset * 1000 };
}

main().catch((error: unknown) => {
  console.error(`smoke FAILED: ${(error as Error).message}`);
  process.exit(1);
});
