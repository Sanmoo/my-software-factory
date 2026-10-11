import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfigFile } from "../config/load.js";
import { Admission, type PollReport } from "../core/admission.js";
import { createObserver } from "../core/observability.js";
import { createRedactor } from "../core/redaction.js";
import { messageOf } from "../core/values.js";
import { createFileFailureStore, createFileHistory } from "../state/history.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import { checkInstance } from "./check.js";
import { composeInstance } from "./compose.js";
import { loadLocalSettings } from "./local-settings.js";

// `run`: the instance's coordinator loop (R04, R05). It polls the trackers at the configured
// interval and keeps the jobs the admission dispatches running in the background. The operator
// supervises with status, logs, reply, resume, release and pause (R09) from other terminals.
//
//   npm run run -- --config FILE --instance NAME --state-dir DIR --local FILE [--check] [--once]
//
// --check   read-only readiness check (no claim, no write); exits non-zero if anything fails.
// --once    one polling cycle, then waits for the dispatched jobs to settle and exits.

const USAGE = "uso: npm run run -- --config FILE --instance NAME --state-dir DIR --local FILE [--check] [--once]";
const VALUE_FLAGS = ["--config", "--instance", "--state-dir", "--local"];
const SWITCHES = ["--check", "--once"];

interface Options {
  configPath: string;
  instanceName: string;
  stateDir: string;
  localPath: string;
  check: boolean;
  once: boolean;
}

function parseArgs(argv: readonly string[]): Options | string {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (SWITCHES.includes(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS.includes(flag)) return `argumento desconhecido: ${flag}\n${USAGE}`;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return `${flag} exige um valor\n${USAGE}`;
    values.set(flag, value);
    index += 1;
  }
  const missing = VALUE_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) return `faltam: ${missing.join(", ")}\n${USAGE}`;
  return {
    configPath: values.get("--config")!, instanceName: values.get("--instance")!,
    stateDir: values.get("--state-dir")!, localPath: values.get("--local")!,
    check: switches.has("--check"), once: switches.has("--once"),
  };
}

const stamp = (): string => new Date().toISOString();
const log = (line: string): void => { process.stdout.write(`${stamp()} ${line}\n`); };

function describe(report: PollReport): string[] {
  return [
    // Admissions are announced by the observer with their reason; the report does not repeat them.
    ...report.commands.map((c) => `comando ${c.type}${c.job ? ` ${c.job}` : ""} comando=${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ""}`),
    ...report.skipped.map((s) => `adiado ${s.key}: ${s.reason}`),
    ...report.errors.map((e) => `ERRO ${e.key}: ${e.message}`),
    ...(report.paused ? ["instância pausada: nada novo é admitido"] : []),
  ];
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") { process.stderr.write(`${options}\n`); return 2; }

  const loaded = await loadConfigFile(options.configPath);
  if (!loaded.ok) {
    process.stderr.write(`configuração inválida:\n${loaded.issues.map((i) => `${i.path}: ${i.message}`).join("\n")}\n`);
    return 1;
  }
  const instance = loaded.config.instances.find((candidate) => candidate.name === options.instanceName);
  if (!instance) {
    process.stderr.write(`instância '${options.instanceName}' não encontrada; disponíveis: ${loaded.config.instances.map((i) => i.name).join(", ")}\n`);
    return 2;
  }
  const local = await loadLocalSettings(options.localPath);
  if (typeof local === "string") { process.stderr.write(`${local}\n`); return 1; }

  const sandbox = sandcastleBoundary();
  // Events reach the main log as they happen, also from invocations running in the background, and
  // the local history that `logs` reads. The commands it prints are the ones this process runs with.
  const observer = createObserver({
    instance: instance.name,
    console: (line) => { process.stdout.write(`${line}\n`); },
    history: createFileHistory(options.stateDir),
    failures: createFileFailureStore(options.stateDir),
    redactor: createRedactor(),
    cli: { config: resolve(options.configPath), instance: instance.name, stateDir: resolve(options.stateDir) },
  });
  let deps;
  try {
    deps = composeInstance({ config: loaded.config, instance, local, stateDir: options.stateDir, sandbox, observer });
  } catch (error) {
    process.stderr.write(`composição falhou: ${messageOf(error)}\n`);
    return 1;
  }

  if (options.check) {
    const lines = await checkInstance({ config: loaded.config, instance, local, deps, sandbox });
    for (const line of lines) process.stdout.write(`${line.ok ? "ok   " : "FALHA"} ${line.what}: ${line.detail}\n`);
    return lines.every((line) => line.ok) ? 0 : 1;
  }

  const admission = await Admission.open(deps);
  if (admission.unreadable.length > 0) log(`ATENÇÃO: arquivos de trabalho ilegíveis (issues continuam rastreadas): ${admission.unreadable.join(", ")}`);
  log(`instância ${instance.name}: N=${instance.maxConcurrent}, polling ${instance.pollIntervalSeconds}s, estado em ${options.stateDir}`);

  const stop = new AbortController();
  process.on("SIGINT", () => {
    if (stop.signal.aborted) { log("segundo sinal: saindo; trabalhos ativos ficam interrompidos e retomáveis"); process.exit(130); }
    log("parando: sem novos ciclos; aguardando trabalhos ativos (Ctrl-C de novo para sair já)");
    stop.abort();
  });

  while (!stop.signal.aborted) {
    try {
      for (const line of describe(await admission.poll())) log(line);
    } catch (error) {
      log(`ERRO no ciclo: ${messageOf(error)}`);
    }
    if (options.once) break;
    await sleep(instance.pollIntervalSeconds * 1000, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  const errors = await admission.settle();
  for (const error of errors) log(`ERRO de persistência: ${messageOf(error)}`);
  await observer.flush();
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
