import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_NPM_STAMP } from "./docker-invocation.js";

// Read-only view of one profile's persistent toolchain (ADR 0004). `./msf check` reports it and never
// repairs it: an absent stamp or an absent shim is the first invocation's business, so it is reported,
// never treated as a failure here. What the check CAN fail on is the image not carrying the toolchain
// programs, which no amount of converging would fix.

export interface ToolchainState {
  // The lock-plus-Node-ABI stamp written after a successful `npm ci`, when the tree was converged.
  stamp?: string;
  // The tools the mise convergence has installed, by shim name.
  tools: string[];
}

export async function readToolchainState(dirs: { npm: string; mise: string }): Promise<ToolchainState> {
  const stamp = await readFile(join(dirs.npm, PROFILE_NPM_STAMP), "utf8").catch(() => undefined);
  const shims = await readdir(join(dirs.mise, "shims")).catch(() => [] as string[]);
  return { ...(stamp === undefined ? {} : { stamp: stamp.trim() }), tools: [...shims].sort() };
}
