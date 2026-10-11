import assert from "node:assert/strict";
import test from "node:test";
import { diffCommandText, DIFF_ARGS, sha256 } from "../src/runtime/review-material.js";

test("sha256 is the SHA-256 of the exact bytes (known vector)", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("the exact diff is the same command for the runner and for the agent, independent of user diff config", () => {
  assert.deepEqual(DIFF_ARGS("base1", "head2"), [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv",
    "--src-prefix=a/", "--dst-prefix=b/", "--binary", "base1", "head2",
  ]);
  assert.equal(
    diffCommandText("base1", "head2"),
    "git -c core.pager=cat diff --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --binary base1 head2",
  );
});
