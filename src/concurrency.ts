/**
 * Bounded concurrency for the tracker reads.
 *
 * The status derivation pays one REST round-trip per candidate for the fact the
 * open-issues listing cannot carry (the blocker read). Awaiting each read
 * inside the derivation loop made the command's latency the SUM of every
 * round-trip; this helper issues them with at most `limit` in flight, so the
 * latency is the longest chain instead — while the bound keeps the burst
 * inside the tracker's rate budget and the results keep the input order.
 */

/**
 * Run `work` over `items` with at most `limit` operations in flight.
 *
 * The returned array is in input order whatever order the operations finish
 * in. The first failure rejects the whole call (never a partial result); the
 * operations already in flight are not cancelled — a caller that must not
 * leave writes behind passes only read-only work.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer (got ${limit})`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
