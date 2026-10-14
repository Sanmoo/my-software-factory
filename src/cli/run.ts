import { setTimeout as sleep } from "node:timers/promises";
import { loadConfigFile } from "../config/load.js";
import { Admission, type PollReport } from "../core/admission.js";
import { createMainLog, terminalMode, type MainLog } from "../core/main-log.js";
import { createObserver } from "../core/observability.js";
import { createRedactor } from "../core/redaction.js";
import { messageOf } from "../core/values.js";
import { createFileFailureStore, createFileHistory } from "../state/history.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import type { GitHubBoundary } from "../tracker/github.js";
import { checkInstance } from "./check.js";
import { composeInstance } from "./compose.js";
import { loadLocalSettings } from "./local-settings.js";

// `run`: the instance's coordinator loop. It polls the trackers at the configured
// interval and keeps the jobs the admission dispatches running in the background. The operator
// supervises with logs, reply, resume, release, pause and unpause from other terminals. The
// operator reaches it through `./msf <instância> run [--check] [--once]` (see msf.ts).
//
// check   read-only readiness check (no claim, no write); exits non-zero if anything fails.
// once    one polling cycle, then waits for the dispatched jobs to settle and exits.

export interface RunOptions {
  configPath: string;
  instanceName: string;
  stateDir: string;
  localPath: string;
  // Absolute base directory, only when it is not the default: it is what the printed commands carry.
  home?: string;
  check: boolean;
  once: boolean;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  // Where the lines go, one call per line (stdout) or per message (stderr).
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  // Boundaries are injectable for tests; the defaults are the real ones.
  sandbox?: SandboxBoundary;
  github?: GitHubBoundary;
}

function describe(report: PollReport, log: MainLog): void {
  // Admissions are announced by the observer with their reason; the report does not repeat them.
  for (const c of report.commands) {
    log.note(c.status === "rejected" ? "atenção" : "info", `comando ${c.type}${c.job ? ` ${c.job}` : ""} comando=${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ""}`);
  }
  for (const s of report.skipped) log.note("info", `adiado ${s.key}: ${s.reason}`);
  log.failures(report.errors);
  if (report.paused) log.note("atenção", "instância pausada: nada novo é admitido");
}

const withHuman = (human: { color: boolean } | undefined) => (human === undefined ? {} : { human });

export async function runInstance(options: RunOptions): Promise<number> {
  const loaded = await loadConfigFile(options.configPath);
  if (!loaded.ok) {
    options.stderr(`configuração inválida:\n${loaded.issues.map((i) => `${i.path}: ${i.message}`).join("\n")}`);
    return 1;
  }
  const instance = loaded.config.instances.find((candidate) => candidate.name === options.instanceName);
  if (!instance) {
    options.stderr(`instância '${options.instanceName}' não encontrada; disponíveis: ${loaded.config.instances.map((i) => i.name).join(", ")}`);
    return 2;
  }
  const local = await loadLocalSettings(options.localPath);
  if (typeof local === "string") { options.stderr(local); return 1; }

  const mainLog = createMainLog({
    instance: instance.name,
    write: options.stdout,
    ...withHuman(terminalMode(options.env, options.isTTY)),
  });
  const sandbox = options.sandbox ?? sandcastleBoundary();
  // Events reach the main log as they happen, also from invocations running in the background, and
  // the local history that `logs` reads. The commands it prints are the ones this process runs with.
  const observer = createObserver({
    instance: instance.name,
    mainLog,
    history: createFileHistory(options.stateDir),
    failures: createFileFailureStore(options.stateDir),
    redactor: createRedactor(),
    cli: { instance: instance.name, ...(options.home === undefined ? {} : { home: options.home }) },
  });
  let deps;
  try {
    deps = composeInstance({
      config: loaded.config, instance, local, stateDir: options.stateDir, sandbox, observer, env: options.env,
      ...(options.github === undefined ? {} : { github: options.github }),
    });
  } catch (error) {
    options.stderr(`composição falhou: ${messageOf(error)}`);
    return 1;
  }

  if (options.check) {
    const lines = await checkInstance({ config: loaded.config, instance, local, deps, sandbox, env: options.env });
    for (const line of lines) options.stdout(`${line.ok ? "ok   " : "FALHA"} ${line.what}: ${line.detail}`);
    return lines.every((line) => line.ok) ? 0 : 1;
  }

  const admission = await Admission.open(deps);
  if (admission.unreadable.length > 0) mainLog.note("atenção", `arquivos de trabalho ilegíveis (issues continuam rastreadas): ${admission.unreadable.join(", ")}`);
  // The post-restart reconciliation (ticket #58) comes before the first admissions of either
  // flow: supervised identities are recovered against the real execution in the containers.
  // Failures land in the reconciliation's own report; they never block the loop below.
  const reconciliation = await deps.assist.reconcile();
  for (const r of reconciliation.recovered) mainLog.note("atenção", `atendimento recuperado ${r.key}: ${r.reason}`);
  for (const u of reconciliation.unknown) mainLog.note("atenção", `execução desconhecida ${u.key}: ${u.reason}`);
  for (const p of reconciliation.pending) mainLog.note("atenção", `atendimento pendente pós-reinício ${p.key}: ${p.reason}`);
  for (const e of reconciliation.ended) mainLog.note("info", `atendimento encerrado na indisponibilidade ${e.key}: ${e.reason}`);
  mainLog.failures(reconciliation.errors.map((error) => ({ key: error.key, message: error.message })));
  mainLog.note("info", `instância ${instance.name}: N=${instance.maxConcurrent}, polling ${instance.pollIntervalSeconds}s, estado em ${options.stateDir}`);

  const stop = new AbortController();
  process.on("SIGINT", () => {
    if (stop.signal.aborted) { mainLog.note("atenção", "segundo sinal: saindo; trabalhos ativos ficam interrompidos e retomáveis"); process.exit(130); }
    mainLog.note("info", "parando: sem novos ciclos; aguardando trabalhos ativos (Ctrl-C de novo para sair já)");
    stop.abort();
  });

  while (!stop.signal.aborted) {
    try {
      describe(await admission.poll(), mainLog);
    } catch (error) {
      mainLog.failures([{ key: "ciclo", message: messageOf(error) }], { cycleFailed: true });
    }
    const assistReport = await deps.assist.poll();
    for (const key of assistReport.opened) mainLog.note("atenção", `sessão assistida aberta: ${key}`);
    for (const resumed of assistReport.resumed) mainLog.note("atenção", `retomada autorizada executada ${resumed.key}: ${resumed.reason}`);
    for (const concluded of assistReport.concluded) mainLog.note("info", `atendimento concluído ${concluded.key}: ${concluded.reason}`);
    for (const rejected of assistReport.rejected) mainLog.note("atenção", `aprovação recusada ${rejected.key}: ${rejected.reason}`);
    for (const pending of assistReport.pending) mainLog.note("atenção", `atendimento pendente ${pending.key}: ${pending.reason}`);
    for (const skip of assistReport.skipped) mainLog.note("info", `atendimento adiado ${skip.key}: ${skip.reason}`);
    mainLog.failures(assistReport.errors.map((error) => ({ key: error.key, message: error.message })));
    if (options.once) break;
    await sleep(instance.pollIntervalSeconds * 1000, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  const errors = await admission.settle();
  for (const error of errors) mainLog.note("erro", `de persistência: ${messageOf(error)}`);
  await observer.flush();
  return errors.length === 0 ? 0 : 1;
}
