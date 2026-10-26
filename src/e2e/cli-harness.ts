import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AMBIENT_TOKEN_ENV_VARS } from "../tracker/github-adapter.js";

/** The built CLI entry, resolved from this module's compiled location. */
function cliPath(): string {
  return new URL("../cli.js", import.meta.url).pathname;
}

/**
 * Hermetic `gh` for the tests that spawn the CLI: the binary under test spawns
 * `gh` for its boot check and its REST calls. A shim on PATH answers the boot
 * check (`gh auth token --user …`) with a fixed token. REST is two modes: with
 * `rest` answers declared, the shim serves them from a canned channel and logs
 * every path the child read; without it, any API call FAILS LOUD (the suites
 * that pass no `rest` run with `repos: []`, so a REST call is a test bug, not
 * something to swallow). Either way an undeclared path is a loud failure.
 *
 * `env` is {@link isolatedEnv}: the child's HOME and XDG dirs point into the
 * suite, so the factory's per-user state stays with the suite, and the ambient
 * token vars plus `GH_CONFIG_DIR` are cleared, so a child never reaches the
 * operator's credential store. That keeps the tests off GitHub, credentials,
 * the network and the operator's dirs.
 *
 * Markers let a test observe, hold and break the owner:
 *   MSF_SHIM_READY — the shim writes its PID here once the boot check reached
 *     it (the run already holds the lock at that point).
 *   MSF_SHIM_HOLD — while this file exists the shim blocks, so the owner
 *     process stays alive (and keeps its exclusivity) under test control.
 *   MSF_SHIM_FAIL — the boot check fails, exercising a startup error AFTER
 *     the lock was acquired.
 *   MSF_GH_REST, MSF_GH_REST_ANSWERS, MSF_GH_REST_LOG — the canned REST
 *     channel's responder, its answer map and the log of paths read.
 */
export interface GhShim {
  /** Directory holding the `gh` shim; prepend it to the child's PATH. */
  binDir: string;
  /** The child environment: the shim on PATH, {@link isolatedEnv} and any
   * markers given. */
  env(markers?: { ready?: string; hold?: string; fail?: boolean }): NodeJS.ProcessEnv;
  /** The paths the child read through the REST channel, in request order
   *  (empty when no `rest` answers were declared). */
  restCalls(): string[];
}

/**
 * One canned answer of the shim's REST channel, keyed by the `gh api` path.
 * A path with no answer FAILS the child loudly: the suite declares exactly the
 * reads it expects, and an undeclared read (a mutation, a dropped query) is a
 * test bug, never something to swallow.
 */
export interface RestAnswer {
  /** The JSON body the answer prints (exit 0). */
  body?: unknown;
  /** Answer 404 "Not Found": the adapter reads it as unknown, never absent. */
  notFound?: true;
  /** Answer a non-404 failure, stderr carrying this text (exit 1). */
  failure?: string;
}

export interface GhShimOptions {
  /** Canned REST answers by `gh api` path; absent = the CLI may not call REST. */
  rest?: Record<string, RestAnswer>;
}

/** The env vars that would point `gh` at a credential source outside the
 * suite's temp dir: the ambient tokens the boot check strips (one shared list,
 * github-adapter.ts) plus gh's config-dir override. */
const CREDENTIAL_ENV_VARS = new Set<string>([...AMBIENT_TOKEN_ENV_VARS, "GH_CONFIG_DIR"]);

/**
 * The environment of a spawned CLI, owned by the suite's temp dir: HOME, the
 * XDG config and state dirs all live there (the factory keeps its per-user
 * state — the run lock — under them), and the variables that
 * would point `gh` at the operator's credential store carried by the parent
 * environment are cleared. Every CLI-spawning suite uses it.
 *
 * `extra` is merged last (the shim's markers and PATH).
 */
export function isolatedEnv(baseDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = join(baseDir, "home");
  mkdirSync(home, { recursive: true });
  const inherited = Object.entries(process.env).filter(
    ([name]) => !CREDENTIAL_ENV_VARS.has(name),
  );
  return {
    ...Object.fromEntries(inherited),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ...extra,
  };
}

