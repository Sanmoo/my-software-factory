/**
 * The waits vocabulary shared by the recovery and model-provider decisions:
 * both budgets render their configured backoff with the same
 * rule, so the two decisions never import each other — the edge that closed
 * the model-provider ↔ recovery cycle.
 */
export function renderWaits(waitsMs: readonly number[]): string {
  return waitsMs.map((wait) => (wait % 1000 === 0 ? `${wait / 1000}s` : `${wait}ms`)).join("/");
}
