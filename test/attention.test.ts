import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFileAttentionStore,
} from "../src/state/file-attention-store.js";
import {
  AttentionKeeper, decisionPending, describePending, digestOf, helpPending,
  interventionPending, pendingId, sessionOpenPending,
  type AttentionBoundary, type AttentionPending,
} from "../src/core/attention.js";
import { desktopNotifyCommand, createDesktopNotifier } from "../src/runtime/desktop-notify.js";
import { parseLocalSettings } from "../src/cli/local-settings.js";
import { refKey, type IssueRef } from "../src/tracker/port.js";

// The operator attention (ticket #59): persistent pendings in operable state, dedupe by id,
// best-effort desktop notification that never touches core state, and resolution ending the
// matching pending. No real OS channel is ever fired in tests (the boundary is a double).

const ref: IssueRef = { tracker: "memory", project: "acme/app", id: "9" };

const moment = (offsetMillis: number): (() => Date) => () => new Date(1700000000000 + offsetMillis);

const sender = (options: { fail?: string; calls?: Array<{ title: string; body: string }> } = {}): AttentionBoundary => ({
  async notify(notification) {
    options.calls?.push(notification);
    if (options.fail !== undefined) throw new Error(options.fail);
    return "notify-send";
  },
});

const memoryStore = () => {
  const pendings = new Map<string, AttentionPending>();
  return {
    async load(): Promise<{ pendings: AttentionPending[]; unreadable: string[] }> {
      return { pendings: [...pendings.values()], unreadable: [] };
    },
    async save(pending: AttentionPending): Promise<void> { pendings.set(pending.id, pending); },
    async remove(id: string): Promise<void> { pendings.delete(id); },
  };
};

const openPending = sessionOpenPending({
  key: "memory:acme/app#9", ref, repository: "acme/app", model: "m1", cloneDir: "/clones/app",
  tabId: "tab-1", paneId: "pane-1", containerName: "msf-assist-m", label: "msf-assist-l", resumes: 0,
}, "2026-10-14T10:00:00.000Z");

test("sessionOpenPending carries the locating references of work and session", () => {
  assert.ok(openPending.id.startsWith("abertura|memory:acme/app#9|"));
  assert.equal(openPending.kind, "abertura");
  assert.equal(openPending.what, "sessão assistida aberta aguardando o operador");
  assert.equal(openPending.work?.ref.id, "9");
  assert.equal(openPending.context?.["modelo"], "m1");
  assert.equal(openPending.context?.["clone"], "/clones/app");
  assert.notEqual(openPending.context?.["aba"], undefined);
  assert.notEqual(openPending.context?.["pane"], undefined);
});

const keeper = (notify?: AttentionBoundary, clock?: () => Date): AttentionKeeper =>
  new AttentionKeeper({ store: memoryStore(), ...(notify === undefined ? {} : { notify }), ...(clock === undefined ? {} : { now: clock }) });

