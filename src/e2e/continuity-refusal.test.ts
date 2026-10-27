import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { pi } from "@ai-hero/sandcastle";

import { DEFAULT_LABELS } from "../config.js";
import { SESSIONS_SUBDIR, WORK_MOUNT_PATH, ensureWorkspace, workDir } from "../layout.js";
import { runOnce, type LoopDeps } from "../loop.js";
import { localGitWork } from "../git/local.js";
import { cleanupFixture, seedFixtureRemote } from "../git/local-fixtures.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { readEffectJournal, readPause } from "../work-record/continuity.js";
import { planContinuity, recheckPausedEffects } from "../runtime/continuity.js";

import { inspectSessionFile, sessionToolCalls, sessionToolResults } from "../work-record/sessions.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import { githubWork } from "./work-fixtures.js";
import { REFUSED_CALL_COMMAND, SAFE_CALL_COMMAND, startDeterministicModel } from "./deterministic-model.js";
import {
  bridgeAddress,
  continuityProofConfig,
  continuityProofRuntime,
  continuitySkipReason as skipReason,
  findSession,
  hostVisibleBase,
  writeDeterministicModelConfig,
} from "./real-continuity-fixtures.js";

/**
 * The real integration proof of the journal gap: a probe extension refuses a
 * call AFTER the guardrail journaled its intent, and Pi never calls the
 * guardrail's result hook for a refused call — so the terminal error exists
 * only in the persisted session. The host closes the journal from that
 * evidence and continuity proceeds, with no operator and no replay.
 *
 * The proof is separate from the session-reopening one so each real Docker run
 * fits the gateway's per-file ceiling; both use the same runtime, image and
 * deterministic model.
 */

