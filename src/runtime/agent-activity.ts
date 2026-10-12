import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FieldValue, Level, Observer } from "../core/observability.js";
import { isObject, type Obj } from "../core/values.js";
import { AgentIssueWatch, type AgentWriteOptions } from "./agent-issue-writes.js";

// What the operator can follow while an invocation runs (issue #15). One AgentActivity per
// invocation reads the raw stdout lines of Pi's JSON stream and keeps two views of it:
//
//   - the detailed log (a readable file, written as the lines arrive): public assistant messages,
//     every tool call with its arguments and its result or error, correlated by tool call id;
//   - the operational events on the main log and history: idle warnings, resumed activity,
//     timeout, and the lifecycle of the children the agent delegated to.
//
// There is no list of recognized tool names: any tool is rendered. Private model reasoning is
// never written. Long arguments and results go whole to an artifact and are summarized with a
// reference, never truncated silently. Known credentials are hidden before anything is written.
// A failure to write is reported through the observer and the run goes on.

const DEFAULT_INLINE_LIMIT = 2000;
const SUMMARY_LENGTH = 300;
const DEFAULT_UPDATE_SUMMARY = 200;

export interface AgentActivityOptions {
  observer: Observer;
  job: string;
  invocation?: string;
  // The readable detailed log of this invocation.
  detailPath: string;
  // Directory for full tool arguments/results and for the logs of the children.
  artifactsDir: string;
  now?: () => number;
  idle: { timeoutSeconds: number; warnEverySeconds: number };
  inlineLimit?: number;
  // Writes the agent makes on the issue, confirmed only by tracker evidence.
  issueWrites?: Omit<AgentWriteOptions, "observer" | "job" | "invocation">;
}

interface ActiveTool {
  name: string;
  startedAt: number;
}

interface Child {
  id: string;
  agent: string;
  async: boolean;
  path: string;
  ended: boolean;
}

const pad = (value: number) => String(value).padStart(2, "0");

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : undefined));
    if (parts.some((part) => part !== undefined)) return parts.filter((part): part is string => part !== undefined).join("");
  }
  if (isObject(value) && "content" in value) return textOf(value.content);
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

const NOTIFY = /Background task completed: \*\*([^*]+)\*\*/g;

export class AgentActivity {
  private readonly now: () => number;
  private readonly redact: (text: string) => string;
  private readonly inlineLimit: number;
  private readonly tools = new Map<string, ActiveTool>();
  private readonly children = new Map<string, Child>();
  private readonly user: string[] = [];
  private readonly watch?: AgentIssueWatch;
  private chain: Promise<void> = Promise.resolve();
  private detailBroken = false;
  private buffer = "";
  private streamed = false;
  private lastOutputAt: number;
  private warned = 0;
  private lastActivity = "invocação iniciada";
  private limitationAnnounced = false;
  private artifactSeq = 0;

  constructor(private readonly options: AgentActivityOptions) {
    this.now = options.now ?? Date.now;
    this.redact = (text) => options.observer.redact(text);
    this.inlineLimit = options.inlineLimit ?? DEFAULT_INLINE_LIMIT;
    this.lastOutputAt = this.now();
    if (options.issueWrites) {
      this.watch = new AgentIssueWatch({
        observer: options.observer, job: options.job,
        ...(options.invocation === undefined ? {} : { invocation: options.invocation }),
        ...options.issueWrites,
      });
    }
  }

  // Texts of the user messages seen in the stream: the evidence that a reply reached the agent.
  userMessages(): readonly string[] {
    return this.user;
  }

