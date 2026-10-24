/**
 * The JQL contract of a Jira selection (issue 128): the operator's query
 * decides WHAT is selected, and the factory always reads the result in Jira's
 * native Rank ascending order.
 *
 * A query with no ORDER BY gets `ORDER BY Rank ASC`; a query that orders by
 * anything else is a named conflict, never silently overridden — dropping the
 * operator's ordering (or falling back to age/Priority) would change priority
 * behind their back. Rank is opaque: nothing here reads a rank value.
 */

/** The ordering the factory supplies when the query gives none. */
export const RANK_ORDER = "Rank ASC";

export type RankOrdering =
  | { ok: true; jql: string; filter: string }
  | { ok: false; because: string };

/**
 * The query the adapter sends: the operator's JQL, with `ORDER BY Rank ASC`
 * appended when it carries no ordering. A conflicting ordering is refused.
 */
export function withNativeRankOrdering(jql: string): RankOrdering {
  const trimmed = jql.trim();
  if (trimmed === "") return { ok: false, because: "the JQL is empty" };

  const masked = maskQuoted(trimmed);
  const clause = topLevelOrderBy(masked);
  if (clause === null) return { ok: true, jql: `${trimmed} ORDER BY ${RANK_ORDER}`, filter: trimmed };

  const clauses = splitTopLevel(trimmed, masked, clause.bodyStart, ",");
  if (clauses.length !== 1) {
    return {
      ok: false,
      because: "ORDER BY names more than one field; the factory reads candidates in native Rank ascending order only",
    };
  }

  const ordering = clauses[0] ?? "";
  const tokens = ordering.trim().split(/\s+/);
  const field = tokens[0] ?? "";
  if (!/^rank$/i.test(field)) {
    return {
      ok: false,
      because: `ORDER BY ${field} conflicts with the native Rank ascending order the factory requires`,
    };
  }
  if (tokens.length > 2) {
    return { ok: false, because: "the Rank ordering clause carries more than a direction" };
  }
  const direction = tokens[1];
  if (direction !== undefined && !/^asc$/i.test(direction)) {
    return {
      ok: false,
      because: `ORDER BY Rank ${direction} conflicts with native Rank ascending order`,
    };
  }
  const filter = trimmed.slice(0, clause.start).trim();
  if (filter === "") {
    return { ok: false, because: "the JQL carries only an ordering and no selection filter" };
  }
  return { ok: true, jql: trimmed, filter };
}

/**
 * One query for a whole Jira site's selections (issue 129): the union of the
 * selections' filters, ordered ONLY by the site's native Rank. Each selection
 * was already validated on its own; its own ordering clause is removed before
 * the union, because independent selection orders cannot be concatenated into
 * the site-wide order. A single selection keeps its exact query.
 */
export function withSiteRankOrdering(selections: readonly string[]): RankOrdering {
  if (selections.length === 0) return { ok: false, because: "the site carries no selection" };
  if (selections.length === 1) return withNativeRankOrdering(selections[0] ?? "");

  const filters: string[] = [];
  for (const selection of selections) {
    const ordered = withNativeRankOrdering(selection);
    if (!ordered.ok) return ordered;
    filters.push(`(${ordered.filter})`);
  }
  return { ok: true, jql: `${filters.join(" OR ")} ORDER BY ${RANK_ORDER}`, filter: filters.join(" OR ") };
}

/** The text inside quoted JQL literals, blanked out (indices preserved). */
function maskQuoted(jql: string): string {
  let masked = "";
  let quote: string | null = null;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        masked += "  ";
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        masked += " ";
        continue;
      }
      masked += " ";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      masked += " ";
      continue;
    }
    masked += char;
  }
  return masked;
}

/** The top-level ORDER BY clause: where it starts and where its body starts,
 *  or null when the query has none (a quoted literal is not a clause). */
function topLevelOrderBy(masked: string): { start: number; bodyStart: number } | null {
  const pattern = /\border\s+by\b/gi;
  let depth = 0;
  let found: { start: number; bodyStart: number } | null = null;
  let position = 0;
  for (const match of masked.matchAll(pattern)) {
    const start = match.index ?? 0;
    for (; position < start; position += 1) {
      if (masked[position] === "(") depth += 1;
      else if (masked[position] === ")") depth -= 1;
    }
    if (depth === 0) found = { start, bodyStart: start + match[0].length };
  }
  return found;
}

/** Split the raw clause body at top-level separators, using the masked text
 *  for quote awareness and the raw text for the values. */
function splitTopLevel(raw: string, masked: string, start: number, separator: string): string[] {
  const parts: string[] = [];
  let from = start;
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(raw.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(raw.slice(from));
  return parts;
}
