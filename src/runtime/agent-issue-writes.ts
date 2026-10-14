import type { Observer } from "../core/observability.js";
import { issueChangeEvent, issueWriteAttempt, type IssueWriteContext } from "../core/ops-events.js";
import { gradeChange } from "../core/issue-writes.js";
import type { ChangeOperation, ChangeResult, Intent, IssueChange, IssueRef, IssueSnapshot, Known, TrackerPort } from "../tracker/port.js";

// Writes the agent makes on its issue by itself (issue #15, decisions 23-25). The orchestrator
// cannot see them as calls of its own, so they are recognized in the tool calls of the Pi
// stream and confirmed only by rereading the tracker. A tool call, its return or the agent's
// own claim is never a confirmed change. What cannot be identified is said, not guessed:
// there is no promise of auditing arbitrary commands.

// What the tracker shows about the issue at one rereading, read in two independent parts: the
// snapshot and the ids of the comments. A failed part stays absent; the other is still judged.
interface IssueRead {
  snapshot?: IssueSnapshot;
  comments?: Known<string[]>;
}

export interface AgentWriteOptions {
  observer: Observer;
  job: string;
  invocation?: string;
  ref: IssueRef;
  // `owner/repo` of the job's issue, to tell it from another repository's `gh issue` number.
  repository: string;
  // The account of the project's token inside the container: `@me` in a `gh` command means this
  // account. Resolved before grading, so the attempt and the change name the same target.
  githubAccount: string;
  // Reads the issue of the job in the tracker: the evidence by which a write the agent makes on
  // its own issue can be confirmed. Absent: confirmation is not available in this runtime.
  tracker?: Pick<TrackerPort, "readIssue" | "readComments">;
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
  if (sub === "reopen") intents.push({ operation: "transição", target: "reabrir", reaches: ["to-do", "in-progress"] });
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

// Why a graded change stayed unconfirmed, for the message when the comparison itself cannot
// confirm it: the reread does not show the change, or the command errored before it did.
const whyUnconfirmed = (isError: boolean): string => (isError
  ? "comando terminou com erro e o tracker não mostra a alteração"
  : "o tracker não mostra a alteração");

// A change the tracker already showed before the call: the write changed nothing.
const ALREADY_THERE = "o tracker já mostrava esse estado antes da chamada";

// Why a graded change could not be confirmed, for the message when the comparison itself stays
// attempted: the field the intent reads, named only for the wording.
const UNREAD_FIELD: Partial<Record<ChangeOperation, string>> = {
  "adicionar-label": "labels não lidas no tracker: resultado não confirmado",
  "remover-label": "labels não lidas no tracker: resultado não confirmado",
  "atribuir": "atribuições não lidas no tracker: resultado não confirmado",
  "remover-atribuição": "atribuições não lidas no tracker: resultado não confirmado",
  "fechar": "estado da issue não lido: resultado não confirmado",
  "transição": "estado da issue não lido: resultado não confirmado",
};

interface Pending {
  classified: Classified[];
  before: Promise<IssueRead>;
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

