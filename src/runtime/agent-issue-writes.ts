import type { Observer } from "../core/observability.js";
import { issueChangeEvent, issueWriteAttempt, type IssueWriteContext } from "../core/ops-events.js";
import type { ChangeOperation, ChangeResult, IssueChange, IssueRef } from "../tracker/port.js";

// Writes the agent makes on its issue by itself (issue #15, decisions 23-25). The orchestrator
// cannot see them as calls of its own, so they are recognized in the tool calls of the Pi
// stream and confirmed only by evidence of the tracker. A tool call, its return or the agent's
// own claim is never a confirmed change. What cannot be identified is said, not guessed:
// there is no promise of auditing arbitrary commands.

// What the tracker shows about the issue right now. Fields the tracker could not tell are absent.
export interface IssueState {
  labels?: string[];
  done?: boolean;
  commentIds?: string[];
}

export interface AgentWriteOptions {
  observer: Observer;
  job: string;
  invocation?: string;
  ref: IssueRef;
  // `owner/repo` of the job's issue, to tell it from another repository's `gh issue` number.
  repository: string;
  // Rereads the issue in the tracker. Absent: confirmation is not available in this runtime.
  evidence?: () => Promise<IssueState>;
}

interface Intent {
  operation: ChangeOperation;
  target?: string;
}

export type Classified =
  | { kind: "issue"; issue: string; repository?: string; intents: Intent[] }
  | { kind: "unidentified"; why: string };

// Splits a command line into words and control operators, honoring simple quotes.
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) current += command[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      started = true;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === ";" || char === "|" || char === "&") {
      push();
      const pair = command.slice(index, index + 2);
      if (pair === "&&" || pair === "||") { tokens.push(pair); index += 1; } else tokens.push(char);
    } else {
      current += char;
      started = true;
    }
  }
  push();
  return tokens;
}

const flagValue = (tokens: string[], index: number, flag: string): { value?: string; skip: number } => {
  const token = tokens[index]!;
  if (token.startsWith(`${flag}=`)) return { value: token.slice(flag.length + 1), skip: 0 };
  return { value: tokens[index + 1], skip: 1 };
};

