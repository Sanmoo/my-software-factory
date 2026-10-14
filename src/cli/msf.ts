import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveJobRef } from "../core/job-ref.js";
import { buildOperatorView, type OperatorView } from "../core/operator-view.js";
import type { SandboxBoundary } from "../runtime/docker-runner.js";
import { sandcastleBoundary } from "../runtime/docker-sandcastle.js";
import type { GitHubBoundary } from "../tracker/github.js";
import type { TrackerPort } from "../tracker/port.js";
import { runAssist, type AssistEnvironmentPort } from "./assist.js";
import { loadInstance, type CliRun } from "./instance.js";
import { loadLocalSettings } from "./local-settings.js";
import { showLogs } from "./logs.js";
import { runInstance } from "./run.js";
import { runStatus } from "./status.js";
import { applySupervision } from "./supervision.js";
import { runTui, type TuiRunner } from "./tui.js";

// The operator's single entry point (issue #22):
//
//   ./msf [--home DIR] <instância> <comando> [trabalho] [opções]
//
// It resolves the base directory (config.json, local.json and state/<instância>/), the job
// reference and the help, and hands over to the commands that already exist. The main log prints
// exactly this form, so what the operator copies from it works as printed.

export const COMMANDS = ["run", "status", "assist", "logs", "reply", "resume", "release", "approve", "pause", "unpause", "tui"] as const;
type Command = (typeof COMMANDS)[number];

// The default base directory, relative to the repository root.
export const DEFAULT_HOME = ".msf";

interface CommandSpec {
  usage: string;
  summary: string;
  needsJob: boolean;
  switches?: readonly string[];
  message?: boolean;
  notes?: readonly string[];
}

const SPECS: Record<Command, CommandSpec> = {
  run: {
    usage: "./msf [--home DIR] <instância> run [--check] [--once]",
    summary: "inicia e supervisiona a instância (polling, admissão, runner, PR, feedback)",
    needsJob: false,
    switches: ["--check", "--once"],
    notes: [
      "--check  confere a prontidão sem escrever nada (nenhum claim, comentário ou outra escrita); sai com erro se algo falhar",
      "--once   um único ciclo de polling; espera os trabalhos despachados terminarem e sai",
      "Instâncias com projeto Jira exigem JIRA_URL, JIRA_USERNAME e JIRA_API_TOKEN no ambiente.",
    ],
  },
  status: {
    usage: "./msf [--home DIR] <instância> status",
    summary: "mostra o estado gravado da instância (vagas, pedidos de ajuda, trabalhos) e as issues elegíveis e rejeitadas de cada projeto, lidas dos trackers; não escreve nada",
    needsJob: false,
    notes: [
      "O estado local aparece sempre; um projeto cujo tracker não respondeu mostra `tracker indisponível` e a saída é 1.",
      "O detalhe de um trabalho está em `./msf <instância> logs <trabalho>`.",
      "Instâncias com projeto Jira exigem JIRA_URL, JIRA_USERNAME e JIRA_API_TOKEN no ambiente.",
    ],
  },
  assist: {
    usage: "./msf [--home DIR] <instância> assist",
    summary: "diagnóstico local do atendimento assistido: issues autorizadas, impedimentos, capacidade e ambiente; não escreve nada e não abre sessão",
    needsJob: false,
    notes: [
      "Descobre candidatos por human-assisted + exatamente um estado humano (needs-triage, needs-info, ready-for-human); estados contraditórios ficam visíveis e não autorizam.",
      "Verifica Herdr, Docker, clone assistido, provider/modelo e o perfil de runtime sem iniciar execução; o que não se puder comprovar aparece como desconhecido, nunca como ok (prova técnica na issue #52).",
      "O clone assistido é gerenciado pelo operador: a factory não cria worktree nem impõe proibição de escrita como condição de elegibilidade.",
    ],
  },
  logs: {
    usage: "./msf [--home DIR] <instância> logs <trabalho>",
    summary: "mostra o estado, o log e o histórico de um trabalho",
    needsJob: true,
  },
  reply: {
    usage: "./msf [--home DIR] <instância> reply <trabalho> --message TEXTO",
    summary: "responde a um pedido de ajuda; entra na fila e é aplicado no próximo ciclo da instância",
    needsJob: true,
    message: true,
  },
  resume: {
    usage: "./msf [--home DIR] <instância> resume <trabalho>",
    summary: "retoma um trabalho interrompido (mesma sessão e mesma área); entra na fila da instância",
    needsJob: true,
  },
  release: {
    usage: "./msf [--home DIR] <instância> release <trabalho>",
    summary: "libera o trabalho: remove o claim sem concluir e encerra o acompanhamento; entra na fila da instância",
    needsJob: true,
  },
  approve: {
    usage: "./msf [--home DIR] <instância> approve <atendimento assistido>",
    summary: "aprova o resultado proposto de um atendimento assistido (a chave da lista de `logs` ou `assist`); o atendimento conclui no ciclo seguinte, sem fechar a issue",
    needsJob: true,
    notes: [
      "A aprovação é explícita do operador: aprovar antes de um resultado reconhecido não registra nada.",
      "O encerramento do pi, a saída zero ou uma declaração do agente nunca valem como aprovação.",
    ],
  },
  pause: {
    usage: "./msf [--home DIR] <instância> pause",
    summary: "pausa a admissão de novos trabalhos da instância",
    needsJob: false,
  },
  tui: {
    usage: "./msf [--home DIR] <instância> tui",
    summary: "abre a TUI de leitura da instância numa tela única (fluxo, estado vivo, medidores); não escreve nada",
    needsJob: false,
    notes: [
      "Leitora do estado gravado: as ações do operador continuam nos comandos existentes da CLI.",
      "Exige um terminal interativo (TTY).",
    ],
  },
  unpause: {
    usage: "./msf [--home DIR] <instância> unpause",
    summary: "retoma a admissão de novos trabalhos da instância",
    needsJob: false,
  },
};

