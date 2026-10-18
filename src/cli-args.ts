export interface CliArgs {
  command: "run" | "status";
  once: boolean;
  configPath?: string;
  runtime?: string;
}

const usage = 'usage: msf run [--once] [--config <path>] [--runtime <name>]\n       msf status [--config <path>]';

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...args] = argv;
  if (command !== "run" && command !== "status") throw new Error(usage);
  let once = false;
  let configPath: string | undefined;
  let runtime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--once" && command === "run") {
      once = true;
      continue;
    }
    if (arg === "--config" || arg === "--runtime") {
      if (arg === "--runtime" && command !== "run") throw new Error(`unknown flag "${arg}"\n${usage}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`unknown flag "${arg}"\n${usage}`);
      if (arg === "--config") configPath = value;
      else runtime = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag "${arg}"\n${usage}`);
    throw new Error(`unexpected argument "${arg}"\n${usage}`);
  }
  return { command, once, ...(configPath ? { configPath } : {}), ...(runtime ? { runtime } : {}) };
}
