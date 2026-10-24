import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "./cli-args.js";

test("CLI accepts documented command forms", () => {
  assert.deepEqual(parseCliArgs(["run"]), { command: "run", once: false, all: false });
  assert.deepEqual(parseCliArgs(["run", "--once", "--config", "factory.yaml", "--runtime", "fake"]), {
    command: "run", once: true, all: false, configPath: "factory.yaml", runtime: "fake",
  });
  assert.deepEqual(parseCliArgs(["status", "--config", "factory.yaml"]), {
    command: "status", once: false, all: false, configPath: "factory.yaml",
  });
  assert.deepEqual(parseCliArgs(["status", "--all"]), { command: "status", once: false, all: true });
});

test("recover parses inspection and requires all explicit consent fields together", () => {
  assert.deepEqual(parseCliArgs(["recover", "Sanmoo/repo#7"]), { command: "recover", once: false, all: false, workKey: "Sanmoo/repo#7" });
  assert.equal(parseCliArgs(["recover", "Sanmoo/repo#7", "--retry", "review", "--accept-duplicate-risk", "--reason", "reviewed"]).retry, "review");
  for (const args of [[], ["--force"], ["Sanmoo/repo#7", "--retry", "hash"], ["Sanmoo/repo#7", "--reason", "why"], ["Sanmoo/repo#7", "--accept-duplicate-risk"], ["Sanmoo/repo#7", "--config", "a", "--config", "b"], ["Sanmoo/repo#7", "--runtime", "fake"]]) {
    assert.throws(() => parseCliArgs(["recover", ...args]));
  }
});

test("CLI rejects model, unknown flags, extra positionals, missing values, and once values", () => {
  // One table: the rejected argv and the error it must carry.
  const rejected: Array<[string[], RegExp]> = [
    [["run", "--model", "x/y"], /unknown flag "--model"/],
    [["run", "gadget"], /unexpected argument "gadget"/],
    [["run", "--runtime"], /unknown flag "--runtime"[\s\S]*usage: msf run[\s\S]*msf status/],
    [["run", "--config"], /unknown flag "--config"[\s\S]*usage: msf run[\s\S]*msf status/],
    [["run", "--once", "yes"], /unexpected argument "yes"/],
    [["run", "--all"], /unknown flag "--all"/],
    [["status", "--runtime", "fake"], /unknown flag "--runtime"/],
    [["status", "--all", "yes"], /unexpected argument "yes"/],
  ];
  for (const [argv, error] of rejected) assert.throws(() => parseCliArgs(argv), error);
});
