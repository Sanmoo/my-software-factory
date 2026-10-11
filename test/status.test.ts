import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runStatus } from "../src/cli/status.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const statusArgs = (instance: string, extra: string[] = []) =>
  ["--config", fixture("instances.json"), "--instance", instance, "--fixture", fixture("status-tracker.json"), ...extra];

// Lines of the status output whose issue reference is exactly `ref`, e.g. "dora-metrics#2"
// or "VAN-4". Matching on the whole token keeps "#9" from matching "#99" in a reason.
const linesFor = (stdout: string, ref: string) =>
  stdout.split("\n").filter((line: string) => line.trimStart().startsWith(`${ref} `));

test("status lists the candidate of a GitHub project with its reference", async () => {
  const run = await runStatus(statusArgs("trabalho"));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /\[dora-metrics\][\s\S]*candidatas[\s\S]*samuel-santos_bjd\/dora-metrics#1 Eligible/);
});

test("status explains every rejection of a GitHub project with its reason", async () => {
  const { stdout } = await runStatus(statusArgs("trabalho"));
  const reasons: Array<[string, RegExp]> = [
    ["#2", /já claimed/],
    ["#3", /bloqueada por #4 \(não terminal\)/],
    ["#7", /issue terminal \(done\)/],
    ["#8", /labels desconhecido: labels API timeout/],
    ["#9", /claim desconhecido: claim field not read/],
    ["#10", /bloqueadores desconhecido: dependency API timeout/],
    ["#12", /estado de #99 desconhecido/],
  ];
  for (const [id, reason] of reasons) {
    const lines = linesFor(stdout, `samuel-santos_bjd/dora-metrics${id}`);
    assert.equal(lines.length, 1, `expected one line for ${id}`);
    assert.match(lines[0], reason);
  }
});

test("status does not list an issue that is not ready for agent", async () => {
  const { stdout } = await runStatus(statusArgs("trabalho"));
  assert.deepEqual(linesFor(stdout, "samuel-santos_bjd/dora-metrics#11"), []);
});

test("a Jira issue without a routing label is shown as sem roteamento and is not a candidate", async () => {
  const { stdout } = await runStatus(statusArgs("trabalho"));
  const lines = linesFor(stdout, "VAN-2");
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /sem roteamento/);
});

test("a Jira issue with two routing labels is shown as roteamento ambíguo and is not a candidate", async () => {
  const { stdout } = await runStatus(statusArgs("trabalho"));
  const lines = linesFor(stdout, "VAN-3");
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /roteamento ambíguo/);
});

test("a Jira issue routed to the project is the candidate of that project; sprint and assignee are checked", async () => {
  const { stdout } = await runStatus(statusArgs("trabalho"));
  assert.match(stdout, /\[revolving-monolith-backend\][\s\S]*candidatas[\s\S]*VAN-1 Monolith ready/);
  assert.match(linesFor(stdout, "VAN-4")[0], /fora da sprint atual/);
  assert.match(linesFor(stdout, "VAN-5")[0], /não atribuída ao operador/);
});

test("the personal instance shows its own projects only", async () => {
  const run = await runStatus(statusArgs("pessoal"));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Instância pessoal/);
  assert.match(run.stdout, /\[my-tasks\][\s\S]*candidatas \(1\)[\s\S]*Sanmoo\/my-tasks#1 Personal eligible/);
  assert.doesNotMatch(run.stdout, /dora-metrics|VAN-/);
});

test("an unknown instance name is a visible error that lists the configured instances", async () => {
  const run = await runStatus(statusArgs("inexistente"));
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /instância 'inexistente' não encontrada.*trabalho, pessoal/);
});

test("an invalid configuration is a visible error and status does not run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msf-status-"));
  const badConfig = join(dir, "bad.json");
  await writeFile(badConfig, JSON.stringify({ instances: [{ name: "x" }] }));
  const run = await runStatus(["--config", badConfig, "--instance", "x", "--fixture", fixture("status-tracker.json")]);
  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /instances\[0\]/);
});

test("a malformed tracker fixture is a visible error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msf-status-"));
  const badFixture = join(dir, "bad-tracker.json");
  await writeFile(badFixture, JSON.stringify({ issues: [{ project: "VAN", id: "VAN-9" }] }));
  const run = await runStatus(["--config", fixture("instances.json"), "--instance", "trabalho", "--fixture", badFixture]);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /fixture inválido/);
});

test("missing --fixture refuses to run until a real tracker adapter exists", async () => {
  const run = await runStatus(["--config", fixture("instances.json"), "--instance", "trabalho"]);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /--fixture/);
  assert.equal(run.stdout, "");
});
