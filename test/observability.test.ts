import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createObserver, shellQuote, type HistoryRecord } from "../src/core/observability.js";
import { createRedactor } from "../src/core/redaction.js";
import type { MainLogEntry } from "../src/core/main-log.js";
import { createFileFailureStore, createFileHistory, readFailures } from "../src/state/history.js";

const SECRET = "synthetic-secret-value-123";
const dir = () => mkdtemp(join(tmpdir(), "msf-obs-"));
const clock = () => new Date("2026-10-11T12:00:00.000Z");

test("an event reaches the main log and the history with job, invocation and fields, secrets hidden", async () => {
  const stateDir = await dir();
  const lines: string[] = [];
  const observer = createObserver({
    instance: "trabalho", console: (line) => lines.push(line), history: createFileHistory(stateDir),
    redactor: createRedactor([SECRET]), now: clock,
  });
  observer.emit({
    kind: "ajuda-solicitada", text: "ajuda solicitada", job: "github:acme/app#13", invocation: "inv-1",
    fields: { motivo: "teste", token: `x ${SECRET} y` }, lines: [`pergunta: usa ${SECRET}?`],
  });
  await observer.flush();

  assert.match(lines[0]!, /^2026-10-11T12:00:00.000Z \[trabalho\] ajuda solicitada trabalho=github:acme\/app#13 invocação=inv-1 motivo=teste/);
  assert.ok(lines.every((line) => !line.includes(SECRET)));
  const { records } = await createFileHistory(stateDir).read("github:acme/app#13");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.invocation, "inv-1");
  assert.ok(!JSON.stringify(records).includes(SECRET));
  assert.match(records[0]!.lines[0]!, /pergunta: usa \[redacted\]\?/);
});

test("known token shapes are hidden even when not registered", () => {
  const redactor = createRedactor();
  const text = redactor.apply("gh token ghp_abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstuvwxyz");
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwx"));
  assert.ok(!text.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("a failing history is visible on the main log and in status, once, and does not stop emitting", async () => {
  const stateDir = await dir();
  const blocked = join(stateDir, "history"); // a file where the directory should be: appends fail
  await writeFile(blocked, "not a directory");
  const lines: string[] = [];
  const observer = createObserver({
    instance: "trabalho", console: (line) => lines.push(line), history: createFileHistory(stateDir),
    failures: createFileFailureStore(stateDir), now: clock,
  });
  observer.emit({ kind: "a", text: "primeiro", job: "j" });
  observer.emit({ kind: "b", text: "segundo", job: "j" });
  await observer.flush();

  assert.equal(lines.filter((line) => line.includes("primeiro") || line.includes("segundo")).length, 2);
  assert.equal(lines.filter((line) => line.includes("falha de observabilidade")).length, 1);
  const failures = await readFailures(stateDir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.sink, "histórico");
});

test("copyable commands carry configuration, instance and state directory, shell escaped", () => {
  const observer = createObserver({
    instance: "trabalho", console: () => {},
    cli: { config: "/home/o'neil/config file.json", instance: "trabalho", stateDir: "/tmp/state dir" },
  });
  const commands = observer.commands("github:acme/app#13")!;
  assert.equal(
    commands.reply,
    "npm run reply -- --config '/home/o'\\''neil/config file.json' --instance trabalho --state-dir '/tmp/state dir' 'github:acme/app#13' --message '<resposta>'",
  );
  assert.equal(shellQuote("plain-word_1"), "plain-word_1");
});

test("history keeps appended records in order and ignores unreadable lines", async () => {
  const stateDir = await dir();
  const history = createFileHistory(stateDir);
  const record = (kind: string): HistoryRecord => ({ at: "t", instance: "i", kind, text: kind, job: "j", fields: {}, lines: [] });
  await history.append(record("um"));
  await history.append(record("dois"));
  const file = join(stateDir, "history", "j.jsonl");
  await writeFile(file, (await readFile(file, "utf8")) + "lixo\n");
  const read = await history.read("j");
  assert.deepEqual(read.records.map((entry) => entry.kind), ["um", "dois"]);
  assert.equal(read.unreadable, 1);
});

test("the level chosen by the emitter is kept in the history and given to the main log", async () => {
  const stateDir = await dir();
  const entries: MainLogEntry[] = [];
  const observer = createObserver({
    instance: "trabalho", history: createFileHistory(stateDir), now: clock,
    mainLog: { event: (entry) => entries.push(entry), note: () => {}, failures: () => {} },
  });
  observer.emit({ kind: "ajuda-solicitada", text: "ajuda solicitada", level: "atenção", highlight: true, job: "j", fields: { sessão: "s-1" } });
  observer.emit({ kind: "trabalho-admitido", text: "trabalho admitido", job: "j" });
  await observer.flush();

  const { records } = await createFileHistory(stateDir).read("j");
  assert.deepEqual(records.map((record) => record.level), ["atenção", "info"]);
  assert.equal(records[0]!.fields["sessão"], "s-1");
  assert.deepEqual(entries.map((entry) => [entry.level, entry.highlight === true]), [["atenção", true], ["info", false]]);
  assert.equal(entries[0]!.at.toISOString(), "2026-10-11T12:00:00.000Z");
});
