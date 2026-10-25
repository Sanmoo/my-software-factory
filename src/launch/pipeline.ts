import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describeError } from "../format.js";
import type { LocalWorkFacts } from "../git/port.js";
import { SESSIONS_SUBDIR, workDirOfKey } from "../layout.js";
import { readLaunchFacts } from "../pool/registry.js";
import { consumeRecovery, recordStopRequest, resetFallCount, consumeStopRequest } from "../pool/recovery.js";
import { openRepairRound, type RepairRoundContext } from "../pool/repair-round.js";
import { reservationRecordOf, reserveWork } from "../pool/reservation.js";
import { EMPTY_REPAIR_CYCLE, readRepairCycle, writeRepairCycle, type RepairAttempt } from "../work-record/repair.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import { readTurnModelProviderError } from "../work-record/model-provider-error.js";
import { readOutcomeRecord } from "../work-record/outcome.js";
import { ownWrittenOutcome } from "../state/outcome.js";
import { clearPause, knownAttempt, readPause } from "../work-record/continuity.js";
import { recheckPausedEffects, planContinuity, type ContinuityDeps } from "../runtime/continuity.js";
import { describeRemoteChange, shortSha } from "../state/repair-view.js";
import { repairSignature, workPullRequest, type RepairTrigger } from "../state/derive.js";
import { renderWorkIdentity, ticketUrl } from "../tracker/identity.js";
import { workKeyOf } from "../pool/work-key.js";
import type { StopLaunch } from "../pool/stop.js";
import type { WorkerMaterial } from "../runtime/port.js";
import type { SessionResult } from "../runtime/port.js";
import type { GitWork } from "../git/port.js";
import type { PullRequestTracker, TicketTracker } from "../tracker/expanded-port.js";
import type { Launch, LaunchDeps, Launchable } from "./launch.js";

/** The production backoff timer; tests inject {@link LaunchDeps.wait}. */
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const logClaim = (log: (message: string) => void, key: string): void =>
  log(`claiming ${key} (ready → claimed on the tracker, before any launch)`);

/** One admission at a time is the caller's business (it holds the slot); this
 *  module keeps only what the pipeline itself owns: the per-repository prepare
 *  queue and the admissions a stop may still have to reach. */
class LaunchPipeline implements Launch {
  // Prepare (clone/fetch/branch) touches the shared clone of a repo — two
  // first-launches of the same repo must not race inside it (ticket 12
  // introduced the parallelism; the serialization stays local to prepares,
  // the launches themselves run concurrently).
  private readonly preparing = new Map<string, Promise<void>>();
  /** The admissions that may still be carrying a worker, by work key. */
  private readonly inFlight = new Map<string, StopLaunch>();

  constructor(private readonly deps: LaunchDeps) {}

  private get cycle(): LaunchDeps["cycle"] {
    return this.deps.cycle;
  }

  private get log(): (message: string) => void {
    return this.deps.log;
  }

  admissions(): readonly StopLaunch[] {
    return [...this.inFlight.values()];
  }

  carries(key: string): boolean {
    return this.inFlight.has(key);
  }

