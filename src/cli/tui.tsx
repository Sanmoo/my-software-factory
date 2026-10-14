import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { buildOperatorView, comandoAtender, nextStepHint, type AtenderContext, type HintColor, type OperatorWork, type OperatorView } from "../core/operator-view.js";
import { operatorCommand, type OperatorAction } from "../core/operator-actions.js";
import { jobCommands, type CliHints, type JobCommands } from "../core/observability.js";
import type { CommandQueue } from "../core/commands.js";
import type { InstanceConfig } from "../config/types.js";
import type { TrackerPort } from "../tracker/port.js";
import { createFileCommandQueue } from "../state/command-queue.js";

// The operator's TUI (issue #61, spec #60; pontos de atenção + dica are #62; operator actions
// are #63; atender is #64): one screen, one instance. It renders the reading model
// (buildOperatorView) and ACTS only through the instance's local command queue — the same
// surface the supervision CLI writes, which the instance applies in order on its next poll
// (ADR 0001: the core grades the effect; the TUI never touches tracker, processes, sessions or
// any store). Keys: ↑/↓ move the focus over the works list, r responds to a help request
// (inline text input), a approves the proposed result, e authorizes the resume, l releases —
// each pre-validated by the pure action map, so a refusal shows its reason on screen and
// enqueues NOTHING — t opens the atender block (the copyable context of the focused work, a
// DISPLAY ONLY block: copying is the terminal's own selection, nothing is executed, nothing
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

// The screen itself, exported for the scenario rounds the acceptance asks for (spec #60:
// "a aceitação é uma rodada de cenários com dados semeados") and for the later tickets that
// grow it. `runTui` is the only place that renders it in production.
export function OperatorScreen({ instance, stateDir, home, tracker, refreshMs = 5_000, queue: queueOption }: TuiOptions): ReactElement {
  const { exit } = useApp();
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
    // atender (issue #64): opens the display-only context block; Esc closes it. Nothing here
    // writes, executes or enqueues — the block is text on screen; copying is the terminal's own.
    if (input === "t") { setAttending(true); return; }
    if (key.escape === true) { setAttending(false); return; }
  });

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
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        {/* O estado vivo aparece sempre separado do status da issue; cabeçalho nomeia a instância. */}
        <Text>Instância {instance.name}{footer.pause.paused ? " — admissões pausadas" : ""}</Text>
        <Text>
          impl. autônoma {meterText(meters.implementation.used, meters.implementation.limit)} ·
          {" "}sessões assistidas {meterText(meters.assisted.used, meters.assisted.limit)}
          {meters.assisted.limit === null ? ` (sem limite: nenhuma sessão é aberta)` : ""}
          {footer.pause.pending ? " · comando de pausa aguarda o próximo ciclo" : ""}
        </Text>
      </Box>

      <Text>Trabalhos ({view.works.length}):</Text>
      {view.works.map((work, index) => (
        <Text key={`${work.fluxo}:${work.key}`} wrap="truncate" bold={index === focusedIndex}>
          {index === focusedIndex ? "> " : "  "}
          [{FLUXO_LABELS[work.fluxo]}] {work.issueRef} — {ESTADO_LABELS[work.estadoVivo]} · issue: {work.issue.status}
        </Text>
      ))}
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
          {/* atender (#64): o comando copiável do trabalho em foco — SÓ exibição: copiar é a
              seleção nativa do terminal; nada é executado, nada entra na fila, nenhuma
              pendência é resolvida. Em fluxo assistido o bloco mostra a identidade da área no
              Herdr (não existe comando de Herdr a executar); sem contexto derivável, o bloco
              nem aparece (nada é inventado). Esc fecha. */}
          <Text bold wrap="truncate">atender [{focused.issueRef}]:</Text>
          {atenderLinhas.map((linha) => <Text key={linha} color="cyan" wrap="truncate">  {linha}</Text>)}
          <Text dimColor wrap="truncate">
            {focused.fluxo === "humano-assistido"
              ? "abra esta área no Herdr — copie o que precisar; nada é aberto, executado ou enfileirado aqui"
              : "copie o comando para ver o contexto; nada é executado ou enfileirado aqui — Esc fecha"}
          </Text>
        </Box>
      )}

      {/* Pontos de atenção persistentes: a fila como o store a devolve, com a idade derivada. */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>Pontos de atenção ({view.pendings.length}):</Text>
        {view.pendings.length === 0 && <Text dimColor>nenhum ponto de atenção</Text>}
        {view.pendings.map((pending) => (
          <Box key={pending.id} flexDirection="column">
            <Text wrap="truncate">{" "}{pending.kind} {pending.key} · {pending.what} · {pending.idade}</Text>
            {/* Falha de entrega marca a linha; nunca remove nem esconde o ponto. */}
            {notaDeEntrega(pending) !== undefined && <Text dimColor wrap="truncate">  {notaDeEntrega(pending)}</Text>}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          Concluídos: {footer.jobsDone} · Liberados: {footer.jobsReleased} ·
          {" "}Comandos pendentes: {footer.pendingCommands}
        </Text>
        <Text dimColor>↑/↓ movem o foco · r responde · a aprova resultado · e autoriza retomada · l libera · t atende (comando copiável) · Esc fecha · q / Ctrl+C sai — escritas só na fila de comandos</Text>
      </Box>
    </Box>
  );
}

// The seam msf hands the terminal over to: `msf`'s `tui` injects a fake in tests, the real one
// below renders Ink and owns the terminal until q/Ctrl+C.
export type TuiRunner = (options: TuiOptions) => void;

export const runTui: TuiRunner = (options: TuiOptions): void => {
  const { instance, stateDir, home, tracker, refreshMs, queue } = options;
  render(
    <OperatorScreen
      instance={instance}
      stateDir={stateDir}
      {...(home === undefined ? {} : { home })}
      {...(tracker === undefined ? {} : { tracker })}
      {...(refreshMs === undefined ? {} : { refreshMs })}
      {...(queue === undefined ? {} : { queue })}
    />,
  );
  // Ink owns the terminal from here; the renderer keeps the process alive like any interactive app.
};
