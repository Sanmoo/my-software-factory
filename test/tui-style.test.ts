// A linguagem visual da TUI (issue #78, spec #74): a derivação estado vivo × fluxo → cor e
// estilo vive num módulo PURO e é o que se testa por unidade — nada de renderização (decisão da
// spec #60). O módulo não importa o Ink: devolve nomes de cor e flags de estilo, e a TUI só
// consome. A fonte de verdade das cores é o protótipo (#49): os sete estados originais mantêm as
// cores de lá; os dois desvios registrados (fora dos sete) recebem cores próprias e distintas,
// porque duas linhas da mesma cor derrotam a leitura de relance.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COR_DO_ESTADO,
  COR_DO_FLUXO,
  MARCADOR_DE_FOCO,
  corHabilitada,
  estiloDaNotaDeEntrega,
  estiloDaLinha,
  estiloDoAviso,
  estiloDoCabecalho,
  estiloDoFoco,
  estiloDoPonto,
} from "../src/core/tui-style.js";
import type { EstadoVivo, Fluxo } from "../src/core/operator-view.js";

const ESTADOS: EstadoVivo[] = [
  "fila",
  "em-invocacao",
  "sessao-aberta",
  "pedido-de-ajuda",
  "interrompido",
  "retomada-autorizada",
  "atendimento-concluido",
  "espera-externa",
  "aguardando-aprovacao",
];

const FLUXOS: Fluxo[] = ["implementacao-autonoma", "humano-assistido"];

// As cores dos sete estados originais, transcritas do protótipo (app.tsx `corEstado`): fonte
// externa ao módulo, para a asserção não recomputar o valor que o código produz.
const CORES_DO_PROTOTIPO: Record<string, string> = {
  fila: "gray",
  "em-invocacao": "blue",
  "sessao-aberta": "cyan",
  "pedido-de-ajuda": "yellow",
  interrompido: "red",
  "retomada-autorizada": "magenta",
  "atendimento-concluido": "green",
};

test("os sete estados originais mantêm as cores do protótipo", () => {
  for (const [estado, cor] of Object.entries(CORES_DO_PROTOTIPO)) {
    assert.equal(COR_DO_ESTADO[estado as EstadoVivo], cor, estado);
  }
  for (const fluxo of FLUXOS) {
    assert.equal(typeof COR_DO_FLUXO[fluxo], "string");
  }
});

test("as nove cores de estado são distintas entre si", () => {
  const cores = ESTADOS.map((estado) => COR_DO_ESTADO[estado]);
  assert.equal(new Set(cores).size, cores.length, `cores repetidas: ${cores.join(", ")}`);
  // Os dois desvios são legíveis: nome de cor não vazio, vindo do mapa exaustivo.
  assert.ok(COR_DO_ESTADO["espera-externa"].length > 0);
  assert.ok(COR_DO_ESTADO["aguardando-aprovacao"].length > 0);
});

test("todo par estado vivo × fluxo devolve cor e estilo, sem deixar buraco", () => {
  for (const fluxo of FLUXOS) {
    for (const estado of ESTADOS) {
      const estilo = estiloDaLinha({ estadoVivo: estado, fluxo }, { color: true });
      assert.equal(estilo.fluxo.color, COR_DO_FLUXO[fluxo], `${fluxo} × ${estado}`);
      assert.equal(estilo.estado.color, COR_DO_ESTADO[estado], `${fluxo} × ${estado}`);
      assert.equal(estilo.fluxo.bold, true, `${fluxo} × ${estado}`);
      assert.equal(estilo.estado.bold, true, `${fluxo} × ${estado}`);
    }
  }
});

test("sem cor, a TUI não carrega cor nenhuma e a estrutura (negrito e marcador) permanece", () => {
  for (const fluxo of FLUXOS) {
    for (const estado of ESTADOS) {
      const estilo = estiloDaLinha({ estadoVivo: estado, fluxo }, { color: false });
      assert.equal(estilo.fluxo.color, undefined, `${fluxo} × ${estado}`);
      assert.equal(estilo.estado.color, undefined, `${fluxo} × ${estado}`);
      assert.equal(estilo.fluxo.bold, true, `${fluxo} × ${estado}`);
      assert.equal(estilo.estado.bold, true, `${fluxo} × ${estado}`);
    }
  }
  assert.equal(estiloDoCabecalho({ color: false }).color, undefined);
  assert.equal(estiloDoCabecalho({ color: false }).bold, true);
  assert.equal(estiloDoAviso(2, { color: false }).color, undefined);
  assert.equal(estiloDoAviso(0, { color: false }).color, undefined);
  assert.equal(estiloDoPonto({ color: false }).color, undefined);
  assert.equal(estiloDoFoco(true, { color: false }).color, undefined);
  assert.equal(estiloDaNotaDeEntrega(false, { color: false }).color, undefined);
});

test("o foco destaca com o marcador do protótipo e se distingue sem cor", () => {
  assert.deepEqual(estiloDoFoco(true, { color: true }), { marcador: MARCADOR_DE_FOCO, color: "yellow" });
  const semCor = estiloDoFoco(true, { color: false });
  assert.equal(semCor.marcador, MARCADOR_DE_FOCO);
  assert.equal(semCor.color, undefined);
  const semFoco = estiloDoFoco(false, { color: true });
  assert.notEqual(semFoco.marcador, MARCADOR_DE_FOCO);
  assert.equal(semFoco.color, undefined);
});

test("o aviso dos pontos de atenção colore pela contagem e fica em negrito sempre", () => {
  assert.deepEqual(estiloDoAviso(0, { color: true }), { color: "green", bold: true });
  assert.deepEqual(estiloDoAviso(3, { color: true }), { color: "yellow", bold: true });
  assert.equal(estiloDoAviso(1, { color: true }).bold, true);
});

test("o cabeçalho é ciano e em negrito; a linha de ponto é amarela", () => {
  assert.deepEqual(estiloDoCabecalho({ color: true }), { color: "cyan", bold: true });
  assert.deepEqual(estiloDoPonto({ color: true }), { color: "yellow", bold: false });
});

test("a entrega falha marca em vermelho; a não comprovada fica discreta", () => {
  assert.deepEqual(estiloDaNotaDeEntrega(false, { color: true }), { color: "red", bold: false });
  assert.deepEqual(estiloDaNotaDeEntrega(true, { color: true }), { bold: false, dim: true });
});

test("a cor só é habilitada por capacidade: TTY ou FORCE_COLOR; NO_COLOR desliga", () => {
  assert.equal(corHabilitada({}, false), false);
  assert.equal(corHabilitada({}, true), true);
  assert.equal(corHabilitada({ NO_COLOR: "1" }, true), false);
  assert.equal(corHabilitada({ FORCE_COLOR: "1" }, false), true);
  // O forçado vence o NO_COLOR, como em `run` (mesma derivação `terminalMode`).
  assert.equal(corHabilitada({ FORCE_COLOR: "1", NO_COLOR: "1" }, false), true);
  assert.equal(corHabilitada({ FORCE_COLOR: "0" }, true), false);
});