export function installGhShim(baseDir: string, options: GhShimOptions = {}): GhShim {
  const binDir = join(baseDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "gh");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "# Drain stdin (the CLI ends it immediately): a shim that exits without",
      "# reading can make the parent's final write fail with EPIPE.",
      "cat >/dev/null 2>&1 || true",
      'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
      '  if [ -n "$MSF_SHIM_FAIL" ]; then',
      '    echo "msf gh-shim: forced boot failure" >&2',
      "    exit 1",
      "  fi",
      '  if [ -n "$MSF_SHIM_READY" ]; then',
      '    printf "%s\\n" "$$" > "$MSF_SHIM_READY"',
      "  fi",
      '  if [ -n "$MSF_SHIM_HOLD" ]; then',
      '    while [ -e "$MSF_SHIM_HOLD" ]; do sleep 0.02; done',
      "  fi",
      '  printf "%s\\n" "ghp_msf_test_shim"',
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && [ -n "$MSF_GH_REST" ]; then',
      '  exec node "$MSF_GH_REST" "$@"',
      "fi",
      'echo "msf gh-shim: unexpected call: gh $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  const rest = options.rest === undefined ? undefined : installRestChannel(baseDir, options.rest);
  return {
    binDir,
    env(markers = {}) {
      return isolatedEnv(baseDir, {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        ...(markers.ready === undefined ? {} : { MSF_SHIM_READY: markers.ready }),
        ...(markers.hold === undefined ? {} : { MSF_SHIM_HOLD: markers.hold }),
        ...(markers.fail === true ? { MSF_SHIM_FAIL: "1" } : {}),
        ...(rest === undefined ? {} : rest.env),
      });
    },
    restCalls() {
      return rest === undefined ? [] : rest.calls();
    },
  };
}

/** The paths a REST-channel log records, in request order. */
function readLog(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
}

/** The REST channel the shim delegates to: canned answers by path, and the log
 *  that records what the child actually read. Each install rewrites both. */
interface RestChannel {
  /** The shim's environment: the responder, its answer map, its call log. */
  env: Record<string, string>;
  /** The paths the child read, in request order. */
  calls(): string[];
}

