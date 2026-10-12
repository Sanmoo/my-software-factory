process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMainLog, terminalMode } from "../src/core/main-log.js";

// Escape sequences are stripped where only the text matters.
const strip = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

function humanLog(color = false) {
  const lines: string[] = [];
  let clock = new Date("2026-10-11T23:08:20.000Z");
  const log = createMainLog({ instance: "pessoal", write: (line) => lines.push(line), human: { color }, now: () => clock });
  return { log, lines, plain: () => lines.map(strip), at: (iso: string) => { clock = new Date(iso); return clock; } };
}

test("human mode: local time, a date line when the day starts or changes, no instance tag", () => {
  const h = humanLog();
  h.log.event({ at: h.at("2026-10-11T23:08:20.000Z"), level: "info", text: "trabalho admitido", fields: { motivo: "issue-elegível" } });
  h.log.event({ at: h.at("2026-10-11T23:59:59.000Z"), level: "info", text: "segundo" });
  h.log.event({ at: h.at("2026-10-12T00:00:01.000Z"), level: "info", text: "terceiro" });
  const out = h.plain();
  assert.match(out[0]!, /── 2026-10-11 ──/);
  assert.match(out[1]!, /^23:08:20 .*trabalho admitido +motivo=issue-elegível$/);
  assert.match(out[2]!, /^23:59:59 .*segundo$/);
  assert.match(out[3]!, /── 2026-10-12 ──/);
  assert.match(out[4]!, /^00:00:01 .*terceiro$/);
  assert.ok(out.every((line) => !line.includes("[pessoal]")));
});

