import { userInfo } from "node:os";
import type { Config } from "./config.js";
import { workspaceLayout } from "./layout.js";
import { scanReservations } from "./pool/reservation.js";
import { readAttemptLedger } from "./pool/registry.js";
import { acquireRunLock } from "./run-lock.js";
import { probeLiveness, workspaceLivenessProbe, type LivenessProbe } from "./state/liveness.js";
import {
  authorizeCallRecovery, CALL_RECOVERY_FILENAME, DUPLICATE_RISK_WARNING,
  readCallRecoveries, recoveryConsumption, reviewCallRecovery,
} from "./runtime/call-recovery.js";
import { readEffectJournal } from "./runtime/continuity-artifacts.js";

export interface RecoveryConsent {
  retry: string;
  reason: string;
  acceptDuplicateRisk: boolean;
}

/** Inspection is read-only. Approval shares run's lock, refuses surviving or
 * unknown workers, and re-reads the reviewed evidence immediately before append. */
export async function recoverCall(
  config: Config, key: string, consent?: RecoveryConsent,
  seams: { probe?: LivenessProbe; actor?: string } = {},
): Promise<string> {
  const layout = workspaceLayout(config.workspace);
  const entry = (await scanReservations(layout)).find((entry) => entry.key === key);
  if (entry?.work === null || entry === undefined || entry.reservation.state === "unreadable") throw new Error("recover requires an identified reservation key from msf status");
  const work = entry.work;
  const currentAttempt = async () => {
    const ledger = await readAttemptLedger(entry.dir);
    if (ledger.recordedAttempt === ledger.lastAttempt) throw new Error("the attempt already has an outcome; a call retry cannot reopen it");
    return ledger.lastAttempt;
  };
  const inspect = async () => reviewCallRecovery(entry.dir, work, await currentAttempt());
  if (consent === undefined) {
    const recoveries = readCallRecoveries(entry.dir);
    const history = recoveries.map((record) => `${record.id}: ${recoveryConsumption(readEffectJournal(entry.dir), record) === undefined ? "not consumed" : "consumed"}; operator ${record.actor}; ${record.at}; reason: ${record.reason}`);
    let review: Awaited<ReturnType<typeof inspect>>;
    try { review = await inspect(); } catch (error) {
      if (history.length === 0) throw error;
      return [`${key}: call recovery history`, ...history, `No eligible call: ${(error as Error).message}`, `Evidence: ${entry.dir}/${CALL_RECOVERY_FILENAME}`].join("\n");
    }
    return [
      `${key}: interrupted attempt ${review.intent.attempt}; session ${review.intent.sessionId}`,
      `Call: ${review.intent.callId}; pause: ${review.pauseId}; cwd: ${review.cwd}`,
      DUPLICATE_RISK_WARNING,
      "--- exact command ---", review.intent.command, "--- end command ---",
      ...history,
      `Review: ${review.review}`,
      "Stop msf run before approving. No call is executed by this command.",
      `Authorize using the same --config, with: msf recover '${key}' --retry ${review.review} --accept-duplicate-risk --reason '<your justification>'`,
      `Evidence: ${entry.dir}/`,
    ].join("\n");
  }
  if (!consent.acceptDuplicateRisk || !consent.reason.trim()) throw new Error("--accept-duplicate-risk and a nonempty --reason are required");
  const lock = await acquireRunLock(config.configPath);
  try {
    const observation = await probeLiveness(seams.probe ?? workspaceLivenessProbe(layout));
    if (observation.state === "unknown") throw new Error(`cannot authorize retry: worker liveness is unknown (${observation.reason})`);
    if (observation.workers.some((worker) => worker.key === key)) throw new Error("cannot authorize retry: a worker of this work is alive");
    const actor = seams.actor ?? `${userInfo().username} (uid ${userInfo().uid})`;
    const record = authorizeCallRecovery(entry.dir, work, await currentAttempt(), {
      review: consent.retry, reason: consent.reason, actor, acceptedDuplicateRisk: consent.acceptDuplicateRisk,
    });
    return `${key}: authorized one exact retry (${record.id}) for attempt ${record.attempt}. Original outcome remains unknown.\nNo worker launched; resume with msf run using the same --config.\nAudit: ${entry.dir}/${CALL_RECOVERY_FILENAME}`;
  } finally {
    await lock.close();
  }
}
