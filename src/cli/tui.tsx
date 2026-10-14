import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { buildOperatorView, nextStepHint, type HintColor, type OperatorWork, type OperatorView } from "../core/operator-view.js";
import { jobCommands } from "../core/observability.js";
import type { InstanceConfig } from "../config/types.js";

// The operator's read-only TUI (issue #61, spec #60; pontos de atenção + dica de próximo passo
// are #62): one screen, one instance, no writes. It renders the reading model (buildOperatorView)
// and nothing else: fluxo badge + estado vivo always separate from the issue status, the two
// independent capacity meters, the persistent pendings with their derived age, and a keyboard
// focus over the works list whose line shows the next-step hint. The keys are ONLY ↑/↓ (move
// focus) and q / Ctrl+C (quit): nothing executes, writes or copies — a hint may quote a command,
// but it stays text on screen; queueing actions is #63/#64.

export interface TuiOptions {
  instance: InstanceConfig;
  stateDir: string;
  // The base directory used, only when it is not the default — it lands in the paste-ready
  // commands the hints embed (same trick `status` uses, so a printed command is usable as
  // printed).
  home?: string;
  // Test seam: interval between rebuilds in milliseconds (default 5s).
  refreshMs?: number;
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

// The paste-ready forms for one work, built here in the TUI layer with the real CliHints exactly
// like `status` composes them: `jobCommands` over ALL work keys (so a short ref resolves against
// the same space the commands will). No release command is built here: an interruption hint
// names release but deliberately does not offer it ready-to-paste (a paste must not end the
// follow-up by accident); the per-pending action lines are #64's slice.
const hintsFor = (work: OperatorWork, view: OperatorView, cli: { instance: string; home?: string }): HintColor => {
  const commands = jobCommands(cli, work.key, view.works.map((row) => row.key));
  return {
    reply: commands.reply,
    resume: commands.resume,
    approve: `${commands.base} approve ${commands.ref}`,
  };
};

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

// The screen itself, exported for the scenario rounds the acceptance asks for (spec #60:
// "a aceitação é uma rodada de cenários com dados semeados") and for the later tickets that
// grow it. `runTui` is the only place that renders it in production.
export function OperatorScreen({ instance, stateDir, home, refreshMs = 5_000 }: TuiOptions): ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyboard focus over the works list (a position, not an id: a rebuild keeps #61's order and
  // the selection follows positions; the list may also shrink between rebuilds).
  const [focus, setFocus] = useState(0);

  const rebuild = useCallback((): void => {
    buildOperatorView({ stateDir, instance })
      .then((next) => { setView(next); setError(null); })
      .catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : String(caught)); });
  }, [stateDir, instance]);

  useEffect(() => {
    rebuild();
    const timer = setInterval(rebuild, refreshMs);
    return () => { clearInterval(timer); };
  }, [rebuild, refreshMs]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl === true && input === "c")) { exit(); return; }
    // Only ↑/↓ move focus; every other key does nothing (no actions on this screen, still).
    if (key.upArrow === true) setFocus((current) => Math.max(0, current - 1));
    if (key.downArrow === true) setFocus((current) => current + 1);
  });

  if (error !== null) return <Text color="red">leitura falhou: {error}</Text>;
  if (view === null) return <Text>lendo o estado da instância…</Text>;

  const { meters, footer } = view;
  // Focus clamps to the list as rebuilt (a shrinking list keeps the selection on the last row).
  const focusedIndex = Math.min(focus, view.works.length - 1);
  const focused = focusedIndex >= 0 ? view.works[focusedIndex] : undefined;
  // The paste-ready text comes from the real CliHints, exactly like `status` composes it.
  const cli = { instance: instance.name, ...(home === undefined ? {} : { home }) };
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
      {focused && (
        <Box marginTop={0} marginBottom={1}>
          {/* Dica derivada no modelo (estado vivo × fluxo); um comando quotado é só texto na tela. */}
          <Text wrap="truncate">Próximo passo [{focused.issueRef}]: {nextStepHint(focused, hintsFor(focused, view, cli))}</Text>
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
          Concluídos: {footer.jobsDone} · Liberados: {footer.jobsReleased} · Pendências: {footer.pendings} ·
          {" "}Comandos pendentes: {footer.pendingCommands}
        </Text>
        <Text dimColor>↑/↓ movem o foco · q / Ctrl+C sai — leitura apenas; nada é escrito pela TUI</Text>
      </Box>
    </Box>
  );
}

// The seam msf hands the terminal over to: `msf`'s `tui` injects a fake in tests, the real one
// below renders Ink and owns the terminal until q/Ctrl+C.
export type TuiRunner = (options: TuiOptions) => void;

export const runTui: TuiRunner = (options: TuiOptions): void => {
  const { instance, stateDir, home, refreshMs } = options;
  render(
    <OperatorScreen
      instance={instance}
      stateDir={stateDir}
      {...(home === undefined ? {} : { home })}
      {...(refreshMs === undefined ? {} : { refreshMs })}
    />,
  );
  // Ink owns the terminal from here; the renderer keeps the process alive like any interactive app.
};