test("human mode: a short job column, the full key only on the job's first mention", () => {
  const h = humanLog();
  const at = h.at("2026-10-11T23:08:20.000Z");
  h.log.event({ at, level: "info", text: "trabalho admitido", job: "github:Sanmoo/my-software-factory#13" });
  h.log.event({ at, level: "info", text: "invocação encerrada", job: "github:Sanmoo/my-software-factory#13", invocation: "inv-1", fields: { resultado: "pr_ready" } });
  h.log.event({ at, level: "info", text: "trabalho admitido", job: "jira:PAY#PAY-7" });
  const out = h.plain().slice(1);
  assert.match(out[0]!, /^23:08:20 . #13 +trabalho admitido +trabalho=github:Sanmoo\/my-software-factory#13$/);
  assert.match(out[1]!, /^23:08:20 . #13 +invocação encerrada +resultado=pr_ready invocação=inv-1$/);
  assert.match(out[2]!, /^23:08:20 . PAY-7 +trabalho admitido +trabalho=jira:PAY#PAY-7$/);
});

test("human mode: secondary paths and ids stay out of the terminal; the detailed log stays", () => {
  const h = humanLog();
  h.log.event({
    at: h.at("2026-10-11T23:08:20.000Z"), level: "info", text: "invocação retomada", job: "github:a/b#1",
    fields: {
      motivo: "retomada-manual", comando: "001-abc", ref: "comando 001-abc", sessão: "01a12cbf", área: "/s/areas/x/repo",
      detalhado: "/s/areas/x/logs/a.log", artefatos: "/s/areas/x/logs/a.artifacts",
    },
  });
  h.log.event({ at: h.at("2026-10-11T23:08:21.000Z"), level: "info", text: "feedback recebido", job: "github:a/b#1", fields: { ref: "revisão PRR_1" } });
  const out = h.plain().slice(1);
  assert.match(out[0]!, /invocação retomada +motivo=retomada-manual comando=001-abc detalhado=\/s\/areas\/x\/logs\/a\.log trabalho=github:a\/b#1$/);
  assert.match(out[1]!, /feedback recebido +ref="revisão PRR_1"$/);
});

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const INVERSE = "\u001b[7m";
const DIM = "\u001b[2m";

test("human mode: each level has its marker and color; a help request stands out; paths are faint", () => {
  const h = humanLog(true);
  const at = h.at("2026-10-11T23:08:20.000Z");
  h.log.event({ at, level: "info", text: "trabalho admitido" });
  h.log.event({ at, level: "progresso", text: "PR aceito" });
  h.log.event({ at, level: "atenção", text: "trabalho interrompido" });
  h.log.event({ at, level: "erro", text: "falha do runner" });
  h.log.event({ at, level: "atenção", text: "ajuda solicitada", highlight: true, lines: ["pergunta: qual?"] });
  h.log.event({ at, level: "info", text: "logs da invocação", fields: { detalhado: "/s/a.log" } });
  const [, info, progress, attention, error, help, question, logs] = h.lines;
  assert.match(strip(info!), /^23:08:20 · /);
  assert.ok(![RED, GREEN, YELLOW].some((code) => info!.includes(code)));
  assert.match(strip(progress!), /^23:08:20 ✓ /);
  assert.ok(progress!.includes(`${GREEN}PR aceito`) || progress!.includes(GREEN));
  assert.match(strip(attention!), /^23:08:20 ! /);
  assert.ok(attention!.includes(YELLOW));
  assert.match(strip(error!), /^23:08:20 ✗ /);
  assert.ok(error!.includes(RED));
  assert.ok(help!.includes(INVERSE) && help!.includes(YELLOW));
  assert.equal(strip(question!), "                  pergunta: qual?");
  assert.ok(logs!.includes(`${DIM}/s/a.log`));
});

test("human mode without color: no escape sequence at all, the markers still tell the level", () => {
  const h = humanLog(false);
  const at = h.at("2026-10-11T23:08:20.000Z");
  h.log.event({ at, level: "erro", text: "falha do runner", fields: { detalhado: "/s/a.log" } });
  h.log.event({ at, level: "atenção", text: "ajuda solicitada", highlight: true });
  assert.ok(h.lines.every((line) => !line.includes("\u001b[")));
  assert.match(h.lines[1]!, /^23:08:20 ✗ /);
  assert.match(h.lines[2]!, /^23:08:20 ! /);
});

test("plain mode keeps today's line: ISO time, instance, text, job, invocation and every field", () => {
  const lines: string[] = [];
  const log = createMainLog({ instance: "pessoal", write: (line) => lines.push(line) });
  log.event({
    at: new Date("2026-10-11T23:08:23.180Z"), level: "atenção", highlight: true, text: "invocação retomada",
    job: "github:a/b#13", invocation: "inv-1", fields: { comando: "001", ref: "comando 001", área: "/s/x repo" }, lines: ["causa 1/1: x"],
  });
  assert.deepEqual(lines, [
    `2026-10-11T23:08:23.180Z [pessoal] invocação retomada trabalho=github:a/b#13 invocação=inv-1 comando=001 ref="comando 001" área="/s/x repo"`,
    "    causa 1/1: x",
  ]);
});

const OFFLINE = (path: string) =>
  `gh api GET ${path}?per_page=100&page=1 sem resposta HTTP (exit 1): error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com`;
const outage = [
  { key: "github:Sanmoo/msf#13", message: OFFLINE("repos/Sanmoo/msf/issues/13/comments") },
  { key: "github:Sanmoo/msf#15", message: OFFLINE("repos/Sanmoo/msf/issues/15/comments") },
  { key: "github:Sanmoo/msf#13", message: "PR não pôde ser lido: consulta de PR no github.com falhou" },
  { key: "discovery", message: OFFLINE("repos/Sanmoo/msf/issues") },
];

function plainLog() {
  const lines: string[] = [];
  let clock = new Date("2026-10-11T23:26:45.000Z");
  const log = createMainLog({ instance: "pessoal", write: (line) => lines.push(line), now: () => clock });
  return { log, lines, at: (iso: string) => { clock = new Date(iso); } };
}

test("one failure shared by several jobs in a cycle is one line naming who it affects; its extra lines come once", () => {
  const p = plainLog();
  p.log.failures(outage);
  assert.deepEqual(p.lines, [
    "2026-10-11T23:26:45.000Z ERRO gh api GET … sem resposta HTTP (exit 1): error connecting to api.github.com (afeta: github:Sanmoo/msf#13, github:Sanmoo/msf#15, discovery)",
    "check your internet connection or https://githubstatus.com",
    "2026-10-11T23:26:45.000Z ERRO github:Sanmoo/msf#13: PR não pôde ser lido: consulta de PR no github.com falhou",
  ]);
});

test("a failure that goes on is silent between reminders every 5 min and says when it recovers", () => {
  const p = plainLog();
  p.log.failures(outage);
  p.lines.length = 0;
  for (const iso of ["2026-10-11T23:27:00.000Z", "2026-10-11T23:27:15.000Z", "2026-10-11T23:31:30.000Z"]) {
    p.at(iso);
    p.log.failures(outage);
  }
  assert.deepEqual(p.lines, []);
  p.at("2026-10-11T23:31:45.000Z");
  p.log.failures(outage.slice(0, 2));
  assert.deepEqual(p.lines, [
    "2026-10-11T23:31:45.000Z ERRO ainda falhando há 5min (×5): gh api GET … sem resposta HTTP (exit 1): error connecting to api.github.com (afeta: github:Sanmoo/msf#13, github:Sanmoo/msf#15)",
    "2026-10-11T23:31:45.000Z recuperado após 5min (×4): github:Sanmoo/msf#13: PR não pôde ser lido: consulta de PR no github.com falhou",
  ]);
  p.lines.length = 0;
  p.at("2026-10-11T23:32:00.000Z");
  p.log.failures([]);
  assert.deepEqual(p.lines, [
    "2026-10-11T23:32:00.000Z recuperado após 5min (×5): gh api GET … sem resposta HTTP (exit 1): error connecting to api.github.com",
  ]);
});

test("a cycle that failed as a whole does not count as recovery of the failures it could not see", () => {
  const p = plainLog();
  p.log.failures(outage.slice(2, 3));
  p.lines.length = 0;
  p.log.failures([{ key: "ciclo", message: "tracker caiu" }], { cycleFailed: true });
  assert.deepEqual(p.lines, ["2026-10-11T23:26:45.000Z ERRO ciclo: tracker caiu"]);
});

test("human mode: a failure is red, with a short job column or the jobs it affects; extra lines faint", () => {
  const h = humanLog(true);
  h.at("2026-10-11T23:26:45.000Z");
  h.log.failures(outage);
  const out = h.lines.slice(1);
  assert.ok(out[0]!.includes(RED));
  assert.equal(strip(out[0]!), "23:26:45 ✗        gh api GET … sem resposta HTTP (exit 1): error connecting to api.github.com  afeta=#13,#15,discovery");
  assert.ok(out[1]!.includes(DIM));
  assert.equal(strip(out[1]!), "                  check your internet connection or https://githubstatus.com");
  assert.equal(strip(out[2]!), "23:26:45 ✗ #13    PR não pôde ser lido: consulta de PR no github.com falhou  trabalho=github:Sanmoo/msf#13");
});

test("notes of the coordinator loop: plain keeps today's prefixes; human shows the level by marker", () => {
  const p = plainLog();
  p.log.note("erro", "de persistência: disco cheio");
  p.log.note("atenção", "arquivos de trabalho ilegíveis: x");
  p.log.note("info", "instância pessoal: N=1");
  assert.deepEqual(p.lines, [
    "2026-10-11T23:26:45.000Z ERRO de persistência: disco cheio",
    "2026-10-11T23:26:45.000Z ATENÇÃO: arquivos de trabalho ilegíveis: x",
    "2026-10-11T23:26:45.000Z instância pessoal: N=1",
  ]);
  const h = humanLog();
  h.at("2026-10-11T23:26:45.000Z");
  h.log.note("atenção", "instância pausada: nada novo é admitido");
  assert.equal(h.lines[1], "23:26:45 !        instância pausada: nada novo é admitido");
});

test("the human presentation needs a terminal or forced colors; NO_COLOR keeps it, without colors", () => {
  assert.equal(terminalMode({}, false), undefined);
  assert.deepEqual(terminalMode({}, true), { color: true });
  assert.deepEqual(terminalMode({ NO_COLOR: "1" }, true), { color: false });
  assert.deepEqual(terminalMode({ NO_COLOR: "" }, true), { color: true });
  assert.deepEqual(terminalMode({ FORCE_COLOR: "0" }, true), { color: false });
  assert.deepEqual(terminalMode({ FORCE_COLOR: "1" }, false), { color: true });
  assert.equal(terminalMode({ FORCE_COLOR: "0" }, false), undefined);
});