function classifyGhIssue(words: string[]): Classified | undefined {
  const [sub, ...rest] = words;
  if (!["edit", "close", "reopen", "comment"].includes(sub ?? "")) return undefined;
  let issue: string | undefined;
  let repository: string | undefined;
  const intents: Intent[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const flag = token.split("=")[0]!;
    if (flag === "--add-label" || flag === "--remove-label") {
      const { value, skip } = flagValue(rest, index, flag);
      index += skip;
      for (const label of (value ?? "").split(",").filter((entry) => entry !== "")) {
        intents.push({ operation: flag === "--add-label" ? "adicionar-label" : "remover-label", target: label });
      }
    } else if (flag === "--repo" || flag === "-R") {
      const { value, skip } = flagValue(rest, index, flag);
      index += skip;
      repository = value;
    } else if (["--add-assignee", "--remove-assignee"].includes(flag)) {
      const { value, skip } = flagValue(rest, index, flag);
      index += skip;
      for (const account of (value ?? "").split(",").filter((entry) => entry !== "")) {
        intents.push({ operation: flag === "--add-assignee" ? "atribuir" : "remover-atribuição", target: account });
      }
    } else if (token.startsWith("-")) {
      // Other flags with a value (title, body, reason...) take the next word; boolean flags do not exist here.
      if (!token.includes("=") && !["--web", "--edit-last"].includes(token)) index += 1;
    } else if (issue === undefined) {
      issue = token.replace(/^#/, "");
    }
  }
  if (sub === "close") intents.push({ operation: "fechar" });
  if (sub === "reopen") intents.push({ operation: "transição", target: "reabrir" });
  if (sub === "comment") intents.push({ operation: "comentar" });
  if (issue === undefined) return { kind: "unidentified" as const, why: "gh issue sem número da issue" };
  return intents.length === 0
    ? { kind: "unidentified", why: `gh issue ${sub} sem operação reconhecida` }
    : { kind: "issue", issue, ...(repository === undefined ? {} : { repository }), intents };
}

// Without the state before the call, a change cannot be told from one made by someone else or earlier.
const NO_BEFORE = "estado anterior desconhecido: a alteração não pode ser atribuída ao agente";

const WRITE_METHOD = /^(POST|PATCH|PUT|DELETE)$/i;

// Every `gh issue` write in a command line, and the writes through other routes that are seen
// but cannot be identified. A read-only command yields nothing.
export function classifyCommand(command: string): Classified[] {
  const tokens = tokenize(command);
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (["&&", "||", ";", "|", "&"].includes(token)) segments.push([]);
    else segments[segments.length - 1]!.push(token);
  }
  const found: Classified[] = [];
  for (const segment of segments) {
    const start = segment.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const words = start === -1 ? [] : segment.slice(start);
    if (words[0] === "gh" && words[1] === "issue") {
      const classified = classifyGhIssue(words.slice(2));
      if (classified !== undefined) found.push(classified);
    } else if (words[0] === "gh" && words[1] === "api") {
      const method = words.findIndex((word) => word === "-X" || word === "--method");
      const writes = (method !== -1 && WRITE_METHOD.test(words[method + 1] ?? ""))
        || words.some((word) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(word));
      if (writes && words.some((word) => /\/issues\b/.test(word))) {
        found.push({ kind: "unidentified", why: "gh api com escrita em issues não é decomposto em operações" });
      }
    } else if (words[0] === "curl" && words.some((word) => /\/(issues|rest\/api)\b/.test(word)) && words.some((word) => WRITE_METHOD.test(word) || word === "-d" || word === "--data")) {
      found.push({ kind: "unidentified", why: "escrita por curl não é decomposta em operações" });
    }
  }
  return found;
}

const textOfInput = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
};

interface Pending {
  classified: Classified[];
  before: Promise<IssueState | undefined>;
}

