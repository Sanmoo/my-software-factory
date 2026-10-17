import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The Herdr boundary of the assisted attendance (spec #48, ticket #54): own tab with the exec
// pane inside the caller's workspace, created without stealing focus (`--no-focus`, ticket #52,
// where focusedBefore == focusedAfter was proven) unless the OPERATOR asked for the reopening
// (`focus: true`, the manual resume of #77: the operator must see where they continued, so
// stealing focus is the intent, not a failure). The exec runs via `herdr pane run`, so the
// pane's foreground process is the host docker client while pi runs in the container. The
// boundary only hosts: supervision goes by container identity from the record, never by pane
// presence (ticket #52: closing the tab does not stop the exec — proving the tab gone is what
// makes the supervision REQUEST the stop, it never means the exec stopped), and no fallback to
// a host pi exists anywhere.

const execFileAsync = promisify(execFile);

export interface HerdrTabRef {
  tabId: string;
  paneId: string; // the root pane of the tab: the exec pane
}

export interface HerdrTabOpening {
  tab: HerdrTabRef;
  // The focused tab id before and after the creation, kept as evidence: without focus (the
  // first opening and the single-use scheduled resume) they must be equal; with `focus: true`
  // (the operator's manual resume, #77) the new tab is the one focused.
  focusedBefore: string;
  focusedAfter: string;
  label: string;
  cwd: string;
}

export interface HerdrTabInput {
  workspace: string;
  cwd: string;
  label: string;
  // Whether the operator ASKED for this reopening (#77): `true` focuses the new tab; absent or
  // `false` keeps `--no-focus` and the no-steal guarantee of #52 (the first opening and the
  // single-use scheduled resume).
  focus?: boolean;
}

export interface HerdrBoundary {
  // Herdr server available for tabs/panes. Throws with the reason otherwise.
  available(): Promise<void>;
  // The workspace of the caller's own pane: where the assisted tab is opened (never host-wide).
  currentWorkspace(): Promise<string>;
  // Own tab inside the workspace. Without `focus`, the tab is created without focus and steering
  // focus is a failure, not an inconvenience (the #52 guarantee); with `focus: true` (the
  // operator's manual resume) the new tab is the one focused on purpose.
  createTab(input: HerdrTabInput): Promise<HerdrTabOpening>;
  // Types one command into the pane (`herdr pane run`); its exit proves nothing beyond delivery.
  paneRun(paneId: string, command: string): Promise<void>;
  // The tab ids the server currently hosts: how supervision proves a session's tab is gone
  // (ticket #56: closing the tab has to solicit the exec's stop). Throws when Herdr cannot be
  // asked; the caller treats a failed query as "cannot prove gone", never as "gone".
  tabIds(): Promise<readonly string[]>;
}

type Json = Record<string, unknown>;

// The herdr CLI wraps its payload in `result` (herdr 0.9.3, the shape the #52 proof used);
// what the boundary codes against is that payload.
const herdrJson = async (args: readonly string[]): Promise<Json> => {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 << 20 });
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`herdr ${args.join(" ")} devolveu resposta sem JSON: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(stdout.slice(start)) as Json;
  const result = parsed.result as Json | undefined;
  if (result === undefined) {
    throw new Error(`herdr ${args.join(" ")} devolveu resposta sem resultado: ${stdout.slice(0, 200)}`);
  }
  return result;
};

// `herdr status`: the proof checked the server this way; only a running server hosts exec panes.
const focusedTabId = (tabs: Json): string => {
  const list = (tabs.tabs as Array<Json> | undefined) ?? [];
  return (list.find((tab) => tab.focused === true)?.tab_id as string | undefined) ?? "";
};

const tabOf = (created: Json): { tabId: string; paneId: string } => {
  const rootPane = created.root_pane as Json | undefined;
  const tab = created.tab as Json | undefined;
  const tabId = tab?.tab_id;
  const paneId = rootPane?.pane_id;
  if (typeof tabId !== "string" || typeof paneId !== "string") {
    throw new Error(`herdr tab create devolveu identidade incompleta: ${JSON.stringify(created).slice(0, 200)}`);
  }
  return { tabId, paneId };
};

export function herdrBoundary(): HerdrBoundary {
  return {
    async available() {
      const { stdout } = await execFileAsync("herdr", ["status"], { encoding: "utf8", timeout: 15_000 });
      if (!/^  status: running/m.test(stdout)) throw new Error(`servidor Herdr indisponível:\n${stdout.trim()}`);
    },
    async currentWorkspace(): Promise<string> {
      const current = await herdrJson(["pane", "current", "--current"]);
      const pane = current.pane as Json | undefined;
      const workspace = pane?.workspace_id;
      if (typeof workspace !== "string") throw new Error("workspace do Herdr não identificado a partir da pane atual");
      return workspace;
    },
    async createTab(input) {
      const requestedFocus = input.focus === true;
      const tabsBefore = await herdrJson(["tab", "list"]);
      const created = await herdrJson([
        "tab", "create", "--workspace", input.workspace, "--cwd", input.cwd,
        "--label", input.label, ...(requestedFocus ? [] : ["--no-focus"]),
      ]);
      const identity = tabOf(created);
      const tabsAfter = await herdrJson(["tab", "list"]);
      const opening: HerdrTabOpening = {
        tab: identity,
        focusedBefore: focusedTabId(tabsBefore),
        focusedAfter: focusedTabId(tabsAfter),
        label: input.label,
        cwd: input.cwd,
      };
      // Only the NOT-asked opening carries the no-steal guarantee; when the operator asked for
      // the reopening, focus landing on the new tab is the intended outcome (evidence kept in
      // `focusedAfter`), never an error to refuse the operator's own request with.
      if (!requestedFocus && opening.focusedBefore !== opening.focusedAfter) {
        throw new Error("abrir a aba assistida roubou o foco do operador; abertura recusada");
      }
      return opening;
    },
    async paneRun(paneId, command) {
      // Confirms delivery by its exit code only; success prints no JSON (herdr 0.9.3).
      await execFileAsync("herdr", ["pane", "run", paneId, command], { encoding: "utf8", timeout: 30_000 });
    },
    async tabIds() {
      const listing = await herdrJson(["tab", "list"]);
      const tabs = (listing.tabs as Array<Json> | undefined) ?? [];
      return tabs.filter((tab) => typeof tab.tab_id === "string").map((tab) => tab.tab_id as string);
    },
  };
}
