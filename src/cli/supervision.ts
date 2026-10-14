import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandBody } from "../core/commands.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { createFileHistory } from "../state/history.js";
import { messageOf } from "../core/values.js";
import { loadInstance, type CliRun } from "./instance.js";

// Operator commands of one instance: reply, resume, release, pause and unpause. The
// CLI validates the request and writes it to the instance's local command queue; it never
// changes job state itself. The instance applies the queue on its next poll, in order.

export const COMMANDS = ["reply", "resume", "release", "approve", "pause", "unpause"] as const;
export type Command = (typeof COMMANDS)[number];
// `approve` targets a human-assisted attendance key, not an implementation job; the flow
// validates it against the assist session store (ticket #55).
const NEEDS_JOB: readonly Command[] = ["reply", "resume", "release", "approve"];
const FLAGS = ["--config", "--instance", "--state-dir", "--message"];
const USAGE = [
  "uso: npm run <reply|resume|release> -- --config FILE --instance NAME --state-dir DIR TRABALHO [--message TEXTO]",
  "     npm run <pause|unpause> -- --config FILE --instance NAME --state-dir DIR",
].join("\n");

export interface SupervisionOptions {
  command: Command;
  configPath: string;
  instanceName: string;
  stateDir: string;
  message?: string;
  job?: string;
}

const usageError = (message: string): CliRun => ({ exitCode: 2, stdout: "", stderr: `${message}\n${USAGE}\n` });

function parseArgs(argv: readonly string[]): SupervisionOptions | CliRun {
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
  approve: "aprovação registrada",
  pause: "pausa registrada",
  unpause: "despausa registrada",
};

export async function runSupervision(argv: readonly string[]): Promise<CliRun> {
  const options = parseArgs(argv);
  if ("exitCode" in options) return options;
  return applySupervision(options);
}

// The request, already validated: the job (when the command takes one) is a full key.
export async function applySupervision(options: SupervisionOptions): Promise<CliRun> {
  const loaded = await loadInstance(options.configPath, options.instanceName);
  if (!loaded.ok) return loaded.run;

  let body: CommandBody;
  if (options.command === "approve") {
    // The approval is of one assisted attendance, never of an implementation job: the key must
    // be a session the assist flow records (ticket #55). Queuing is not applying: the flow
    // applies it on the next poll, where the proposal must exist.
    const { sessions } = await createFileAssistSessionStore(join(options.stateDir, "assist-sessions")).load();
    if (!sessions.some((candidate) => candidate.key === options.job)) {
      return { exitCode: 1, stdout: "", stderr: `atendimento assistido ${options.job} não encontrado\n` };
    }
    body = { type: "approve", job: options.job! };
  } else if (options.job !== undefined) {
    const { jobs } = await createFileJobStore(options.stateDir).load();
    if (!jobs.some((candidate) => candidate.key === options.job)) {
      // A command may also name an assisted session (ticket #56): its registry decides, and the
      // state guards live in the flow that applies the command at the next poll.
      const assist = await createFileAssistSessionStore(join(options.stateDir, "assist-sessions")).load();
      if (!assist.sessions.some((candidate) => candidate.key === options.job)) {
        return { exitCode: 1, stdout: "", stderr: `trabalho ${options.job} não encontrado (nem como atendimento assistido)\n` };
      }
    }
    body = options.command === "reply"
      ? { type: "reply", job: options.job, message: options.message ?? "" }
      : { type: options.command as "resume" | "release", job: options.job };
  } else {
    body = { type: options.command as "pause" | "unpause" };
  }

  const id = await createFileCommandQueue(options.stateDir).enqueue(body);
  const target = options.job !== undefined ? ` (${options.job})` : "";
  // Queued is not applied and not delivered: the instance applies the queue on its next poll and
  // the runner only later shows whether the agent received it (issue #15, decision 4).
  const lines = [
    `${CONFIRMATION[options.command]}${target} na fila da instância ${options.instanceName}; comando=${id}; `
      + "enfileirado, ainda não aplicado nem entregue ao agente; será aplicado no próximo ciclo",
  ];
  try {
    await createFileHistory(options.stateDir).append({
      at: new Date().toISOString(), instance: options.instanceName, kind: "comando-enfileirado",
      text: `${options.command} enfileirado`, level: "info", ...(options.job === undefined ? {} : { job: options.job }),
      fields: { comando: id }, lines: [],
    });
  } catch (error) {
    // The command is queued whatever happens to the history: the loss is said, not hidden.
    lines.push(`aviso: o histórico local não pôde ser gravado (${messageOf(error)}); o comando continua na fila`);
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runSupervision(process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}
