import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { WORKER_IMAGE } from "../worker-image.js";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadConfig } from "../config.js";
import { ensureWorkspace, workDir } from "../layout.js";
import { recoverCall, processRecoveryRequests } from "../recover.js";
import { acquireRunLock } from "../run-lock.js";
import { runOnce } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import type { GitWork } from "../git/port.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { authorizeCallRecovery, CALL_RECOVERY_FILENAME, readCallRecoveries, recoveryConsumption, reviewCallRecovery } from "../runtime/call-recovery.js";
import { appendJournalIntent, appendJournalResult, appendJournalStart, clearPause, readEffectJournal, readPause, writeGuardrailState, writePause } from "../runtime/continuity-artifacts.js";
import { installGuardrail, type GuardrailApi, type GuardrailBlock, type ToolCallLike, type ToolResultLike } from "../runtime/guardrail/extension.js";
import { buildWorkerPrompt } from "../runtime/prompt.js";
import { seedExtraToolResult, seedSession, seedSessionToolCall } from "./session-fixtures.js";
import { githubWork } from "./work-fixtures.js";

const REPO = "Sanmoo/recovery";
const key = `${REPO}#7`;
const work = githubWork(REPO, 7);
const command = "node /tmp/diagnostic.mjs";
let root: string;
let target: string;
let config: ReturnType<typeof loadConfig>;
let layout: ReturnType<typeof ensureWorkspace>;
let session: ReturnType<typeof seedSession>;

