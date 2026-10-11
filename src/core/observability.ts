import { createRedactor, type Redactor } from "./redaction.js";
import { messageOf } from "./values.js";

// Operational observability (issue #15). Every relevant transition of the orchestrator and of
// the runner is an OpsEvent. The observer prints it on the main log immediately and appends it
// to the local history, after hiding known credentials. Observing never changes what the
// orchestrator does: a failing sink is reported through the channels that are left and the
// work goes on (decision 16). No event is ever the cause of a retry or of a second mutation.

export type FieldValue = string | number | undefined;

export interface OpsEvent {
  // Stable machine name of the event, e.g. "ajuda-solicitada".
  kind: string;
  // Operator-facing label, e.g. "ajuda solicitada".
  text: string;
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

// What the main log needs to print commands the operator can paste.
export interface CliHints {
  config: string;
  instance: string;
  stateDir: string;
}

export interface Observer {
  emit(event: OpsEvent): void;
  // Resolves when every history append requested so far has been attempted.
  flush(): Promise<void>;
  // Reports the failure of a sink that lives outside the observer (the detailed log, an artifact).
  failure(sink: string, error: unknown): void;
  redact(text: string): string;
  registerSecret(secret: string | undefined): void;
  // The detailed log of the job's latest invocation, so a help request can point to it.
  setDetailLog(job: string, path: string): void;
  // Copyable commands for one job.
  commands(job: string): { reply: string; logs: string; detail?: string } | undefined;
}

export const noopObserver: Observer = {
  emit() {},
  async flush() {},
  failure() {},
  redact: (text) => text,
  registerSecret() {},
  setDetailLog() {},
  commands: () => undefined,
};

// Shell quoting for one argument: plain words stay as they are, anything else is single-quoted.
export function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

const plain = (value: string): string => (/^[^\s"=\\]+$/.test(value) ? value : JSON.stringify(value));

export function renderFields(fields: Record<string, FieldValue>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([name, value]) => `${name}=${plain(String(value))}`)
    .join(" ");
}

export interface ObserverOptions {
  instance: string;
  // The main log. Called synchronously for every event; one call per line.
  console: (line: string) => void;
  history?: HistoryStore;
  failures?: FailureStore;
  cli?: CliHints;
  redactor?: Redactor;
  now?: () => Date;
}

export function createObserver(options: ObserverOptions): Observer {
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const detailLogs = new Map<string, string>();
  const failing = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const print = (line: string): void => {
    try {
      options.console(line);
    } catch {
      // The main log itself is gone: the history and `status` are what is left.
    }
  };

  const sinkFailed = (sink: string, error: unknown): void => {
    const message = redactor.apply(messageOf(error));
    if (!failing.has(sink)) {
      failing.add(sink);
      print(`${now().toISOString()} [${options.instance}] ATENÇÃO falha de observabilidade sink=${plain(sink)} motivo=${plain(message)}; a execução continua e não é repetida`);
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

  const commands: Observer["commands"] = (job) => {
    const cli = options.cli;
    if (!cli) return undefined;
    const base = `--config ${shellQuote(cli.config)} --instance ${shellQuote(cli.instance)} --state-dir ${shellQuote(cli.stateDir)}`;
    const detail = detailLogs.get(job);
    return {
      reply: `npm run reply -- ${base} ${shellQuote(job)} --message '<resposta>'`,
      logs: `npm run logs -- ${base} ${shellQuote(job)}`,
      ...(detail ? { detail: `tail -f ${shellQuote(detail)}` } : {}),
    };
  };

  return {
    emit(event) {
      const at = now().toISOString();
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
        ...(event.job === undefined ? {} : { job: event.job }),
        ...(event.invocation === undefined ? {} : { invocation: event.invocation }),
        fields,
        lines: (event.lines ?? []).map((line) => redactor.apply(line)),
      };
      const head = [
        at,
        `[${options.instance}]`,
        record.text,
        renderFields({
          ...(record.job === undefined ? {} : { trabalho: record.job }),
          ...(record.invocation === undefined ? {} : { invocação: record.invocation }),
          ...fields,
        }),
      ].filter((part) => part !== "").join(" ");
      print(head);
      for (const line of record.lines) print(`    ${line}`);
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
    redact: (text) => redactor.apply(text),
    registerSecret: (secret) => redactor.add(secret),
    setDetailLog(job, path) {
      detailLogs.set(job, path);
    },
    commands,
  };
}
