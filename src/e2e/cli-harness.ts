import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The built CLI entry, resolved from this module's compiled location. */
export function cliPath(): string {
  return new URL("../cli.js", import.meta.url).pathname;
}

/**
 * Hermetic `gh` for the CLI e2e suites: the binary under test spawns `gh` for
 * its boot check and its REST calls. A shim on PATH answers the boot check
 * (`gh auth token --user …`) with a fixed token and fails LOUD on any REST
 * call — the suites that use it run with `repos: []`, so any API call is a
 * test bug, not something to swallow. This keeps the CLI process tests free of
 * GitHub, credentials and the network (issue #90, Testing Decisions).
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
  /** The child environment: the shim on PATH plus any markers given. */
  env(markers?: { ready?: string; hold?: string; fail?: boolean }): NodeJS.ProcessEnv;
}

export function installGhShim(baseDir: string): GhShim {
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
      'echo "msf gh-shim: unexpected call: gh $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  return {
    binDir,
    env(markers = {}) {
      return {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        ...(markers.ready === undefined ? {} : { MSF_SHIM_READY: markers.ready }),
        ...(markers.hold === undefined ? {} : { MSF_SHIM_HOLD: markers.hold }),
        ...(markers.fail === true ? { MSF_SHIM_FAIL: "1" } : {}),
      };
    },
  };
}

/** Run the built CLI to completion in `cwd` (synchronous, bounded). */
export function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
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