beforeEach(() => {
  const base = existsSync("/.dockerenv") ? execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim() : tmpdir();
  root = mkdtempSync(join(base, "msf-call-recovery-"));
  const path = join(root, "msf.yaml");
  writeFileSync(path, `worker-gh-account: bot\nworker-model: test/model\nrepos: [${REPO}]\nworkspace: ${join(root, "ws")}\nrecovery:\n  waits-ms: [0, 0, 0]\n`);
  config = loadConfig(path);
  layout = ensureWorkspace(config.workspace);
  target = workDir(layout, REPO, 7);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "log-2.jsonl"), '{"event":"session-start","attempt":2}\n');
  session = seedSession(target, work, 2);
  seedSessionToolCall(session, { callId: "old", command, answered: false });
  appendJournalStart(target, { attempt: 2, sessionId: session.sessionId });
  appendJournalIntent(target, { attempt: 2, sessionId: session.sessionId, callId: "old", command, tool: "bash", safety: "unknown", actions: [] });
  writePause(target, { version: 1, work, attempt: 3, id: "pause-1", sessionId: session.sessionId, reason: "effect-unsupported", detail: "interrupted", at: "2026-01-01T00:00:00Z", announced: true });
  writeGuardrailState(target, { version: 1, mode: "resume", attempt: 2, sessionId: session.sessionId, verdicts: {}, at: "2026-01-01T00:00:00Z" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function authorize() {
  return authorizeCallRecovery(target, work, 2, { review: reviewCallRecovery(target, work, 2).review, actor: "operator", reason: "Reviewed diagnostic and accept partial repetition", acceptedDuplicateRisk: true });
}
function guard() {
  let toolCall: (event: ToolCallLike) => GuardrailBlock | undefined | Promise<GuardrailBlock | undefined> = () => undefined;
  let toolResult: (event: ToolResultLike) => void | Promise<void> = () => {};
  const api = { on: (event: string, handler: unknown) => {
    if (event === "tool_call") toolCall = handler as typeof toolCall;
    if (event === "tool_result") toolResult = handler as typeof toolResult;
    return () => {};
  } } as GuardrailApi;
  installGuardrail(api, { workMount: target });
  return {
    call: (id: string, text = command, cwd = "/fake/worker") => toolCall({ type: "tool_call", toolCallId: id, toolName: "bash", input: { command: text, cwd } }),
    tool: (id: string, input: Record<string, unknown>) => toolCall({ type: "tool_call", toolCallId: id, toolName: "subagent", input }),
    result: (id: string) => toolResult({ type: "tool_result", toolCallId: id, toolName: "bash", isError: false }),
  };
}

test("a legacy interrupted subagent has an exact, single-use recovery with its original input", async () => {
  const input = { agent: "code-reviewer", task: "Review the preserved branch", async: false, cwd: "/fake/worker" };
  session = seedSession(target, work, 2);
  seedSessionToolCall(session, { callId: "old", tool: "subagent", command: "", input, answered: false });
  writeFileSync(join(target, "efeitos.jsonl"), "");
  appendJournalStart(target, { attempt: 2, sessionId: session.sessionId });
  appendJournalIntent(target, { attempt: 2, sessionId: session.sessionId, callId: "old", tool: "subagent", command: "", safety: "unknown", actions: [] });
  assert.match(await recoverCall(config, key), /subagent/);
  const authorized = authorize();
  assert.equal(readEffectJournal(target).results.length, 0, "consent is not an outcome");
  const guarded = guard();
  assert.ok(await guarded.tool("changed", { ...input, task: "Different work" }));
  assert.equal(await guarded.tool("retry", { cwd: input.cwd, async: false, task: input.task, agent: input.agent }), undefined);
  assert.equal(recoveryConsumption(readEffectJournal(target), authorized)?.callId, "retry");
  assert.ok(await guard().tool("again", input), "another process cannot reuse consent");
  assert.equal(readEffectJournal(target).results.length, 0);
});

test("an ambiguous guarded child's command can be retried by its owning session, never as invented child output", async () => {
  session = seedSession(target, work, 2);
  seedSessionToolCall(session, { callId: "delegate", command: "", tool: "subagent", input: { agent: "code-reviewer", task: "review", async: false }, answered: false });
  const child = seedSession(join(target, "sessao", "child"), work, 2, { sessionId: "22222222-2222-4222-8222-222222222222" });
  seedSessionToolCall(child, { callId: "old", command, answered: false });
  writeFileSync(join(target, "efeitos.jsonl"), "");
  appendJournalStart(target, { attempt: 2, sessionId: session.sessionId });
  appendJournalIntent(target, { attempt: 2, sessionId: session.sessionId, callId: "delegate", tool: "subagent", command: "", safety: "unknown", actions: [], delegation: "guarded-v1" });
  appendJournalStart(target, { attempt: 2, sessionId: child.sessionId, childOf: session.sessionId });
  appendJournalIntent(target, { attempt: 2, sessionId: child.sessionId, callId: "old", tool: "bash", command, safety: "unknown", actions: [] });
  writePause(target, { ...readPause(target)!, sessionId: child.sessionId });
  const record = authorize();
  assert.equal(record.sessionId, child.sessionId, "the source of the doubt stays the child");
  assert.equal(await guard().call("retry-child-command"), undefined);
  assert.equal(recoveryConsumption(readEffectJournal(target), record)?.sessionId, session.sessionId);
  assert.equal(readEffectJournal(target).results.length, 0, "neither child's nor parent's original result is fabricated");
  assert.ok(await guard().call("repeat-child-command"));
});

test("preview is read-only and approval keeps the original result unknown with an auditable reason", async () => {
  const before = readFileSync(join(target, "efeitos.jsonl"), "utf8");
  const preview = await recoverCall(config, key);
  assert.match(preview, /may have executed partially/);
  assert.match(preview, /node \/tmp\/diagnostic.mjs/);
  assert.match(preview, /interrupted attempt 2/);
  assert.deepEqual(readCallRecoveries(target), []);
  const token = reviewCallRecovery(target, work, 2).review;
  await recoverCall(config, key, { retry: token, reason: "inspected diagnostic", acceptDuplicateRisk: true }, { probe: async () => [], actor: "human" });
  const record = readCallRecoveries(target)[0]!;
  assert.equal(record.pauseId, "pause-1");
  assert.equal(record.actor, "human");
  assert.equal(record.attempt, 2, "not planned attempt 3");
  assert.equal(readFileSync(join(target, "efeitos.jsonl"), "utf8"), before);
  assert.equal(readEffectJournal(target).results.length, 0, "consent never invents a terminal result");
});

test("approval queues for the active run but refuses live worker, unknown Docker, stale review and missing consent", async () => {
  const token = reviewCallRecovery(target, work, 2).review;
  const consent = { retry: token, reason: "inspected", acceptDuplicateRisk: true };
  const lock = await acquireRunLock(config.configPath);
  try {
    assert.match(await recoverCall(config, key, consent, { probe: async () => [] }), /queued/);
    assert.deepEqual(readCallRecoveries(target), [], "a request is not authorization until the owner rechecks it");
  }
  finally { await lock.close(); }
  await assert.rejects(recoverCall(config, key, consent, { probe: async () => [{ key, ageMs: 1, containerId: "live" }] }), /alive/);
  await assert.rejects(recoverCall(config, key, consent, { probe: async () => { throw new Error("Docker unavailable"); } }), /unknown/);
  await assert.rejects(recoverCall(config, key, { ...consent, acceptDuplicateRisk: false }), /accept-duplicate-risk/);
  await assert.rejects(recoverCall(config, key, { ...consent, reason: " " }), /nonempty/);
  await assert.rejects(recoverCall(config, "../outside", consent), /identified reservation/);
  appendFileSync(session.file, JSON.stringify({ type: "message", id: "more", timestamp: "2026-01-01", message: { role: "user", content: "new evidence" } }) + "\n");
  await assert.rejects(recoverCall(config, key, consent, { probe: async () => [] }), /stale/);
  assert.deepEqual(readCallRecoveries(target), []);
});

for (const verdict of ["authorized", "stale", "live", "unknown", "in-flight"] as const) {
  test(`the lock-owning run rechecks a queued recovery: ${verdict}`, async () => {
    const consent = { retry: reviewCallRecovery(target, work, 2).review, reason: "reviewed risk", acceptDuplicateRisk: true };
    const lock = await acquireRunLock(config.configPath);
    try {
      assert.match(await recoverCall(config, key, consent, { probe: async () => [], actor: "operator" }), /queued/);
      if (verdict === "stale") appendFileSync(session.file, JSON.stringify({ type: "message", id: "new", message: { role: "user", content: "new evidence" } }) + "\n");
      const seams = {
        probe: async () => {
          if (verdict === "unknown") throw new Error("Docker unavailable");
          return verdict === "live" ? [{ key, containerId: "surviving", ageMs: 1 }] : [];
        },
        inFlight: new Set(verdict === "in-flight" ? [key] : []),
      };
      await processRecoveryRequests(config, seams);
      await processRecoveryRequests(config, seams);
      assert.equal(readCallRecoveries(target).length, verdict === "authorized" ? 1 : 0);
      assert.match(await recoverCall(config, key), verdict === "authorized" ? /Request .*authorized/ : /Request .*rejected/);
      assert.equal(readEffectJournal(target).results.length, 0);
    } finally { await lock.close(); }
  });
}

test("a crash between queued consent and its receipt is idempotent, and another config cannot consume the request", async () => {
  const consent = { retry: reviewCallRecovery(target, work, 2).review, reason: "reviewed", acceptDuplicateRisk: true };
  const lock = await acquireRunLock(config.configPath);
  try {
    await recoverCall(config, key, consent, { probe: async () => [] });
    const otherConfig = join(root, "other.yaml");
    writeFileSync(otherConfig, "different configuration");
    await processRecoveryRequests({ ...config, configPath: otherConfig }, { probe: async () => [] });
    assert.equal(readCallRecoveries(target).length, 0);
    const requestRoot = join(config.workspace, "recovery-requests");
    const scoped = join(requestRoot, readdirSync(requestRoot)[0]!);
    const pendingDir = join(scoped, "pending");
    const pendingFile = join(pendingDir, readdirSync(pendingDir)[0]!);
    const queued = readFileSync(pendingFile, "utf8");
    await processRecoveryRequests(config, { probe: async () => [] });
    assert.equal(readCallRecoveries(target).length, 1, "the owner consumed the queued request exactly once");
    assert.match(await recoverCall(config, key), /Request .*authorized/);
    // A crash after consent but before the request's own deletion replays it.
    writeFileSync(pendingFile, queued);
    await processRecoveryRequests(config, { probe: async () => [] });
    assert.equal(readCallRecoveries(target).length, 1, "the persisted requestId prevents a second consent");
    assert.match(await recoverCall(config, key), /Request .*authorized/);
  } finally { await lock.close(); }
});

test("a persisted rejection stays terminal after a crash before pending-request deletion", async () => {
  const consent = { retry: reviewCallRecovery(target, work, 2).review, reason: "reviewed", acceptDuplicateRisk: true };
  const lock = await acquireRunLock(config.configPath);
  try {
    await recoverCall(config, key, consent, { probe: async () => [] });
    const requestRoot = join(config.workspace, "recovery-requests");
    const pending = join(requestRoot, readdirSync(requestRoot)[0]!, "pending");
    const file = join(pending, readdirSync(pending)[0]!);
    const request = readFileSync(file, "utf8");
    await processRecoveryRequests(config, { probe: async () => [{ key, containerId: "alive", ageMs: 1 }] });
    writeFileSync(file, request);
    await processRecoveryRequests(config, { probe: async () => [] });
    assert.equal(readCallRecoveries(target).length, 0, "a rejected request cannot become permission on a later sweep");
    assert.match(await recoverCall(config, key), /Request .*rejected/);
  } finally { await lock.close(); }
});

test("new pause identity, different command and terminal result invalidate the reviewed call", () => {
  const review = reviewCallRecovery(target, work, 2).review;
  writePause(target, { ...readPause(target)!, id: "new-pause" });
  assert.throws(() => authorizeCallRecovery(target, work, 2, { review, actor: "operator", reason: "reviewed", acceptedDuplicateRisk: true }), /stale/);
  seedExtraToolResult(session, "old");
  assert.throws(() => reviewCallRecovery(target, work, 2), /terminal result/);
});

test("exact retry is consumed before execution and cannot be reused by a new process", async () => {
  const authorization = authorize();
  const first = guard();
  assert.ok(await first.call("other", command + " --changed"));
  assert.ok(await first.call("wrong-cwd", command, "/elsewhere"));
  assert.ok(await first.call("old"), "old call identity cannot consume authorization");
  assert.equal(await first.call("retry"), undefined);
  const journal = readEffectJournal(target);
  assert.equal(recoveryConsumption(journal, authorization)?.callId, "retry");
  assert.equal(journal.results.length, 0);
  const restarted = guard();
  assert.ok(await restarted.call("again"), "crash after intent but before dispatch spends the permission");
  assert.ok(await restarted.call("publish", "git push origin agent-issue-7"), "unknown retry result blocks other effects");
  await first.result("retry");
  assert.ok(await guard().call("third"), "even a successful result never renews permission");
  assert.equal(readEffectJournal(target).results.some((result) => result.callId === "old"), false);
});

test("an interrupted retry needs a fresh pause-bound authorization; the old permission cannot release it", async () => {
  authorize();
  await guard().call("retry");
  seedSessionToolCall(session, { callId: "retry", command, answered: false });
  writePause(target, { ...readPause(target)!, id: "pause-2" });
  const next = authorize();
  assert.equal(next.callId, "retry");
  assert.equal(await guard().call("retry-2"), undefined);
  assert.ok(await guard().call("retry-3"));
  assert.equal(readCallRecoveries(target).length, 2);
});

test("corrupt recovery journal fails closed, preserving its bytes", async () => {
  authorize();
  appendFileSync(join(target, CALL_RECOVERY_FILENAME), '{"partial":');
  const before = readFileSync(join(target, CALL_RECOVERY_FILENAME), "utf8");
  assert.throws(() => readCallRecoveries(target), /incomplete/);
  assert.ok(await guard().call("retry"));
  assert.equal(readFileSync(join(target, CALL_RECOVERY_FILENAME), "utf8"), before);
});

test("a corrupt effect journal cannot renew a spent authorization", async () => {
  authorize();
  await guard().call("retry");
  appendFileSync(join(target, "efeitos.jsonl"), '{"partial":');
  assert.ok(await guard().call("another"));
});

test("authorization refuses a changed call, missing session or different current attempt", () => {
  const original = readFileSync(session.file, "utf8");
  writeFileSync(session.file, original.replace(command, command + " --changed"));
  assert.throws(() => reviewCallRecovery(target, work, 2), /does not match/);
  writeFileSync(session.file, original);
  assert.throws(() => reviewCallRecovery(target, work, 3), /current attempt/);
  rmSync(session.file);
  assert.throws(() => reviewCallRecovery(target, work, 2), /missing/);
});

test("a retry authorization cannot reopen an attempt that already has an outcome", async () => {
  writeFileSync(join(target, "desfecho.json"), JSON.stringify({ class: "pr-open", attempt: 2 }));
  await assert.rejects(recoverCall(config, key), /already has an outcome/);
  assert.deepEqual(readCallRecoveries(target), []);
});

test("the provisioned guardrail consumes before the real command and blocks a second container", (t) => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch (error) {
    if (process.env.MSF_REQUIRE_DOCKER === "1") throw error;
    t.skip("Docker and the provisioned worker image are required");
    return;
  }
  authorize();
  const script = `
    import { installGuardrail } from '/opt/msf/runtime/guardrail/extension.js';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const dir = ${JSON.stringify(target.replace(root, "/proof"))};
    const recovery = JSON.parse(readFileSync(dir + '/recuperacoes.jsonl', 'utf8').trim());
    let call;
    installGuardrail({ on(event, handler) { if (event === 'tool_call') call = handler; return () => {}; } }, { workMount: dir });
    writeFileSync('/tmp/diagnostic.mjs', 'import { appendFileSync } from "node:fs"; appendFileSync("/proof/effect", "x");');
    const decision = await call({ type: 'tool_call', toolCallId: process.env.RETRY_CALL_ID, toolName: 'bash', input: { command: recovery.command, cwd: recovery.cwd } });
    if (decision?.block) console.log('blocked');
    else { execFileSync('bash', ['-lc', recovery.command], { cwd: recovery.cwd }); console.log('executed'); }
  `;
  const run = (id: string) => execFileSync("docker", ["run", "--rm", "--network", "none", "-v", `${root}:/proof`, "-w", "/fake/worker", "-e", `RETRY_CALL_ID=${id}`, "--entrypoint", "node", WORKER_IMAGE, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.match(run("retry-real"), /executed/);
  assert.match(run("retry-after-crash"), /blocked/);
  assert.equal(readFileSync(join(root, "effect"), "utf8"), "x");
  assert.equal(readEffectJournal(target).results.length, 0, "the process died without a terminal result, not a success invented by recovery");
});

for (const mode of ["direct", "crash", "queued"] as const) test(`sweep resumes original attempt/session: ${mode}`, async () => {
  const hostCrashed = mode === "crash";
  if (mode === "queued") {
    const lock = await acquireRunLock(config.configPath);
    try {
      await recoverCall(config, key, { retry: reviewCallRecovery(target, work, 2).review, reason: "reviewed", acceptDuplicateRisk: true }, { probe: async () => [] });
    } finally { await lock.close(); }
  } else authorize();
  if (hostCrashed) clearPause(target);
  const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
  seedIssue(tracker, { repo: REPO, number: 7, labels: [config.labels.blocked], createdAt: "2026-01-01T00:00:00Z" });
  const git: GitWork = {
    prepareWorkFor: async () => ({ repoDir: root, branch: "agent-issue-7", baseBranch: "main", branchCreated: false, branchOnOrigin: true }),
    diffWorkFor: async () => "diff", observeRemoteHeadFor: async () => null,
    inspectLocalWorkFor: async () => ({ headSha: "local", commits: 2, uncommitted: true, operationInProgress: null }),
    cleanupDoneWorkFor: async () => {},
  };
  const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"] });
  const result = await runOnce({ config, workspace: layout, tickets: tracker, pullRequests: tracker, git, runtime, probe: async () => [], wait: async () => {} });
  assert.equal(result.launched.length, 1);
  const request = result.launched[0]!.request;
  assert.equal(request.attempt, 2);
  assert.deepEqual(request.session, { mode: "resume", sessionId: session.sessionId });
  assert.equal(request.material.callRetry?.command, command);
  const prompt = buildWorkerPrompt(request, { continuesSession: true, blockedLabel: config.labels.blocked });
  assert.match(prompt, /original call has NO known outcome/);
  assert.match(prompt, /All validation and publication obligations still apply/);
  assert.equal(readEffectJournal(target).results.length, 0);
});
