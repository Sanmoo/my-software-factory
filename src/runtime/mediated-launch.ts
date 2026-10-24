import { JIRA_CONTRACT_CONTAINER_PATH } from "../tracker/jira-mediation-protocol.js";
import type { JiraMediationComposition } from "../tracker/jira-mediation.js";
import type { SessionResult, WorkRequest, WorkerRuntime } from "./port.js";

/**
 * One worker launch, with factory-mediated Jira access for a Jira Work
 * (issue 131). The contract is written BEFORE the session starts and the
 * handler is closed only after the session ended, so a request issued at any
 * point of the session is served; the Work is never launched into a Jira it
 * cannot reach.
 */
export async function launchWithJiraMediation(
  runtime: WorkerRuntime,
  request: WorkRequest,
  composition: JiraMediationComposition | undefined,
): Promise<SessionResult> {
  if (request.work.ticket.provider !== "jira") return runtime.launch(request);
  if (composition === undefined) {
    throw new Error(
      `no factory-mediated Jira access is configured for ${request.work.ticket.key}; ` +
        "refusing to launch a worker that could not read or publish to its ticket",
    );
  }
  if (request.session === undefined) {
    throw new Error(
      `a Jira Work is launched without a recorded session; mediated requests could not be correlated ` +
        `(refusing ${request.work.ticket.key})`,
    );
  }
  const handle = composition.open({
    work: request.work,
    workDir: request.workDir,
    attempt: request.attempt,
    sessionId: request.session.sessionId,
  });
  if (handle === null) {
    throw new Error(
      `no configured Jira selection serves ${request.work.ticket.key} at ${request.work.destination.repo}; ` +
        "refusing a launch whose mediated access has no configured source",
    );
  }
  request.material.jira = { contractPath: JIRA_CONTRACT_CONTAINER_PATH };
  try {
    return await runtime.launch(request);
  } finally {
    handle.close();
  }
}