const JOB_NOTE = "trabalho: a referência curta do log (#13, PAY-7) ou a chave completa (github:dono/repo#13); com `#`, use aspas.";
const HOME_NOTE = `--home DIR: diretório base com config.json, local.json e state/<instância>/ (padrão: ${DEFAULT_HOME}/ na raiz do repositório; um caminho relativo parte da raiz).`;

const GLOBAL_USAGE = [
  "uso: ./msf [--home DIR] <instância> <comando> [trabalho] [opções]",
  "",
  "comandos:",
  ...COMMANDS.map((command) => `  ${command.padEnd(8)} ${SPECS[command].summary}`),
  "",
  HOME_NOTE,
  JOB_NOTE,
  "./msf <instância> <comando> --help mostra o uso de um comando.",
].join("\n");

function commandUsage(command: Command): string {
  const spec = SPECS[command];
  return [
    `uso: ${spec.usage}`,
    spec.summary,
    ...(spec.needsJob ? [JOB_NOTE] : []),
    ...(spec.notes ?? []),
    HOME_NOTE,
  ].join("\n");
}

// Sentinel for the TUI handover: the terminal is Ink's from `runTui` on, so the CLI must never
// write to stdout/stderr again. The process entry writes only the empty strings of this run and
// the exit code stays 0 while Ink keeps the terminal alive until the operator quits.
const PENDING_TUI: CliRun = { exitCode: 0, stdout: "", stderr: "" };

const isCommand = (word: string | undefined): word is Command => word !== undefined && (COMMANDS as readonly string[]).includes(word);

const ok = (text: string): CliRun => ({ exitCode: 0, stdout: `${text}\n`, stderr: "" });
const failure = (exitCode: number, message: string): CliRun => ({ exitCode, stdout: "", stderr: `${message}\n` });
const usageError = (message: string, command?: Command): CliRun =>
  failure(2, `${message}\n${command === undefined ? GLOBAL_USAGE : commandUsage(command)}`);

interface Request {
  home: string | undefined;
  instance: string;
  command: Command;
  job: string | undefined;
  message: string | undefined;
  check: boolean;
  once: boolean;
}