test("raise persists the pending and records the delivery attempt with its channel", async () => {
  const calls: Array<{ title: string; body: string }> = [];
  const keeperNow = keeper(sender({ calls }), moment(0));
  await keeperNow.raise(openPending);
  const stored = await keeperNow.consult();
  assert.equal(stored.pendings.length, 1);
  assert.equal(stored.pendings[0]?.notification?.ok, true);
  assert.equal(stored.pendings[0]?.notification?.channel, "notify-send");
  // The notification proven the channel entered: one attempt, with the real references.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.title, /sessão assistida aberta/);
  assert.match(calls[0]!.body, /memory:acme\/app#9/);
  assert.match(calls[0]!.body, /aba=tab-1/);
});

test("dedupe: the same pending id is not raised again and is not re-notified on the next cycle", async () => {
  const calls: Array<{ title: string; body: string }> = [];
  const keeperNow = keeper(sender({ calls }));
  await keeperNow.raise(openPending);
  await keeperNow.raise(openPending);
  assert.equal(calls.length, 1);
  await keeperNow.consult().then((loaded) => assert.equal(loaded.pendings.length, 1));
});

test("restart persistence: the file store keeps the pending and the dedupe across keepers", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-attention-"));
  try {
    const dir = join(root, "pendencias");
    const calls: Array<{ title: string; body: string }> = [];
    const first = new AttentionKeeper({ store: createFileAttentionStore(dir), notify: sender({ calls }) });
    await first.raise(openPending);
    const second = new AttentionKeeper({ store: createFileAttentionStore(dir), notify: sender({ calls }) });
    await second.raise(openPending);
    assert.equal(calls.length, 1, "nenhuma segunda notificação da mesma ocorrência");
    const loaded = await second.consult();
    assert.equal(loaded.pendings.length, 1);
    assert.equal(loaded.pendings[0]?.id, pendingId("abertura", "memory:acme/app#9", digestOf(["abertura", 0])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new interruption has a fresh digest and raises again (dedupe is per id, not per key)", async () => {
  const pendings: AttentionPending[] = [];
  const store = {
    ...memoryStoreV2(pendings),
  };
  const keeperNow = new AttentionKeeper({ store });
  await keeperNow.raise(openPending);
  const other = sessionOpenPending({
    key: "memory:acme/app#9", ref, repository: "acme/app", model: "m1", cloneDir: "/clones/app", resumes: 1,
  }, "2026-10-14T11:00:00.000Z");
  assert.notEqual(other.id, openPending.id);
  await keeperNow.raise(other);
  // The dedupe is by id: two occurrences, each single, whatever the saves counted.
  assert.equal(new Set(pendings.map((pending) => pending.id)).size, 2);
});

const memoryStoreV2 = (sink: AttentionPending[]) => {
  const byId = new Map<string, AttentionPending>();
  return {
    async load() { return { pendings: [...byId.values()], unreadable: [] }; },
    async save(pending: AttentionPending) { byId.set(pending.id, pending); sink.push(pending); },
    async remove(id: string) { byId.delete(id); },
  };
};

test("delivery failure: the pending stays, the failure is recorded, and the raise never throws", async () => {
  const keeperNow = keeper(sender({ fail: "sem notify-send" }));
  await keeperNow.raise(openPending);
  const stored = await keeperNow.consult();
  assert.equal(stored.pendings.length, 1, "a pendência permanece mesmo com o canal falhando");
  assert.equal(stored.pendings[0]?.notification?.ok, false);
  assert.match(stored.pendings[0]?.notification?.error ?? "", /sem notify-send/);
});

test("absent channel: configured off, the pending records the absence instead of staying silent", async () => {
  const keeperNow = keeper(undefined, moment(0));
  await keeperNow.raise(openPending);
  const stored = await keeperNow.consult();
  assert.equal(stored.pendings[0]?.notification?.ok, false);
  assert.equal(stored.pendings[0]?.notification?.channel, "nenhum");
  assert.match(stored.pendings[0]?.notification?.error ?? "", /ausente ou desabilitado/);
});

test("resolution ends the pending of the work; other keys keep theirs", async () => {
  const keeperNow = keeper(sender());
  await keeperNow.raise(openPending);
  await keeperNow.raise(helpPending({ key: "memory:acme/app#3", ref, repository: "acme/app", question: "q?" }, "t"));
  assert.equal(await keeperNow.resolve("memory:acme/app#9"), 1);
  const stored = await keeperNow.consult();
  assert.deepEqual(stored.pendings.map((pending) => pending.key), ["memory:acme/app#3"]);
});

test("resolution by kind: an answered decision ends the decision pending, not the open one", async () => {
  const keeperNow = keeper(sender());
  await keeperNow.raise(openPending);
  await keeperNow.raise(decisionPending({ key: "memory:acme/app#9", ref, repository: "acme/app", question: "q?" }, "t"));
  await keeperNow.resolve("memory:acme/app#9", ["decisão"]);
  const stored = await keeperNow.consult();
  assert.deepEqual(stored.pendings.map((pending) => pending.kind), ["abertura"]);
});

test("decisionPending changes id per interruption and asks the actions the key accepts", () => {
  const first = decisionPending({ key: "memory:acme/app#9", ref, repository: "acme/app", question: "pergunta 1" }, "t1");
  const second = decisionPending({ key: "memory:acme/app#9", ref, repository: "acme/app", question: "pergunta 2" }, "t2");
  assert.notEqual(first.id, second.id, "nova interrupção pede nova decisão");
  assert.deepEqual(first.actions, ["reply", "resume", "release", "approve"]);
});

test("interventionPending keeps the failure visible with its context", () => {
  const pending = interventionPending(
    { key: "memory:acme/app#9", ref, repository: "acme/app" },
    "execução ilegível", "t", digestOf(["execução-ilegível", "motivo"]),
    { reason: "registro ilegível" });
  assert.equal(pending.kind, "intervenção");
  assert.equal(pending.reason, "registro ilegível");
  assert.deepEqual(pending.actions, ["reply", "resume", "release"]);
});

test("describePending builds the notification text without inventing delivery", () => {
  const text = describePending(openPending);
  assert.ok(text.title.startsWith("msf: "));
  assert.ok(text.body.includes("memory:acme/app#9"));
  assert.ok(text.body.includes("clone=/clones/app"));
});

// ── The desktop command channel: platform-chosen, injectable runner (tests never fire the OS). ──

test("the platform command is chosen per OS and the configured command wins", () => {
  const linux = desktopNotifyCommand("linux", "título", "corpo");
  assert.equal(linux?.command, "notify-send");
  assert.deepEqual(linux?.args, ["título", "corpo"]);
  const darwin = desktopNotifyCommand("darwin", "título", "corpo");
  assert.equal(darwin?.command, "osascript");
  assert.match(darwin?.args[1] ?? "", /display notification "corpo" with title "título"/);
  assert.equal(desktopNotifyCommand("sunos", "t", "b"), undefined, "plataforma sem canal: ausência documentada");
});

test("the configured command template is quoted and run via the shell; nothing is invented", async () => {
  const ran: string[] = [];
  const notify = createDesktopNotifier({
    platform: "sunos",
    command: "line-notify {title} {body}",
    runShell: async (line) => { ran.push(line); },
  });
  const channel = await notify.notify({ title: "t; it's", body: "b | x" });
  assert.equal(channel, "comando configurado: line-notify {title} {body}");
  assert.equal(ran.length, 1);
  assert.equal(ran[0], "line-notify 't; it'\\''s' 'b | x'");
});

test("the injected runner never fires a real OS notification and faults become pending-resilient", async () => {
  const ran: Array<{ command: string; args: readonly string[] }> = [];
  const notify = createDesktopNotifier({
    platform: "linux",
    run: async (command, args) => { ran.push({ command, args }); return Promise.reject(new Error("canal falhou")); },
  });
  await assert.rejects(async () => notify.notify({ title: "t", body: "b" }), { message: "canal falhou" });
  assert.deepEqual(ran[0]?.command, "notify-send");
});

// ── Store round-trip: pendings survive restart, files are one per id, unreadable never hides. ──

test("the file store round-trips pendings and reports unreadable files without hiding the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-attention-store-"));
  try {
    const dir = join(root, "pendencias");
    const store = createFileAttentionStore(dir);
    await store.save(openPending);
    await store.save(helpPending({ key: "k2", ref, repository: "acme/app", question: "q" }, "t"));
    const reopened = createFileAttentionStore(dir);
    const loaded = await reopened.load();
    assert.equal(loaded.pendings.length, 2);
    assert.ok(loaded.pendings.some((pending) => pending.id === openPending.id));
    // One file per id (| encoded in the file name).
    const names = await readdir(dir);
    assert.equal(names.length, 2);
    // Appending garbage does not hide the other pendings.
    const writeFile = await import("node:fs/promises").then((fs) => fs.writeFile);
    await writeFile(join(dir, "roto.json"), "não é json\n");
    const after = await reopened.load();
    assert.deepEqual(after.pendings.map((pending) => pending.id).sort(), loaded.pendings.map((pending) => pending.id).sort());
    assert.deepEqual(after.unreadable, ["roto.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Local settings: the channel is configurable; absent block is default-enabled. ──

const notificationsOf = (raw: Record<string, unknown>): { enabled: boolean; command?: string } | undefined => {
  const parsed = parseLocalSettings(raw);
  return typeof parsed === "string" ? undefined : parsed.notifications;
};

test("local settings parse the notifications block", () => {
  assert.deepEqual(notificationsOf({ image: "/i", profiles: {}, checkouts: { a: "/c" } }), undefined);
  assert.equal(notificationsOf({ image: "/i", profiles: {}, checkouts: { a: "/c" }, notifications: { enabled: false } })?.enabled, false);
  const configured = notificationsOf({ image: "/i", profiles: {}, checkouts: { a: "/c" }, notifications: { enabled: true, command: "herdr-notify {title}" } });
  assert.equal(configured?.command, "herdr-notify {title}");
  const badEnabled = parseLocalSettings({ image: "/i", profiles: {}, checkouts: { a: "/c" }, notifications: { enabled: "sim" } });
  assert.ok(typeof badEnabled === "string" && badEnabled.includes("notifications.enabled"));
  const badCommand = parseLocalSettings({ image: "/i", profiles: {}, checkouts: { a: "/c" }, notifications: { command: "" } });
  assert.ok(typeof badCommand === "string" && badCommand.includes("notifications.command"));
});

test("the refKey identity both flows share names the pendings' keys", () => {
  assert.equal(refKey(ref), "memory:acme/app#9");
});
