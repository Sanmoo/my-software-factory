import { styleText } from "node:util";

// The main log (Log principal): the continuous stream in which the operator follows an instance
// (issue #17). Two presentations of the same content: the plain one, stable for files and grep,
// and the human one, for a terminal, with local time, a job column, severity and colors. The
// grouping of repeated failures applies to both. The local history is not touched here: it
// always keeps everything.

export type Level = "info" | "progresso" | "atenção" | "erro";
export type FieldValue = string | number | undefined;

export interface MainLogEntry {
  at: Date;
  level: Level;
  text: string;
  job?: string;
  invocation?: string;
  fields?: Record<string, FieldValue>;
  lines?: string[];
  // The moment the operator has to act (a help request): stands out beyond its level.
  highlight?: boolean;
}

export interface Failure {
  // The job key, or what failed outside a job ("discovery", "ciclo").
  key: string;
  message: string;
}

export interface MainLog {
  event(entry: MainLogEntry): void;
  // A line of the coordinator loop itself (start, commands, deferrals, pause).
  note(level: Level, text: string): void;
  // The failures of one polling cycle. The same failure is printed once, then reminded at most
  // every 5 minutes, and its recovery is said; only what is printed changes, never what is tried.
  // `cycleFailed`: the cycle did not run, so the failures it could not see are not recovered.
  failures(failures: readonly Failure[], options?: { cycleFailed?: boolean }): void;
}

export interface MainLogOptions {
  instance: string;
  // One call per printed line.
  write: (line: string) => void;
  // Present: human presentation; absent: plain.
  human?: { color: boolean };
  now?: () => Date;
}

