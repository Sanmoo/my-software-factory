import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "./cli-args.js";

test("CLI accepts documented command forms", () => {
  assert.deepEqual(parseCliArgs(["run"]), { command: "run", once: false });
  assert.deepEqual(parseCliArgs(["run", "--once", "--config", "factory.yaml", "--runtime", "fake"]), {
    command: "run", once: true, configPath: "factory.yaml", runtime: "fake",
  });
  assert.deepEqual(parseCliArgs(["status", "--config", "factory.yaml"]), {
    command: "status", once: false, configPath: "factory.yaml",
  });
});

test("CLI rejects model, unknown flags, extra positionals, missing values, and once values", () => {
  for (const argv of [
    ["run", "--model", "x/y"], ["run", "gadget"], ["run", "--runtime"],
    ["run", "--config"], ["run", "--once", "yes"], ["status", "--runtime", "fake"],
  ]) assert.throws(() => parseCliArgs(argv));
  assert.throws(() => parseCliArgs(["run", "--model", "x/y"]), /unknown flag "--model"/);
});
