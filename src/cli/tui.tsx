import { Box, Text, render, useApp, useInput, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { buildOperatorView, comandoAtender, nextStepHint, type AtenderContext, type HintColor, type OperatorWork, type OperatorView } from "../core/operator-view.js";
import {
  COR_DA_BORDA,
  corHabilitada,
  estiloDaNotaDeEntrega,
  estiloDaLinha,
  estiloDoAviso,
  estiloDoCabecalho,
  estiloDoFoco,
  estiloDoPonto,
} from "../core/tui-style.js";
import { operatorCommand, type OperatorAction } from "../core/operator-actions.js";
import { jobCommands, type CliHints, type JobCommands } from "../core/observability.js";
import type { CommandQueue } from "../core/commands.js";
import type { InstanceConfig } from "../config/types.js";
import type { TrackerPort } from "../tracker/port.js";
import { createFileCommandQueue } from "../state/command-queue.js";

// The operator's TUI (issue #61, spec #60; pontos de atenção + dica are #62; operator actions
// are #63; atender is #64; `t` also resumes are #77): one screen, one instance. It renders the
// reading model (buildOperatorView) and ACTS only through the instance's local command queue —
// the same surface the supervision CLI writes, which the instance applies in order on its next
// poll (ADR 0001: the core grades the effect; the TUI never touches tracker, processes, sessions
// or any store). Keys: ↑/↓ move the focus over the works list, r responds to a help request
// (inline text input), a approves the proposed result, e authorizes the resume, l releases —
// each pre-validated by the pure action map, so a refusal shows its reason on screen and
// enqueues NOTHING — t RESUMES the focused assisted attendance when the core's own pre-check
// accepts it (`retomar`: interrupted, or an open session whose exec end record already exists,
// #77) and otherwise keeps opening the atender block (the copyable context of the focused work,
// a DISPLAY ONLY block: copying is the terminal's own selection, nothing is executed, nothing
// enters the queue, no pending is resolved; Esc closes) — and q / Ctrl+C quits.

export interface TuiOptions {
  instance: InstanceConfig;
  stateDir: string;
  // The base directory used, only when it is not the default — it lands in the paste-ready
  // commands the hints embed (same trick `status` uses, so a printed command is usable as
  // printed).
  home?: string;
  // The read-only tracker port for the issue status column: msf composes it exactly like the
  // one `status` reads through (spec #60 story 4). Absent ⇒ every issue shows "indisponível";
  // a failing read degrades per work. The TUI never writes through it (no write path exists).
  tracker?: TrackerPort;
  // Test seam: interval between rebuilds in milliseconds (default 5s).
  refreshMs?: number;
  // Test seam: the command queue the actions write through (default: the instance's real file
  // queue under `stateDir`). Injected so the write-path tests record every enqueue without a
  // terminal — and so they can prove nothing else is written.
  queue?: CommandQueue;
  // Test seam: the environment the color capability is read from (default: process.env).
  env?: Record<string, string | undefined>;
  // Test seam: whether stdout is a terminal (default: process.stdout.isTTY === true). Gates the
  // alternate screen and the total clears; without a TTY both stay off and the screen is a plain,
  // colorless dump (spec #74: the TUI stays legible without color).
  isTTY?: boolean;
}

// ── Tela (issue #78, spec #74) ────────────────────────────────────────────────────────────────
// A TUI roda na tela alternativa do Ink (opção `alternateScreen`: `ESC[?1049h` no mount,
// `ESC[?1049l` ao sair, restaurando o buffer primário) e limpa a tela inteira no mount e em
// QUALQUER resize — o Ink só limpa quando o terminal encolhe. Sem TTY, nada de tela alternativa
// nem de escape ANSI: a tela continua legível sem cor. A derivação cor/estilo é do módulo puro
// `../core/tui-style.js`; aqui só se consome.

// A limpeza total: apaga a tela visível (`2J`), o histórico (`3J`) e volta o cursor ao topo (`H`).
// É a mesma sequência do protótipo da #49.
export const FULL_CLEAR = "\x1B[2J\x1B[3J\x1B[H";

// O mínimo que a costura de resize usa de um stdout: o evento `resize` e o `write`.
export interface ResizeWritable {
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
  write(data: string): unknown;
}

export interface ResizeClearOptions {
  // O stream cujo evento `resize` dispara a limpeza (o stdout do Ink, por padrão process.stdout).
  stdout: ResizeWritable;
  // Capacidade: um stdout não interativo não tem tela para limpar e não ganha ouvinte.
  interactive: boolean;
  // Como a limpeza é escrita. Em produção vai o `useStdout().write` do Ink, que também zera a
  // contabilidade de quadro do Ink e REPINTA o quadro (um resize nunca deixa a tela em branco);
  // ausente ⇒ `stdout.write` cru, o padrão fora do Ink.
  write?: (data: string) => void;
}

// Instala a limpeza de resize e devolve o descarte (chamar no desmonte). O Ink limpa a tela só
// quando o terminal ENCOLHE; um crescimento reflui o quadro e pode deixar resto, então TODO resize
// recebe a limpeza total (spec #74 história 31: nenhum resto de quadro em resize algum).
export function installResizeClear({ stdout, interactive, write }: ResizeClearOptions): () => void {
  if (!interactive) return () => {};
  const onResize = (): void => {
    if (write !== undefined) { write(FULL_CLEAR); return; }
    stdout.write(FULL_CLEAR);
  };
  stdout.on("resize", onResize);
  return () => { stdout.off("resize", onResize); };
}

// A capacidade do terminal que a TUI vai assumir: um TTY ganha a tela alternativa e as cores (a
// não ser que NO_COLOR/FORCE_COLOR digam outra coisa); sem ele, as duas ficam desligadas.
const capacidadeDoTerminal = (options: Pick<TuiOptions, "env" | "isTTY">): { terminal: boolean; color: boolean } => {
  const terminal = options.isTTY ?? process.stdout.isTTY === true;
  return { terminal, color: corHabilitada(options.env ?? process.env, terminal) };
};

// O efeito de tela dentro do app: cada resize limpa pela `write` do próprio stdout do Ink (que
// zera a contabilidade de quadro e repinta), e o desmonte remove o ouvinte.
function useResizeClear(interactive: boolean): void {
  const { stdout, write } = useStdout();
  useEffect(() => installResizeClear({ stdout, interactive, write }), [stdout, interactive, write]);
}

// PT-BR labels for the estados vivos, including the two derived states registered as deviations
// (espera externa e aguardando aprovação, fora dos 7 da spec, reais no estado gravado).
export const ESTADO_LABELS: Record<OperatorView["works"][number]["estadoVivo"], string> = {
  fila: "fila",
  "em-invocacao": "em invocação",
  "sessao-aberta": "sessão aberta",
  "pedido-de-ajuda": "pedido de ajuda",
  interrompido: "interrompido",
  "retomada-autorizada": "retomada autorizada",
  "atendimento-concluido": "atendimento concluído",
  "espera-externa": "espera externa",
  "aguardando-aprovacao": "aguardando aprovação",
};

const FLUXO_LABELS = {
  "implementacao-autonoma": "AUTÔNOMO",
  "humano-assistido": "ASSISTIDO",
} as const;

const meterText = (used: number, limit: number | null): string =>
  limit === null ? `${used}/—` : `${used}/${limit}`;

// The shared composition of the paste-ready command set of one work: `jobCommands` over ALL
// work keys (so a short ref resolves against the same space the commands will), the real
// CliHints exactly like `status` composes them.
const commandsFor = (work: OperatorWork, view: OperatorView, cli: CliHints): JobCommands =>
  jobCommands(cli, work.key, view.works.map((row) => row.key));

// The paste-ready forms for one work, built here in the TUI layer with the real CliHints exactly
// like `status` composes them: `jobCommands` over ALL work keys (so a short ref resolves against
// the same space the commands will). No release command is built here: an interruption hint
// names release but deliberately does not offer it ready-to-paste (a paste must not end the
// follow-up by accident); the per-pending action lines are #64's slice.
const hintsFor = (work: OperatorWork, view: OperatorView, cli: CliHints): HintColor => {
  const commands = commandsFor(work, view, cli);
  return {
    reply: commands.reply,
    resume: commands.resume,
    approve: `${commands.base} approve ${commands.ref}`,
  };
};

// The atender context of one work (issue #64), composed with the real CliHints exactly like
// `status` composes its paste-ready lines: `jobCommands` over ALL work keys (so a short ref
// resolves against the same space the commands will). An assisted work hands its RECORDED
// session, so the derivation shows the Herdr area identity — there is no host Herdr command
// to run, and none is invented here.
const atenderContextFor = (work: OperatorWork, view: OperatorView, cli: CliHints): AtenderContext =>
  work.fluxo === "humano-assistido"
    ? { session: view.sessions.find((session) => session.key === work.key) }
    : { commands: commandsFor(work, view, cli) };

// The per-pending annotation of a delivery that is not confirmed: `status` prints a provenance
// line for every pending (it never claims the desktop notification appeared); the TUI marks the
// row only when there is something to say — the attempt failed or the channel was absent.
// Absent notification: nothing was attempted yet, nothing to flag.
const notaDeEntrega = (pending: OperatorView["pendings"][number]): string | undefined => {
  const notification = pending.notification;
  if (notification === undefined) return undefined;
  return notification.ok
    ? `entrega de notificação ao desktop não comprovada (comando executado no canal: ${notification.channel})`
    : `entrega de notificação não comprovada — canal tentado: ${notification.channel} falhou: ${notification.error ?? ""}`;
};

// The label each action gets in the confirmation line (supervision's CONFIRMATION wording,
// adapted to the TUI banner).
const ACTION_LABELS: Record<OperatorAction, string> = {
  responder: "resposta",
  "aprovar-resultado": "aprovação",
  "autorizar-retomada": "autorização de retomada",
  retomar: "retomada manual",
  liberar: "liberação",
};

// What one key press left on screen: either the enqueue confirmation or the refusal reason
// (rendered in the banner above the hint line; a refusal never enqueues anything).
export type TuiNotice = { kind: "ok" | "recusa"; text: string };

// The write path of one operator action (issue #63): the pure action map decides, an ok
// enqueues through the INJECTED queue and reports the confirmation adapted from the
// supervision CLI's wording (queued is not applied: the instance applies the queue on its
// next poll); a refusal enqueues NOTHING and reports the reason.
export async function applyOperatorAction(
  action: OperatorAction,
  work: OperatorWork,
  view: OperatorView,
  queue: CommandQueue,
  instanceName: string,
  message?: string,
): Promise<TuiNotice> {
  const outcome = operatorCommand(action, work, view, message);
  if (outcome.ok === false) return { kind: "recusa", text: outcome.reason };
  const id = await queue.enqueue(outcome.command);
  return {
    kind: "ok",
    text: `${ACTION_LABELS[action]} para ${work.issueRef}: enfileirado na fila da instância ${instanceName}; `
      + `comando=${id}; será aplicado no próximo ciclo — aguarde o scanner da instância`,
  };
}

// The decision of one `t` press (#77): either the manual resume was ENQUEUED (the confirmation
// notice, exactly like every other action), or the press opens today's display-only block.
export type AtenderDecisao = { kind: "retomada"; notice: TuiNotice } | { kind: "exibicao" };

// The `t` key of the focused work (issue #77, spec #74). The reading model is reread AT KEY TIME
// — a fresh `buildOperatorView`, never the possibly stale screen state — because the decision on
// disk right after Ctrl-C (the end record existing before the supervision pass parks the session)
// is exactly what the stored state may not show yet. The manual resume goes through the core's own
// pre-check map (`retomar`) and the same injected queue as every other action; a refusal enqueues
// NOTHING and keeps `t` as the copyable-context key of #64 (the display block). Nothing else is
// written anywhere.
export async function atenderFoco(
  focusedKey: string | undefined,
  deps: {
    stateDir: string;
    instance: InstanceConfig;
    tracker?: TrackerPort;
    queue: CommandQueue;
    instanceName: string;
  },
): Promise<AtenderDecisao> {
  if (focusedKey === undefined) return { kind: "exibicao" };
  const view = await buildOperatorView({
    stateDir: deps.stateDir, instance: deps.instance,
    ...(deps.tracker === undefined ? {} : { tracker: deps.tracker }),
  });
  const work = view.works.find((candidate) => candidate.key === focusedKey);
  // A key that left the model between the last rebuild and the key press: nothing to resume.
  if (work === undefined) return { kind: "exibicao" };
  if (operatorCommand("retomar", work, view).ok === false) return { kind: "exibicao" };
  return { kind: "retomada", notice: await applyOperatorAction("retomar", work, view, deps.queue, deps.instanceName) };
}

// The screen itself, exported for the scenario rounds the acceptance asks for (spec #60:
// "a aceitação é uma rodada de cenários com dados semeados") and for the later tickets that
// grow it. `runTui` is the only place that renders it in production.
export function OperatorScreen({ instance, stateDir, home, tracker, refreshMs = 5_000, queue: queueOption, env, isTTY }: TuiOptions): ReactElement {
  const { exit } = useApp();
  // Sem um stdin em modo cru (stdout sem TTY), o Ink recusa `setRawMode` e a tecla não existe: o
  // `useInput` fica inativo e a tela continua sendo desenhada e legível sem cor (spec #74).
  const { isRawModeSupported } = useStdin();
  // A linguagem visual: a capacidade do terminal (TTY e cores) e o efeito de limpeza em cada
  // resize. `color: false` desliga as cores e deixa a tela legível sem elas (spec #74).
  const { terminal, color } = capacidadeDoTerminal({ env, isTTY });
  useResizeClear(terminal);
  const [view, setView] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyboard focus over the works list (a position, not an id: a rebuild keeps #61's order and
  // the selection follows positions; the list may also shrink between rebuilds).
  const [focus, setFocus] = useState(0);
  // The queue the actions write through, created once (the injected fake in tests, the real
  // file queue of the instance in production).
  const [queue] = useState(() => queueOption ?? createFileCommandQueue(stateDir));
  // The banner above the hint line: the confirmation of an enqueued command or the reason of a
  // refusal (a refusal enqueues nothing).
  const [notice, setNotice] = useState<TuiNotice | null>(null);
  // The inline reply input opened by `r`: Enter submits, Esc cancels.
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  // The atender block opened by `t` (issue #64): a DISPLAY ONLY block over the focused work —
  // the derivation happens fresh on every render, so the block follows the focus; Esc closes.
  // Opening or reading it never writes anywhere (the side-effect proof lives in the tests).
  const [attending, setAttending] = useState(false);

  const rebuild = useCallback((): void => {
    buildOperatorView({ stateDir, instance, ...(tracker === undefined ? {} : { tracker }) })
      .then((next) => { setView(next); setError(null); })
      .catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : String(caught)); });
  }, [stateDir, instance, tracker]);

  useEffect(() => {
    rebuild();
    const timer = setInterval(rebuild, refreshMs);
    return () => { clearInterval(timer); };
  }, [rebuild, refreshMs]);

  useInput((input, key) => {
    if (replying) {
      // While the reply input is open, the keys type the message: Enter submits it, Esc
      // cancels, backspace erases — `q` types a `q`, it does not quit.
      if (key.ctrl === true && input === "c") { exit(); return; }
      if (key.return === true) {
        const message = draft;
        setReplying(false);
        setDraft("");
        act("responder", message);
        return;
      }
      if (key.escape === true) { setReplying(false); setDraft(""); return; }
      if (key.backspace === true || key.delete === true) { setDraft((current) => current.slice(0, -1)); return; }
      // Ink delivers '' for functional keys and the whole chunk for a paste: append whatever
      // printable text arrived (a paste lands as one chunk, not one character at a time).
      if (input.length > 0) setDraft((current) => current + input);
      return;
    }
    if (input === "q" || (key.ctrl === true && input === "c")) { exit(); return; }
    if (key.upArrow === true) { setFocus((current) => Math.max(0, current - 1)); return; }
    if (key.downArrow === true) { setFocus((current) => current + 1); return; }
    // The four operator actions act on the focused work; with no work focused they do nothing.
    if (input === "r") { setReplying(true); setDraft(""); setNotice(null); return; }
    if (input === "a") { act("aprovar-resultado"); return; }
    if (input === "e") { act("autorizar-retomada"); return; }
    if (input === "l") { act("liberar"); return; }
    // atender/retomar (issues #64 and #77): the manual resume when the core's pre-check accepts
    // it (enqueue + green banner), otherwise the display-only context block of #64; Esc closes.
    // The decision is reread from disk at key time inside `atender`.
    if (input === "t") { atender(); return; }
    if (key.escape === true) { setAttending(false); return; }
  }, { isActive: isRawModeSupported });

  // One action of the operator on the focused work: pre-validated by the pure map, enqueued
  // through the queue (an ok also rebuilds so the pending-commands count stays honest), or
  // refused with the reason shown in the banner and NOTHING enqueued.
  function act(action: OperatorAction, message?: string): void {
    if (view === null) return;
    const focused = view.works.length === 0 ? undefined : view.works[Math.min(focus, view.works.length - 1)];
    if (focused === undefined) return;
    applyOperatorAction(action, focused, view, queue, instance.name, message).then((result) => {
      setNotice(result);
      if (result.kind === "ok") rebuild();
    });
  }

  // `t` (#77): the reading model is reread AT KEY TIME (never the screen state, which may be up
  // to `refreshMs` old — and, right after Ctrl-C, wrong by construction). An accepted manual
  // resume enqueues through the same queue and shows the confirmation; a refusal enqueues
  // NOTHING and opens today's display-only context block (#64), which is what keeps `t` the
  // copyable-context key for everything else.
  function atender(): void {
    const current = view;
    if (current === null) return;
    const index = Math.min(focus, current.works.length - 1);
    const focusedKey = index >= 0 ? current.works[index]?.key : undefined;
    atenderFoco(focusedKey, {
      stateDir, instance, ...(tracker === undefined ? {} : { tracker }), queue, instanceName: instance.name,
    }).then((decision) => {
      if (decision.kind === "retomada") { setAttending(false); setNotice(decision.notice); rebuild(); return; }
      setAttending(true);
    }).catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : String(caught)); });
  }

  if (error !== null) return <Text color="red">leitura falhou: {error}</Text>;
  if (view === null) return <Text>lendo o estado da instância…</Text>;

  const { meters, footer } = view;
  // Focus clamps to the list as rebuilt (a shrinking list keeps the selection on the last row).
  const focusedIndex = Math.min(focus, view.works.length - 1);
  const focused = focusedIndex >= 0 ? view.works[focusedIndex] : undefined;
  // The paste-ready text comes from the real CliHints, exactly like `status` composes it.
  const cli: CliHints = { instance: instance.name, ...(home === undefined ? {} : { home }) };
  // atender (#64): the copyable context of the focused work, derived pure per fluxo. It is
  // recomputed on every render, so the open block follows the focus; null shows nothing.
  const atendido = focused !== undefined ? comandoAtender(focused, atenderContextFor(focused, view, cli)) : null;
  const atenderLinhas = atendido === null ? [] : atendido.split("\n");
  // A linguagem visual do protótipo (#49), consumida do módulo puro: cabeçalho ciano, aviso dos
  // pontos de atenção colorido pela contagem e o amarelo da linha de cada ponto.
  const cabecalho = estiloDoCabecalho({ color });
  const aviso = estiloDoAviso(view.pendings.length, { color });
  const ponto = estiloDoPonto({ color });
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Box flexDirection="column" marginBottom={1}>
        {/* O estado vivo aparece sempre separado do status da issue; o cabeçalho nomeia a instância. */}
        <Text color={cabecalho.color} bold={cabecalho.bold}>
          ■ Factory — gestão local · {instance.name}{footer.pause.paused ? " — admissões pausadas" : ""}
        </Text>
        <Text>
          impl. autônoma {meterText(meters.implementation.used, meters.implementation.limit)} ·
          {" "}sessões assistidas {meterText(meters.assisted.used, meters.assisted.limit)}
          {meters.assisted.limit === null ? ` (sem limite: nenhuma sessão é aberta)` : ""}
          {footer.pause.pending ? " · comando de pausa aguarda o próximo ciclo" : ""}
        </Text>
      </Box>

      <Text bold underline>Trabalhos ({view.works.length}):</Text>
      {view.works.map((work, index) => {
        // Foco: o marcador do protótipo no trabalho em foco (a linha em foco também fica em
        // negrito, para o destaque sobreviver sem cor); a tag de fluxo e o rótulo do estado vivo
        // levam cada um a sua cor.
        const foco = estiloDoFoco(index === focusedIndex, { color });
        const linha = estiloDaLinha(work, { color });
        return (
          <Text key={`${work.fluxo}:${work.key}`} wrap="truncate" bold={index === focusedIndex}>
            <Text color={foco.color}>{foco.marcador}</Text>
            {" "}
            <Text color={linha.fluxo.color} bold={linha.fluxo.bold}>[{FLUXO_LABELS[work.fluxo]}]</Text>
            {" "}{work.issueRef} — <Text color={linha.estado.color} bold={linha.estado.bold}>{ESTADO_LABELS[work.estadoVivo]}</Text> · issue: {work.issue.status}
          </Text>
        );
      })}
      {/* Banner de confirmação/recusa: acima da dica; uma recusa nunca enfileirou nada. */}
      {notice !== null && (
        <Text color={notice.kind === "ok" ? "green" : "red"} wrap="truncate">
          {notice.kind === "ok" ? notice.text : `recusa: ${notice.text}`}
        </Text>
      )}
      {replying && focused !== undefined && (
        <Text wrap="truncate">resposta para [{focused.issueRef}] — Enter envia, Esc cancela: {draft}_</Text>
      )}
      {focused && (
        <Box marginTop={0} marginBottom={1}>
          {/* Dica derivada no modelo (estado vivo × fluxo); um comando quotado é só texto na tela. */}
          <Text wrap="truncate">Próximo passo [{focused.issueRef}]: {nextStepHint(focused, hintsFor(focused, view, cli))}</Text>
        </Box>
      )}
      {attending && focused !== undefined && atendido !== null && (
        <Box marginTop={0} marginBottom={1} flexDirection="column">
          {/* atender (#64): o contexto copiável do trabalho em foco — SÓ exibição: copiar é a
              seleção nativa do terminal; nada é executado, nada entra na fila, nenhuma
              pendência é resolvida. Para o assistido sem retomada possível (`t` recusado pela
              pré-checagem, #77) o bloco mostra a identidade da área no Herdr; o autônomo mostra
              os comandos de leitura. Sem contexto derivável, o bloco nem aparece (nada é
              inventado). Esc fecha. A retomada possível NÃO passa por aqui: ela enfileira e
              confirma no banner. */}
          <Text bold wrap="truncate">atender [{focused.issueRef}]:</Text>
          {atenderLinhas.map((linha) => <Text key={linha} color="cyan" wrap="truncate">  {linha}</Text>)}
          <Text dimColor wrap="truncate">
            {focused.fluxo === "humano-assistido"
              ? "abra esta área no Herdr — copie o que precisar; nada é aberto, executado ou enfileirado aqui"
              : "copie o comando para ver o contexto; nada é executado ou enfileirado aqui — Esc fecha"}
          </Text>
        </Box>
      )}

      {/* Pontos de atenção persistentes: a fila como o store a devolve, com a idade derivada.
          O aviso colore pela contagem e cada ponto é amarelo; a proveniência de uma entrega que
          falhou marca em vermelho. */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={aviso.color} bold={aviso.bold}>⚠ Pontos de atenção ({view.pendings.length})</Text>
        {view.pendings.length === 0 && <Text dimColor>· nenhum ponto de atenção</Text>}
        {view.pendings.map((pending) => {
          const nota = notaDeEntrega(pending);
          const entrega = pending.notification === undefined ? undefined : estiloDaNotaDeEntrega(pending.notification.ok, { color });
          return (
            <Box key={pending.id} flexDirection="column">
              <Text color={ponto.color} bold={ponto.bold} wrap="truncate">· {pending.kind} {pending.key} · {pending.what} · {pending.idade}</Text>
              {/* Falha de entrega marca a linha; nunca remove nem esconde o ponto. */}
              {nota !== undefined && (
                <Text color={entrega?.color} dimColor={entrega?.dim} wrap="truncate">  {nota}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Rodapé com borda e largura total, como a legenda do protótipo. */}
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={COR_DA_BORDA} width="100%">
        <Text>
          {" "}Concluídos: {footer.jobsDone} · Liberados: {footer.jobsReleased} ·
          {" "}Comandos pendentes: {footer.pendingCommands}
        </Text>
        <Text dimColor>{" "}↑/↓ movem o foco · r responde · a aprova resultado · e autoriza retomada · l libera · t retoma o atendimento assistido (ou atende: comando copiável) · Esc fecha · q / Ctrl+C sai — escritas só na fila de comandos</Text>
      </Box>
    </Box>
  );
}

// The seam msf hands the terminal over to: `msf`'s `tui` injects a fake in tests, the real one
// below renders Ink and owns the terminal until q/Ctrl+C.
export type TuiRunner = (options: TuiOptions) => void;

export const runTui: TuiRunner = (options: TuiOptions): void => {
  const { instance, stateDir, home, tracker, refreshMs, queue } = options;
  const { terminal } = capacidadeDoTerminal(options);
  // Limpeza total antes de montar: a tela alternativa já nasce vazia, mas a limpeza explícita
  // cobre também o caso sem tela alternativa. Só um terminal interativo recebe escapes ANSI.
  if (terminal) process.stdout.write(FULL_CLEAR);
  render(
    <OperatorScreen
      instance={instance}
      stateDir={stateDir}
      {...(home === undefined ? {} : { home })}
      {...(tracker === undefined ? {} : { tracker })}
      {...(refreshMs === undefined ? {} : { refreshMs })}
      {...(queue === undefined ? {} : { queue })}
      {...(options.env === undefined ? {} : { env: options.env })}
      {...(options.isTTY === undefined ? {} : { isTTY: options.isTTY })}
    />,
    {
      stdout: process.stdout,
      // O Ink é dono da tela alternativa: entra no mount (`ESC[?1049h`) e restaura o buffer
      // primário ao sair, deixando o histórico do terminal como estava (spec #74 história 32).
      // Sem TTY, as duas ficam desligadas e a tela é um despejo comum, sem cor.
      alternateScreen: terminal,
      interactive: terminal,
    },
  );
  // Ink owns the terminal from here; the renderer keeps the process alive like any interactive app.
};
