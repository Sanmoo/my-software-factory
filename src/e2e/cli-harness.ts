import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AMBIENT_TOKEN_ENV_VARS } from "../tracker/github-adapter.js";

/** The built CLI entry, resolved from this module's compiled location. */
function cliPath(): string {
  return new URL("../cli.js", import.meta.url).pathname;
}

/**
 * Hermetic `gh` for the tests that spawn the CLI: the binary under test spawns
 * `gh` for its boot check and its REST calls. A shim on PATH answers the boot
 * check (`gh auth token --user …`) with a fixed token and fails LOUD on any
 * REST call — the suites that use it run with `repos: []`, so an API call is a
 * test bug, not something to swallow.
 *
 * `env` is {@link isolatedEnv}: the child's HOME and XDG dirs point into the
 * suite, so the factory's per-user state stays with the suite, and the ambient
 * token vars plus `GH_CONFIG_DIR` are cleared, so a child never reaches the
 * operator's credential store. That keeps the tests off GitHub, credentials,
 * the network and the operator's dirs (issue #90, Testing Decisions).
 *
 * Markers let a test observe and hold the owner:
 *   MSF_SHIM_READY — the shim writes its PID here once the boot check reached
 *     it (the run already holds the lock at that point).
 *   MSF_SHIM_HOLD  — while this file exists the shim blocks, so the owner
 *     process stays alive (and keeps its exclusivity) under test control.
 *   MSF_SHIM_FAIL  — the boot check fails, exercising a startup error AFTER
 *     the lock was acquired.
 */
export interface GhShim {
  /** Directory holding the `gh` shim; prepend it to the child's PATH. */
  binDir: string;
  /** The child environment: the shim on PATH, {@link isolatedEnv} and any
   * markers given. */
  env(markers?: { ready?: string; hold?: string; fail?: boolean }): NodeJS.ProcessEnv;
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
  /** Delay before answering — controlled latency for the timing properties. */
  delayMs?: number;
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
 * state — the run lock of issue #90 — under them), and the variables that
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
        ...(rest === undefined
          ? {}
          : {
              MSF_GH_REST: rest.responder,
              MSF_GH_REST_ANSWERS: rest.answers,
              MSF_GH_REST_LOG: rest.log,
            }),
      });
    },
  };
}

/** The REST channel the shim delegates to: canned answers by path + the log of
 *  what the child actually read. Once per install, the answers are rewritten. */
function installRestChannel(
  baseDir: string,
  answers: Record<string, RestAnswer>,
): { responder: string; answers: string; log: string } {
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
      "if (answer.delayMs) {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, answer.delayMs);",
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
  return { responder, answers: answersPath, log };
}

/** The paths the child read through the shim's REST channel, in request order. */
export function readRestCalls(baseDir: string): string[] {
  const log = join(baseDir, "gh-rest", "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
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
