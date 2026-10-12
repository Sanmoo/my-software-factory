import { createMainLog, type FieldValue, type Level, type MainLog } from "./main-log.js";
import { refForCommand } from "./job-ref.js";
import { createRedactor, type Redactor } from "./redaction.js";
import { messageOf } from "./values.js";

// Operational observability (issue #15). Every relevant transition of the orchestrator and of
// the runner is an OpsEvent. The observer prints it on the main log immediately and appends it
// to the local history, after hiding known credentials. Observing never changes what the
// orchestrator does: a failing sink is reported through the channels that are left and the
// work goes on (decision 16). No event is ever the cause of a retry or of a second mutation.

export { renderFields, type FieldValue, type Level } from "./main-log.js";

export interface OpsEvent {
  // Stable machine name of the event, e.g. "ajuda-solicitada".
  kind: string;
  // Operator-facing label, e.g. "ajuda solicitada".
  text: string;
  // Severity, decided by the emitter (issue #17). Absent: info.
  level?: Level;
  // The operator has to act now (a help request): stands out on the main log beyond its level.
  highlight?: boolean;
  job?: string;
  invocation?: string;
  fields?: Record<string, FieldValue>;
  // Detail printed under the line and kept whole in the history (question, context, commands).
  lines?: string[];
}

export interface HistoryRecord {
  at: string;
  instance: string;
  kind: string;
  text: string;
  // Absent in records written before issue #17.
  level?: Level;
  job?: string;
  invocation?: string;
  fields: Record<string, string | number>;
  lines: string[];
}

// Local timeline of one instance, one sequence per job. It complements the job snapshot and
// promises neither fsync nor event sourcing (decision 3).
export interface HistoryStore {
  append(record: HistoryRecord): Promise<void>;
  read(job: string): Promise<{ records: HistoryRecord[]; unreadable: number }>;
}

// Where the operator can still see that observability lost something (`status`).
export interface FailureStore {
  record(failure: { at: string; sink: string; message: string }): Promise<void>;
  clear(sink: string): Promise<void>;
}

// What the main log needs to print commands the operator can paste: `./msf [--home DIR] <instance> ...`.
export interface CliHints {
  instance: string;
  // Absolute base directory, only when it is not the default one.
  home?: string;
}

// The commands the main log prints for one job, ready to paste.
export interface JobCommands {
  reply: string;
  resume: string;
  logs: string;
  detail?: string;
}

export interface Observer {
  emit(event: OpsEvent): void;
  // Resolves when every history append requested so far has been attempted.
  flush(): Promise<void>;
  // Reports the failure of a sink that lives outside the observer (the detailed log, an artifact).
  failure(sink: string, error: unknown): void;
  // A sink that failed before has written again: its failure no longer stands in `status`.
  recovered(sink: string): void;
  redact(text: string): string;
  registerSecret(secret: string | undefined): void;
  // The detailed log of the job's latest invocation, so a help request can point to it.
  setDetailLog(job: string, path: string): void;
  // Copyable commands for one job. `jobs` are the keys of the instance's jobs: a short reference
  // that more than one of them shares is printed as the full key.
  commands(job: string, jobs?: readonly string[]): JobCommands | undefined;
}

export const noopObserver: Observer = {
  emit() {},
  async flush() {},
  failure() {},
  recovered() {},
  redact: (text) => text,
  registerSecret() {},
  setDetailLog() {},
  commands: () => undefined,
};

// Shell quoting for one argument: plain words stay as they are, anything else is single-quoted.
export function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

// The commands for one job, ready to paste: the form the main log and `status` both print.
export function jobCommands(cli: CliHints, job: string, jobs: readonly string[] = []): JobCommands {
  const base = `./msf${cli.home === undefined ? "" : ` --home ${shellQuote(cli.home)}`} ${shellQuote(cli.instance)}`;
  const ref = shellQuote(refForCommand(job, jobs));
  return {
    reply: `${base} reply ${ref} --message '<resposta>'`,
    resume: `${base} resume ${ref}`,
    logs: `${base} logs ${ref}`,
  };
}

export interface ObserverOptions {
  instance: string;
  // The main log, as plain lines: called synchronously for every event, one call per line.
  console?: (line: string) => void;
  // The main log, already built (the human presentation of `run`); takes the place of `console`.
  mainLog?: MainLog;
  history?: HistoryStore;
  failures?: FailureStore;
  cli?: CliHints;
  redactor?: Redactor;
  now?: () => Date;
}

export function createObserver(options: ObserverOptions): Observer {
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const mainLog = options.mainLog ?? createMainLog({ instance: options.instance, write: options.console ?? (() => {}), now });
  const detailLogs = new Map<string, string>();
  const failing = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const print = (show: (log: MainLog) => void): void => {
    try {
      show(mainLog);
    } catch {
      // The main log itself is gone: the history and `status` are what is left.
    }
  };

  const sinkFailed = (sink: string, error: unknown): void => {
    const message = redactor.apply(messageOf(error));
    if (!failing.has(sink)) {
      failing.add(sink);
      print((log) => log.event({
        at: now(), level: "atenção", text: "falha de observabilidade",
        fields: { sink, motivo: message, efeito: "a execução continua e não é repetida" },
      }));
    }
    if (options.failures) {
      const store = options.failures;
      queue = queue.then(() => store.record({ at: now().toISOString(), sink, message })).catch(() => undefined);
    }
  };

  const sinkRecovered = (sink: string): void => {
    if (!failing.delete(sink)) return;
    const store = options.failures;
    if (store) queue = queue.then(() => store.clear(sink)).catch(() => undefined);
  };

  const commands: Observer["commands"] = (job, jobs = []) => {
    const cli = options.cli;
    if (!cli) return undefined;
    const detail = detailLogs.get(job);
    return { ...jobCommands(cli, job, jobs), ...(detail ? { detail: `tail -f ${shellQuote(detail)}` } : {}) };
  };

  return {
    emit(event) {
      const date = now();
      const at = date.toISOString();
      const fields: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(event.fields ?? {})) {
        if (value === undefined || value === "") continue;
        fields[name] = typeof value === "string" ? redactor.apply(value) : value;
      }
      const record: HistoryRecord = {
        at,
        instance: options.instance,
        kind: event.kind,
        text: redactor.apply(event.text),
        level: event.level ?? "info",
        ...(event.job === undefined ? {} : { job: event.job }),
        ...(event.invocation === undefined ? {} : { invocation: event.invocation }),
        fields,
        lines: (event.lines ?? []).map((line) => redactor.apply(line)),
      };
      print((log) => log.event({
        at: date, level: record.level ?? "info", text: record.text, fields: record.fields, lines: record.lines,
        ...(event.highlight === true ? { highlight: true } : {}),
        ...(record.job === undefined ? {} : { job: record.job }),
        ...(record.invocation === undefined ? {} : { invocation: record.invocation }),
      }));
      const history = options.history;
      if (!history) return;
      queue = queue
        .then(() => history.append(record))
        .then(() => sinkRecovered("histórico"))
        .catch((error: unknown) => sinkFailed("histórico", error));
    },
    async flush() {
      // A failing sink appends its own record to the queue, so wait until it stops growing.
      for (let seen = queue; ; seen = queue) {
        await seen;
        if (seen === queue) return;
      }
    },
    failure(sink, error) {
      sinkFailed(sink, error);
    },
    recovered(sink) {
      sinkRecovered(sink);
    },
    redact: (text) => redactor.apply(text),
    registerSecret: (secret) => redactor.add(secret),
    setDetailLog(job, path) {
      detailLogs.set(job, path);
    },
    commands,
  };
}