function installRestChannel(baseDir: string, answers: Record<string, RestAnswer>): RestChannel {
  const channelDir = join(baseDir, "gh-rest");
  mkdirSync(channelDir, { recursive: true });
  const answersPath = join(channelDir, "answers.json");
  const log = join(channelDir, "calls.log");
  const responder = join(channelDir, "respond.cjs");
  writeFileSync(answersPath, JSON.stringify(answers), "utf8");
  writeFileSync(log, "", "utf8");
  writeFileSync(
    responder,
    [
      '"use strict";',
      "// The canned REST channel of the gh shim (cli-harness.ts): answers the",
      "// child's `gh api` calls from answers.json, logs the path it read, and",
      "// fails loudly on a path the suite did not declare.",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      'let path = "";',
      "for (let i = 1; i < argv.length; i += 1) {",
      '  if (argv[i] === "-X" || argv[i] === "--input") { i += 1; continue; }',
      '  if (argv[i].startsWith("-")) continue;',
      "  path = argv[i];",
      "}",
      "fs.appendFileSync(process.env.MSF_GH_REST_LOG, path + \"\\n\");",
      "const answers = JSON.parse(fs.readFileSync(process.env.MSF_GH_REST_ANSWERS, \"utf8\"));",
      "const answer = answers[path];",
      "if (answer === undefined) {",
      '  process.stderr.write("msf gh-shim: no canned REST answer for " + path + "\\n");',
      "  process.exit(1);",
      "}",
      "if (answer.notFound) {",
      '  process.stderr.write("HTTP 404: Not Found\\n");',
      "  process.exit(1);",
      "}",
      "if (answer.failure) {",
      "  process.stderr.write(answer.failure + \"\\n\");",
      "  process.exit(1);",
      "}",
      "process.stdout.write(JSON.stringify(answer.body));",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    env: { MSF_GH_REST: responder, MSF_GH_REST_ANSWERS: answersPath, MSF_GH_REST_LOG: log },
    calls: () => readLog(log),
  };
}

/**
 * Make `docker` unreachable for a spawned CLI, deterministically: the shim
 * fails exactly as a stopped daemon does, so the factory's liveness probe is
 * honestly unknown. It sits BESIDE the `gh` shim (same bin dir), so a test
 * that already uses {@link installGhShim} gets it on PATH with no extra env.
 */
export function installUnreachableDocker(binDir: string): void {
  const shim = join(binDir, "docker");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      // No stdin read: unlike `gh`, the factory never feeds `docker` a body,
      // and draining a pipe that stays open would hang the call instead of
      // failing it (the probe would time out five seconds later).
      "exec 0</dev/null",
      'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
}

/** Run the built CLI to completion in `cwd` (synchronous, bounded). The
 * bound is generous on purpose: a concurrent suite may delay a node start,
 * and the calls under test answer in milliseconds. */
export function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath(), ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Spawn the built CLI, returning the live child. */
export function spawnCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [cliPath(), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Poll `condition` until it holds, or throw a timeout that names the wait. */
export async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolve when the child's stdout carries `text`; reject on timeout or exit. */
export function waitForStdout(child: ChildProcess, text: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${text}"; saw: ${out}`)), timeoutMs);
    child.stdout!.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code} before "${text}"; saw: ${out}`));
    });
  });
}

/**
 * Hermetic Jira REST for the tests that spawn the CLI: the binary's Jira
 * adapter uses `fetch`, so a preload (NODE_OPTIONS=--require) replaces it with
 * a canned channel. Answers are keyed by "METHOD /rest/api/3/<path>"; a search
 * may instead be keyed by "METHOD path :: <jql>" (the JQL the request carried)
 * when two selections query the same site differently. A key may hold a list,
 * consumed per entry key, for the token-paginated search. The call log records
 * what the child actually requested; a malformed body or an undeclared request
 * fails loudly — a mutation or a dropped query is a test bug, never swallowed.
 */
export interface JiraRestAnswer {
  /** The JSON body the shim answers (200 by default). */
  body?: unknown;
  /** A non-2xx status for the canned body. */
  status?: number;
  /** A transport failure: `fetch` rejects with this text. */
  failure?: string;
}

export interface JiraFetchShim {
  /** The environment the child needs (answers, log and the fetch preload). */
  env: NodeJS.ProcessEnv;
  /** The "METHOD path" requests the child made, in request order. */
  calls(): string[];
}

export function installJiraFetchShim(
  baseDir: string,
  answers: Record<string, JiraRestAnswer | JiraRestAnswer[]>,
): JiraFetchShim {
  const channelDir = join(baseDir, "jira-rest");
  mkdirSync(channelDir, { recursive: true });
  const answersPath = join(channelDir, "answers.json");
  const log = join(channelDir, "calls.log");
  const preload = join(channelDir, "fetch-shim.cjs");
  writeFileSync(answersPath, JSON.stringify(answers), "utf8");
  writeFileSync(log, "", "utf8");
  writeFileSync(
    preload,
    [
      '"use strict";',
      "// The canned Jira REST channel (cli-harness.ts): the preload replaces the",
      "// child's fetch, answers from answers.json and records every request.",
      'const fs = require("node:fs");',
      'const answers = JSON.parse(fs.readFileSync(process.env.MSF_JIRA_ANSWERS, "utf8"));',
      "const used = new Map();",
      "globalThis.fetch = async (input, init) => {",
      '  const url = new URL(typeof input === "string" ? input : input.url);',
      '  const method = String((init && init.method) || "GET").toUpperCase();',
      '  const key = method + " " + url.pathname;',
      '  fs.appendFileSync(process.env.MSF_JIRA_CALLS, key + "\\n");',
      "  let jql = null;",
      "  if (init && init.body) {",
      "    let body;",
      "    try {",
      '      body = JSON.parse(String(init.body));',
      "    } catch {",
      '      throw new TypeError("msf jira-shim: the request body is not JSON");',
      "    }",
      '    if (body && typeof body.jql === "string") jql = body.jql;',
      "  }",
      "  const qualified = jql === null ? null : key + ' :: ' + jql;",
      "  const entryKey = qualified !== null && answers[qualified] !== undefined ? qualified : key;",
      "  const entry = answers[entryKey];",
      '  if (entry === undefined) {',
      '    throw new TypeError("msf jira-shim: no canned answer for " + (qualified === null ? key : qualified));',
      "  }",
      "  const list = Array.isArray(entry) ? entry : [entry];",
      "  const index = used.get(entryKey) ?? 0;",
      "  used.set(entryKey, index + 1);",
      "  const answer = list[Math.min(index, list.length - 1)];",
      "  if (answer.failure) throw new TypeError(answer.failure);",
      "  return new Response(JSON.stringify(answer.body === undefined ? {} : answer.body), {",
      "    status: answer.status || 200,",
      '    headers: { "content-type": "application/json" },',
      "  });",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  const nodeOptions = [process.env["NODE_OPTIONS"], `--require ${preload}`].filter(Boolean).join(" ");
  return {
    env: {
      NODE_OPTIONS: nodeOptions,
      MSF_JIRA_ANSWERS: answersPath,
      MSF_JIRA_CALLS: log,
    },
    calls: () => readLog(log),
  };
}
