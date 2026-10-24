import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RANK_ORDER, withNativeRankOrdering, withSiteRankOrdering } from "./jira-jql.js";

/**
 * The configured query's effective ordering (issue 128): Jira Rank ascending
 * always, supplied when absent and refused when the query asks for something
 * else. The parser never rewrites a conflicting query and never reads a Rank
 * value — Rank is opaque.
 */

function accepted(jql: string): string {
  const result = withNativeRankOrdering(jql);
  if (!result.ok) assert.fail(`expected an accepted query, got: ${result.because}`);
  return result.jql;
}

function refused(jql: string): string {
  const result = withNativeRankOrdering(jql);
  if (result.ok) assert.fail(`expected a refused query, got: ${result.jql}`);
  return result.because;
}

describe("Jira JQL: native Rank ascending", () => {
  test("a query with no ordering gets ORDER BY Rank ASC", () => {
    assert.equal(accepted("project = ABC AND assignee = currentUser()"), `project = ABC AND assignee = currentUser() ORDER BY ${RANK_ORDER}`);
  });

  test("an explicit Rank ascending clause is accepted as written", () => {
    assert.equal(accepted("project = ABC ORDER BY Rank ASC"), "project = ABC ORDER BY Rank ASC");
    assert.equal(accepted("project = ABC order by rank asc"), "project = ABC order by rank asc");
    assert.equal(accepted("project = ABC ORDER BY rank"), "project = ABC ORDER BY rank", "JQL's default direction is ASC");
  });

  test("a descending Rank order is a named conflict, never silently reversed", () => {
    const because = refused("project = ABC ORDER BY Rank DESC");
    assert.match(because, /Rank DESC/);
    assert.match(because, /Rank ascending/);
  });

  test("ordering by any other field is a named conflict, never a silent weakening", () => {
    for (const field of ["created ASC", "priority DESC", "updated"]) {
      const because = refused(`project = ABC ORDER BY ${field}`);
      assert.match(because, new RegExp(field.split(" ")[0]!), `${field} is named`);
      assert.match(because, /Rank/);
    }
  });

  test("a second ordering field is refused, even when Rank comes first", () => {
    assert.match(refused("project = ABC ORDER BY Rank ASC, created DESC"), /more than one field/);
  });

  test("a quoted literal that contains 'order by' is not a clause", () => {
    assert.equal(
      accepted('summary ~ "order by rank desc"'),
      `summary ~ "order by rank desc" ORDER BY ${RANK_ORDER}`,
    );
    assert.equal(
      accepted('assignee in membersOf("order by rank")'),
      `assignee in membersOf("order by rank") ORDER BY ${RANK_ORDER}`,
    );
  });

  test("a quoted literal does not hide the real ordering clause", () => {
    assert.match(refused('summary ~ "rank" ORDER BY Rank DESC'), /Rank DESC/);
    assert.equal(
      accepted('summary ~ "rank" ORDER BY Rank ASC'),
      'summary ~ "rank" ORDER BY Rank ASC',
    );
  });

  test("an empty query is refused instead of ordered", () => {
    assert.match(refused("   "), /empty/);
  });

  test("a query carrying only an ordering has no selection filter and is refused", () => {
    assert.match(refused("ORDER BY Rank ASC"), /only an ordering and no selection filter/);
    assert.match(refused("ORDER BY Rank"), /only an ordering and no selection filter/);
  });
});

describe("Jira JQL: one native Rank order for a site's selections", () => {
  test("several selections become one query, parenthesized and ordered only by Rank ascending", () => {
    const result = withSiteRankOrdering(["project = ABC AND labels = frontend", "project = DEF ORDER BY Rank ASC"]);
    assert.deepEqual(result, {
      ok: true,
      jql: `(project = ABC AND labels = frontend) OR (project = DEF) ORDER BY ${RANK_ORDER}`,
      selectionFilter: "(project = ABC AND labels = frontend) OR (project = DEF)",
    });
  });

  test("one selection keeps its own native query, ordering included", () => {
    assert.deepEqual(withSiteRankOrdering(["project = ABC"]), {
      ok: true,
      jql: `project = ABC ORDER BY ${RANK_ORDER}`,
      selectionFilter: "project = ABC",
    });
  });

  test("a conflicting ordering anywhere in the site is refused, never silently weakened", () => {
    const result = withSiteRankOrdering(["project = ABC", "project = DEF ORDER BY created ASC"]);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("the site query is refused");
    assert.match(result.because, /created/);
    assert.match(result.because, /Rank ascending/);
  });

  test("an empty site has no query, and quoted ordering text is not a clause", () => {
    const empty = withSiteRankOrdering([]);
    assert.equal(empty.ok, false);
    const quoted = withSiteRankOrdering(['summary ~ "order by rank desc"', "project = DEF"]);
    assert.deepEqual(quoted, {
      ok: true,
      jql: `(summary ~ "order by rank desc") OR (project = DEF) ORDER BY ${RANK_ORDER}`,
      selectionFilter: '(summary ~ "order by rank desc") OR (project = DEF)',
    });
  });
});