describe("e2e: a refused call is reconciled from the real session", { skip: skipReason }, () => {
  let root: string;

  before(() => {
    // The whole tree lives under a directory the host daemon sees at the same
    // absolute path, so the binds really carry the session file.
    root = mkdtempSync(join(hostVisibleBase(), "msf-continuity-refusal-"));
    // The runtime stages the supplied agent files under tmpdir(); they must
    // land in the host-visible tree as well.
    const tmp = join(root, "tmp");
    mkdirSync(tmp, { recursive: true });
    process.env["TMPDIR"] = tmp;
  });

  after(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  test(
    "a refusal a probe extension makes AFTER the guardrail's intent is closed from the session, with nobody asked",
    { timeout: 10 * 60 * 1000 },
    async () => {
      // The journal gap of the reported incident, reproduced in the real
      // lifecycle: the guardrail journals the intent, a second extension refuses
      // the call BEFORE it runs (Pi calls no tool_result hook for a refused
      // call, so the guardrail never records a result), and the terminal error
      // exists only in the persisted session. The host must close the journal
      // from that evidence and let continuity proceed — no operator, no replay.
      const repo = "Sanmoo/prova-recuperacao";
      const branch = "agent-issue-172";
      const workspace = ensureWorkspace(join(root, "fabrica-recuperacao"));
      const workDirPath = workDir(workspace, repo, 172);
      mkdirSync(workDirPath, { recursive: true });

      const fixtures = await seedFixtureRemote(join(workDirPath, "fixtures"), repo, { defaultBranch: "main" });
      const remotePath = fixtures.barePath(repo);

      const refusalModel = await startDeterministicModel({
        branch,
        attempt: 1,
        script: "refused-call",
        address: bridgeAddress(),
        workMount: WORK_MOUNT_PATH,
        remoteUrl: "/msf-work/fixtures/remotas/Sanmoo#prova-recuperacao.git",
      });
      try {
        const modelsFile = join(root, "agent-config-recuperacao", "models.json");
        writeDeterministicModelConfig(modelsFile, refusalModel.baseUrl);

        const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
        seedIssue(tracker, { repo, number: 172, createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.claimed] });
        const config = continuityProofConfig({
          workspace,
          repo,
          configPath: join(root, "msf-recuperacao.yaml"),
        });

        const git = localGitWork({ reposDir: workspace.repos, remoteUrl: () => remotePath });
        const probeFile = join(workDirPath, PROBE_FILENAME);
        writeFileSync(probeFile, PROBE_SOURCE, "utf8");
        const runtime = continuityProofRuntime({
          workspace,
          modelsFile,
          token: "recovery-proof-no-github",
          piProvider: probeAfterGuardrailProvider(),
        });

        // 1. The real session, launched exactly as the loop launches it: the
        //    host's own continuity decision (association and guardrail state
        //    written BEFORE the worker starts) and the production runtime.
        const work = githubWork(repo, 172);
        const decision = await planContinuity(
          {
            workDir: workDirPath,
            sessionsDir: join(workDirPath, SESSIONS_SUBDIR),
            work,
            attempt: 1,
            git,
            tickets: tracker,
            pullRequests: tracker,
          },
          "new",
        );
        assert.equal(decision.decision, "launch", JSON.stringify(decision));
        if (decision.decision !== "launch") return;
        const prepared = await git.prepareWorkFor(work);
        const first = await runtime.launch({
          work,
          workDir: workDirPath,
          branch: prepared.branch,
          repoDir: prepared.repoDir,
          baseBranch: prepared.baseBranch,
          attempt: 1,
          session: { mode: "new", sessionId: decision.sessionId },
          material: { ticket: { title: "prove the journal gap is repaired", body: "" }, diff: "" },
        });
        assert.equal(first.outcome, "abrupt-death", "the session ended without an outcome record");

        // 2. The gap, as the real lifecycle left it: the session holds the
        //    terminal error of the refused call, the journal holds its intent
        //    and no result at all.
        const file = findSession(join(workDirPath, SESSIONS_SUBDIR), decision.sessionId);
        assert.ok(file, "the session persisted on the host");
        const inspection = inspectSessionFile(file, decision.sessionId);
        assert.equal(inspection.status, "intact", inspection.detail);
        // 2a. The rule the factory reads needs its POSITIVE control in the SAME
        //     session: a call that really executed carries the duration Pi only
        //     records for one, so "no duration" means "never ran" and not "this
        //     Pi version records none".
        const safe = sessionToolCalls(file, inspection.intactEntries).find((call) => call.command === SAFE_CALL_COMMAND);
        assert.ok(safe, `the harmless call reached the session: ${inspection.detail ?? ""}`);
        const safeTerminal = sessionToolResults(file, inspection.intactEntries).filter(
          (result) => result.callId === safe.callId,
        );
        assert.equal(safeTerminal.length, 1, "the executed call has exactly one terminal result");
        assert.equal(safeTerminal[0]?.isError, false, "the harmless call succeeded");
        assert.equal(typeof safeTerminal[0]?.durationMs, "number", "a call that executed records its duration");
        // 2b. The guarded call, refused by the probe AFTER the guardrail's intent:
        //     the terminal error exists only in the session, and it carries no
        //     duration — the contrast with the call above is the whole rule.
        const refused = sessionToolCalls(file, inspection.intactEntries).find(
          (call) => call.command === REFUSED_CALL_COMMAND,
        );
        assert.ok(refused, `the guarded call reached the session: ${inspection.detail ?? ""}`);
        const terminal = sessionToolResults(file, inspection.intactEntries).filter(
          (result) => result.callId === refused.callId,
        );
        assert.equal(terminal.length, 1, "exactly one terminal result");
        assert.equal(terminal[0]?.isError, true, "the probe refused the call");
        assert.equal(terminal[0]?.durationMs, null, "the refused tool never executed");
        assert.match(terminal[0]?.text ?? "", /refused after the guardrail journaled the intent/);

        const before = readEffectJournal(workDirPath);
        assert.equal(before.intact, true);
        assert.deepEqual(
          before.pending.map((intent) => intent.callId),
          [refused.callId],
          "the guardrail journaled the intent; no result followed it",
        );
        assert.deepEqual(before.results, [], "the journal never received the result the session holds");
        assert.equal(readPause(workDirPath), null, "nothing was paused: the factory had not looked yet");

        // 3. The public operational cycle: the interrupted attempt is recovered
        //    and the journal is completed from the session, with no answer.
        const deps: LoopDeps = {
          config,
          tickets: tracker,
          pullRequests: tracker,
          runtime,
          git,
          workspace,
          log: () => {},
          notifier: new FakeNotifier(),
          wait: async () => {},
        };
        const sweep = await runOnce(deps);

        assert.equal(sweep.launched.length, 1, "one recovery: the work was not paused for help");
        const recovered = sweep.launched[0]!.request;
        assert.equal(recovered.attempt, 1, "the SAME attempt continues");
        assert.deepEqual(recovered.session, { mode: "resume", sessionId: decision.sessionId });
        assert.equal(readPause(workDirPath), null, "no human was asked");
        const issue = await tracker.readIssue({ repo, number: 172 });
        assert.ok(issue.known);
        assert.equal(issue.value.labels.includes(DEFAULT_LABELS.blocked), false, "the ticket was not blocked");

        const journal = readEffectJournal(workDirPath);
        const repaired = journal.results.filter((result) => result.callId === refused.callId);
        assert.equal(repaired.length, 1, "closed exactly once");
        assert.equal(repaired[0]?.ok, false, "the observed error is preserved");
        assert.equal(repaired[0]?.source, "session", "closed from the transcript, not from the guardrail callback");
        assert.equal(repaired[0]?.evidenceAt, terminal[0]?.timestamp, "correlated to the evidence it came from");
        assert.equal(
          journal.intents.filter((intent) => intent.callId === refused.callId).length,
          1,
          "the original intent is preserved as written",
        );
        assert.equal((await readRecoveryLedger(workDirPath)).consumed, 1, "the recovery ruler still applies");
        assert.equal(refusalModel.requests.some((request) => request.resumed), true, "the resumed session really ran");

        const record = JSON.parse(readFileSync(join(workDirPath, "desfecho.json"), "utf8")) as {
          attempt: number;
          class: string;
        };
        assert.equal(record.attempt, 1, "the resumed session wrote attempt 1's outcome");
        assert.equal(record.class, "clean-without-pr");
        assert.match(
          readFileSync(file, "utf8"),
          /refused after the guardrail journaled the intent/,
          "the transcript keeps the evidence the repair came from",
        );

        // 4. Repeating the evaluation duplicates nothing: the intent is already
        //    closed, so a fresh read settles on the same evidence.
        const recheck = await recheckPausedEffects(
          {
            workDir: workDirPath,
            sessionsDir: join(workDirPath, SESSIONS_SUBDIR),
            work,
            attempt: 1,
            git,
            tickets: tracker,
            pullRequests: tracker,
          },
          {
            version: 1,
            work,
            attempt: 1,
            reason: "effect-unsupported",
            detail: "the interrupted call cannot be classified",
            at: "",
          },
        );
        assert.deepEqual(recheck, { resolved: true, pause: null });
        assert.equal(
          readEffectJournal(workDirPath).results.filter((result) => result.callId === refused.callId).length,
          1,
          "no duplicated result",
        );
      } finally {
        await refusalModel.close();
        cleanupFixture(join(workDirPath, "fixtures"));
      }
    },
  );
});

