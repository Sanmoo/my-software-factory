import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, installGhShim, type GhShim, type RestAnswer } from "./cli-harness.js";
import { githubWork } from "./work-fixtures.js";
import { PAUSE_FILENAME, clearPause, writePause } from "../runtime/continuity-artifacts.js";
import { workspaceLayout, workDir, SESSIONS_SUBDIR, type WorkspaceLayout } from "../layout.js";

/**
 * `msf status` at the CLI seam over the REAL adapter: the spawned
 * command reads the tracker through a hermetic `gh` whose REST answers the
 * suite declares, so the complete report — derivation on demand, registry scan,
 * repository state, caps, reconciliation and archive — is exercised without
 * GitHub, credentials or network. The local registry is seeded with the
 * volumes of the operator's reported example (interrupted attempts, a repair
 * cycle, a concluded attempt, a bare reservation, 20 archived works).
 *
 * Docker is answered by a failing shim: liveness is deterministically unknown,
 * the registry-only view stands, and no work is ever called Orphaned by
 * absence of the service (ADR 0002). The Running/Orphaned split is covered
 * with controlled probes in state/status.test.ts.
 *
 * Issue 175: work #1 carries an ACTIVE continuity pause naming attempt 2 while
 * the ledger evidences only attempt 1 (the launch planned it and continuity
 * refused before the runtime spawned), so the report must name the cause, the
 * work, the session and both attempts. Work #2 carries the `pausa.json.resolved`
 * of a pause that is over: a resolved pause is never an active one.
 */

const REPO = "Sanmoo/my-tasks";
const ARCHIVED = 20;
/** The active pause's own facts — distinctive strings, so an assertion cannot
 *  pass on another pause's text. */
const PAUSE_DETAIL = "the push to the work branch may or may not have landed";
const PAUSE_SESSION = "sess-8f31";
/** The resolved pause's detail: it must never reach the report. */
const RESOLVED_DETAIL = "the resolved pause's own diagnosis";

