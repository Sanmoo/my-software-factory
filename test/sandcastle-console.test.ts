import assert from "node:assert/strict";
import { relative } from "node:path";
import test from "node:test";
import { installConsoleFilter, SandcastleLineFilter } from "../src/runtime/sandcastle-console.js";

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[22m";

function fakeConsole() {
  const out: string[] = [];
  const target = { log: (...args: unknown[]) => { out.push(args.join(" ")); } };
  return { out, target };
}

const PATH = "/state/areas/x/logs/2026.runtime.log";

test("drops the two Sandcastle lines of a registered runtime log, styled or not", () => {
  const filter = new SandcastleLineFilter();
  filter.register(PATH);
  const c = fakeConsole();
  installConsoleFilter(filter, c.target);
  c.target.log(`${BOLD}[Agent]${RESET} Started on branch main`);
  c.target.log(`${DIM}  tail -f ${PATH}${RESET}`);
  c.target.log(`  tail -f ${relative(process.cwd(), PATH)}`);
  assert.deepEqual(c.out, []);
});

test("a tail -f of a path that is not registered, and any other line, still show up", () => {
  const filter = new SandcastleLineFilter();
  filter.register(PATH);
  const c = fakeConsole();
  installConsoleFilter(filter, c.target);
  c.target.log("  tail -f /state/areas/y/logs/other.runtime.log");
  c.target.log("  tail -f /state/areas/x/logs/2026.log");
  c.target.log("some other line", 42);
  assert.deepEqual(c.out, [
    "  tail -f /state/areas/y/logs/other.runtime.log",
    "  tail -f /state/areas/x/logs/2026.log",
    "some other line 42",
  ]);
});

test("once the invocation ends, its path is no longer filtered", () => {
  const filter = new SandcastleLineFilter();
  const done = filter.register(PATH);
  const c = fakeConsole();
  installConsoleFilter(filter, c.target);
  done();
  done();
  c.target.log(`  tail -f ${PATH}`);
  c.target.log("[Agent] Started");
  assert.equal(c.out.length, 2);
});

test("simultaneous invocations: each path is filtered until its own invocation ends", () => {
  const filter = new SandcastleLineFilter();
  const other = "/state/areas/z/logs/2027.runtime.log";
  const doneA = filter.register(PATH);
  filter.register(other);
  const c = fakeConsole();
  installConsoleFilter(filter, c.target);
  doneA();
  c.target.log(`  tail -f ${PATH}`);
  c.target.log(`  tail -f ${other}`);
  assert.deepEqual(c.out, [`  tail -f ${PATH}`]);
});

test("installing twice wraps once", () => {
  const filter = new SandcastleLineFilter();
  const c = fakeConsole();
  installConsoleFilter(filter, c.target);
  const wrapped = c.target.log;
  installConsoleFilter(filter, c.target);
  assert.equal(c.target.log, wrapped);
});
