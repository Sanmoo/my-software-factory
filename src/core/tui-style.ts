// A linguagem visual da TUI (issue #78, spec #74): a derivação estado vivo × fluxo → cor e estilo
// mora aqui, num módulo PURO — sem importar o Ink e sem renderizar nada. Devolve nomes de cor
// (strings, o vocabulário que o `<Text color>` do Ink aceita via chalk) e flags de estilo; a TUI
// só consome. A fonte de verdade é o protótipo da #49 (`tui-prototype/src/app.tsx`): os sete
// estados originais mantêm as cores de lá, e os DOIS desvios registrados contra os sete
// (`espera-externa`, `aguardando-aprovacao`) ganham cores próprias e distintas — duas linhas da
// mesma cor derrotariam a leitura de relance que é o ponto do ticket. Os mapas são
// `Record<EstadoVivo, …>` / `Record<Fluxo, …>`: um estado futuro quebra a compilação, não o
// operador.
//
// Quando não há cor (sem TTY, ou NO_COLOR sem FORCE_COLOR), toda derivação devolve a MESMA forma
// sem a cor: o rótulo textual, o negrito e o marcador de foco continuam, então a tela segue
// legível sem cor (spec #74 história 33).
import { terminalMode } from "./main-log.js";
import type { EstadoVivo, Fluxo, OperatorWork } from "./operator-view.js";

// ── Capacidade ───────────────────────────────────────────────────────────────────────────────

// A cor só é habilitada por capacidade, pela MESMA derivação do log humano (`terminalMode`): TTY
// (ou FORCE_COLOR) habilita, NO_COLOR desliga. É a própria derivação que é capability-aware.
export function corHabilitada(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return terminalMode(env, isTTY)?.color ?? false;
}

// ── Cores ────────────────────────────────────────────────────────────────────────────────────

export const COR_DO_ESTADO: Record<EstadoVivo, string> = {
  fila: "gray",
  "em-invocacao": "blue",
  "sessao-aberta": "cyan",
  "pedido-de-ajuda": "yellow",
  interrompido: "red",
  "retomada-autorizada": "magenta",
  "atendimento-concluido": "green",
  // Espera externa (autônomo em `waiting-for-pr`): uma espera passiva — nada exige o operador —
  // por isso um neutro claro, distinto do cinza da fila.
  "espera-externa": "whiteBright",
  // Aguardando aprovação (assistido em `proposed`): há uma decisão pendente, mais suave que um
  // pedido de ajuda em vermelho/amarelo; um amarelo claro a separa do pedido de ajuda.
  "aguardando-aprovacao": "yellowBright",
};

export const COR_DO_FLUXO: Record<Fluxo, string> = {
  "implementacao-autonoma": "blue",
  "humano-assistido": "cyan",
};

export const COR_DO_CABECALHO = "cyan";
export const COR_DO_FOCO = "yellow";
export const COR_DO_AVISO_COM_PONTOS = "yellow";
export const COR_DO_AVISO_SEM_PONTOS = "green";
export const COR_DO_PONTO = "yellow";
export const COR_DA_FALHA_DE_ENTREGA = "red";
export const COR_DA_BORDA = "gray";
export const MARCADOR_DE_FOCO = "❯";

// ── Estilos ───────────────────────────────────────────────────────────────────────────────────

export interface EstiloTexto {
  // Ausente quando a capacidade está desligada: o texto continua, a cor não.
  color?: string;
  bold: boolean;
  dim?: boolean;
}

export interface EstiloDaLinha {
  fluxo: EstiloTexto;
  estado: EstiloTexto;
}

export interface EstiloDoFoco {
  // O marcador sozinho distingue o foco quando não há cor.
  marcador: string;
  color?: string;
}

// A linha de um trabalho: a tag de fluxo e o rótulo do estado vivo, ambos em negrito, cada um com
// a sua cor (o protótipo colore os dois).
export function estiloDaLinha(work: Pick<OperatorWork, "estadoVivo" | "fluxo">, opts: { color: boolean }): EstiloDaLinha {
  return {
    fluxo: { bold: true, ...(opts.color ? { color: COR_DO_FLUXO[work.fluxo] } : {}) },
    estado: { bold: true, ...(opts.color ? { color: COR_DO_ESTADO[work.estadoVivo] } : {}) },
  };
}

// O foco da lista: o marcador do protótipo no trabalho em foco, amarelo quando há cor; os demais
// ficam com um espaço (alinhamento preservado). Sem cor, o marcador ainda distingue.
export function estiloDoFoco(focado: boolean, opts: { color: boolean }): EstiloDoFoco {
  return focado ? { marcador: MARCADOR_DE_FOCO, ...(opts.color ? { color: COR_DO_FOCO } : {}) } : { marcador: " " };
}

// O cabeçalho da tela: ciano e em negrito, como o banner do protótipo.
export function estiloDoCabecalho(opts: { color: boolean }): EstiloTexto {
  return { bold: true, ...(opts.color ? { color: COR_DO_CABECALHO } : {}) };
}

// O título dos pontos de atenção: verde quando não há nenhum, amarelo quando há — a cor é a
// contagem, para o aviso saltar de relance.
export function estiloDoAviso(abertos: number, opts: { color: boolean }): EstiloTexto {
  if (!opts.color) return { bold: true };
  return { color: abertos > 0 ? COR_DO_AVISO_COM_PONTOS : COR_DO_AVISO_SEM_PONTOS, bold: true };
}

// Uma linha de ponto de atenção (o ponto em si é amarelo, não em negrito no protótipo).
export function estiloDoPonto(opts: { color: boolean }): EstiloTexto {
  return { bold: false, ...(opts.color ? { color: COR_DO_PONTO } : {}) };
}

// A nota de proveniência de uma entrega de notificação: não comprovada (`ok`) fica discreta; a
// que falhou marca em vermelho. Chamada só para um pendente COM proveniência.
export function estiloDaNotaDeEntrega(ok: boolean, opts: { color: boolean }): EstiloTexto {
  return ok ? { bold: false, dim: true } : { bold: false, ...(opts.color ? { color: COR_DA_FALHA_DE_ENTREGA } : {}) };
}