describe("e2e: msf status over the real adapter — complete report, read-only, REST-answered", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-status-rest-"));
    layout = workspaceLayout(join(dir, "ws"));
    seedRegistry();
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        `repos: [${REPO}]`,
        `workspace: ${layout.root}`,
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The registry the operator's report describes: two interrupted attempts
   *  (one of them inside a repair cycle), one concluded attempt, one bare
   *  reservation and 20 archived works, plus an active and a resolved
   *  continuity pause. Only what status reads exists. */
  function seedRegistry(): void {
    for (const number of [1, 4]) {
      const work = workDir(layout, REPO, number);
      mkdirSync(join(work, SESSIONS_SUBDIR), { recursive: true });
      writeFileSync(join(work, "log-1.jsonl"), "{}\n", "utf8");
    }
    // Work #1 waits for the operator: the launch planned attempt 2 and
    // continuity refused it before the runtime could write that attempt's log.
    writePause(workDir(layout, REPO, 1), {
      version: 1,
      work: githubWork(REPO, 1),
      attempt: 2,
      reason: "effect-ambiguous",
      detail: PAUSE_DETAIL,
      at: "2026-02-01T00:00:00.000Z",
      sessionId: PAUSE_SESSION,
      announced: true,
    });
    writeFileSync(
      join(workDir(layout, REPO, 4), "reparo.json"),
      JSON.stringify({
        usedRounds: 1,
        lastEvidence: "conflicts:head",
        consecutiveFalls: 0,
        attempt: {
          evidence: "conflicts:head",
          attempt: 1,
          observedHeadSha: "0123456789abcdef0123456789abcdef01234567",
          remoteHeadSha: null,
          publication: "not-published",
          localWork: null,
        },
      }),
      "utf8",
    );
    const concluded = workDir(layout, REPO, 2);
    mkdirSync(join(concluded, SESSIONS_SUBDIR), { recursive: true });
    writeFileSync(join(concluded, "log-1.jsonl"), "{}\n", "utf8");
    writeFileSync(
      join(concluded, "desfecho.json"),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );
    // A pause that was resolved keeps its evidence beside the work and is
    // NEVER an active pause.
    writePause(concluded, {
      version: 1,
      work: githubWork(REPO, 2),
      attempt: 4,
      reason: "session-unreadable",
      detail: RESOLVED_DETAIL,
      at: "2026-02-01T00:00:00.000Z",
    });
    clearPause(concluded);
    mkdirSync(workDir(layout, REPO, 3), { recursive: true });
    for (let index = 0; index < ARCHIVED; index += 1) {
      mkdirSync(join(layout.archive, `${REPO}#${101 + index}-2026-02-01`), { recursive: true });
    }
  }

  function archivedPath(number: number): string {
    return join(layout.archive, `${REPO}#${number}-2026-02-01`);
  }

  /** The tracker's open state: candidates with closed/open/unknown blockers, a
   *  claim without a reservation, a reservation without a mark, an assigned
   *  work and a work already linked by an open PR. */
  function restAnswers(): Record<string, RestAnswer> {
    const issue = (
      number: number,
      createdAt: string,
      labels: string[],
      assignees: string[] = [],
    ) => ({
      number,
      title: `issue ${number}`,
      created_at: createdAt,
      labels: labels.map((name) => ({ name })),
      assignees: assignees.map((login) => ({ login })),
    });
    const ready = "ready-for-agent";
    const claimed = "agent-claimed";
    return {
      [`repos/${REPO}/issues?state=open&per_page=500`]: {
        body: [
          issue(11, "2026-02-02T00:00:00Z", [ready]),
          issue(10, "2026-02-01T00:00:00Z", [ready]),
          issue(12, "2026-02-03T00:00:00Z", [ready]),
          issue(13, "2026-02-04T00:00:00Z", [ready]),
          issue(14, "2026-02-05T00:00:00Z", [ready, claimed], ["bot-do-samuca"]),
          issue(16, "2026-02-06T00:00:00Z", [ready], ["someone"]),
          issue(17, "2026-02-07T00:00:00Z", [ready]),
          issue(3, "2026-02-08T00:00:00Z", []),
        ],
      },
      [`repos/${REPO}/pulls?state=open&per_page=100`]: {
        body: [{ number: 900, body: "Closes #17" }],
      },
      // Both blockers closed: eligible. A history of blockers still resolves.
      [`repos/${REPO}/issues/10/dependencies/blocked_by`]: {
        body: [
          { number: 100, state: "closed" },
          { number: 101, state: "closed" },
        ],
      },
      // No blockers: eligible.
      [`repos/${REPO}/issues/11/dependencies/blocked_by`]: { body: [] },
      // An open blocker: not eligible.
      [`repos/${REPO}/issues/12/dependencies/blocked_by`]: { body: [{ number: 102, state: "open" }] },
      // Unreadable blockers: unknown is never "without impediment".
      [`repos/${REPO}/issues/13/dependencies/blocked_by`]: { notFound: true },
    };
  }

  /** Docker is not reachable: the probe fails, liveness is unknown. */
  function dockerDown(binDir: string): void {
    const shim = join(binDir, "docker");
    writeFileSync(shim, "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n", "utf8");
    chmodSync(shim, 0o755);
  }

  /** The spawned CLI's environment: the canned REST channel, Docker down. */
  function statusShim(answers: Record<string, RestAnswer> = restAnswers()): GhShim {
    const shim = installGhShim(dir, { rest: answers });
    dockerDown(shim.binDir);
    return shim;
  }

  function runStatus(args: string[]): {
    stdout: string;
    stderr: string;
    status: number | null;
    restCalls: string[];
  } {
    const shim = statusShim();
    return { ...runCli(dir, ["status", ...args], shim.env()), restCalls: shim.restCalls() };
  }

  function expectedReport(cap: number): string {
    const archived = Array.from({ length: ARCHIVED }, (_value, index) => `  ${archivedPath(101 + index)}`);
    const shown = archived.slice(0, cap);
    return [
      "msf status (derived on demand — the factory may be stopped)",
      "running (worker alive): liveness unknown (docker not reachable)",
      "duplicate workers (more than one container for the same work — a human decision is needed): liveness unknown (docker not reachable)",
      "orphaned (attempt interrupted — no outcome record of its own, no worker alive): liveness unknown (docker not reachable)",
      "interrupted attempts without their own outcome (Running or Orphaned — only Docker can tell): 1",
      `  ${REPO}#4 (attempt 1 was interrupted — no outcome record on disk)`,
      "reserved without attempt (the claim landed, no attempt evidence on disk): 1",
      `  ${REPO}#3`,
      "recovery (what ended the last stop: the operator's requested stop — confirmed or not — an interruption absorbed by its budget, or a failure that consumed the attempt): none",
      "model provider (the last attempt ended by a model provider failure — not an interruption of the agent): none",
      "continuity paused (the interrupted attempt cannot be continued safely — waiting for the operator): 1",
      `  ${REPO}#1 (planned attempt 2; last evidenced attempt 1; session ${PAUSE_SESSION}: effect-ambiguous — ${PAUSE_DETAIL})`,
      "repair (unpublished attempts, local work, pending reconciliation): 1",
      `  ${REPO}#4 (rounds 1/2; falls 0/2; attempt 1: not published (the remote does not carry the attempt's commit); local work: the local work could not be read; evidence: reservation trabalhos/${REPO}#4/ present, event log trabalhos/${REPO}#4/log-1.jsonl present, sandcastle log trabalhos/${REPO}#4/sessao/sandcastle-1.log absent)`,
      "last outcome: 1",
      `  ${REPO}#2 = pr-open (attempt 1)`,
      "pool (eligible): 2",
      `  ${REPO}#10`,
      `  ${REPO}#11`,
      `archived (dones): ${ARCHIVED}`,
      ...shown,
      ...(shown.length < archived.length ? [`  … and ${archived.length - shown.length} more`] : []),
      "reconciliation: 2",
      `  unbacked claim: ${REPO}#14 — a factory mark on an open issue with no reservation in this workspace (another factory or workspace may hold this claim — confirm before releasing); return it to the pool with: gh issue edit 14 --repo ${REPO} --remove-label agent-claimed --remove-assignee bot-do-samuca`,
      `  unmarked reservation: ${REPO}#3 — the work dir exists but the tracker carries no factory mark (no claim, no block, no pool label); the decision is human, nothing was touched`,
      "", // console.log ends the report with a newline
    ].join("\n");
  }

  test("the complete report derives on demand from the declared reads — and changes nothing on disk", () => {
    assert.ok(!existsSync(layout.repos), "the workspace has no repos/ dir before the run");
    const before = readdirSync(layout.root, { recursive: true }).sort();

    const result = runStatus([]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, expectedReport(10), "the default view: every section, capped once");
    assert.ok(!existsSync(layout.repos), "status never ensures the workspace");
    assert.deepEqual(
      readdirSync(layout.root, { recursive: true }).sort(),
      before,
      "the read-only query leaves the workspace as it found it",
    );
  });

  test("an active pause is shown with cause, work, session and both attempts — and status repairs nothing", () => {
    const paused = workDir(layout, REPO, 1);
    const resolvedDir = workDir(layout, REPO, 2);
    const recordBefore = readFileSync(join(paused, PAUSE_FILENAME), "utf8");
    const resolvedBefore = readFileSync(join(resolvedDir, `${PAUSE_FILENAME}.resolved`), "utf8");
    const treeBefore = readdirSync(layout.root, { recursive: true }).sort();

    const result = runStatus([]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(
      result.stdout,
      /continuity paused \(the interrupted attempt cannot be continued safely — waiting for the operator\): 1/,
    );
    assert.ok(
      result.stdout.includes(
        `${REPO}#1 (planned attempt 2; last evidenced attempt 1; session ${PAUSE_SESSION}: effect-ambiguous — ${PAUSE_DETAIL})`,
      ),
      `the pause's cause, work, session and BOTH attempts are named: ${result.stdout}`,
    );
    // The pause's own section owns the work: it is not also an interruption.
    assert.ok(!result.stdout.includes(`${REPO}#1 (attempt 1 was interrupted`), "one line per wait, never two");
    // A resolved pause is not an active one, and its diagnosis is not surfaced.
    assert.ok(!result.stdout.includes(RESOLVED_DETAIL), "a resolved pause never reappears as active");

    // Read-only, byte for byte. The tracker side is the shim's: an undeclared
    // path — any mutation — fails the child loudly, and this run read only.
    assert.equal(readFileSync(join(paused, PAUSE_FILENAME), "utf8"), recordBefore, "status never rewrites the pause");
    assert.equal(
      readFileSync(join(resolvedDir, `${PAUSE_FILENAME}.resolved`), "utf8"),
      resolvedBefore,
      "the resolved evidence is left exactly as it was",
    );
    assert.deepEqual(
      readdirSync(layout.root, { recursive: true }).sort(),
      treeBefore,
      "no artifact was created, renamed, resolved or removed",
    );
  });

  test("--all lifts the caps for the same workload — every archived work is shown", () => {
    const result = runStatus(["--all"]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, expectedReport(Number.POSITIVE_INFINITY));
    assert.doesNotMatch(result.stdout, /… and \d+ more/, "--all omits nothing");
    assert.match(result.stdout, new RegExp(`${REPO}#120-2026-02-01`), "the last archived work is shown");
  });

  test("the derivation still reads every candidate's blockers — and only those", () => {
    const { restCalls } = runStatus([]);
    assert.deepEqual(
      restCalls.sort(),
      [
        `repos/${REPO}/issues?state=open&per_page=500`,
        `repos/${REPO}/pulls?state=open&per_page=100`,
        `repos/${REPO}/issues/10/dependencies/blocked_by`,
        `repos/${REPO}/issues/11/dependencies/blocked_by`,
        `repos/${REPO}/issues/12/dependencies/blocked_by`,
        `repos/${REPO}/issues/13/dependencies/blocked_by`,
      ].sort(),
      "one listing pass, and one blocker read per candidate — never a skipped check, never an extra one",
    );
  });

  test("a failing tracker read is an explicit failure, never an incomplete report", () => {
    const answers = restAnswers();
    answers[`repos/${REPO}/issues?state=open&per_page=500`] = { failure: "HTTP 500: server error" };

    const result = runCli(dir, ["status"], statusShim(answers).env());

    assert.notEqual(result.status, 0, "a tracker failure fails the command");
    assert.equal(result.stdout, "", "no partial status is presented as complete");
    assert.match(result.stderr, /HTTP 500: server error/);
  });
});