function parse(argv: readonly string[]): Request | CliRun {
  let home: string | undefined;
  let message: string | undefined;
  let help = false;
  const switches = new Set<string>();
  const positional: string[] = [];
  const known = new Set(["--home", "--message", "--help", "-h", "--check", "--once"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") && token !== "-h") { positional.push(token); continue; }
    if (!known.has(token)) return usageError(`argumento desconhecido: ${token}`, isCommand(positional[1]) ? positional[1] : undefined);
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (token === "--check" || token === "--once") { switches.add(token); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return usageError(`${token} exige um valor`, isCommand(positional[1]) ? positional[1] : undefined);
    if (token === "--home") home = value; else message = value;
    index += 1;
  }

  const [first, second, job, ...extra] = positional;
  if (help) {
    // `./msf <comando> --help` and `./msf <instância> <comando> --help`.
    const command = isCommand(first) ? first : isCommand(second) ? second : undefined;
    return ok(command === undefined ? GLOBAL_USAGE : commandUsage(command));
  }
  if (first === undefined) return usageError("informe a instância e o comando");
  if (second === undefined) {
    return usageError(isCommand(first) ? `informe a instância antes do comando: ./msf <instância> ${first}` : `informe o comando para a instância ${first}`);
  }
  if (!isCommand(second)) {
    return usageError(isCommand(first) ? `informe a instância antes do comando: ./msf <instância> ${first}` : `comando desconhecido: ${second}`);
  }
  const spec = SPECS[second];
  if (extra.length > 0 || (!spec.needsJob && job !== undefined)) {
    return usageError(spec.needsJob ? `argumento a mais: ${extra[0]}` : `${second} não recebe trabalho (recebeu ${job})`, second);
  }
  if (spec.needsJob && job === undefined) return usageError("informe um trabalho", second);
  for (const flag of switches) {
    if (!spec.switches?.includes(flag)) return usageError(`${second} não recebe ${flag}`, second);
  }
  if (spec.message === true) {
    if (message === undefined) return usageError("reply exige --message", second);
    if (message.trim() === "") return usageError("resposta vazia", second);
  } else if (message !== undefined) {
    return usageError(`${second} não recebe --message`, second);
  }
  return { home, instance: first, command: second, job, message, check: switches.has("--check"), once: switches.has("--once") };
}

export interface MsfDeps {
  // The repository root: where the default base directory lives and what a relative --home is relative to.
  root: string;
  env: NodeJS.ProcessEnv;
  isTTY?: boolean;
  // Where a long-running `run` writes its lines as they happen. Default: the process streams.
  live?: { stdout: (line: string) => void; stderr: (line: string) => void };
  // Boundaries are injectable for tests; the defaults are the real ones.
  sandbox?: SandboxBoundary;
  github?: GitHubBoundary;
  // Replaces the trackers `status` and `assist` read (tests inject one).
  tracker?: TrackerPort;
  // Replaces the Herdr check `assist` runs (tests inject one);
  // the default reports the integration as unknown (prova técnica na issue #52).
  herdr?: AssistEnvironmentPort["herdr"];
  // Replaces the TUI renderer `tui` opens (tests inject one; the real one requires a TTY).
  tui?: TuiRunner;
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

export async function runMsf(argv: readonly string[], deps: MsfDeps): Promise<CliRun> {
  const request = parse(argv);
  if ("exitCode" in request) return request;

  const defaultHome = resolve(deps.root, DEFAULT_HOME);
  const homeDir = request.home === undefined ? defaultHome : resolve(deps.root, request.home);
  const configPath = join(homeDir, "config.json");
  const stateDir = join(homeDir, "state", request.instance);

  if (!(await exists(configPath))) {
    return failure(1, `config.json não encontrado em ${configPath} (diretório base: ${homeDir}; use --home para indicar outro)`);
  }
  const loaded = await loadInstance(configPath, request.instance);
  if (!loaded.ok) return loaded.run;

  if (request.command === "run") return runCommand(request, { deps, homeDir, defaultHome, configPath, stateDir });

  if (request.command === "assist") {
    const localPath = join(homeDir, "local.json");
    if (!(await exists(localPath))) {
      return failure(1, `local.json não encontrado em ${localPath} (diretório base: ${homeDir}; use --home para indicar outro)`);
    }
    const local = await loadLocalSettings(localPath);
    if (typeof local === "string") return failure(1, local);
    return runAssist({
      config: loaded.config,
      instance: loaded.instance,
      local,
      stateDir,
      env: deps.env,
      sandbox: deps.sandbox ?? sandcastleBoundary(),
      ...(deps.tracker === undefined ? {} : { tracker: deps.tracker }),
      ...(deps.herdr === undefined ? {} : { herdr: deps.herdr }),
    });
  }

  if (request.command === "status") {
    return runStatus({
      instance: loaded.instance,
      stateDir,
      ...(homeDir === defaultHome ? {} : { home: homeDir }),
      env: deps.env,
      ...(deps.github === undefined ? {} : { github: deps.github }),
      ...(deps.tracker === undefined ? {} : { tracker: deps.tracker }),
    });
  }

  // The TUI is a pure reading view of this one instance: same resolution as `status`, no
  // local.json requirement. Without a TTY there is nothing to render; it refuses before
  // touching any state (spec #60: one TUI per instance, reading first).
  if (request.command === "tui") {
    if (deps.isTTY === false) {
      return usageError("a TUI requer um terminal interativo", "tui");
    }
    (deps.tui ?? runTui)({
      instance: loaded.instance,
      stateDir,
      ...(homeDir === defaultHome ? {} : { home: homeDir }),
    });
    // The terminal is Ink's from here on; the CLI hands it over and writes nothing more.
    return PENDING_TUI;
  }

  // The approval targets an assisted attendance key, never an implementation job: it goes
  // through raw and the supervision validates it against the assist session store.
  if (request.command === "approve" && request.job !== undefined) {
    return applySupervision({
      command: "approve", configPath, instanceName: request.instance, stateDir, job: request.job,
    });
  }

  // The operator's reading model is the CLI's single local read (issue #65): the keys that
  // short references resolve against and the job that `logs` shows come from ONE
  // buildOperatorView load, the same reading the TUI consumes. Supervision keeps its own
  // validation reads (they end in writes and re-reads; that is not this reading).
  let job: string | undefined;
  let view: OperatorView | undefined;
  if (request.job !== undefined) {
    view = await buildOperatorView({ stateDir, instance: loaded.instance });
    const resolved = resolveJobRef(request.job, view.jobs.map((candidate) => candidate.key));
    if (resolved.status === "none") return failure(1, `trabalho ${request.job} não encontrado na instância ${request.instance}`);
    if (resolved.status === "ambiguous") {
      return failure(1, [
        `a referência ${request.job} corresponde a mais de um trabalho da instância ${request.instance}; nada foi feito. Use a chave completa:`,
        ...resolved.keys.map((key) => `  ${key}`),
      ].join("\n"));
    }
    job = resolved.key;
  }

  if (request.command === "logs") {
    return showLogs({ configPath, instanceName: request.instance, stateDir, job: job!, view });
  }
  return applySupervision({
    command: request.command,
    configPath,
    instanceName: request.instance,
    stateDir,
    ...(job === undefined ? {} : { job }),
    ...(request.message === undefined ? {} : { message: request.message }),
  });
}

async function runCommand(
  request: Request,
  where: { deps: MsfDeps; homeDir: string; defaultHome: string; configPath: string; stateDir: string },
): Promise<CliRun> {
  const { deps, homeDir } = where;
  const localPath = join(homeDir, "local.json");
  if (!(await exists(localPath))) {
    return failure(1, `local.json não encontrado em ${localPath} (diretório base: ${homeDir}; use --home para indicar outro)`);
  }
  // A check is a report: it is returned. The loop is a stream: it goes out as it happens.
  const buffered = { stdout: [] as string[], stderr: [] as string[] };
  const live = deps.live ?? {
    stdout: (line: string) => { process.stdout.write(`${line}\n`); },
    stderr: (line: string) => { process.stderr.write(`${line}\n`); },
  };
  const sinks = request.check
    ? { stdout: (line: string) => { buffered.stdout.push(line); }, stderr: (line: string) => { buffered.stderr.push(line); } }
    : live;
  const exitCode = await runInstance({
    configPath: where.configPath,
    instanceName: request.instance,
    stateDir: where.stateDir,
    localPath,
    ...(homeDir === where.defaultHome ? {} : { home: homeDir }),
    check: request.check,
    once: request.once,
    env: deps.env,
    isTTY: deps.isTTY === true,
    ...sinks,
    ...(deps.sandbox === undefined ? {} : { sandbox: deps.sandbox }),
    ...(deps.github === undefined ? {} : { github: deps.github }),
  });
  const text = (lines: string[]): string => lines.map((line) => `${line}\n`).join("");
  return { exitCode, stdout: text(buffered.stdout), stderr: text(buffered.stderr) };
}

// The repository root is where this file lives (src/cli): the launcher is versioned there.
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runMsf(process.argv.slice(2), { root: REPOSITORY_ROOT, env: process.env, isTTY: process.stdout.isTTY === true });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}
