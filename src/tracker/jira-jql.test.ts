import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RANK_ORDER, withNativeRankOrdering } from "./jira-jql.js";

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
});