// The presentation `run` uses: human only on a terminal (or when colors are forced), colors unless
// NO_COLOR or FORCE_COLOR=0 says otherwise.
export function terminalMode(env: Record<string, string | undefined>, isTTY: boolean): { color: boolean } | undefined {
  const force = env["FORCE_COLOR"];
  const forced = force !== undefined && force !== "0";
  if (!isTTY && !forced) return undefined;
  const noColor = env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "";
  return { color: forced || (!noColor && force !== "0") };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");
const localDate = (at: Date): string => `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
const localTime = (at: Date): string => `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
const plainValue = (value: string): string => (/^[^\s"=\\]+$/.test(value) ? value : JSON.stringify(value));

export function renderFields(fields: Record<string, FieldValue>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([name, value]) => `${name}=${plainValue(String(value))}`)
    .join(" ");
}

// `github:owner/repo#13` -> `#13`; `jira:PAY#PAY-7` -> `PAY-7`.
export function shortJob(key: string): string {
  const id = key.slice(key.lastIndexOf("#") + 1);
  return /^\d+$/.test(id) ? `#${id}` : id;
}

const isJob = (key: string): boolean => /^[^:#\s]+:.+#.+$/.test(key);
const labelOf = (key: string): string => (isJob(key) ? shortJob(key) : key);

type Format = Extract<Parameters<typeof styleText>[0], string>;

// Readable without color too: the marker says the level.
const MARKER: Record<Level, string> = { info: "·", progresso: "✓", "atenção": "!", erro: "✗" };
const TEXT_STYLE: Record<Level, Format[]> = { info: ["bold"], progresso: ["bold", "green"], "atenção": ["bold", "yellow"], erro: ["bold", "red"] };
// Today's plain words for the loop's own lines.
const PLAIN_PREFIX: Record<Level, string> = { info: "", progresso: "", "atenção": "ATENÇÃO: ", erro: "ERRO " };

// What the human presentation leaves to the history and to `./msf <instância> logs`: the area, the session
// and the logs nobody follows live. The detailed log stays, it is the one to `tail -f`.
const SECONDARY = new Set(["área", "sessão", "runtime", "artefatos"]);
const JOB_COLUMN = 6;
// Detail lines start under the event text: time, marker, job column and their spaces.
const INDENT = " ".repeat(8 + 1 + 1 + 1 + JOB_COLUMN + 1);
const REMINDER_MS = 5 * 60 * 1000;

// The same failure, whatever job, page or path it was about: first line, key and paths left out.
const identityOf = (failure: Failure, first: string): string =>
  first.split(failure.key).join("…").replace(/\S*[/?]\S*/g, "…");

const elapsed = (from: Date, to: Date): string => {
  const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}min` : `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}min`;
};

// How one failure (or a group of them) is told: whole in plain, by job column in human.
interface Told {
  plain: string;
  text: string;
  job?: string;
  // The keys sharing the failure, when more than one.
  affected?: string[];
}

interface Ongoing {
  told: Told;
  since: Date;
  shown: Date;
  cycles: number;
}

export function createMainLog(options: MainLogOptions): MainLog {
  const { human, write } = options;
  const now = options.now ?? (() => new Date());
  let lastDate: string | undefined;
  const mentioned = new Set<string>();
  const ongoing = new Map<string, Ongoing>();

  const paint = (style: Format | Format[], text: string): string =>
    human?.color ? styleText(style, text, { validateStream: false }) : text;

  const fieldsOf = (fields: Record<string, FieldValue>): string =>
    Object.entries(fields)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
      .map(([name, value]) => {
        const text = plainValue(String(value));
        return `${paint("dim", `${name}=`)}${String(value).startsWith("/") ? paint("dim", text) : text}`;
      })
      .join(" ");

  // One event on a terminal. `faint` lines are secondary detail (the tail of an error message).
  const humanEntry = (entry: MainLogEntry, faint: readonly string[] = []): void => {
    const date = localDate(entry.at);
    if (date !== lastDate) {
      lastDate = date;
      write(paint("dim", `── ${date} ──`));
    }
    const shown: Record<string, FieldValue> = {};
    for (const [name, value] of Object.entries(entry.fields ?? {})) {
      if (SECONDARY.has(name)) continue;
      if (name === "ref" && entry.fields?.["comando"] !== undefined && value === `comando ${entry.fields["comando"]}`) continue;
      shown[name] = value;
    }
    if (entry.invocation !== undefined) shown["invocação"] = entry.invocation;
    if (entry.job !== undefined && isJob(entry.job) && !mentioned.has(entry.job)) {
      mentioned.add(entry.job);
      shown["trabalho"] = entry.job;
    }
    const style = TEXT_STYLE[entry.level];
    const column = (entry.job === undefined ? "" : labelOf(entry.job)).padEnd(JOB_COLUMN);
    const text = paint(entry.highlight ? [...style, "inverse"] : style, entry.text);
    const fields = fieldsOf(shown);
    write(`${localTime(entry.at)} ${paint(style, MARKER[entry.level])} ${column} ${fields === "" ? text : `${text}  ${fields}`}`);
    for (const line of entry.lines ?? []) write(`${INDENT}${line}`);
    for (const line of faint) write(`${INDENT}${paint("dim", line)}`);
  };

  const plainNote = (at: Date, level: Level, text: string, extra: readonly string[] = []): void => {
    write(`${at.toISOString()} ${PLAIN_PREFIX[level]}${text}`);
    for (const line of extra) write(line);
  };

  const tell = (at: Date, level: Level, told: Told, prefix = "", extra: readonly string[] = []): void => {
    if (!human) {
      return plainNote(at, level, `${prefix}${told.plain}${told.affected ? ` (afeta: ${told.affected.join(", ")})` : ""}`, extra);
    }
    humanEntry({
      at, level, text: `${prefix}${told.text}`,
      ...(told.job === undefined ? {} : { job: told.job }),
      ...(told.affected === undefined ? {} : { fields: { afeta: told.affected.map(labelOf).join(",") } }),
    }, extra);
  };

  return {
    event(entry) {
      if (human) return humanEntry(entry);
      const fields = renderFields({
        ...(entry.job === undefined ? {} : { trabalho: entry.job }),
        ...(entry.invocation === undefined ? {} : { invocação: entry.invocation }),
        ...entry.fields,
      });
      write([entry.at.toISOString(), `[${options.instance}]`, entry.text, fields].filter((part) => part !== "").join(" "));
      for (const line of entry.lines ?? []) write(`    ${line}`);
    },

    note(level, text) {
      const at = now();
      if (human) humanEntry({ at, level, text });
      else plainNote(at, level, text);
    },

    failures(failures, cycle = {}) {
      const at = now();
      const groups = new Map<string, { keys: string[]; first: string; rest: string[] }>();
      for (const failure of failures) {
        const [first = "", ...rest] = failure.message.split("\n");
        const identity = identityOf(failure, first);
        const group = groups.get(identity) ?? { keys: [], first, rest };
        if (!group.keys.includes(failure.key)) group.keys.push(failure.key);
        groups.set(identity, group);
      }
      for (const [identity, group] of groups) {
        const [only] = group.keys;
        const told: Told = group.keys.length === 1 && only !== undefined
          ? { plain: `${only}: ${group.first}`, ...(isJob(only) ? { text: group.first, job: only } : { text: `${only}: ${group.first}` }) }
          : { plain: identity, text: identity, affected: group.keys };
        const current = ongoing.get(identity);
        if (current === undefined) {
          ongoing.set(identity, { told, since: at, shown: at, cycles: 1 });
          tell(at, "erro", told, "", group.rest);
          continue;
        }
        current.cycles += 1;
        current.told = told;
        if (at.getTime() - current.shown.getTime() < REMINDER_MS) continue;
        current.shown = at;
        tell(at, "erro", told, `ainda falhando há ${elapsed(current.since, at)} (×${current.cycles}): `);
      }
      if (cycle.cycleFailed) return;
      for (const [identity, current] of ongoing) {
        if (groups.has(identity)) continue;
        ongoing.delete(identity);
        // Who it affected no longer matters: the failure as such is over.
        const { affected: _over, ...told } = current.told;
        tell(at, "progresso", told, `recuperado após ${elapsed(current.since, at)} (×${current.cycles}): `);
      }
    },
  };
}