/** The probe the refusal proof loads AFTER the guardrail: Pi registers handlers
 *  in load order, so the guardrail has journaled the intent by the time this one
 *  refuses the call. */
const PROBE_FILENAME = "prova-extensao.js";
const PROBE_SOURCE = `export default function probe(pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    if (String(event.input?.command ?? "") !== ${JSON.stringify(REFUSED_CALL_COMMAND)}) return undefined;
    return { block: true, reason: "msf test probe: refused after the guardrail journaled the intent" };
  });
}
`;

/**
 * The Pi provider of the refusal proof: the production provider, with the probe
 * extension appended AFTER the flags the runtime adds — Pi loads `--extension`
 * paths in the order given, so the guardrail gets the call first.
 *
 * The runtime composes `"<this provider's command> <WORKER_FLAG_ARGS>"`, so the
 * probe cannot simply be appended here. The command is therefore staged through
 * a shell that takes those appended flags as ITS arguments and adds the probe
 * last — same process, same stdin, same exit status.
 */
function probeAfterGuardrailProvider(): (model: string, options?: Parameters<typeof pi>[1]) => ReturnType<typeof pi> {
  return (model, options) => {
    const agent = pi(model, options);
    return {
      ...agent,
      buildPrintCommand: (commandOptions) => {
        const command = agent.buildPrintCommand(commandOptions);
        const staged = `${command.command} "$@" --extension ${WORK_MOUNT_PATH}/${PROBE_FILENAME}`;
        return { ...command, command: `/bin/sh -c ${shellQuote(staged)} msf-probe` };
      },
    };
  };
}

/** One POSIX shell word, whatever the value contains. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
