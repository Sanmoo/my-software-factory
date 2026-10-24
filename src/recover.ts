import { userInfo } from "node:os";
import type { Config } from "./config.js";
import { workspaceLayout } from "./layout.js";
import { scanReservations } from "./pool/reservation.js";
import { readAttemptLedger } from "./pool/registry.js";
import { acquireRunLock, RunLockBusyError } from "./run-lock.js";
import { probeLiveness, workspaceLivenessProbe, type LivenessProbe } from "./state/liveness.js";
import {
  authorizeCallRecovery, CALL_RECOVERY_FILENAME, DUPLICATE_RISK_WARNING,
  readCallRecoveries, recoveryConsumption, reviewCallRecovery,
} from "./runtime/call-recovery.js";
import { readEffectJournal } from "./runtime/continuity-artifacts.js";
import { drainRecoveryRequests, queueRecovery, recoveryRequestStatus } from "./recovery-requests.js";

export interface RecoveryConsent {
  retry: string;
  reason: string;
  acceptDuplicateRisk: boolean;
}

interface RecoverySeams { probe?: LivenessProbe; actor?: string }

async function locate(config: Config, key: string) {
  const entry = (await scanReservations(workspaceLayout(config.workspace))).find((entry) => entry.key === key);
  if (entry?.work === null || entry === undefined || entry.reservation.state === "unreadable") throw new Error("recover requires an identified reservation key from msf status");
  return { entry, work: entry.work };
}

async function currentAttempt(dir: string): Promise<number> {
  const ledger = await readAttemptLedger(dir);
  if (ledger.recordedAttempt === ledger.lastAttempt) throw new Error("the attempt already has an outcome; a call retry cannot reopen it");
  return ledger.lastAttempt;
}

async function validate(config: Config, key: string, consent: RecoveryConsent, seams: RecoverySeams) {
  const { entry, work } = await locate(config, key);
  const observation = await probeLiveness(seams.probe ?? workspaceLivenessProbe(workspaceLayout(config.workspace)));
  if (observation.state === "unknown") throw new Error(`cannot authorize retry: worker liveness is unknown (${observation.reason})`);
  if (observation.workers.some((worker) => worker.key === key)) throw new Error("cannot authorize retry: a worker of this work is alive");
  const attempt = await currentAttempt(entry.dir);
  const review = reviewCallRecovery(entry.dir, work, attempt);
  if (review.review !== consent.retry) throw new Error("recovery review is stale; inspect the call again");
  return { entry, work, attempt };
}

async function approve(config: Config, key: string, consent: RecoveryConsent, seams: RecoverySeams, requestId?: string): Promise<string> {
  const { entry, work, attempt } = await validate(config, key, consent, seams);
  const record = authorizeCallRecovery(entry.dir, work, attempt, {
    review: consent.retry, reason: consent.reason,
    actor: seams.actor ?? `${userInfo().username} (uid ${userInfo().uid})`,
    acceptedDuplicateRisk: consent.acceptDuplicateRisk,
    ...(requestId === undefined ? {} : { requestId }),
  });
  return `${key}: authorized one exact retry (${record.id}) for attempt ${record.attempt}. Original outcome remains unknown.\nNo worker launched; msf run using the same --config consumes permission.\nAudit: ${entry.dir}/${CALL_RECOVERY_FILENAME}`;
}

/** Preview is read-only. An active owner receives a request, never an out-of-lock authorization. */
export async function recoverCall(config: Config, key: string, consent?: RecoveryConsent, seams: RecoverySeams = {}): Promise<string> {
  const { entry, work } = await locate(config, key);
  if (consent === undefined) {
    const requestStatus = await recoveryRequestStatus(config, key);
    const recoveries = readCallRecoveries(entry.dir);
    const history = recoveries.map((record) => `${record.id}: ${recoveryConsumption(readEffectJournal(entry.dir), record) === undefined ? "not consumed" : "consumed"}; operator ${record.actor}; ${record.at}; reason: ${record.reason}`);
    let review: ReturnType<typeof reviewCallRecovery>;
    try { review = reviewCallRecovery(entry.dir, work, await currentAttempt(entry.dir)); }
    catch (error) {
      if (history.length === 0 && requestStatus === undefined) throw error;
      return [requestStatus, `${key}: call recovery history`, ...history, `No eligible call: ${(error as Error).message}`, `Evidence: ${entry.dir}/${CALL_RECOVERY_FILENAME}`].filter(Boolean).join("\n");
    }
    return [
      ...(requestStatus === undefined ? [] : [requestStatus]),
      `${key}: interrupted attempt ${review.intent.attempt}; session ${review.intent.sessionId}`,
      `Call: ${review.intent.callId}; pause: ${review.pauseId}; cwd: ${review.cwd}`,
      ...(review.executorSessionId === review.intent.sessionId ? [] : [`Replay is in owning session ${review.executorSessionId}; the child outcome remains unknown.`]),
      DUPLICATE_RISK_WARNING,
      ...(review.input === undefined
        ? ["--- exact command ---", review.intent.command, "--- end command ---"]
        : [`--- exact tool: ${review.intent.tool} ---`, review.input, "--- end tool input ---"]),
      ...history, `Review: ${review.review}`,
      "No call is executed by this command. An active msf run rechecks a queued request on its next sweep.",
      `Authorize using the same --config, with: msf recover '${key}' --retry ${review.review} --accept-duplicate-risk --reason '<your justification>'`,
      `Evidence: ${entry.dir}/`,
    ].join("\n");
  }
  if (!consent.acceptDuplicateRisk || !consent.reason.trim()) throw new Error("--accept-duplicate-risk and a nonempty --reason are required");
  let lock;
  try { lock = await acquireRunLock(config.configPath); }
  catch (error) {
    if (!(error instanceof RunLockBusyError)) throw error;
    await validate(config, key, consent, seams);
    const request = await queueRecovery(config, {
      key, retry: consent.retry, reason: consent.reason, acceptDuplicateRisk: true,
      actor: seams.actor ?? `${userInfo().username} (uid ${userInfo().uid})`,
    });
    return `${key}: recovery request ${request.id} queued, not yet authorized. The active run rechecks it on its next sweep.\nInspect with msf recover '${key}' using the same --config; no need to stop other Works.`;
  }
  try { return await approve(config, key, consent, seams); }
  finally { await lock.close(); }
}

/** Called only by the lock-owning run, serialized with its admissions. */
export async function processRecoveryRequests(
  config: Config,
  seams: RecoverySeams & { inFlight?: ReadonlySet<string>; log?: (line: string) => void } = {},
): Promise<void> {
  await drainRecoveryRequests(config, async (request) => {
    const { entry } = await locate(config, request.key);
    // A crash after fsync of consent but before the receipt must not duplicate it.
    const previous = readCallRecoveries(entry.dir).find((record) => record.requestId === request.id);
    if (previous !== undefined) return `authorization ${previous.id} was already persisted`;
    if (seams.inFlight?.has(request.key)) throw new Error("cannot authorize retry: a launch of this Work is in flight");
    return approve(config, request.key, request, { ...seams, actor: request.actor }, request.id);
  }, seams.log ?? (() => {}));
}
