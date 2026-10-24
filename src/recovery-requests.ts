import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";

export interface RecoveryRequest {
  version: 1;
  id: string;
  key: string;
  at: string;
  actor: string;
  retry: string;
  reason: string;
  acceptDuplicateRisk: true;
}

interface RequestResult {
  id: string;
  key: string;
  at: string;
  status: "authorized" | "rejected";
  message: string;
  request: RecoveryRequest;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

async function requestRoot(config: Config): Promise<string> {
  return join(config.workspace, "recovery-requests", digest(await realpath(config.configPath)));
}

async function writeDurable(file: string, record: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try { await fd.writeFile(JSON.stringify(record) + "\n"); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temp, file);
  const directory = await open(dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** A request is not permission. Only the lock-owning orchestrator rechecks and authorizes it. */
export async function queueRecovery(config: Config, input: Omit<RecoveryRequest, "version" | "id" | "at">): Promise<RecoveryRequest> {
  const root = await requestRoot(config);
  const request: RecoveryRequest = { ...input, version: 1, id: randomUUID(), at: new Date().toISOString() };
  await writeDurable(join(root, "pending", `${request.id}.json`), request);
  await writeDurable(join(root, "latest", `${digest(input.key)}.json`), { id: request.id });
  return request;
}

export async function recoveryRequestStatus(config: Config, key: string): Promise<string | undefined> {
  const root = await requestRoot(config);
  let latest: { id?: unknown };
  try { latest = JSON.parse(await readFile(join(root, "latest", `${digest(key)}.json`), "utf8")) as typeof latest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (typeof latest.id !== "string" || !/^[0-9a-f-]{36}$/.test(latest.id)) throw new Error("invalid recovery request reference");
  try {
    const result = JSON.parse(await readFile(join(root, "results", `${latest.id}.json`), "utf8")) as RequestResult;
    return `Request ${latest.id}: ${result.status} — ${result.message}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `Request ${latest.id}: queued — the active run must recheck it on a sweep`;
  }
}

/** Caller owns the run lock; processing stays serialized with admissions and liveness. */
export async function drainRecoveryRequests(
  config: Config,
  authorize: (request: RecoveryRequest) => Promise<string>,
  log: (line: string) => void,
): Promise<void> {
  try { await readdir(join(config.workspace, "recovery-requests")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const root = await requestRoot(config);
  const pending = join(root, "pending");
  let names: string[];
  try { names = await readdir(pending); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names.sort()) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = join(pending, name);
    let request: RecoveryRequest;
    try { request = JSON.parse(await readFile(file, "utf8")) as RecoveryRequest; }
    catch { throw new Error(`unreadable recovery request ${name}; no authorization was issued`); }
    if (request === null || request.version !== 1 || request.id + ".json" !== name || request.acceptDuplicateRisk !== true ||
        ![request.key, request.actor, request.retry, request.reason].every((value) => typeof value === "string" && value.trim() !== "")) {
      throw new Error(`invalid recovery request ${name}; no authorization was issued`);
    }
    let receiptExists = false;
    try {
      const receipt = JSON.parse(await readFile(join(root, "results", name), "utf8")) as RequestResult;
      if (receipt === null || receipt.id !== request.id || receipt.key !== request.key ||
          (receipt.status !== "authorized" && receipt.status !== "rejected")) throw new Error(`invalid recovery receipt ${name}`);
      receiptExists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (receiptExists) { await rm(file); continue; }
    let status: RequestResult["status"] = "authorized";
    let message: string;
    try { message = await authorize(request); }
    catch (error) { status = "rejected"; message = (error as Error).message; }
    await writeDurable(join(root, "results", name), {
      id: request.id, key: request.key, at: new Date().toISOString(), status, message, request,
    } satisfies RequestResult);
    await rm(file);
    log(`recovery request ${request.id} for ${request.key}: ${status}`);
  }
}
