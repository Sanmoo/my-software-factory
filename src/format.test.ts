import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeError, formatDuration } from "./format.js";

/**
 * The operator-facing renderings: a
 * duration never rounds a real span away, and an error is one line.
 */

describe("the operator's renderings", () => {
  test("a duration keeps its unit — a sub-second span is not '0s'", () => {
    assert.equal(formatDuration(0), "0ms");
    assert.equal(formatDuration(250), "250ms");
    assert.equal(formatDuration(999), "999ms");
    assert.equal(formatDuration(1_000), "1s");
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(180_000), "3m");
    assert.equal(formatDuration(3_900_000), "1h5m");
  });

  test("an error is its message on one line, whatever was thrown", () => {
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError("plain"), "plain");
  });
});