  async attempt(launchable: Launchable): Promise<Launchable | null> {
    const key = workKeyOf(launchable.work);
    const entry: StopLaunch = {
      work: launchable.work,
      dir: launchable.dir,
      // A recovery continues a known attempt even before the registry answers.
      attempt: launchable.kind === "recover" ? (launchable.attempt ?? null) : null,
      ...(launchable.kind === "recover" && launchable.attempt !== undefined
        ? { attemptHint: launchable.attempt }
        : {}),
      launched: false,
      recoveryIndex: null,
    };
    this.inFlight.set(key, entry);
    try {
      return await this.launchInner(launchable, entry);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async launchInner(launchable: Launchable, entry: StopLaunch): Promise<Launchable | null> {
    const { config, tickets, pullRequests, runtime, git, workspace } = this.deps;
    const { work, kind, dir } = launchable;
    const key = workKeyOf(work);

    // The requested stop closes admissions the instant it arrives (issue
    // #146): a launch that has not written to the tracker yet leaves nothing
    // behind, and one that already reserved the work merely stops here — the
    // reservation stays for the next run's reconciliation.
    if (this.cycle.stopping()) {
      this.log(`the launch of ${key} stopped before the claim — nothing was reserved`);
      return null;
    }

    if (kind === "claim") {
      logClaim(this.log, key);
      // The dir is the safety footprint of issue 98 and lands before the claim;
      // the record is the Work's own facts (issue 125). An unknown or
      // unwritable record is reported and never blocks the claim — nor is it
      // overwritten.
      mkdirSync(dir, { recursive: true });
      const url = ticketUrl(work.ticket);
      const presentation = {
        ...(launchable.title === undefined ? {} : { title: launchable.title }),
        ...(url === undefined ? {} : { url }),
      };
      try {
        const reservation = reserveWork(workspace, reservationRecordOf(work, presentation));
        if (reservation.reservation.state === "unreadable") {
          this.log(
            `reservation of ${key} is unreadable (${reservation.reservation.reason}) — ` +
              "keeping it and launching on the dir key",
          );
        }
      } catch (error) {
        this.log(`reservation of ${key} could not be persisted (${describeError(error)}) — launching on the dir key`);
      }
      await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
    } else if (kind === "resume") {
      this.log(`resuming ${key}: a human answered after the marker — blocked→claimed on the tracker`);
      await tickets.resumeTicketClaim(work.ticket, config.labels);
      // The rejection's retomada: the SAME PR is reopened, never a new one.
      if (launchable.pr !== null && launchable.pr.state === "closed") {
        await pullRequests.reopenPullRequest({ work, pullRequest: launchable.pr.identity });
      }
    } else if (kind === "recover" || kind === "model-provider-retry") {
      this.log(
        kind === "model-provider-retry"
          ? `model provider retry for ${key}: attempt ${launchable.attempt} ended by a model provider failure — ` +
              "the same attempt continues (no new attempt, branch preserved)"
          : launchable.requestedStop === true
            ? `resuming ${key}: the operator's requested stop ended attempt ${launchable.attempt} — ` +
                "the same attempt resumes (no new attempt, no recovery spent, branch preserved)"
            : `recovering ${key}: attempt ${launchable.attempt} was interrupted — ` +
                "the same attempt continues (no new attempt, branch preserved)",
      );
      // The claim swap itself may have been interrupted (issue 98) — or the
      // outage of issue 144 killed it: re-asserting the idempotent claim heals
      // it without releasing the work to the pool.
      if (launchable.callRecovery !== undefined) await tickets.resumeTicketClaim(work.ticket, config.labels);
      await tickets.claimTicket(work.ticket, config.workerGhAccount, config.labels.ready);
    } else if (kind === "feedback") {
      this.log(`feedback round for ${key}: the claim is already held — same branch, same PR`);
    }
    // Every launch kind holds the claim, so the work is reserved from here.
    this.cycle.announce(work, "reserved");

    // Git host (ticket 15): clone once + delta fetch + work branch born from
    // the default the clone reveals; relaunches reuse the branch untouched.
    const prepared = await this.serializePrepare(work.destination.repo, () => git.prepareWorkFor(work));

    // A repair targets the PR's CURRENT base — never the repo default (story 8)
    // — and opens only on a premise re-read now. The opening owns the single
    // read of the facts, the head the intervention is pinned to and the
    // concurrent-change verdict (issue 189); this method only applies them.
    const derivedTrigger = launchable.repair;
    const resuming = launchable.resuming ?? null;
    let repair: RepairRoundContext | undefined;
    let baseBranch = prepared.baseBranch;
    if (derivedTrigger !== undefined) {
      // The facts are re-read at the opening point (issue 149): the impediment
      // that opened the round may have been resolved meanwhile — by a human
      // pushing the resolution, by a base advance. Only a confirmed premise
      // buys a session; an obsolete one returns the round unspent, and an
      // unconfirmed one waits for the next derivation instead of paying for
      // stale evidence. The round is announced below, after this decision: a
      // returned round is never also "reactivated".
      const opening = await openRepairRound({
        trigger: derivedTrigger,
        resuming,
        readPremise: () => pullRequests.readPullRequestRepairFacts(workPullRequest(work, launchable.pr)),
        observeRemote: () => this.cycle.observeRemote(work),
      });
      if (opening.kind === "returned") {
        this.log(
          `repair round for ${key} not opened: the impediment that opened it no longer exists ` +
            "(the premise is obsolete) — no round is spent",
        );
        return null;
      }
      if (opening.kind === "held") {
        this.log(
          opening.because === "premise-unknown"
            ? `repair round for ${key} not opened: the PR's facts could not confirm the impediment — ` +
                "nothing is spent and the next sweep re-derives"
            : `repair round for ${key} skipped: the remote head could not be read — ` +
                "its reconciliation stays pending and nothing is launched (the next sweep retries)",
        );
        return null;
      }
      if (opening.kind === "skipped") {
        this.log(
          `repair round for ${key} skipped: the remote head ${opening.observedHeadSha ?? "(absent)"} no longer matches the ` +
            `observed ${opening.pinnedHeadSha} — nothing is launched`,
        );
        if (opening.concurrentChange !== null) {
          // Somebody moved the branch after the fall: the local work must not
          // be published over it. The opening settled the attempt as a
          // concurrent change, and the next derivation asks the human.
          await this.markConcurrentChange(work, opening.concurrentChange);
        }
        return null;
      }
      // A fresh round follows the facts as they read now: when the head moved
      // while the impediment persists, the evidence was recalculated, so the
      // round opens on the current head and is charged on the new evidence
      // (issue 149). A resumption keeps its observed head — moving it would
      // publish the fallen attempt's local history over a concurrent one.
      if (resuming === null && opening.context.trigger.facts.headSha !== derivedTrigger.facts.headSha) {
        this.log(
          `repair round for ${key}: the evidence was recalculated on the current head ` +
            `${shortSha(opening.context.trigger.facts.headSha)} — the round opens there`,
        );
      }
      repair = opening.context;
      baseBranch = opening.context.baseBranch;
      this.log(
        `repair round for ${key}: ${repair.trigger.reasons.join(" + ")} reactivated the worker — ` +
          "same branch, same PR, no human comment needed",
      );
    }

    this.log(
      `launching worker for ${key} (branch ${prepared.branch}, ` +
        `${prepared.branchCreated ? "created" : "reused"} from base ${baseBranch})`,
    );
    // A work branch reaches the remote only when the worker publishes it
    // (push + PR): a relaunch of a work that fell before publishing reuses a
    // branch the remote never saw, so the reuse has nothing to fast-forward.
    // Said once per launch, next to the launch it explains (issue 96) — the
    // runtime's reuse fetch then reads as expected instead of a broken remote.
    if (!prepared.branchCreated && !prepared.branchOnOrigin) {
      this.log(
        `branch ${prepared.branch} is not on origin yet (the worker pushes it when it opens the PR) — ` +
          `the relaunch has nothing to fast-forward`,
      );
    }

    // The registry numbers the attempt and remembers the previous WRITTEN
    // failure — both are disk facts of this work, not process state (ticket
    // 13; an interruption never counts as a fall, issue 123).
    const continuesAttempt = kind === "recover" || kind === "model-provider-retry";
    const facts = await readLaunchFacts(dir, continuesAttempt ? launchable.attempt : undefined);
    entry.attempt = facts.attempt;
    if (kind === "resume" && facts.previousFall) {
      // Ticket 14's decision: the human's answer resets the consecutive
      // failure count — the blocked valve already did its job and was
      // addressed; a new failure starts a fresh count (1st → release again).
      // The count is the Work's own fact (the recovery ledger), so the restart
      // is WRITTEN there: an in-memory flag would be lost by the next sweep —
      // or a restart — and the collection would see a 2nd fall nobody ruled.
      await resetFallCount(dir);
    }
    if (kind === "resume") {
      // A human answer that unblocks the work also renews the automatic
      // repair budget (issue 107 story 23); new commits never do.
      await writeRepairCycle(dir, EMPTY_REPAIR_CYCLE);
    }
    // The local work the round takes over, read from real git only once the
    // round is really going out: existing commits are reused, changes are
    // inspected, an unfinished operation is continued — the resumption never
    // restarts the work blind (issue 112).
    const localWork = repair === undefined ? null : await this.cycle.inspectLocalWork(work);
    // The launch material (ticket 17): the issue, the open PR with its
    // conversation (a feedback round), the diff of the branch — every
    // session starts from the whole context through the port + git host.
    const material = await launchMaterial(tickets, pullRequests, git, launchable, repair, localWork);
    // Ctrl-C perceived after the reservation but before the worker started:
    // do not start a new worker after this point. The reservation (the claim
    // and the registry dir) stays for the next run's reconciliation; the
    // caller releases the slot.
    if (this.cycle.stopping()) {
      this.log(`the launch of ${key} stopped before the worker started — the reservation stays for reconciliation`);
      return null;
    }

    // Continuity (issue 119): which Pi session this launch opens, and whether
    // it may open it at all. A human's answer to a paused work is orientation,
    // not proof about the world: the facts are read again before acting, and
    // an effect that is still ambiguous keeps the work paused.
    const continuityDeps: ContinuityDeps = {
      workDir: dir,
      sessionsDir: join(dir, SESSIONS_SUBDIR),
      work,
      attempt: facts.attempt,
      git,
      tickets,
      pullRequests,
    };
    if (kind === "resume") {
      const pause = readPause(dir);
      if (pause !== null) {
        const recheck = await recheckPausedEffects(
          {
            ...continuityDeps,
            attempt: knownAttempt(pause.attempt) ?? facts.attempt,
          },
          pause,
        );
        if (!recheck.resolved && recheck.pause !== null) {
          // No new information and no changed cause: the answer does not
          // authorize a replay and the same question is not asked again. The
          // pause keeps its identity and its binding to the answer (issue 174);
          // a real cause change posts exactly one diagnostic.
          await this.cycle.pauseForContinuity(work, dir, recheck.pause, facts.attempt);
          return null;
        }
        // The fresh read settled it: the answer becomes the updated context
        // of a NEW round (the material above already carries it).
        clearPause(dir);
        this.log(`the continuity pause of ${key} is resolved by a fresh read of the real state — starting a new round`);
      }
    }
    if (launchable.callRecovery !== undefined) {
      material.callRetry = {
        id: launchable.callRecovery.id, command: launchable.callRecovery.command,
        cwd: launchable.callRecovery.cwd, reason: launchable.callRecovery.reason,
        ...(launchable.callRecovery.tool === undefined ? {} : { tool: launchable.callRecovery.tool, input: launchable.callRecovery.input! }),
        ...(launchable.callRecovery.executorSessionId === undefined ? {} : { sourceSessionId: launchable.callRecovery.sessionId }),
      };
    }
    // Every relaunch of the same attempt continues ITS session (ADR 0005):
    // a recovery, a model provider retry and the resume after the operator's
    // requested stop. A claim, a feedback or orientation round and a repair
    // round are new executions.
    const continuity = await planContinuity(continuityDeps, continuesAttempt ? "resume" : "new");
    if (continuity.decision === "pause") {
      this.log(
        `continuity of ${key} halted the relaunch (${continuity.pause.reason}) — ` +
          "the work pauses for help; no recovery is spent and no new attempt starts",
      );
      await this.cycle.pauseForContinuity(work, dir, continuity.pause, facts.attempt);
      return null;
    }

    // The recovery is GRANTED and persisted before the wait and the relaunch
    // (issue 123): a death during the backoff or the session continues the
    // count instead of renewing the allowance. An exhausted budget pauses the
    // work and asks the operator for help — never another blind relaunch.
    //
    // The resume after the operator's requested stop (issue #146) spends
    // nothing and waits nothing: it continues the SAME attempt.
    if (kind === "recover" && launchable.requestedStop !== true) {
      const decision = await consumeRecovery(dir, config.recovery, facts.attempt);
      if (decision.decision === "recover") entry.recoveryIndex = decision.consumed - 1;
      if (decision.decision === "pause-help") {
        this.log(`recovery of ${key} paused: ${decision.reason} — the work is blocked and asks for help`);
        await this.cycle.pauseInterrupted(work, dir, facts.attempt, decision);
        return null;
      }
      this.log(
        `recovery ${decision.consumed}/${config.recovery.maxRecoveries} for ${key} — ` +
          `attempt ${facts.attempt} keeps its number, ` +
          (continuity.mode === "resume"
            ? `session ${continuity.sessionId} is reopened with ${continuity.intactEntries} confirmed entries of its history`
            : `session ${continuity.sessionId} starts fresh (no session had been created yet)`) +
          `; waiting ${decision.waitMs}ms before the relaunch`,
      );
      await this.wait(decision.waitMs);
      if (this.cycle.stopping()) {
        await this.cycle.cancelAdmission(entry, facts.attempt);
        this.log(
          `the recovery of ${key} stopped during the backoff — nothing is launched and the grant is returned ` +
            "with the requested-stop evidence",
        );
        return null;
      }
    }
    // The model provider retry is settled and persisted before the wait (issue 144):
    // a death during the backoff continues the model provider count instead of
    // renewing it, and the recovery budget of issue 123 is never touched.
    if (kind === "model-provider-retry") {
      const failure = await readTurnModelProviderError(dir, facts.attempt);
      if (failure === null) {
        this.log(
          `model provider retry for ${key} skipped: the attempt's stream no longer shows a provider error — nothing is launched`,
        );
        return null;
      }
      const decision = await this.cycle.settleModelProviderFailure(work, dir, facts.attempt, failure);
      if (decision.decision === "awaiting-model-provider") return null;
      await this.wait(decision.waitMs);
      if (this.cycle.stopping()) {
        this.log(`the model provider retry of ${key} stopped during the backoff — the grant stays consumed, nothing is launched`);
        return null;
      }
    }

    // The stop may have landed while this admission persisted its own
    // bookkeeping (the grant, or the consumption of the requested stop): what
    // it wrote is undone and the requested stop is what the work keeps.
    if (this.cycle.stopping()) {
      await this.cycle.cancelAdmission(entry, facts.attempt);
      this.log(`the launch of ${key} stopped before the worker started — the requested stop stays on record`);
      return null;
    }

    // A launch means this attempt is being carried NOW: a stop record left on
    // it by a previous requested stop has done its job (or the record is stale on a
    // fresh claim of the same number), so it never excuses a later, unexpected
    // interruption of this attempt.
    const stopBeforeLaunch = (await readRecoveryLedger(dir)).lastStop;
    await consumeStopRequest(dir, facts.attempt);

    if (launchable.callRecovery !== undefined) clearPause(dir);
    // Charge only after continuity allowed the launch. A pause before a worker
    // exists is not an unpublished Repair and cannot consume a round or fall.
    if (repair !== undefined) {
      await this.recordRepairRound(dir, work, repair.trigger, facts.attempt, localWork);
    }
    if (this.cycle.stopping()) {
      await this.cycle.cancelAdmission(entry, facts.attempt);
      return null;
    }
    entry.launched = true;
    let result: SessionResult;
    try {
      result = await runtime.launch({
        work,
        workDir: dir,
        branch: prepared.branch,
        repoDir: prepared.repoDir,
        baseBranch,
        attempt: facts.attempt,
        session: { mode: continuity.mode, sessionId: continuity.sessionId },
        material,
      });
    } catch (error) {
      if (stopBeforeLaunch?.kind === "stop-requested" && stopBeforeLaunch.attempt === facts.attempt &&
          ownWrittenOutcome(await readOutcomeRecord(dir), facts.attempt) === null &&
          (await readRecoveryLedger(dir)).lastStop === null) {
        await recordStopRequest(dir, facts.attempt);
      }
      throw error;
    }
    this.cycle.launched(result);

    return this.cycle.collect(launchable, result, facts.attempt);
  }

  /** The backoff before a recovery relaunch (the injected seam or a real timer).
   *  The requested stop ends the wait at once: a pending admission never delays
   *  the requested stop. */
  private async wait(ms: number): Promise<void> {
    if (ms <= 0 || this.cycle.stopping()) return;
    await Promise.race([(this.deps.wait ?? sleepMs)(ms), this.cycle.stopped]);
  }

  /**
   * Persist the concurrent-change verdict the opening reached: the derivation
   * then blocks the work with the help request (issue 112).
   */
  private async markConcurrentChange(work: Launchable["work"], attempt: RepairAttempt): Promise<void> {
    const dir = workDirOfKey(this.deps.workspace, workKeyOf(work));
    const cycle = await readRepairCycle(dir);
    await writeRepairCycle(dir, { ...cycle, attempt });
    this.log(
      `repair attempt ${attempt.attempt} of ${renderWorkIdentity(work)}: the remote branch ` +
        `${describeRemoteChange(attempt.remoteHeadSha)} while the attempt's observed head was ` +
        `${shortSha(attempt.observedHeadSha)} — local work preserved, nothing is published`,
    );
  }

  /** Charge one automatic repair round as its session starts — only after the
   *  continuity decision allowed the launch (issue 181): the budget, the
   *  consumed evidence and the attempt's own facts persist on disk, so a
   *  restart neither renews the cap nor repeats the same round, and a death is
   *  attributable once the remote answers (issue 112). */
  private async recordRepairRound(
    dir: string,
    work: Launchable["work"],
    trigger: RepairTrigger,
    attempt: number,
    localWork: LocalWorkFacts | null,
  ): Promise<void> {
    const cycle = await readRepairCycle(dir);
    const signature = repairSignature(work, trigger);
    await writeRepairCycle(dir, {
      usedRounds: cycle.usedRounds + 1,
      lastEvidence: signature,
      consecutiveFalls: cycle.consecutiveFalls,
      attempt: {
        evidence: signature,
        attempt,
        observedHeadSha: trigger.facts.headSha,
        remoteHeadSha: null,
        publication: "unknown",
        localWork,
      },
    });
  }

  private serializePrepare<T>(repo: string, prepare: () => Promise<T>): Promise<T> {
    const tail = this.preparing.get(repo) ?? Promise.resolve();
    const run = tail.then(prepare, prepare);
    this.preparing.set(
      repo,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }
}

/**
 * Gather the launch material of a work from the port + git host (ticket 17):
 * the issue (title/body), human issue replies on a blocked retomada, the open
 * PR's conversation on a feedback round, the repair context above, and the
 * diff. Unknown reads degrade to empty — the prompt still carries whatever is
 * known, never a lie.
 */
async function launchMaterial(
  tickets: TicketTracker,
  pullRequests: PullRequestTracker,
  git: GitWork,
  launchable: Launchable,
  repair: RepairRoundContext | undefined,
  localWork: LocalWorkFacts | null,
): Promise<WorkerMaterial> {
  const { work, issueReplies } = launchable;
  const issue = await tickets.readTicket(work.ticket);
  const feedback = await pullRequests.readPullRequestFeedback(workPullRequest(work, launchable.pr));
  const diff = await git.diffWorkFor(work);

  const pr =
    feedback.known && feedback.value.pr !== null && feedback.value.pr.state === "open"
      ? {
          number: feedback.value.pr.number,
          comments: [...feedback.value.comments, ...feedback.value.reviews].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          ),
        }
      : undefined;

  const material: WorkerMaterial = {
    ticket: issue.known ? { title: issue.value.title, body: issue.value.body } : { title: "", body: "" },
    diff,
  };
  if (pr !== undefined) material.pr = pr;
  if (issueReplies !== undefined) material.ticketReplies = issueReplies;
  if (repair !== undefined) {
    material.repair = {
      reasons: repair.trigger.reasons,
      observedHeadSha: repair.pinnedHeadSha,
      baseBranch: repair.trigger.facts.baseBranch,
      checks: repair.trigger.failingChecks,
      ...(localWork === null ? {} : { localWork }),
      ...(repair.resuming === null ? {} : { resuming: repair.resuming.attempt }),
    };
  }
  return material;
}

export function openPipeline(deps: LaunchDeps): Launch {
  return new LaunchPipeline(deps);
}
