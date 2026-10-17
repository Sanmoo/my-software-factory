import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { EXIT_RECORD_NAME, createExitRecordWake } from "../src/cli/wake.js";

// A fonte de "acordar" do laço da instância (issue #77, spec #74): o laço para de dormir o
// intervalo inteiro e espera o REGISTRO DE FIM da execução assistida aparecer no diretório de
// estado. O teste é o do seam público — sem admissão, com um diretório real descartável, no
// espírito de `test/execution-loop.test.ts`: o que se prova é o contrato da costura (registro
// acorda, tempo vence, abortar encerra, dispose libera, erro de watcher degrada para o tempo).

const fixture = async (context: TestContext): Promise<{ root: string; stateDir: string }> => {
  const root = await mkdtemp(join(tmpdir(), "msf-wake-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, "state") };
};

// O caminho do registro de fim de uma sessão, como o fluxo o grava.
const seedRecord = async (stateDir: string, key: string, text = '{"exitCode":130,"at":"2026-10-14T12:05:00.000Z"}'): Promise<void> => {
  const dir = join(stateDir, "assist", key, "state");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, EXIT_RECORD_NAME), text);
};

test("o aparecimento do registro de fim acorda a espera em milissegundos, sem esperar o intervalo", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    const waiting = wake.wait(30_000, new AbortController().signal);
    await sleep(20);
    await seedRecord(stateDir, "memory%3Aacme%2Fapp%231");
    const wokeAt = Date.now();
    assert.equal(await waiting, "record");
    assert.ok(Date.now() - wokeAt < 2_000, "acordou na hora, não no fim do intervalo");
  } finally {
    wake.close();
  }
});

test("sem registro, a espera termina no tempo e responde timeout", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    const started = Date.now();
    assert.equal(await wake.wait(120, new AbortController().signal), "timeout");
    assert.ok(Date.now() - started >= 100, "respeitou o tempo pedido");
  } finally {
    wake.close();
  }
});

test("outros arquivos da área não acordam a espera: só o registro de fim é o sinal", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    const waiting = wake.wait(200, new AbortController().signal);
    await sleep(20);
    // Os textos de sessão do container e um registro de OUTRO nome não são o canal de fim.
    const sessions = join(stateDir, "assist", "sessao", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "pi.jsonl"), "{}\n");
    await writeFile(join(sessions, "msf-exit.json.bak"), "{}\n");
    assert.equal(await waiting, "timeout");
  } finally {
    wake.close();
  }
});

test("dispose: depois do close não há mais watcher para acordar a espera", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  wake.close();
  const waiting = wake.wait(150, new AbortController().signal);
  await sleep(20);
  await seedRecord(stateDir, "sessao");
  assert.equal(await waiting, "timeout", "sem watcher, o tempo é a única saída");
});

test("a signal abortada encerra a espera (o laço decide pela própria signal)", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    const controller = new AbortController();
    const waiting = wake.wait(30_000, controller.signal);
    controller.abort();
    assert.equal(await waiting, "timeout");
    // Já abortada na chamada: nunca fica pendurada.
    assert.equal(await wake.wait(30_000, controller.signal), "timeout");
  } finally {
    wake.close();
  }
});

test("um watcher que não pode ser instalado degrada para o tempo, sem erro e sem travar", async (context) => {
  const { stateDir } = await fixture(context);
  // Um ARQUIVO onde o diretório vigiado deveria estar: criar/observar é impossível.
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "assist"), "não é diretório\n");
  const problems: string[] = [];
  const wake = await createExitRecordWake({ stateDir, onError: (reason) => problems.push(reason) });
  try {
    assert.equal(problems.length, 1, "a degradação é reportada uma vez");
    assert.equal(await wake.wait(120, new AbortController().signal), "timeout");
    wake.close();
  } finally {
    wake.close();
  }
});

test("o diretório vigiado é criado quando falta: um stateDir novo já acorda", async (context) => {
  const { root } = await fixture(context);
  const fresh = join(root, "state-novo");
  const wake = await createExitRecordWake({ stateDir: fresh });
  try {
    assert.ok(await readdir(join(fresh, "assist")).then(() => true, () => false), "o diretório vigiado foi criado");
    const waiting = wake.wait(30_000, new AbortController().signal);
    await sleep(20);
    await seedRecord(fresh, "sessao");
    assert.equal(await waiting, "record");
  } finally {
    wake.close();
  }
});

test("um evento que chega FORA da espera (o ciclo está rodando) não se perde: a espera seguinte acorda na hora", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    // Ninguém esperando: o registro aparece durante a passagem (é exatamente o que a primeira
    // passagem de supervisão provocada pelo próprio evento faz).
    await seedRecord(stateDir, "sessao");
    await sleep(50);
    const started = Date.now();
    assert.equal(await wake.wait(30_000, new AbortController().signal), "record", "o evento guardado acorda a espera seguinte");
    assert.ok(Date.now() - started < 2_000, "não esperou o intervalo");
  } finally {
    wake.close();
  }
});

test("duas esperas seguidas: a primeira vence no tempo, a segunda acorda com o registro", async (context) => {
  const { stateDir } = await fixture(context);
  const wake = await createExitRecordWake({ stateDir });
  try {
    assert.equal(await wake.wait(80, new AbortController().signal), "timeout");
    const waiting = wake.wait(30_000, new AbortController().signal);
    await sleep(20);
    await seedRecord(stateDir, "sessao");
    assert.equal(await waiting, "record");
  } finally {
    wake.close();
  }
});