// Watches the tool calls of one invocation. Each recognized write is announced as an attempt of
// the agent when it starts, and its outcome is decided when the call ends by rereading the tracker.
export class AgentIssueWatch {
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentWriteOptions) {}

  private context(operation: string, reason: string): IssueWriteContext {
    return {
      ref: this.options.ref, job: this.options.job, ...(this.options.invocation === undefined ? {} : { invocation: this.options.invocation }),
      origin: "agente", operation, reason,
    };
  }

  private read(): Promise<IssueState | undefined> {
    const evidence = this.options.evidence;
    if (evidence === undefined) return Promise.resolve(undefined);
    return evidence().catch(() => undefined);
  }

  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    if (toolName !== "bash") return;
    const command = textOfInput(args);
    if (command === undefined) return;
    const classified = classifyCommand(command);
    if (classified.length === 0) return;
    const before = this.read();
    this.pending.set(toolCallId, { classified, before });
    for (const item of classified) {
      if (item.kind === "issue") {
        for (const intent of item.intents) {
          this.options.observer.emit(issueWriteAttempt({
            ...this.context(intent.operation, "chamada de ferramenta do agente; não é confirmação"),
            refs: { issue_agente: `#${item.issue}`, alvo: intent.target },
          }));
        }
      } else {
        this.options.observer.emit({
          kind: "issue-escrita-limitação", text: "escrita direta do agente na issue não identificável",
          job: this.options.job, ...(this.options.invocation === undefined ? {} : { invocation: this.options.invocation }),
          fields: { origem: "agente", motivo: item.why, confirmação: "não confirmada; limitação de observação" },
        });
      }
    }
  }

  toolEnded(toolCallId: string, isError: boolean): void {
    const pending = this.pending.get(toolCallId);
    if (pending === undefined) return;
    this.pending.delete(toolCallId);
    this.chain = this.chain.then(() => this.settle(pending, isError)).catch(() => undefined);
  }

  // Resolves when every outcome decided so far has been announced.
  async drain(): Promise<void> {
    await this.chain;
  }

  private async settle(pending: Pending, isError: boolean): Promise<void> {
    const before = await pending.before;
    const after = await this.read();
    for (const item of pending.classified) {
      if (item.kind !== "issue") continue;
      if (item.repository !== undefined && item.repository !== this.options.repository) {
        this.announce(item.issue, { operation: "transição", result: "attempted", detail: `outro repositório (${item.repository}): sem evidência` });
        continue;
      }
      if (item.issue !== this.options.ref.id) {
        this.announce(item.issue, { operation: "transição", result: "attempted", detail: "outra issue que não a do trabalho: sem evidência" });
        continue;
      }
      for (const intent of item.intents) {
        this.announce(item.issue, this.judge(intent, before, after, isError));
      }
    }
  }

  private announce(issue: string, change: IssueChange): void {
    const context = { ...this.context(change.operation, "escrita direta do agente"), refs: { issue_agente: `#${issue}` } };
    this.options.observer.emit(issueChangeEvent(context, change));
  }

  private judge(intent: Intent, before: IssueState | undefined, after: IssueState | undefined, isError: boolean): IssueChange {
    const make = (result: ChangeResult, detail?: string, states?: { before?: string; after?: string }): IssueChange => ({
      operation: intent.operation, ...(intent.target === undefined ? {} : { target: intent.target }),
      ...(states?.before === undefined ? {} : { before: states.before }), ...(states?.after === undefined ? {} : { after: states.after }),
      result, ...(detail === undefined ? {} : { detail }),
    });
    if (after === undefined) {
      return make("attempted", this.options.evidence === undefined
        ? "sem evidência do tracker neste runtime: confirmação indisponível"
        : "tracker não pôde ser relido: resultado não confirmado");
    }
    const unconfirmed = isError ? "comando terminou com erro e o tracker não mostra a alteração" : "o tracker não mostra a alteração";
    switch (intent.operation) {
      case "adicionar-label":
      case "remover-label": {
        if (after.labels === undefined) return make("attempted", "labels não lidas no tracker: resultado não confirmado");
        const adding = intent.operation === "adicionar-label";
        const present = after.labels.includes(intent.target ?? "");
        const hadBefore = before?.labels?.includes(intent.target ?? "");
        if (present !== adding) return make("attempted", unconfirmed);
        if (hadBefore === undefined) return make("attempted", NO_BEFORE);
        if (hadBefore === adding) return make("unchanged", "o tracker já tinha esse estado antes da chamada");
        return make("confirmed", undefined, { before: hadBefore ? "presente" : "ausente", after: present ? "presente" : "ausente" });
      }
      case "fechar": {
        if (after.done === undefined) return make("attempted", "estado da issue não lido: resultado não confirmado");
        if (!after.done) return make("attempted", unconfirmed);
        if (before?.done === undefined) return make("attempted", NO_BEFORE);
        return before.done
          ? make("unchanged", "a issue já estava fechada antes da chamada")
          : make("confirmed", undefined, { before: "open", after: "closed" });
      }
      case "transição": {
        if (after.done === undefined) return make("attempted", "estado da issue não lido: resultado não confirmado");
        if (after.done !== false) return make("attempted", unconfirmed);
        if (before?.done === undefined) return make("attempted", NO_BEFORE);
        return before.done ? make("confirmed", undefined, { before: "closed", after: "open" }) : make("unchanged", "a issue já estava aberta antes da chamada");
      }
      case "comentar": {
        if (after.commentIds === undefined || before?.commentIds === undefined) {
          return make("attempted", "comentários não comparáveis no tracker: resultado não confirmado");
        }
        const created = after.commentIds.filter((id) => !before.commentIds!.includes(id));
        return created.length > 0
          ? make("confirmed", `comentário ${created.join(",")}`)
          : make("attempted", unconfirmed);
      }
      default:
        return make("attempted", "operação sem verificação no tracker: resultado não confirmado");
    }
  }
}
