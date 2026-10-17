// A tela alternativa e a limpeza total no resize (issue #78, spec #74): o Ink só limpa a tela
// quando o terminal ENCOLHE, então a TUI registra o próprio ouvinte de 'resize' e reescreve a
// limpeza completa em QUALQUER resize. O instalador é uma costura isolável — recebe um stdout
// falsificado e o flag de capacidade — e o teste NÃO renderiza nada (decisão da spec #60: sem
// teste de renderização da TUI); a tela alternativa em si é do Ink (opção `alternateScreen`), que
// entra com `ESC[?1049h` no mount e restaura o buffer primário ao sair.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { FULL_CLEAR, alwaysLatest, installResizeClear, type LatestWrite, type ResizeWritable } from "../src/cli/tui.js";

interface FakeStdout {
  stream: ResizeWritable;
  written: string[];
  resize: () => void;
  listenerCount: () => number;
}

// Um stdout mínimo: só o que a costura usa (on/off/write), sem TTY nem render.
function fakeStdout(): FakeStdout {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const stream = emitter as unknown as ResizeWritable & { write: (data: string) => boolean };
  stream.write = (data: string): boolean => { written.push(data); return true; };
  return {
    stream,
    written,
    resize: () => { emitter.emit("resize"); },
    listenerCount: () => emitter.listenerCount("resize"),
  };
}

test("a limpeza completa apaga a tela, o histórico e volta ao topo", () => {
  assert.equal(FULL_CLEAR, "\x1B[2J\x1B[3J\x1B[H");
});

test("todo resize escreve a limpeza completa; o descarte remove o ouvinte", () => {
  const fake = fakeStdout();
  const dispose = installResizeClear({ stdout: fake.stream, interactive: true });
  assert.equal(fake.listenerCount(), 1);
  fake.resize();
  fake.resize();
  assert.deepEqual(fake.written, [FULL_CLEAR, FULL_CLEAR]);
  dispose();
  assert.equal(fake.listenerCount(), 0);
  fake.resize();
  assert.deepEqual(fake.written, [FULL_CLEAR, FULL_CLEAR]);
});

test("sem tela interativa, o instalador não registra ouvinte nem escreve", () => {
  const fake = fakeStdout();
  const dispose = installResizeClear({ stdout: fake.stream, interactive: false });
  assert.equal(fake.listenerCount(), 0);
  fake.resize();
  assert.deepEqual(fake.written, []);
  // O descarte de um no-op é seguro.
  dispose();
  assert.equal(fake.listenerCount(), 0);
});

test("o write injetado leva a limpeza (o caminho do Ink, que também repinta o quadro)", () => {
  const fake = fakeStdout();
  const viaWrite: string[] = [];
  installResizeClear({ stdout: fake.stream, interactive: true, write: (data) => { viaWrite.push(data); } });
  fake.resize();
  assert.deepEqual(viaWrite, [FULL_CLEAR]);
  // Com write injetado, a costura não escreve direto no stream.
  assert.deepEqual(fake.written, []);
});

// O ouvinte de resize é instalado UMA vez por mount: a `write` do Ink vai num ref e o efeito depende
// só dela, então o escritor que a costura recebe é estável e chama sempre a versão mais recente.
test("o escritor da limpeza é estável e chama sempre a write mais recente", () => {
  const primeiro: string[] = [];
  const segundo: string[] = [];
  const ref: LatestWrite = { current: (data) => { primeiro.push(data); } };
  const write = alwaysLatest(ref);
  // A mesma função instalada no ouvinte, com a `write` trocada por outra (o que o Ink pode fazer a
  // cada render): o resize seguinte tem de escrever pela nova.
  ref.current = (data) => { segundo.push(data); };
  write(FULL_CLEAR);
  assert.deepEqual(primeiro, [], "a função antiga não é mais chamada");
  assert.deepEqual(segundo, [FULL_CLEAR]);
  // E a costura continua instalando um ouvinte só com esse escritor.
  const fake = fakeStdout();
  const dispose = installResizeClear({ stdout: fake.stream, interactive: true, write });
  assert.equal(fake.listenerCount(), 1);
  fake.resize();
  assert.deepEqual([...segundo], [FULL_CLEAR, FULL_CLEAR]);
  dispose();
  assert.equal(fake.listenerCount(), 0);
});
