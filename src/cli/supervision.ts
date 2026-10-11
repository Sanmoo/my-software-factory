import { pathToFileURL } from "node:url";
import type { CommandBody } from "../core/commands.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { loadInstance, type CliRun } from "./instance.js";

// Operator commands of one instance (R09): reply, resume, release, pause and unpause. The
// CLI validates the request and writes it to the instance's local command queue; it never
// changes job state itself. The instance applies the queue on its next poll, in order.

const COMMANDS = ["reply", "resume", "release", "pause", "unpause"] as const;
type Command = (typeof COMMANDS)[number];
const NEEDS_JOB: readonly Command[] = ["reply", "resume", "release"];
const FLAGS = ["--config", "--instance", "--state-dir", "--message"];
const USAGE = [
  "uso: npm run <reply|resume|release> -- --config FILE --instance NAME --state-dir DIR TRABALHO [--message TEXTO]",
  "     npm run <pause|unpause> -- --config FILE --instance NAME --state-dir DIR",
].join("\n");

interface Options {
  command: Command;
  configPath: string;
  instanceName: string;
  stateDir: string;
  message?: string;
  job?: string;
}

const usageError = (message: string): CliRun => ({ exitCode: 2, stdout: "", stderr: `${message}\n${USAGE}\n` });

function parseArgs(argv: readonly string[]): Options | CliRun {
  const [command, ...rest] = argv;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    return usageError(`comando desconhecido: ${command ?? ""}`.trim());
  }
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (!FLAGS.includes(token)) return usageError(`argumento desconhecido: ${token}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) return usageError(`${token} exige um valor`);
    values.set(token, value);
    index += 1;
  }
  const configPath = values.get("--config");
  const instanceName = values.get("--instance");
  const stateDir = values.get("--state-dir");
  if (configPath === undefined || instanceName === undefined || stateDir === undefined) {
    return usageError("--config, --instance e --state-dir são obrigatórios");
  }
  const needsJob = (NEEDS_JOB as readonly string[]).includes(command);
  if (needsJob !== (positional.length === 1)) {
    return usageError(needsJob ? "informe um trabalho" : "pause e unpause não recebem trabalho");
  }
  const message = values.get("--message");
  if (command === "reply") {
    if (message === undefined) return usageError("reply exige --message");
    if (message.trim() === "") return usageError("resposta vazia");
  } else if (message !== undefined) {
    return usageError(`${command} não recebe --message`);
  }
  return {
    command: command as Command,
    configPath,
    instanceName,
    stateDir,
    message,
    job: needsJob ? positional[0] : undefined,
  };
}

const CONFIRMATION: Record<Command, string> = {
  reply: "resposta registrada",
  resume: "resume registrado",
  release: "liberação registrada",
  pause: "pausa registrada",
  unpause: "despausa registrada",
};

export async function runSupervision(argv: readonly string[]): Promise<CliRun> {
  const options = parseArgs(argv);
  if ("exitCode" in options) return options;

  const loaded = await loadInstance(options.configPath, options.instanceName);
  if (!loaded.ok) return loaded.run;

  let body: CommandBody;
  if (options.job !== undefined) {
    const { jobs } = await createFileJobStore(options.stateDir).load();
    if (!jobs.some((candidate) => candidate.key === options.job)) {
      return { exitCode: 1, stdout: "", stderr: `trabalho ${options.job} não encontrado\n` };
    }
    body = options.command === "reply"
      ? { type: "reply", job: options.job, message: options.message ?? "" }
      : { type: options.command as "resume" | "release", job: options.job };
  } else {
    body = { type: options.command as "pause" | "unpause" };
  }

  await createFileCommandQueue(options.stateDir).enqueue(body);
  const target = options.job !== undefined ? ` (${options.job})` : "";
  return {
    exitCode: 0,
    stdout: `${CONFIRMATION[options.command]}${target} na fila da instância ${options.instanceName}; será aplicada no próximo ciclo\n`,
    stderr: "",
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runSupervision(process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}
