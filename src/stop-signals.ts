/**
 * The operator's stop of the factory: a lifecycle condition, not
 * a Cancellation, a Delivery or a new Attempt. The first Ctrl-C/SIGTERM closes
 * admissions and requests a cooperative stop of the running workers; a second
 * signal escalates to the forced stop. The cooperative window bounds only the
 * request phase — the factory never calls the stop safe without confirming
 * that every worker ended (the runtime answers the confirmation, Docker being
 * the authority for the real one).
 *
 * The module owns the signals and their two-step shape, so the CLI can install
 * them BEFORE the startup steps that leave resources active (the run lock, the
 * workspace, a reservation) and every mode — continuous or `run --once` —
 * shares the same contract.
 */

/** How long the workers get to end after the cooperative request, in total for
 *  the whole run (never multiplied by the number of workers). */
export const COOPERATIVE_STOP_MS = 10_000;

/**
 * The stop as the loop receives it: `requested` is aborted by the first
 * signal, `escalated` by the second. Both keep their listeners until
 * {@link StopSignals.dispose} runs — the same window the run lock covers.
 */
export interface StopSignals {
  /** The first Ctrl-C/SIGTERM: close admissions, request the cooperative stop. */
  readonly requested: AbortSignal;
  /** The second Ctrl-C/SIGTERM: force the remaining workers now. */
  readonly escalated: AbortSignal;
  /** Detach the process listeners; the run is over. */
  dispose(): void;
}

/**
 * Install the SIGINT/SIGTERM handlers on the process. Both signals carry the
 * same guarantees: a process manager stops the factory exactly as Ctrl-C does.
 * The second signal of either kind escalates.
 */
export function installStopSignals(target: NodeJS.Process = process): StopSignals {
  const requested = new AbortController();
  const escalated = new AbortController();
  let signals = 0;

  const onSignal = (): void => {
    signals += 1;
    if (signals === 1) requested.abort();
    else escalated.abort();
  };

  target.on("SIGINT", onSignal);
  target.on("SIGTERM", onSignal);
  return {
    requested: requested.signal,
    escalated: escalated.signal,
    dispose() {
      target.removeListener("SIGINT", onSignal);
      target.removeListener("SIGTERM", onSignal);
    },
  };
}