  private read(): Promise<IssueRead> {
    const tracker = this.options.tracker;
    if (tracker === undefined) return Promise.resolve({});
    return Promise.allSettled([tracker.readIssue(this.options.ref), tracker.readComments(this.options.ref)])
      .then(([snapshot, comments]): IssueRead => ({
        ...(snapshot.status === "fulfilled" ? { snapshot: snapshot.value } : {}),
        comments: comments.status === "fulfilled"
          ? { known: true, value: comments.value.map((comment) => comment.id) }
          : { known: false, reason: "falha ao reler os comentários no tracker" },
      }));
  }

  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    if (toolName !== "bash") return;
    const command = textOfInput(args);
    if (command === undefined) return;
    const classified = classifyCommand(command).map((item) => item.kind === "issue"
      ? { ...item, intents: item.intents.map((intent) => this.resolveAccount(intent)) }
      : item);
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
        this.announceOutside(item.issue, item.intents, `outro repositório (${item.repository}): sem evidência`);
        continue;
      }
      if (item.issue !== this.options.ref.id) {
        this.announceOutside(item.issue, item.intents, "outra issue que não a do trabalho: sem evidência");
        continue;
      }
      for (const intent of item.intents) {
        this.announce(item.issue, this.judge(intent, before, after, isError));
      }
    }
  }

  // Outside the job's issue there is no before to compare: one attempt per intent, with the real
  // operation and target, never a single unnamed transition.
  private announceOutside(issue: string, intents: Intent[], detail: string): void {
    for (const intent of intents) this.announce(issue, this.changeOf(intent, "attempted", detail));
  }

  private announce(issue: string, change: IssueChange): void {
    const context = { ...this.context(change.operation, "escrita direta do agente"), refs: { issue_agente: `#${issue}` } };
    this.options.observer.emit(issueChangeEvent(context, change));
  }

  // Inside the container `gh` acts as the project's account, so `@me` in an assignment means that
  // account. Resolved before grading, never after: the attempt and the change name the same target.
  private resolveAccount(intent: Intent): Intent {
    if (intent.target !== "@me" || (intent.operation !== "atribuir" && intent.operation !== "remover-atribuição")) return intent;
    return { ...intent, target: this.options.githubAccount };
  }

  private changeOf(intent: Intent, result: ChangeResult, detail?: string): IssueChange {
    return {
      operation: intent.operation, ...(intent.target === undefined ? {} : { target: intent.target }),
      result, ...(detail === undefined ? {} : { detail }),
    };
  }

  // Labels, assignments, closing and reopening go through the same pure comparison the orchestrator's
  // writes use; this watch only recognizes the intent and says why the comparison did not confirm it.
  private judge(intent: Intent, before: IssueRead, after: IssueRead, isError: boolean): IssueChange {
    if (this.options.tracker === undefined) {
      return this.changeOf(intent, "attempted", "sem evidência do tracker neste runtime: confirmação indisponível");
    }
    if (intent.operation === "comentar") return this.judgeComment(intent, before, after, isError);
    const change = gradeChange(intent, before.snapshot, after.snapshot);
    if (change.result === "unchanged") return { ...change, detail: ALREADY_THERE };
    return change.result === "attempted"
      ? { ...change, detail: this.unconfirmedReason(intent, before, after, isError, change) }
      : change;
  }

  // Why the comparison stayed attempted: which read is missing, or that the reread simply does not
  // show the change. The comparison itself is gradeChange's, never this watch's.
  private unconfirmedReason(intent: Intent, before: IssueRead, after: IssueRead, isError: boolean, change: IssueChange): string {
    const unconfirmed = whyUnconfirmed(isError);
    if (after.snapshot === undefined) return "tracker não pôde ser relido: resultado não confirmado";
    if (change.after === undefined) return UNREAD_FIELD[intent.operation] ?? unconfirmed;
    if (before.snapshot === undefined || change.before === undefined) return NO_BEFORE;
    return unconfirmed;
  }

  // A comment leaves no snapshot evidence: it is judged by the difference of the comment ids
  // between the two readings, the only evidence a comment leaves.
  private judgeComment(intent: Intent, before: IssueRead, after: IssueRead, isError: boolean): IssueChange {
    const unconfirmed = whyUnconfirmed(isError);
    const comments = after.comments;
    const beforeComments = before.comments;
    if (comments?.known !== true || beforeComments?.known !== true) {
      return this.changeOf(intent, "attempted", "comentários não comparáveis no tracker: resultado não confirmado");
    }
    const created = comments.value.filter((id) => !beforeComments.value.includes(id));
    return created.length > 0
      ? this.changeOf(intent, "confirmed", `comentário ${created.join(",")}`)
      : this.changeOf(intent, "attempted", unconfirmed);
  }
}
