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
