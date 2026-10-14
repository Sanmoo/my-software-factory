import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { buildOperatorView, type OperatorView } from "../core/operator-view.js";
import type { InstanceConfig } from "../config/types.js";

// The operator's read-only TUI (issue #61, spec #60): one screen, one instance, no writes.
// It renders the reading model (buildOperatorView) and nothing else: fluxo badge + estado vivo
// always separate from the issue status, the two independent capacity meters and the footer
// counts. The only interactions are q and Ctrl+C to quit; a timer rebuilds the view on an
// interval and is cleared on unmount. Pendings and actions come in later tickets (#62/#63).

export interface TuiOptions {
  instance: InstanceConfig;
  stateDir: string;
  // The base directory used, only when it is not the default (kept for the later tickets that
  // print paste-ready commands; this slice prints no commands).
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

// The screen itself, exported for the scenario rounds the acceptance asks for (spec #60:
// "a aceitação é uma rodada de cenários com dados semeados") and for the later tickets that
// grow it. `runTui` is the only place that renders it in production.
export function OperatorScreen({ instance, stateDir, refreshMs = 5_000 }: Omit<TuiOptions, "home">): ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (input === "q" || (key.ctrl === true && input === "c")) exit();
  });

  if (error !== null) return <Text color="red">leitura falhou: {error}</Text>;
  if (view === null) return <Text>lendo o estado da instância…</Text>;

  const { meters, footer } = view;
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
      {view.works.map((work) => (
        <Text key={`${work.fluxo}:${work.key}`} wrap="truncate">
          {" "}
          [{FLUXO_LABELS[work.fluxo]}] {work.issueRef} — {ESTADO_LABELS[work.estadoVivo]} · issue: {work.issue.status}
        </Text>
      ))}

      <Box flexDirection="column" marginTop={1}>
        <Text>
          Concluídos: {footer.jobsDone} · Liberados: {footer.jobsReleased} · Pendências: {footer.pendings} ·
          {" "}Comandos pendentes: {footer.pendingCommands}
        </Text>
        <Text dimColor>q / Ctrl+C sai — leitura apenas; nada é escrito pela TUI</Text>
      </Box>
    </Box>
  );
}

// `home` is accepted this slice (the resolution wiring of msf passes it) but unused until #64
// prints paste-ready commands.

// The seam msf hands the terminal over to: `msf`'s `tui` injects a fake in tests, the real one
// below renders Ink and owns the terminal until q/Ctrl+C.
export type TuiRunner = (options: TuiOptions) => void;

export const runTui: TuiRunner = (options: TuiOptions): void => {
  const { instance, stateDir, home: _home, refreshMs } = options;
  void _home;
  render(
    <OperatorScreen
      instance={instance}
      stateDir={stateDir}
      {...(refreshMs === undefined ? {} : { refreshMs })}
    />,
  );
  // Ink owns the terminal from here; the renderer keeps the process alive like any interactive app.
};
