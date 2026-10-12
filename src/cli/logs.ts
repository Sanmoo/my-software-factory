import { pathToFileURL } from "node:url";
import { renderFields } from "../core/observability.js";
import { messageOf } from "../core/values.js";
import { createFileJobStore } from "../state/file-job-store.js";
import { createFileHistory } from "../state/history.js";
import { loadInstance, type CliRun } from "./instance.js";
import { stateLabel, summaryOf } from "./jobs-view.js";

// `logs <trabalho>`: the state and log lines of one job of an instance (R09). The job is
// identified by its key (tracker:project#id), as shown by `status`.

const USAGE = "uso: npm run logs -- --config FILE --instance NAME --state-dir DIR TRABALHO";
const FLAGS = ["--config", "--instance", "--state-dir"];

export interface LogsOptions {
  configPath: string;
  instanceName: string;
  stateDir: string;
  job: string;
}

function parseArgs(argv: readonly string[]): LogsOptions | string {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const value = argv[index + 1];
    if (!FLAGS.includes(token)) return `argumento desconhecido: ${token}\n${USAGE}`;
    if (value === undefined || value.startsWith("--")) return `${token} exige um valor\n${USAGE}`;
    values.set(token, value);
    index += 1;
  }
  const configPath = values.get("--config");
  const instanceName = values.get("--instance");
  const stateDir = values.get("--state-dir");
  if (configPath === undefined || instanceName === undefined || stateDir === undefined || positional.length !== 1) {
    return USAGE;
  }
  return { configPath, instanceName, stateDir, job: positional[0] };
}

// The timestamped history of the job: help, replies, waits, resumes and outcomes, with the whole
// question and context kept as they were asked (issue #15). It does not depend on the snapshot.
async function timeline(stateDir: string, job: string): Promise<string[]> {
  let history;
  try {
    history = await createFileHistory(stateDir).read(job);
  } catch (error) {
    return ["linha do tempo: indisponível", `  o histórico local não pôde ser lido: ${messageOf(error)}`];
  }
  if (history.records.length === 0 && history.unreadable === 0) return ["linha do tempo: (nenhum evento registrado)"];
  const lines = ["linha do tempo:"];
  for (const record of history.records) {
    const head = [record.at, record.text, renderFields({ ...(record.invocation === undefined ? {} : { invocação: record.invocation }), ...record.fields })]
      .filter((part) => part !== "").join(" ");
    lines.push(`  ${head}`, ...record.lines.map((line) => `      ${line}`));
  }
  if (history.unreadable > 0) lines.push(`  (${history.unreadable} linha(s) ilegível(is) no histórico)`);
  return lines;
}

export async function runLogs(argv: readonly string[]): Promise<CliRun> {
  const options = parseArgs(argv);
  if (typeof options === "string") return { exitCode: 2, stdout: "", stderr: `${options}\n` };
  return showLogs(options);
}

// The job is a full key.
export async function showLogs(options: LogsOptions): Promise<CliRun> {
  const loaded = await loadInstance(options.configPath, options.instanceName);
  if (!loaded.ok) return loaded.run;

  const { jobs } = await createFileJobStore(options.stateDir).load();
  const job = jobs.find((candidate) => candidate.key === options.job);
  if (!job) return { exitCode: 1, stdout: "", stderr: `trabalho ${options.job} não encontrado\n` };

  const lines = [`trabalho ${job.key}`, `estado: ${stateLabel(job.state)}`];
  if (job.state === "waiting-for-help") {
    lines.push(`pergunta: ${job.question ?? ""}`);
    if (job.context) lines.push(`contexto: ${job.context}`);
  } else if (job.state === "waiting-for-pr" && job.pr) {
    lines.push(`PR: ${job.pr.repository}#${job.pr.number}`);
  } else if (summaryOf(job)) {
    lines.push(`motivo: ${summaryOf(job)}`);
  }
  lines.push("log:", ...job.log.map((entry) => `  ${entry}`));
  lines.push(...(await timeline(options.stateDir, job.key)));
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runLogs(process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}
