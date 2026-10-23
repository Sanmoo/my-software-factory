import type { DockerRunner } from "./liveness.js";

/**
 * The Docker shell's canned replies (issue 160): the daemon is
 * replaced by a runner, and every command is recorded so a test can prove
 * which question the shell asked — and which it never asks.
 */
export interface FakeDockerReplies {
  listing: string;
  inspect?: string;
  failure?: Error;
}

export interface FakeDocker {
  run: DockerRunner;
  calls: string[][];
}

/**
 * One container as `docker inspect` renders it: its id, its start and the bind
 * sources it carries — the work the runtime binds at /msf-work among them.
 */
export function inspectedContainer(
  id: string,
  mounts: readonly string[],
  startedAt = "2026-02-01T11:47:00.000Z",
): Record<string, unknown> {
  return {
    Id: id,
    State: { Running: true, StartedAt: startedAt },
    Mounts: mounts.map((Source) => ({ Type: "bind", Source })),
  };
}

export function fakeDocker(replies: FakeDockerReplies): FakeDocker {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    if (replies.failure !== undefined) throw replies.failure;
    if (args[0] === "ps") return replies.listing;
    if (args[0] === "inspect" && replies.inspect !== undefined) return replies.inspect;
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  return { run, calls };
}
