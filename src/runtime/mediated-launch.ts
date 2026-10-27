import { describeError } from "../format.js";
import { JIRA_CONTRACT_CONTAINER_PATH } from "../work-record/jira-mediation.js";
import type { JiraMediationComposition, JiraMediationHandle } from "../tracker/jira-mediation.js";
import {
  LaunchPreconditionError,
  type SessionResult,
  type WorkRequest,
  type WorkerRuntime,
} from "./port.js";

/**
 * One worker launch, with factory-mediated Jira access for a Jira Work.
 *
 * The contract is written BEFORE the session starts and the handler is closed
 * only after the session ended, so a request issued at any point of the
 * session is served. A Jira Work that has no configured mediation, whose
 * source the configuration does not promise, or whose session is not recorded,
 * is refused instead of launched into a Jira it could not read or answer.
 *
 * Every refusal here happens before `runtime.launch` — no worker exists, no
 * footprint was written — so each one is the Launch refusal of GLOSSARY.md and
 * the admission's grant is refunded, never silently consumed.
 */
export async function launchWithJiraMediation(
  runtime: WorkerRuntime,
  request: WorkRequest,
  composition: JiraMediationComposition | undefined,
): Promise<SessionResult> {
  if (request.work.ticket.provider !== "jira") return runtime.launch(request);
  if (composition === undefined) {
    refuse(
      `no factory-mediated Jira access is configured for ${request.work.ticket.key}; ` +
        "refusing to launch a worker that could not read or publish to its ticket",
    );
  }
  const session = request.session;
  if (session === undefined) {
    refuse(
      `a Jira Work is launched without a recorded session; mediated requests could not be correlated ` +
        `(refusing ${request.work.ticket.key})`,
    );
  }
  let handle: JiraMediationHandle | null;
  try {
    handle = composition.open({
      work: request.work,
      workDir: request.workDir,
      attempt: request.attempt,
      sessionId: session.sessionId,
    });
  } catch (error) {
    // The handler refuses a Work it cannot correlate with its reservation and
    // the recorded session: still before the worker, still a Launch refusal.
    refuse(describeError(error), error);
  }
  if (handle === null) {
    refuse(
      `no configured Jira selection serves ${request.work.ticket.key} at ${request.work.destination.repo}; ` +
        "refusing a launch whose mediated access has no configured source",
    );
  }
  try {
    return await runtime.launch({
      ...request,
      material: { ...request.material, jira: { contractPath: JIRA_CONTRACT_CONTAINER_PATH } },
    });
  } finally {
    handle.close();
  }
}

/** No worker existed: the Launch refusal the pipeline refunds the grant for. */
function refuse(message: string, cause?: unknown): never {
  throw new LaunchPreconditionError(message, cause);
}
