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

test("CLI rejects model, unknown flags, extra positionals, missing values, and once values", () => {
  for (const argv of [
    ["run", "--model", "x/y"], ["run", "gadget"], ["run", "--runtime"],
    ["run", "--config"], ["run", "--once", "yes"], ["status", "--runtime", "fake"],
    ["status", "--all", "yes"],
  ]) assert.throws(() => parseCliArgs(argv));
  assert.throws(() => parseCliArgs(["run", "--model", "x/y"]), /unknown flag "--model"/);
  assert.throws(() => parseCliArgs(["run", "--runtime"]), /unknown flag "--runtime"[\s\S]*usage: msf run[\s\S]*msf status/);
  assert.throws(() => parseCliArgs(["run", "--config"]), /unknown flag "--config"[\s\S]*usage: msf run[\s\S]*msf status/);
  assert.throws(() => parseCliArgs(["run", "--all"]), /unknown flag "--all"/);
});