  // One raw stdout line of the agent. Any line, even one that is not an event, is output.
  line(raw: string): void {
    if (this.warned > 0) {
      const silent = Math.round((this.now() - this.lastOutputAt) / 1000);
      this.event("agente-atividade-retomada", "atividade do agente retomada", { "sem-saída-por": `${silent}s` });
      this.detail(`atividade retomada após ${silent}s sem saída`);
      this.warned = 0;
    }
    this.lastOutputAt = this.now();
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      this.detail(`saída: ${raw}`);
      return;
    }
    if (isObject(event) && typeof event.type === "string") this.render(event);
  }

  // Called by a timer in production and by a controlled clock in tests. A warning is technical:
  // it says no output arrived, not that the agent failed or asked for help.
  checkIdle(): void {
    const silent = Math.floor((this.now() - this.lastOutputAt) / 1000);
    const due = Math.floor(silent / this.options.idle.warnEverySeconds);
    if (due <= this.warned) return;
    this.warned = due;
    const active = [...this.tools.entries()].map(([id, tool]) => `${tool.name}:${id}`).join(",");
    this.event("agente-sem-saída", "aviso técnico: sem saída recebida do agente (não é falha nem pedido de ajuda)", {
      "sem-saída": `${silent}s`,
      "timeout-efetivo": `${this.options.idle.timeoutSeconds}s`,
      "última-atividade": this.lastActivity,
      "ferramentas-ativas": active === "" ? undefined : active,
    }, "atenção");
    this.detail(`aviso: sem saída há ${silent}s; timeout efetivo ${this.options.idle.timeoutSeconds}s; última atividade: ${this.lastActivity}`);
  }

  // The runtime gave up waiting: a real transition, distinct from the warnings before it.
  timedOut(reason: string): void {
    const silent = Math.floor((this.now() - this.lastOutputAt) / 1000);
    this.event("agente-timeout", "timeout: sem saída do agente", {
      "sem-saída": `${silent}s`, "timeout-efetivo": `${this.options.idle.timeoutSeconds}s`,
      "última-atividade": this.lastActivity, motivo: reason,
    }, "erro");
    this.detail(`timeout: ${reason}`);
  }

  // Resolves when every write requested so far has been attempted. The invocation stays open.
  async drain(): Promise<void> {
    await this.chain;
  }

  // Closes the invocation: pending text is written, children without an observed outcome are said
  // to be unknown, and every queued write is attempted.
  async close(): Promise<void> {
    this.flushText();
    for (const child of this.children.values()) {
      if (child.ended) continue;
      this.event("filho-sem-desfecho", "filho sem desfecho observado (não é sucesso)", {
        filho: child.id, agente: child.agent, "log-do-filho": child.path,
      }, "atenção");
      this.childLine(child, "invocação encerrada sem desfecho observado deste filho");
    }
    await this.watch?.drain();
    await this.chain;
  }

  // ---- rendering --------------------------------------------------------------------------

  private render(event: Obj): void {
    switch (event.type) {
      case "session":
        if (typeof event.id === "string") this.detail(`sessão ${event.id}`);
        return;
      case "message_update":
        this.messageUpdate(event);
        return;
      case "message_end":
        this.messageEnd(event);
        return;
      case "tool_execution_start":
        this.toolStart(event);
        return;
      case "tool_execution_update":
        this.toolUpdate(event);
        return;
      case "tool_execution_end":
        this.toolEnd(event);
        return;
      case "agent_settled":
        this.flushText();
        this.detail(`agente assentado (aborted=${String(event.aborted)})`);
        return;
      case "agent_error":
      case "error": {
        this.flushText();
        const message = textOf(event.message ?? event.error ?? event);
        this.lastActivity = "erro do agente";
        this.detail(`erro do agente: ${message}`);
        return;
      }
      default:
        this.notifyChildren(event);
    }
  }

  private messageUpdate(event: Obj): void {
    const inner = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
    // Only public text. Thinking deltas are the model's private reasoning and are never written.
    if (inner?.type !== "text_delta" || typeof inner.delta !== "string") return;
    this.streamed = true;
    this.buffer += inner.delta;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.detail(`agente: ${line}`);
    this.lastActivity = "mensagem do agente";
  }

  private messageEnd(event: Obj): void {
    const message = isObject(event.message) ? event.message : undefined;
    if (message === undefined) return;
    this.notifyChildren(event);
    if (message.role === "user") {
      const text = textOf(message.content);
      this.user.push(text);
      this.detail(`mensagem do usuário recebida (${text.length} caracteres)`);
      return;
    }
    if (message.role !== "assistant") return;
    this.flushText();
    if (!this.streamed && Array.isArray(message.content)) {
      const text = message.content
        .filter((block): block is Obj => isObject(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string).join("");
      if (text !== "") for (const line of text.split("\n")) this.detail(`agente: ${line}`);
    }
    this.streamed = false;
    if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
      this.detail(`erro na mensagem do agente: ${message.errorMessage}`);
    }
  }

  private flushText(): void {
    if (this.buffer !== "") this.detail(`agente: ${this.buffer}`);
    this.buffer = "";
  }

  private toolStart(event: Obj): void {
    this.flushText();
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "?";
    const name = typeof event.toolName === "string" ? event.toolName : "?";
    this.tools.set(id, { name, startedAt: this.now() });
    this.lastActivity = `ferramenta ${name} id=${id} iniciada`;
    const args = event.args === undefined ? "" : JSON.stringify(event.args);
    this.detail(`→ ferramenta ${name} id=${id}`, this.bounded(args, id, "argumentos", "args"));
    this.watch?.toolStarted(id, name, event.args);
    if (name === "subagent") this.childStarted(id, event);
  }

  private toolUpdate(event: Obj): void {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "?";
    const name = typeof event.toolName === "string" ? event.toolName : (this.tools.get(id)?.name ?? "?");
    const text = textOf(event.partialResult ?? event.result ?? event.update ?? "");
    this.lastActivity = `ferramenta ${name} id=${id} atualização`;
    this.detail(`… ferramenta ${name} id=${id} atualização`, this.bounded(text, id, "atualização", "update", DEFAULT_UPDATE_SUMMARY));
    const child = this.children.get(id);
    if (child) this.childLine(child, `atividade observada: ${this.summary(text, DEFAULT_UPDATE_SUMMARY)}`);
  }

  private toolEnd(event: Obj): void {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "?";
    const known = this.tools.get(id);
    const name = typeof event.toolName === "string" ? event.toolName : (known?.name ?? "?");
    this.tools.delete(id);
    const failed = event.isError === true;
    const text = textOf(event.result ?? event.output ?? "");
    this.lastActivity = `ferramenta ${name} id=${id} ${failed ? "com erro" : "concluída"}`;
    this.detail(`← ferramenta ${name} id=${id} ${failed ? "ERRO" : "ok"}`, this.bounded(text, id, "resultado", "result"));
    this.watch?.toolEnded(id, failed);
    const child = this.children.get(id);
    if (child) this.childEnded(child, failed, text);
  }

  // ---- children -----------------------------------------------------------------------------

  private childStarted(id: string, event: Obj): void {
    const args = isObject(event.args) ? event.args : {};
    const agent = typeof args.agent === "string" ? args.agent : "(sem nome)";
    const child: Child = {
      id, agent, async: args.async === true, ended: false,
      path: join(this.options.artifactsDir, "children", `${encodeURIComponent(id)}.log`),
    };
    this.children.set(id, child);
    this.event("filho-iniciado", "filho iniciado", {
      filho: id, agente: agent, assíncrono: child.async ? "sim" : "não",
      modelo: typeof args.model === "string" ? args.model : undefined, "log-do-filho": child.path,
    });
    if (!this.limitationAnnounced) {
      this.limitationAnnounced = true;
      this.event("filho-limitação", "limitação do runtime: o stream do Pi não expõe a atividade interna nem pedidos de ajuda dos filhos; só lançamento, atualizações recebidas e desfecho são observados", {});
    }
    this.detail(`filho ${agent} id=${id}: log próprio em ${child.path}`);
    this.childLine(child, `filho ${agent} lançado (assíncrono=${String(child.async)}); argumentos: ${this.redact(JSON.stringify(args))}`);
  }

  private childEnded(child: Child, failed: boolean, text: string): void {
    if (child.async && !failed) {
      this.event("filho-lançado", "filho lançado em segundo plano; desfecho aguarda a notificação", { filho: child.id, agente: child.agent });
      this.childLine(child, "lançamento confirmado; o desfecho chega por notificação");
      return;
    }
    child.ended = true;
    this.event(failed ? "filho-erro" : "filho-concluído", failed ? "filho terminou com erro" : "filho concluído", {
      filho: child.id, agente: child.agent, resultado: this.summary(text), "log-do-filho": child.path,
    }, failed ? "erro" : "info");
    this.childLine(child, `${failed ? "ERRO" : "desfecho"}: ${text}`);
  }

  // Asynchronous children report their end by a custom `subagent-notify` message.
  private notifyChildren(event: Obj): void {
    const message = isObject(event.message) ? event.message : undefined;
    if (message?.customType !== "subagent-notify" || typeof message.content !== "string") return;
    for (const match of message.content.matchAll(NOTIFY)) {
      const agent = match[1] ?? "";
      const child = [...this.children.values()].find((candidate) => candidate.agent === agent && candidate.async && !candidate.ended);
      if (child) child.ended = true;
      this.event("filho-concluído", "filho concluído (notificação)", {
        filho: child?.id, agente: agent, "log-do-filho": child?.path,
      });
      if (child) this.childLine(child, `notificação de conclusão: ${message.content}`);
    }
  }

  private childLine(child: Child, text: string): void {
    this.enqueue(child.path, `${this.stamp()} ${this.redact(text)}\n`, "log do filho");
  }

  // ---- output ---------------------------------------------------------------------------------

  // Redacts first, then shortens: a credential cut in two by the summary would no longer be recognized.
  private summary(text: string, length = SUMMARY_LENGTH): string {
    const flat = this.redact(text).replace(/\s+/g, " ").trim();
    return flat.length > length ? `${flat.slice(0, length)}…` : flat;
  }

  // Text that fits is shown whole. Text that does not is kept whole in an artifact, and the log
  // shows a summary with its size and where the complete content is.
  private bounded(text: string, id: string, label: string, suffix: string, summaryLength = SUMMARY_LENGTH): string[] {
    if (text === "") return [];
    if (text.length <= this.inlineLimit) return text.split("\n");
    this.artifactSeq += 1;
    const path = join(this.options.artifactsDir, "tool-output", `${this.artifactSeq}-${encodeURIComponent(id)}-${suffix}.txt`);
    this.enqueue(path, this.redact(text), "artefato", true);
    return [`${label}: ${this.summary(this.redact(text), summaryLength)}`, `[${label} extenso: ${text.length} caracteres; conteúdo completo em ${path}]`];
  }

  private stamp(): string {
    const date = new Date(this.now());
    return `${date.toISOString().slice(0, 10)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
  }

  private detail(head: string, body: string[] = []): void {
    if (this.detailBroken) return;
    const text = [`${this.stamp()} ${head}`, ...body.map((line) => `    ${line}`)].map((line) => this.redact(line)).join("\n") + "\n";
    this.enqueue(this.options.detailPath, text, "log detalhado");
  }

  private event(kind: string, text: string, fields: Record<string, FieldValue>, level: Level = "info"): void {
    this.options.observer.emit({
      kind, text, level, job: this.options.job,
      ...(this.options.invocation === undefined ? {} : { invocation: this.options.invocation }),
      fields,
    });
  }

  // Writes happen in order and never block the stream. A failed write is reported once for its
  // destination; the others keep working (decision 16).
  private enqueue(path: string, text: string, sink: string, replace = false): void {
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        if (replace) await writeFile(path, text, { mode: 0o600 });
        else await appendFile(path, text, { mode: 0o600 });
        this.options.observer.recovered(sink);
      } catch (error) {
        if (sink === "log detalhado") this.detailBroken = true;
        this.options.observer.failure(sink, error);
      }
    });
  }
}
